# pi-ttft

Time-to-first-token for the [Pi coding agent](https://pi.dev) — a footer HUD that
stays out of the way until something is actually slow.

Pi's built-in status line covers token accounting and context occupancy
(`↑ input`, `↓ output`, `R cache read`, `CH cache hit %`, `used/capacity`).
It says nothing about **latency**. `pi-ttft` adds the missing time dimension,
and splits a slow first token into the two causes that matter:

```
TTFT 6.8s · resp 300ms · prefill 6.5s ⚠server
TTFT 6.8s · resp 6.5s · prefill 300ms ⚠network
```

## Status line

The HUD follows one rule: **report state while running, report the last turn while
idle, and only expand when something is wrong.**

| Moment | Width | Status line |
|---|---|---|
| request sent | 6 | `TTFT …` |
| headers received | 19 | `TTFT … · resp 304ms` |
| first chunk arrived | 9 | `TTFT 1.4s` |
| turn finished (normal) | **20** | `TTFT 1.4s · 71 tok/s` |
| turn finished (slow prefill) | 45 | `TTFT 6.8s · resp 300ms · prefill 6.5s ⚠server` |
| turn finished (slow network) | 43 | `TTFT 6.8s · resp 6.5s · prefill 300ms ⚠network` |
| slow decode | 20 | `TTFT 1.2s · 15 tok/s ↓` |

Two details that matter:

- **In-flight and idle are mutually exclusive branches.** The current request's
  `resp` can never be rendered next to the previous turn's `prefill` or `tok/s`.
- **Cumulative values are not in the status bar.** `LLM` / `tool` totals, averages
  and extremes only grow, so they live behind `/ttft` instead of occupying every frame.

### Metrics

| Field | Definition |
|---|---|
| `TTFT` | request → first stream event (the provider's first chunk) |
| `resp` | request → response headers (network + server queueing) |
| `prefill` | headers → first chunk. Server-side prefill; a spike here usually means the prompt cache missed |
| `tok/s` | decode speed = output tokens / (message_end − first token) |

The `⚠network` / `⚠server` verdict is only printed when one side is at least
`dominantRatio` (default 2×) larger. Otherwise no culprit is named.

## Install

```bash
pi install git:github.com/quanxinwang18-a11y/pi-ttft@v1.1.0
```

Or try it without installing:

```bash
pi -e git:github.com/quanxinwang18-a11y/pi-ttft
```

Requires Pi `>= 0.85.1`.

## Commands

| Command | Effect |
|---|---|
| `/ttft` | Full breakdown: TTFT min/avg/max, last-turn resp+prefill split, LLM/tool totals, steps, effective config |
| `/ttft reload` | Re-read settings without restarting |
| `/ttft reset` | Reset counters |

## Configuration

Thresholds live in your Pi settings, so tuning them does not require editing code:

```json
// ~/.pi/agent/settings.json  — global
// .pi/settings.json          — per project
{
  "ttft": {
    "slowMs": 5000,
    "slowTps": 20,
    "dominantRatio": 2
  }
}
```

| Key | Default | Meaning |
|---|---|---|
| `slowMs` | `3000` | TTFT at or above this (ms) expands the `resp` / `prefill` breakdown |
| `slowTps` | `20` | Decode speed below this (tok/s) gets the `↓` marker |
| `dominantRatio` | `2` | How many times larger one side must be before a culprit is named |

Every key is optional. **Project settings override global settings key by key**, so
a repository can raise `slowMs` for a slow provider without touching your global
config. Invalid values (negative, non-numeric, or a `dominantRatio` below 1) fall
back to the default.

Changes are picked up on session start, or immediately with `/ttft reload`.
`/ttft` always prints the effective values and where each came from:

```
config slowMs=8000  slowTps=35  dominantRatio=2
       source: global: slowMs=5000, slowTps=35 | project: slowMs=8000
       files:  /Users/you/.pi/agent/settings.json
               /Users/you/project/.pi/settings.json
```

### Turning it off

`pi config` toggles any installed resource and writes the result to settings.
To do it by hand, add a force-exclude to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["-extensions/ttft.ts"]
}
```

The path is relative to `~/.pi/agent`. `-path` outranks `+path`, so a project can
disable a globally-installed extension it does not want.

## Design notes

- Timing starts at `before_provider_request`, not `turn_start`, so Pi's own
  payload construction is excluded from TTFT.
- Pi synthesizes an assistant message with `stopReason: "error" | "aborted"` when a
  request fails, emitted through the same `message_start` / `message_end` events.
  Those are filtered out so a failure cannot pollute the TTFT average.
- Concurrent tool calls are summed as a **union of intervals**. Two overlapping
  800ms tools add 800ms, not 1.6s.
- Settings are read through Pi's own `SettingsManager`, which is what makes
  project-over-global merging and trust handling behave the same as the rest of Pi.

## Development

```bash
node test/harness.mjs
```

The suite drives the extension through a stubbed Pi API with a virtual clock, so
assertions are exact and it runs instantly without touching a model. A module
resolution hook (`test/stub-loader.mjs`) redirects the Pi import to
`test/pi-stub.mjs`, which also lets tests inject arbitrary settings.

### Packaging note

The core Pi packages are declared as `peerDependencies` (Pi bundles them at
runtime, so they must not ship in the tarball) but are also marked `optional` in
`peerDependenciesMeta`. Without that, npm resolves the `*` range and installs Pi's
entire dependency tree into the package directory — 434 MB for a seven-file
extension. With it, the install is empty.

## Related packages

- [`pi-turn-metrics`](https://pi.dev/packages/pi-turn-metrics) — turns/steps, LLM vs tool
  duration, TTFT average, TPS
- [`pi-token-speed`](https://github.com/gsanhueza/pi-token-speed) — real-time TPS with
  sliding windows and per-provider threshold overrides

Both report cumulative execution metrics continuously. `pi-ttft` deliberately does
not: it optimises for a narrow status line and for naming the cause of a slow turn.

## License

MIT

---

## 中文说明

Pi 内置状态栏只统计 token 和上下文占用，不报任何延迟。`pi-ttft` 补上时间维度，
并把「首个 token 慢」拆成两个真正有意义的成因：

- `resp` 偏大 → 网络或服务端排队
- `prefill` 偏大 → 服务端 prefill 慢，通常意味着 prompt cache 未命中（对照内置
  状态栏的 `CH` 一起看）

状态栏常态只占 20 列，只有在 TTFT 越过 `slowMs`、或 decode 低于 `slowTps` 时才
展开成因拆解并给出结论。`LLM` / `tool` 累计值这类单调递增的数字不在状态栏常驻，
敲 `/ttft` 查看。

三个阈值都在 settings 里配，项目级覆盖全局：

```json
{ "ttft": { "slowMs": 5000, "slowTps": 20, "dominantRatio": 2 } }
```

改完 `/ttft reload` 立即生效。关闭方式：`pi config` 里切换，或在
`~/.pi/agent/settings.json` 加 `{"extensions": ["-extensions/ttft.ts"]}`。
