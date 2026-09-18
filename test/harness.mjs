#!/usr/bin/env node
/**
 * Offline tests for the pi-ttft extension.
 *
 * Drives the extension through a stubbed Pi API with a virtual clock, so every
 * assertion is exact and the suite runs instantly without touching a model.
 *
 *   node test/harness.mjs
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// The extension imports the Pi API at runtime; point it at the stub.
const { resolve: resolveStub } = await import("./stub-loader.mjs");
registerHooks({ resolve: resolveStub });

const { setStubSettings } = await import("./pi-stub.mjs");

// ---- virtual clock: patch Date.now before the extension reads it ----------
let vnow = 1_000_000;
Date.now = () => vnow;
const advance = (ms) => {
	vnow += ms;
};

// ---- stub the Pi extension API -------------------------------------------
const handlers = {};
const statuses = [];
let lastNotify = null;
let commandHandler = null;

const ctx = {
	cwd: "/stub/project",
	ui: {
		setStatus: (key, text) => statuses.push({ key, text }),
		notify: (message) => {
			lastNotify = message;
		},
	},
};

const pi = {
	on: (name, handler) => {
		(handlers[name] ??= []).push(handler);
	},
	registerCommand: (name, definition) => {
		commandHandler = definition.handler;
	},
};

const { default: extension } = await import("../extensions/ttft.ts");
extension(pi);

const fire = async (name, event = {}) => {
	for (const handler of handlers[name] ?? []) await handler(event, ctx);
};

/** Current status text, or null when the extension cleared it. */
const status = () => {
	const last = statuses.at(-1);
	return last === undefined ? undefined : (last.text ?? null);
};

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed++;
		console.log(`  ok   ${name}`);
	} catch (error) {
		console.error(`  FAIL ${name}\n       ${error.message}`);
		process.exitCode = 1;
	}
}

/** Complete one assistant turn with explicit timings. */
async function turn({ respMs, ttftMs, firstTokenMs, tailMs, outputTokens, stopReason = "stop" }) {
	await fire("before_provider_request", { payload: {} });
	if (respMs !== null) {
		advance(respMs);
		await fire("after_provider_response", { status: 200, headers: {} });
	}
	advance(ttftMs - (respMs ?? 0));
	await fire("message_start", { message: { role: "assistant", content: [], stopReason } });
	if (firstTokenMs !== null) {
		advance(firstTokenMs);
		await fire("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
		});
	}
	if (tailMs !== null) advance(tailMs);
	await fire("message_end", { message: { role: "assistant", stopReason, usage: { output: outputTokens ?? 0 } } });
	await fire("turn_end", { turnIndex: 0, message: {}, toolResults: [] });
}

console.log("pi-ttft extension tests\n");

console.log("status line");
setStubSettings();

await test("session_start clears the status line", async () => {
	await fire("session_start");
	assert.equal(status(), null);
});

await test("request sent shows a pending TTFT", async () => {
	await fire("before_provider_request", { payload: {} });
	assert.equal(status(), "TTFT …");
});

await test("headers received adds resp while still pending", async () => {
	advance(300);
	await fire("after_provider_response", { status: 200, headers: {} });
	assert.equal(status(), "TTFT … · resp 300ms");
});

await test("first chunk replaces the placeholder with the TTFT", async () => {
	advance(1100);
	await fire("message_start", { message: { role: "assistant", content: [] } });
	assert.equal(status(), "TTFT 1.4s");
});

await test("idle shows TTFT and decode speed", async () => {
	advance(200);
	await fire("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
	});
	advance(2800);
	await fire("message_end", { message: { role: "assistant", stopReason: "stop", usage: { output: 200 } } });
	await fire("turn_end", { turnIndex: 0, message: {}, toolResults: [] });
	// decode = 200 tokens / (4400 - 1600)ms = 71.4 tok/s
	assert.equal(status(), "TTFT 1.4s · 71 tok/s");
});

await test("slow prefill blames the server", async () => {
	await turn({ respMs: 300, ttftMs: 6800, firstTokenMs: 200, tailMs: 2800, outputTokens: 200 });
	assert.equal(status(), "TTFT 6.8s · resp 300ms · prefill 6.5s ⚠server · 71 tok/s");
});

await test("waiting state never mixes in the previous turn's prefill", async () => {
	await fire("before_provider_request", { payload: {} });
	advance(6500);
	await fire("after_provider_response", { status: 200, headers: {} });
	assert.equal(status(), "TTFT … · resp 6.5s");
});

await test("slow network blames the network", async () => {
	advance(300);
	await fire("message_start", { message: { role: "assistant", content: [] } });
	assert.equal(status(), "TTFT 6.8s · resp 6.5s · prefill 300ms ⚠network");
});

await test("no verdict when neither side dominates", async () => {
	await turn({ respMs: 1600, ttftMs: 4000, firstTokenMs: 200, tailMs: 800, outputTokens: 100 });
	// resp 1.6s vs prefill 2.4s: 2.4 < 1.6 * 2, so no culprit is named.
	assert.equal(status(), "TTFT 4.0s · resp 1.6s · prefill 2.4s · 125 tok/s");
});

await test("slow decode gets a marker", async () => {
	await turn({ respMs: 200, ttftMs: 1200, firstTokenMs: 100, tailMs: 4000, outputTokens: 60 });
	assert.equal(status(), "TTFT 1.2s · 15 tok/s ↓");
});

await test("failed turns are ignored", async () => {
	await fire("before_provider_request", { payload: {} });
	await fire("message_start", { message: { role: "assistant", stopReason: "error" } });
	await fire("message_end", { message: { role: "assistant", stopReason: "error" } });
	assert.equal(status(), "TTFT …");
	await fire("session_start");
	assert.equal(status(), null);
});

await test("recovers to the minimal line after an anomaly", async () => {
	await turn({ respMs: 300, ttftMs: 6800, firstTokenMs: 200, tailMs: 2800, outputTokens: 200 });
	assert.match(status(), /⚠server/);
	await turn({ respMs: 200, ttftMs: 1200, firstTokenMs: 200, tailMs: 2000, outputTokens: 150 });
	assert.equal(status(), "TTFT 1.2s · 75 tok/s");
});

await test("concurrent tools are summed as a union, not twice", async () => {
	await fire("tool_execution_start", { toolCallId: "a", toolName: "read", args: {} });
	await fire("tool_execution_start", { toolCallId: "b", toolName: "bash", args: {} });
	advance(800);
	await fire("tool_execution_end", { toolCallId: "a", isError: false });
	await fire("tool_execution_end", { toolCallId: "b", isError: false });
	await commandHandler("", ctx);
	// Two overlapping 800ms tools: 800ms total, not 1.6s
	assert.match(lastNotify, /tool {3}800ms total/);
});

console.log("\nconfiguration");

await test("defaults apply when no settings are present", async () => {
	setStubSettings();
	await fire("session_start");
	await commandHandler("", ctx);
	assert.match(lastNotify, /slowMs=3000 {2}slowTps=20 {2}dominantRatio=2/);
	assert.match(lastNotify, /source: defaults/);
});

await test("global settings override defaults", async () => {
	setStubSettings({ global: { ttft: { slowMs: 5000, slowTps: 35, dominantRatio: 3 } } });
	await fire("session_start");
	await commandHandler("", ctx);
	assert.match(lastNotify, /slowMs=5000 {2}slowTps=35 {2}dominantRatio=3/);
	assert.match(lastNotify, /source: global: slowMs=5000, slowTps=35, dominantRatio=3/);
});

await test("project settings win over global, key by key", async () => {
	setStubSettings({
		global: { ttft: { slowMs: 5000, slowTps: 35 } },
		project: { ttft: { slowMs: 8000 } },
	});
	await fire("session_start");
	await commandHandler("", ctx);
	// slowMs from project, slowTps still from global
	assert.match(lastNotify, /slowMs=8000 {2}slowTps=35 {2}dominantRatio=2/);
	assert.match(lastNotify, /global: slowMs=5000, slowTps=35 \| project: slowMs=8000/);
});

await test("invalid values fall back to the default", async () => {
	setStubSettings({
		global: { ttft: { slowMs: -1, slowTps: "fast", dominantRatio: 0.5 } },
	});
	await fire("session_start");
	await commandHandler("", ctx);
	// negative, non-numeric, and a sub-1 ratio are all rejected
	assert.match(lastNotify, /slowMs=3000 {2}slowTps=20 {2}dominantRatio=2/);
	assert.match(lastNotify, /source: defaults/);
});

await test("slowMs controls when the breakdown expands", async () => {
	// TTFT 1.4s is unremarkable at the default 3000ms threshold
	setStubSettings();
	await fire("session_start");
	await turn({ respMs: 300, ttftMs: 1400, firstTokenMs: 200, tailMs: 2800, outputTokens: 200 });
	assert.equal(status(), "TTFT 1.4s · 71 tok/s");

	// ...but expandable once the threshold drops below it
	setStubSettings({ global: { ttft: { slowMs: 1000 } } });
	await fire("session_start");
	await turn({ respMs: 300, ttftMs: 1400, firstTokenMs: 200, tailMs: 2800, outputTokens: 200 });
	assert.equal(status(), "TTFT 1.4s · resp 300ms · prefill 1.1s ⚠server · 71 tok/s");
});

await test("slowTps controls the decode marker", async () => {
	setStubSettings({ global: { ttft: { slowTps: 10 } } });
	await fire("session_start");
	// 15 tok/s is slow by default but fine at a 10 threshold
	await turn({ respMs: 200, ttftMs: 1200, firstTokenMs: 100, tailMs: 4000, outputTokens: 60 });
	assert.equal(status(), "TTFT 1.2s · 15 tok/s");
});

await test("dominantRatio controls when a culprit is named", async () => {
	// resp 1.6s vs prefill 2.4s: a 1.5x gap, invisible at the default ratio of 2
	setStubSettings({ global: { ttft: { dominantRatio: 1.2 } } });
	await fire("session_start");
	await turn({ respMs: 1600, ttftMs: 4000, firstTokenMs: 200, tailMs: 800, outputTokens: 100 });
	assert.equal(status(), "TTFT 4.0s · resp 1.6s · prefill 2.4s ⚠server · 125 tok/s");
});

await test("/ttft reload picks up changes without a restart", async () => {
	setStubSettings({ global: { ttft: { slowMs: 7777 } } });
	await commandHandler("reload", ctx);
	assert.match(lastNotify, /slowMs=7777/);
	assert.match(lastNotify, /config reloaded/);
});

await test("/ttft reset clears counters", async () => {
	await commandHandler("reset", ctx);
	assert.equal(lastNotify, "pi-ttft: counters reset");
	assert.equal(status(), null);
	await commandHandler("", ctx);
	// Config is still reported even with no samples
	assert.match(lastNotify, /no data yet/);
	assert.match(lastNotify, /slowMs=7777/);
});

console.log(`\n${passed} passed${process.exitCode ? ", with failures" : ""}`);
