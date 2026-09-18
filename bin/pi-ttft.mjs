#!/usr/bin/env node
/**
 * pi-ttft — measure time-to-first-token for the Pi coding agent from the command line.
 *
 * Runs `pi --mode json` and timestamps the event stream as it arrives, so the
 * numbers come from the same stream the agent renders. Useful for comparing
 * models, providers, or proxy settings without a human watching a spinner.
 *
 * Timings reported per run:
 *   startup    spawn → turn_start        Pi's own boot and request preparation
 *   ttft       turn_start → first chunk  time to first token
 *   firstToken turn_start → first delta  first token the user could actually see
 *   total      spawn → message_end       wall clock for the whole turn
 *   decode     output tokens / (message_end - firstToken)
 *
 * Note: `ttft` here starts at turn_start, while the companion extension starts
 * its clock at before_provider_request. The CLI number is therefore a few
 * milliseconds larger, and includes Pi's own pre-request work.
 *
 * Only the first assistant turn is timed, so a prompt that triggers tool calls
 * reports the latency of the first model response rather than the whole run.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PI_BIN = process.env.PI_BIN ?? "pi";
const DEFAULT_TIMEOUT_S = 180;
/** Matches the extension's threshold: flag TTFT at or above this. */
const TTFT_SLOW_MS = 3000;
/**
 * Below this many output tokens the decode rate is sampling noise, not a
 * measurement — a two-token reply can compute any speed at all.
 */
const MIN_TOKENS_FOR_TPS = 10;

function usage() {
	return `pi-ttft — measure Pi's time-to-first-token

Usage:
  pi-ttft [options] <prompt...>

Options:
  -n, --runs <N>       repeat the prompt N times (default 1)
  -m, --model <id>     forward --model to pi
  -c, --provider <id>  forward --provider to pi
      --timeout <s>    per-run timeout in seconds (default ${DEFAULT_TIMEOUT_S})
      --json           emit machine-readable JSON
  -h, --help           show this help

Examples:
  pi-ttft "explain this repo"
  pi-ttft -n 5 -m anthropic/claude-sonnet-4-5 "hi"
  pi-ttft --json -n 3 "hi" | jq '.summary'`;
}

function parseArgs(argv) {
	const opts = { runs: 1, json: false, timeoutS: DEFAULT_TIMEOUT_S, piArgs: [] };
	const prompt = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") {
			opts.help = true;
		} else if (a === "--json") {
			opts.json = true;
		} else if (a === "-n" || a === "--runs") {
			opts.runs = Number.parseInt(argv[++i] ?? "", 10);
		} else if (a === "--timeout") {
			opts.timeoutS = Number.parseFloat(argv[++i] ?? "");
		} else if (a === "-m" || a === "--model" || a === "-c" || a === "--provider") {
			opts.piArgs.push(a, argv[++i] ?? "");
		} else {
			prompt.push(a);
		}
	}
	if (!Number.isFinite(opts.runs) || opts.runs < 1) opts.runs = 1;
	if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) opts.timeoutS = DEFAULT_TIMEOUT_S;
	opts.prompt = prompt.join(" ").trim();
	return opts;
}

/** Run pi once and derive timings from its JSON event stream. */
function runOnce(prompt, opts) {
	return new Promise((resolve) => {
		const spawnAt = performance.now();
		const args = ["--mode", "json", "--no-session", ...opts.piArgs, "--", prompt];
		const proc = spawn(PI_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });

		const timings = { startupMs: null, ttftMs: null, firstTokenMs: null, totalMs: null };
		let outputTokens = null;
		let sawTurnStart = false;
		let didTimeout = false;
		let stderr = "";

		proc.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const timer = setTimeout(() => {
			didTimeout = true;
			proc.kill("SIGKILL");
		}, opts.timeoutS * 1000);

		const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

		rl.on("line", (line) => {
			const now = performance.now();
			const trimmed = line.trim();
			if (!trimmed) return;

			let event;
			try {
				event = JSON.parse(trimmed);
			} catch {
				return; // not part of the event stream
			}

			if (event.type === "turn_start" && !sawTurnStart) {
				sawTurnStart = true;
				timings.startupMs = now - spawnAt;
				return;
			}

			if (event.type === "message_start" && event.message?.role === "assistant") {
				if (sawTurnStart && timings.ttftMs === null) timings.ttftMs = now - spawnAt - timings.startupMs;
				return;
			}

			if (event.type === "message_update" && sawTurnStart) {
				const kind = event.assistantMessageEvent?.type;
				if ((kind === "text_delta" || kind === "thinking_delta") && timings.firstTokenMs === null) {
					timings.firstTokenMs = now - spawnAt - timings.startupMs;
				}
				return;
			}

			if (event.type === "message_end" && event.message?.role === "assistant") {
				if (timings.totalMs === null) timings.totalMs = now - spawnAt;
				const usage = event.message.usage;
				if (usage && typeof usage.output === "number") outputTokens = usage.output;
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			resolve({ ok: false, error: `failed to run ${PI_BIN}: ${err.message}` });
		});

		proc.on("close", (code) => {
			clearTimeout(timer);
			rl.close();

			if (didTimeout) {
				return resolve({ ok: false, error: `timed out after ${opts.timeoutS}s` });
			}
			if (timings.totalMs === null) {
				const detail = stderr.trim().split("\n").slice(-3).join("\n");
				return resolve({
					ok: false,
					error: `no assistant message (exit ${code})${detail ? `\n${detail}` : ""}`,
				});
			}

			const decodeBasisMs =
				timings.firstTokenMs !== null ? timings.totalMs - timings.startupMs - timings.firstTokenMs : null;
			const tps =
				decodeBasisMs !== null && decodeBasisMs > 0 && outputTokens !== null && outputTokens >= MIN_TOKENS_FOR_TPS
					? outputTokens / (decodeBasisMs / 1000)
					: null;

			resolve({ ok: true, timings, outputTokens, tps });
		});
	});
}

function fmtMs(ms) {
	if (ms === null || ms === undefined) return "—";
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function summarize(runs) {
	const ok = runs.filter((r) => r.ok);
	if (ok.length === 0) return null;
	const stat = (pick) => {
		const values = ok.map(pick).filter((v) => v !== null && v !== undefined);
		if (values.length === 0) return null;
		return {
			min: Math.min(...values),
			max: Math.max(...values),
			avg: values.reduce((a, b) => a + b, 0) / values.length,
			n: values.length,
		};
	};
	const tpsValues = ok.map((r) => r.tps).filter((v) => v !== null);
	return {
		runs: ok.length,
		failed: runs.length - ok.length,
		startupMs: stat((r) => r.timings.startupMs),
		ttftMs: stat((r) => r.timings.ttftMs),
		firstTokenMs: stat((r) => r.timings.firstTokenMs),
		totalMs: stat((r) => r.timings.totalMs),
		tpsAvg: tpsValues.length > 0 ? tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length : null,
	};
}

const opts = parseArgs(process.argv.slice(2));

if (opts.help || !opts.prompt) {
	console.log(usage());
	process.exit(opts.help ? 0 : 1);
}

const runs = [];
for (let i = 0; i < opts.runs; i++) {
	if (!opts.json && opts.runs > 1) process.stderr.write(`run ${i + 1}/${opts.runs}…\r`);
	const result = await runOnce(opts.prompt, opts);
	runs.push(result);
	if (!opts.json && !result.ok && result.error) {
		process.stderr.write(`run ${i + 1} failed: ${result.error}\n`);
	}
}

const summary = summarize(runs);

if (opts.json) {
	console.log(JSON.stringify({ prompt: opts.prompt, runs, summary }, null, 2));
} else {
	if (opts.runs > 1) process.stderr.write("                    \r");
	console.log(`prompt: ${JSON.stringify(opts.prompt)}\n`);

	runs.forEach((r, i) => {
		if (!r.ok) {
			console.log(`run ${i + 1}  FAILED — ${r.error}\n`);
			return;
		}
		const { timings, outputTokens, tps } = r;
		const ttftNote = timings.ttftMs !== null && timings.ttftMs >= TTFT_SLOW_MS ? "  ← slow" : "";
		console.log(`run ${i + 1}`);
		console.log(`  startup     ${fmtMs(timings.startupMs).padStart(8)}   spawn → turn_start`);
		console.log(`  TTFT        ${fmtMs(timings.ttftMs).padStart(8)}   turn_start → first chunk${ttftNote}`);
		console.log(`  first token ${fmtMs(timings.firstTokenMs).padStart(8)}   turn_start → first visible delta`);
		console.log(`  total       ${fmtMs(timings.totalMs).padStart(8)}   spawn → message_end`);
		console.log(
			`  decode      ${(tps !== null ? `${Math.round(tps)} tok/s` : "—").padStart(8)}   ${outputTokens ?? "—"} output tokens${tps === null && outputTokens !== null && outputTokens < MIN_TOKENS_FOR_TPS ? " (too few to rate)" : ""}`,
		);
		console.log("");
	});

	if (summary && opts.runs > 1) {
		const line = (label, s, unit) => {
			if (!s) return;
			const f = (v) => (unit === "tok/s" ? `${Math.round(v)}` : fmtMs(v));
			console.log(`  ${label.padEnd(12)} min ${f(s.min).padStart(8)} / avg ${f(s.avg).padStart(8)} / max ${f(s.max).padStart(8)}`);
		};
		console.log(`summary (${summary.runs} runs${summary.failed > 0 ? `, ${summary.failed} failed` : ""})`);
		line("TTFT", summary.ttftMs);
		line("first token", summary.firstTokenMs);
		line("total", summary.totalMs);
		line("startup", summary.startupMs);
		if (summary.tpsAvg !== null) console.log(`  ${"decode".padEnd(12)} avg ${Math.round(summary.tpsAvg)} tok/s`);
	}
}

process.exit(summary === null ? 1 : 0);
