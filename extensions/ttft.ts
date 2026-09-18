/**
 * pi-ttft — time-to-first-token HUD for the Pi coding agent footer.
 *
 * Design rule: stay minimal until something is wrong.
 *   - Idle, only "state" values are shown (TTFT, decode speed)
 *   - When TTFT or decode speed crosses a threshold, the breakdown appears
 *   - Cumulative values (LLM/tool totals, averages, extremes) live in /ttft,
 *     not in the status bar
 *
 * Status line shapes:
 *   request sent        TTFT …
 *   headers received    TTFT … · resp 0.3s
 *   first chunk         TTFT 1.4s
 *   turn finished       TTFT 1.4s · 62 tok/s
 *
 * In-flight and idle are mutually exclusive branches, so the current request's
 * `resp` can never be shown next to the previous turn's `prefill` / `tok/s`.
 *
 *   TTFT over threshold expands the breakdown and states a conclusion:
 *     TTFT 6.8s · resp 0.3s · prefill 6.5s ⚠server
 *     TTFT 6.8s · resp 6.5s · prefill 0.3s ⚠network
 *
 *   Slow decode gets a marker:
 *     TTFT 1.4s · 18 tok/s ↓
 *
 * Metric definitions:
 *   TTFT     request → first stream event (provider emits its first chunk)
 *   resp     request → response headers (network + server queueing)
 *   prefill  headers → first chunk (server-side prefill; a spike here usually
 *            means the prompt cache missed)
 *   tok/s    decode speed = output tokens / (message_end - first token)
 *
 * Configuration (see README):
 *
 *   // ~/.pi/agent/settings.json, or .pi/settings.json in a project
 *   {
 *     "ttft": {
 *       "slowMs": 5000,
 *       "slowTps": 20,
 *       "dominantRatio": 2
 *     }
 *   }
 *
 * Project settings override global ones key by key. Invalid values fall back to
 * the default. Config is read on session start and by `/ttft reload`.
 *
 * Commands:
 *   /ttft          full breakdown plus effective config
 *   /ttft reload   re-read settings without restarting
 *   /ttft reset    reset counters
 */

import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ttft";

interface TtftConfig {
	/** TTFT at or above this (ms) is treated as slow: expand the breakdown. */
	slowMs: number;
	/** Decode speed below this (tok/s) is treated as slow: add a marker. */
	slowTps: number;
	/** How dominant one side must be (×) before a culprit is named. */
	dominantRatio: number;
}

const DEFAULT_CONFIG: TtftConfig = {
	slowMs: 3000,
	slowTps: 20,
	dominantRatio: 2,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isPositive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Read `ttft` from global settings, then project settings (project wins per key). */
function readConfig(ctx: ExtensionContext): { config: TtftConfig; notes: string[] } {
	const config = { ...DEFAULT_CONFIG };
	const notes: string[] = [];

	let scopes: Array<[string, unknown]>;
	try {
		const manager = SettingsManager.create(ctx.cwd, getAgentDir());
		scopes = [
			["global", manager.getGlobalSettings()],
			["project", manager.getProjectSettings()],
		];
	} catch {
		return { config, notes: ["could not read settings, using defaults"] };
	}

	for (const [scope, settings] of scopes) {
		if (!isRecord(settings)) continue;
		const raw = settings.ttft;
		if (!isRecord(raw)) continue;

		const applied: string[] = [];
		if (isPositive(raw.slowMs)) {
			config.slowMs = raw.slowMs;
			applied.push(`slowMs=${raw.slowMs}`);
		}
		if (isPositive(raw.slowTps)) {
			config.slowTps = raw.slowTps;
			applied.push(`slowTps=${raw.slowTps}`);
		}
		// A ratio below 1 would flag every turn, so require at least 1.
		if (isPositive(raw.dominantRatio) && raw.dominantRatio >= 1) {
			config.dominantRatio = raw.dominantRatio;
			applied.push(`dominantRatio=${raw.dominantRatio}`);
		}
		if (applied.length > 0) notes.push(`${scope}: ${applied.join(", ")}`);
	}

	return { config, notes };
}

const configPath = (scope: "global" | "project", cwd: string): string =>
	scope === "global" ? `${getAgentDir()}/settings.json` : `${cwd}/${CONFIG_DIR_NAME}/settings.json`;

export default function (pi: ExtensionAPI) {
	// ---- current request (reset by before_provider_request) ----
	let reqAt: number | undefined; // HTTP request sent
	let respAt: number | undefined; // response headers received
	let firstEventAt: number | undefined; // first stream event → TTFT
	let firstTokenAt: number | undefined; // first visible token

	// ---- last completed turn (shown only while idle) ----
	let lastTtftMs: number | undefined;
	let lastRespMs: number | undefined;
	let lastPrefillMs: number | undefined;
	let lastTps: number | undefined;

	// ---- session totals ----
	let llmMs = 0;
	let toolMs = 0;
	let steps = 0;
	const ttfts: number[] = [];

	// Concurrent tool timers, summed as a union of intervals
	const runningTools = new Map<string, number>();

	// ---- effective configuration ----
	let config: TtftConfig = { ...DEFAULT_CONFIG };
	let configNotes: string[] = ["defaults"];

	const fmt = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

	/** Name a culprit when one side clearly dominates; stay silent otherwise. */
	function verdict(respMs: number, prefillMs: number): string {
		if (respMs >= prefillMs * config.dominantRatio) return " ⚠network";
		if (prefillMs >= respMs * config.dominantRatio) return " ⚠server";
		return "";
	}

	function render(ctx: ExtensionContext): void {
		const parts: string[] = [];

		if (reqAt !== undefined) {
			// ---- in flight: only what this request knows so far ----
			if (firstEventAt === undefined) {
				parts.push("TTFT …");
				if (respAt !== undefined) parts.push(`resp ${fmt(respAt - reqAt)}`);
			} else {
				const ttftMs = firstEventAt - reqAt;
				parts.push(`TTFT ${fmt(ttftMs)}`);
				if (respAt !== undefined && ttftMs >= config.slowMs) {
					const respMs = respAt - reqAt;
					const prefillMs = firstEventAt - respAt;
					parts.push(`resp ${fmt(respMs)}`, `prefill ${fmt(prefillMs)}${verdict(respMs, prefillMs)}`);
				}
			}
		} else {
			// ---- idle: only the last completed turn ----
			if (lastTtftMs !== undefined) {
				parts.push(`TTFT ${fmt(lastTtftMs)}`);
				if (lastTtftMs >= config.slowMs && lastRespMs !== undefined && lastPrefillMs !== undefined) {
					parts.push(
						`resp ${fmt(lastRespMs)}`,
						`prefill ${fmt(lastPrefillMs)}${verdict(lastRespMs, lastPrefillMs)}`,
					);
				}
			}
			if (lastTps !== undefined) {
				parts.push(`${Math.round(lastTps)} tok/s${lastTps < config.slowTps ? " ↓" : ""}`);
			}
		}

		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
	}

	function reset(): void {
		reqAt = undefined;
		respAt = undefined;
		firstEventAt = undefined;
		firstTokenAt = undefined;
		lastTtftMs = undefined;
		lastRespMs = undefined;
		lastPrefillMs = undefined;
		lastTps = undefined;
		llmMs = 0;
		toolMs = 0;
		steps = 0;
		ttfts.length = 0;
		runningTools.clear();
	}

	// Start the clock right before the HTTP request goes out (payload already
	// built), then clear the previous turn's display values — otherwise the
	// wait for the first token would show this request's `resp` next to the
	// previous turn's `prefill` / `tok/s`.
	pi.on("before_provider_request", (_event, ctx) => {
		reqAt = Date.now();
		respAt = undefined;
		firstEventAt = undefined;
		firstTokenAt = undefined;
		lastTtftMs = undefined;
		lastRespMs = undefined;
		lastPrefillMs = undefined;
		lastTps = undefined;
		render(ctx);
	});

	// Headers arrive: network + queueing. Visible while still waiting for the
	// first chunk, which is what separates "network is slow" from "prefill is slow".
	pi.on("after_provider_response", (_event, ctx) => {
		if (reqAt === undefined || respAt !== undefined) return;
		respAt = Date.now();
		render(ctx);
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		// On failure Pi synthesizes an assistant message through the same events.
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (stopReason === "error" || stopReason === "aborted") return;
		if (reqAt === undefined || firstEventAt !== undefined) return;

		firstEventAt = Date.now();
		ttfts.push(firstEventAt - reqAt);
		render(ctx);
	});

	pi.on("message_update", (event) => {
		if (reqAt === undefined || firstTokenAt !== undefined) return;
		const kind = event.assistantMessageEvent.type;
		if (kind !== "text_delta" && kind !== "thinking_delta") return;
		firstTokenAt = Date.now();
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const stopReason = (event.message as { stopReason?: string }).stopReason;
		if (stopReason === "error" || stopReason === "aborted") return;
		if (reqAt === undefined) return;

		const endedAt = Date.now();
		llmMs += endedAt - reqAt;

		// This turn becomes "the previous turn", shown from now on while idle.
		lastTtftMs = firstEventAt !== undefined ? firstEventAt - reqAt : undefined;
		lastRespMs = respAt !== undefined ? respAt - reqAt : undefined;
		lastPrefillMs = firstEventAt !== undefined && respAt !== undefined ? firstEventAt - respAt : undefined;

		const output = (event.message as { usage?: { output?: number } }).usage?.output ?? 0;
		lastTps = undefined;
		if (firstTokenAt !== undefined && output > 0) {
			const decodeMs = endedAt - firstTokenAt;
			if (decodeMs > 0) lastTps = output / (decodeMs / 1000);
		}

		reqAt = undefined;
		render(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		steps += 1;
		render(ctx);
	});

	pi.on("tool_execution_start", (event) => {
		if (!runningTools.has(event.toolCallId)) runningTools.set(event.toolCallId, Date.now());
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const startedAt = runningTools.get(event.toolCallId);
		if (startedAt === undefined) return;
		runningTools.delete(event.toolCallId);
		// Hold off while concurrent tools are still running so overlapping
		// intervals are never counted twice.
		if (runningTools.size > 0) return;
		toolMs += Date.now() - startedAt;
		render(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		const loaded = readConfig(ctx);
		config = loaded.config;
		configNotes = loaded.notes.length > 0 ? loaded.notes : ["defaults"];
		reset();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("ttft", {
		description: "Show pi-ttft statistics and effective config",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();

			if (sub === "reset") {
				reset();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("pi-ttft: counters reset", "info");
				return;
			}

			if (sub === "reload") {
				const loaded = readConfig(ctx);
				config = loaded.config;
				configNotes = loaded.notes.length > 0 ? loaded.notes : ["defaults"];
				render(ctx);
				ctx.ui.notify(`pi-ttft: config reloaded\n${describeConfig(config, configNotes, ctx)}`, "info");
				return;
			}

			if (ttfts.length === 0) {
				ctx.ui.notify(`pi-ttft: no data yet, send a message first\n\n${describeConfig(config, configNotes, ctx)}`, "info");
				return;
			}

			const avg = ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
			const min = Math.min(...ttfts);
			const max = Math.max(...ttfts);
			const slow = ttfts.filter((t) => t >= config.slowMs).length;

			const lines = [
				`TTFT   min ${fmt(min)} / avg ${fmt(avg)} / max ${fmt(max)}   (${ttfts.length} calls${slow > 0 ? `, ${slow} over ${fmt(config.slowMs)}` : ""})`,
			];
			if (lastRespMs !== undefined && lastPrefillMs !== undefined) {
				lines.push(`last   resp ${fmt(lastRespMs)} + prefill ${fmt(lastPrefillMs)}`);
			}
			lines.push(
				`LLM    ${fmt(llmMs)} total`,
				`tool   ${fmt(toolMs)} total`,
				lastTps !== undefined ? `speed  ${Math.round(lastTps)} tok/s last turn` : "",
				`steps  ${steps}`,
				"",
				describeConfig(config, configNotes, ctx),
			);

			ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
		},
	});
}

/** Human-readable effective config, showing where each value came from. */
function describeConfig(config: TtftConfig, notes: string[], ctx: ExtensionContext): string {
	return [
		`config slowMs=${config.slowMs}  slowTps=${config.slowTps}  dominantRatio=${config.dominantRatio}`,
		`       source: ${notes.join(" | ")}`,
		`       files:  ${configPath("global", ctx.cwd)}`,
		`               ${configPath("project", ctx.cwd)}`,
	].join("\n");
}
