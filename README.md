# pi-ttft

Time-to-first-token for the [Pi coding agent](https://pi.dev) — a footer HUD that
stays out of the way until something is actually slow, plus a CLI for benchmarking.

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
`DOMINANT_RATIO` (default 2×) larger. Otherwise no culprit is named.

## Install

```bash
pi install git:github.com/quanxinwang18-a11y/pi-ttft@v1.0.0
```

Or try it without installing:

```bash
pi -e git:github.com/quanxinwang18-a11y/pi-ttft
```

Requires Pi `>= 0.85.1`.

## Commands

| Command | Effect |
|---|---|
| `/ttft` | Full breakdown: TTFT min/avg/max, last-turn resp+prefill split, LLM/tool totals, steps |
| `/ttft reset` | Reset counters |

## Configuration

Thresholds are constants at the top of `extensions/ttft.ts`:

```ts
const TTFT_SLOW_MS = 3000;   // at or above this, expand the breakdown
const TPS_SLOW = 20;         // below this, mark the decode speed
const DOMINANT_RATIO = 2;    // how dominant one side must be to name a culprit
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

## CLI

The same measurement from the command line, for comparing models, providers, or
proxy settings without a human watching a spinner.

```bash
pi-ttft "explain this repo"
pi-ttft -n 5 -m anthropic/claude-sonnet-4-5 "hi"
pi-ttft --json -n 3 "hi" | jq '.summary'
```

```
prompt: "用一句话说明什么是 TTFT"

run 2
  startup        726ms   spawn → turn_start
  TTFT           3.30s   turn_start → first chunk  ← slow
  first token    4.08s   turn_start → first visible delta
  total          5.56s   spawn → message_end
  decode      121 tok/s   91 output tokens

summary (3 runs)
  TTFT         min    3.30s / avg    4.12s / max    4.53s
  first token  min    4.08s / avg    4.55s / max    4.80s
  total        min    5.56s / avg    6.22s / max    6.63s
  startup      min    719ms / avg    727ms / max    736ms
  decode       avg 117 tok/s
```

| Option | Effect |
|---|---|
| `-n, --runs <N>` | Repeat the prompt N times and aggregate |
| `-m, --model <id>` | Forward `--model` to Pi |
| `-c, --provider <id>` | Forward `--provider` to Pi |
| `--timeout <s>` | Per-run timeout (default 180) |
| `--json` | Machine-readable output |

Two caveats, both intentional:

- The CLI starts its TTFT clock at `turn_start`, while the extension starts at
  `before_provider_request`. The CLI number is therefore a few milliseconds larger
  and includes Pi's own pre-request work. The CLI compensates by reporting
  `startup` separately.
- Only the **first** assistant turn is timed, so a prompt that triggers tool calls
  reports the latency of the first model response rather than the whole run.

Decode speed is suppressed below 10 output tokens — a two-token reply can compute
any rate at all.

## Design notes

- Timing starts at `before_provider_request`, not `turn_start`, so Pi's own
  payload construction is excluded from TTFT.
- Pi synthesizes an assistant message with `stopReason: "error" | "aborted"` when a
  request fails, emitted through the same `message_start` / `message_end` events.
  Those are filtered out so a failure cannot pollute the TTFT average.
- Concurrent tool calls are summed as a **union of intervals**. Two overlapping
  800ms tools add 800ms, not 1.6s.

## Development

```bash
node test/harness.mjs
```

The suite drives the extension through a stubbed Pi API with a virtual clock, so
assertions are exact and it runs instantly without touching a model.

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

状态栏常态只占 20 列，只有在 TTFT 超过 3s、或 decode 低于 20 tok/s 时才展开
成因拆解并给出结论。`LLM` / `tool` 累计值这类单调递增的数字不在状态栏常驻，
敲 `/ttft` 查看。

关闭方式：`pi config` 里切换，或在 `~/.pi/agent/settings.json` 加
`{"extensions": ["-extensions/ttft.ts"]}`。
