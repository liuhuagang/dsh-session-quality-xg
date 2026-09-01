# dsh-session-quality-xg — Cross-Session Conversation Quality Analysis

<div align="center">
  <sub><a href="README.md">简体中文</a> | <b>English</b></sub>
</div>

> [!NOTE] Maintenance status
> This plugin is an internal tool in the XG series, **provided for learning and reference only, with no maintenance commitment** (issues are not guaranteed to be answered).
> The latest development version is maintained in the internal GitLab XGDSHPlugins; this repository is a source snapshot.

Analyzes DSH session quality: scale, context usage trajectory, cache hits, time-to-first-token (TTFT), compaction events, model-routing changes, and anomalous turns. It complements `dsh-token-stats` (token usage statistics): token-stats answers "how many tokens were spent", while this plugin answers "how good is the session quality and whether the context tier is appropriate".

## Data source and mechanism

The data source is the session log (durable log) event stream, structurally identical to dsh-token-stats:

- `session/created`: batch-replays the full in-memory log when a session is announced (including the complete history of a recovered session); the folded result replaces the state entry wholesale (the log is the source of truth)
- `session/event`: real-time incremental folding; a `seq` guard deduplicates, so batch replays and increments are naturally idempotent
- Persistence: `~/.dsh/session-quality/session-quality.json` (debounced writes to disk; cumulative values are restored after a process restart; refreshed by batch folding when the session is activated again)

The event types that are folded (all standard DSH session-log events):

| Event | Produced metrics |
|------|---------|
| `turn/start` / `turn/end` | Turn scale; anomalous termination reason distribution (error/aborted/blocked/max-tokens/interrupted) |
| `step/start` + `assistant/chunk`(token-delta) + `assistant/message` | Step (model call) boundaries; TTFT (time-to-first-token); total step duration |
| `assistant/chunk`(usage) / `assistant/message`(usage) | Token usage (same turn/step replacement semantics as token-meter); prompt-side context occupancy |
| `request/context` | Model routing and contextWindow tier change sequence (recorded only when route/capacity changes) |
| `request/header`(reason=resume) | Session resume count |
| `compaction/start`..`end` | Compaction events: duration/failure/manual vs auto/context occupancy before and after compaction |
| `session/end-seed` | Seed boundary (the historical prefix of a recovered session) |

**Context occupancy convention** (consistent with token-meter's contextPressure projection): `pressure = inputTokens + cacheReadTokens + cacheWriteTokens` (prompt side); `contextWindow` takes the nearest `request/context` record for that call; occupancy = pressure / window.

## Quality metrics (per session)

- **Scale**: turns / steps / calls with usage (calls without usage are counted separately = failed/interrupted) / event count / time span / recovery marks (seed + resume count)
- **Context trajectory**: peak occupancy and peak occupancy rate, last occupancy, per-call increments (last 10 samples), compaction trigger level (median of occupancy rates before each compaction), estimated remaining calls until compaction, suggested minimum window (peak × 1.25 rounded up to 1K)
- **Cache quality**: prompt-side cacheRead ratio; prefix-break count (adjacent-call cache hit drops sharply from ≥50% to ≤20%, e.g. model switch / large tool result re-serialization / reset after compaction)
- **Performance**: TTFT median/P90/max; step duration median/P90/max; output-rate estimate (output tokens ÷ duration of calls with duration); slow-call TOP
- **Compaction**: count (auto/manual), per-event duration, failure reason, context occupancy before and after compaction
- **Routing**: provider/model/contextWindow change-point sequence
- **Anomalies**: turn/end reason.kind distribution

## Query tool

The model tool `session_quality`:

- **Without sessionId**: list mode — filters by `cwd` (working-directory substring, to locate projects), `days` (recent active window), `limit`, and returns a per-session aggregate summary (scale/total tokens/peak context/compaction count/anomalous turns/routing); well suited to locating sessions by project first and then drilling down
- **With sessionId** (exact or prefix): a full per-session quality report (all of the metrics above + slow-call TOP + compaction details + routing sequence)

The output is structured JSON (exactly described by the tool schema), also rendered as a Chinese-language summary text.

## Configuration (cordis.patch.yml)

```yaml
- insert:
    - id: session-quality
      name: 'dsh-session-quality-xg'
      config:
        logCalls: true        # 每次模型调用输出一行终端质量监控（默认 true）
        # dir: ~/.dsh/session-quality   # 状态目录
        # flushMs: 2000        # 状态写盘防抖
        # detailLimit: 2000    # 每会话调用明细上限（超出裁剪最旧，聚合不受影响）
        # headroom: 0.25       # 建议窗口余量系数（峰值 × (1+headroom)）
```

## Build / Test / Deploy

```bash
node scripts/build.mjs        # junction 补齐 + tsc → lib/ + 单元测试
node --test tests/            # 单独跑测试（需先构建）
```

Deployment: copy `lib/` and `package.json` to
`~/.dsh/profiles/web/node_modules/dsh-session-quality-xg/`, add an insert entry
to `cordis.patch.yml`, and restart DSH.

## Typical usage example

"Analyze the session results for the GyraSearch project" →
`session_quality` (cwd=GyraSearch) lists all session summaries for that project →
`session_quality` (sessionId=…) retrieves details for a key session →
combine with the measured values at each tier (contextWindow/occupancy rate/TTFT/compaction water level) to make a tier assessment.
