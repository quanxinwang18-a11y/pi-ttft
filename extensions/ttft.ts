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
 * Commands:
 *   /ttft          full breakdown
 *   /ttft reset    reset counters
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "ttft";

/** TTFT at or above this is treated as slow: expand the breakdown. */
const TTFT_SLOW_MS = 3000;
/** Decode speed below this is treated as slow: add a marker. */
const TPS_SLOW = 20;
/** How dominant one side must be before we name a culprit. */
const DOMINANT_RATIO = 2;

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

	const fmt = (ms: number): string =>
		ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;

	/** Name a culprit when one side clearly dominates; stay silent otherwise. */
	function verdict(respMs: number, prefillMs: number): string {
		if (respMs >= prefillMs * DOMINANT_RATIO) return " ⚠network";
		if (prefillMs >= respMs * DOMINANT_RATIO) return " ⚠server";
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
				if (respAt !== undefined && ttftMs >= TTFT_SLOW_MS) {
					const respMs = respAt - reqAt;
					const prefillMs = firstEventAt - respAt;
					parts.push(`resp ${fmt(respMs)}`, `prefill ${fmt(prefillMs)}${verdict(respMs, prefillMs)}`);
				}
			}
		} else {
			// ---- idle: only the last completed turn ----
			if (lastTtftMs !== undefined) {
				parts.push(`TTFT ${fmt(lastTtftMs)}`);
				if (lastTtftMs >= TTFT_SLOW_MS && lastRespMs !== undefined && lastPrefillMs !== undefined) {
					parts.push(
						`resp ${fmt(lastRespMs)}`,
						`prefill ${fmt(lastPrefillMs)}${verdict(lastRespMs, lastPrefillMs)}`,
					);
				}
			}
			if (lastTps !== undefined) {
				parts.push(`${Math.round(lastTps)} tok/s${lastTps < TPS_SLOW ? " ↓" : ""}`);
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
		reset();
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("ttft", {
		description: "Show or reset pi-ttft statistics",
		handler: async (args, ctx) => {
			if (args.trim() === "reset") {
				reset();
				ctx.ui.setStatus(STATUS_KEY, undefined);
				ctx.ui.notify("pi-ttft: counters reset", "info");
				return;
			}

			if (ttfts.length === 0) {
				ctx.ui.notify("pi-ttft: no data yet, send a message first", "info");
				return;
			}

			const avg = ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
			const min = Math.min(...ttfts);
			const max = Math.max(...ttfts);
			const slow = ttfts.filter((t) => t >= TTFT_SLOW_MS).length;

			const lines = [
				`TTFT   min ${fmt(min)} / avg ${fmt(avg)} / max ${fmt(max)}   (${ttfts.length} calls${slow > 0 ? `, ${slow} slow` : ""})`,
			];
			if (lastRespMs !== undefined && lastPrefillMs !== undefined) {
				lines.push(`last   resp ${fmt(lastRespMs)} + prefill ${fmt(lastPrefillMs)}`);
			}
			lines.push(
				`LLM    ${fmt(llmMs)} total`,
				`tool   ${fmt(toolMs)} total`,
				lastTps !== undefined ? `speed  ${Math.round(lastTps)} tok/s last turn` : "",
				`steps  ${steps}`,
			);

			ctx.ui.notify(lines.filter(Boolean).join("\n"), "info");
		},
	});
}
