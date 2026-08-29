/**
 * dsh-session-quality-xg 纯逻辑层单元测试（Node 内置 test runner）。
 * 运行：先构建（npm run build 或 tsc），再 node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildContextTrace,
  buildListReport,
  buildSessionReport,
  createQualityFold,
  daysBetween,
  emptyState,
  foldQualityEvent,
  foldToStored,
  isTokenDeltaChunk,
  loadState,
  median,
  normalizeUsage,
  percentile,
  pressureOf,
  renderListReport,
  renderSessionReport,
  replayEvents,
  saveState,
  stateFilePath,
  totalTokens,
} from '../lib/logic.js'

// ---------- 测试事件构造 ----------

const ev = (seq, type, time, data) => ({ type, seq, time, data })

/** 标准会话：4 轮 4 调用，含 TTFT/压缩/断裂/错误轮/恢复标记（见测试注释） */
function standardEvents() {
  return [
    ev(0, 'turn/start', 1_000, { turn: 0 }),
    ev(1, 'step/start', 2_000, { turn: 0, step: 0 }),
    ev(2, 'assistant/chunk', 2_500, { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hi' } }),
    ev(3, 'assistant/chunk', 3_000, { turn: 0, step: 0, chunk: { type: 'usage', usage: { inputTokens: 10_000, outputTokens: 200, cacheReadTokens: 50_000 } } }),
    ev(4, 'assistant/message', 5_000, {
      turn: 0, step: 0,
      usage: { inputTokens: 10_000, outputTokens: 800, cacheReadTokens: 50_000 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
    ev(5, 'turn/end', 6_000, { turn: 0, reason: { kind: 'completed' } }),
    ev(6, 'turn/start', 7_000, { turn: 1 }),
    ev(7, 'step/start', 8_000, { turn: 1, step: 0 }),
    ev(8, 'request/context', 8_500, { provider: 'p1', model: 'm1', contextWindow: 131_072 }),
    ev(9, 'assistant/chunk', 9_000, { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 12_000, outputTokens: 100, cacheReadTokens: 58_000 } } }),
    ev(10, 'assistant/message', 11_000, {
      turn: 1, step: 0,
      usage: { inputTokens: 12_000, outputTokens: 600, cacheReadTokens: 58_000 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
    ev(11, 'compaction/start', 12_000, { compactionId: 'auto-1', turn: null }),
    ev(12, 'compaction/end', 13_000, { compactionId: 'auto-1', turn: null }),
    ev(13, 'turn/end', 14_000, { turn: 1, reason: { kind: 'completed' } }),
    ev(14, 'turn/start', 15_000, { turn: 2 }),
    ev(15, 'step/start', 16_000, { turn: 2, step: 0 }),
    ev(16, 'assistant/chunk', 17_000, { turn: 2, step: 0, chunk: { type: 'usage', usage: { inputTokens: 40_000, outputTokens: 60, cacheReadTokens: 2_000 } } }),
    ev(17, 'assistant/message', 19_000, {
      turn: 2, step: 0,
      usage: { inputTokens: 40_000, outputTokens: 500, cacheReadTokens: 2_000 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
    ev(18, 'turn/end', 20_000, { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } }),
    ev(19, 'turn/start', 21_000, { turn: 3 }),
    ev(20, 'step/start', 22_000, { turn: 3, step: 0 }),
    ev(21, 'assistant/chunk', 23_000, { turn: 3, step: 0, chunk: { type: 'usage', usage: { inputTokens: 20_000, outputTokens: 70, cacheReadTokens: 45_000 } } }),
    ev(22, 'assistant/message', 25_000, {
      turn: 3, step: 0,
      usage: { inputTokens: 20_000, outputTokens: 400, cacheReadTokens: 45_000 },
      message: { source: { provider: 'p1', model: 'm1' } },
    }),
    ev(23, 'turn/end', 26_000, { turn: 3, reason: { kind: 'completed' } }),
    ev(24, 'request/header', 27_000, { header: { config: { provider: 'p2', model: 'm2' } }, reason: 'resume' }),
    ev(25, 'session/end-seed', 28_000, {}),
  ]
}

function foldStandard(events = standardEvents(), opts = {}) {
  const fold = createQualityFold({ cwd: '/work/gyra', agentPreset: 'cordis', createdAt: 999 }, opts)
  replayEvents(fold, events, opts)
  return fold
}

// ---------- 基础工具 ----------

test('normalizeUsage：合法记录归一化（缺省可选桶补 0）', () => {
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 5 }), {
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  })
  assert.equal(normalizeUsage({ outputTokens: 1 }), null)
  assert.equal(normalizeUsage({ inputTokens: -1, outputTokens: 1 }), null)
})

test('totalTokens / pressureOf：口径正确', () => {
  const u = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 3 }
  assert.equal(totalTokens(u), 65) // 输入三桶 + 输出
  assert.equal(pressureOf(u), 45) // prompt 侧：input + cacheR + cacheW
})

test('daysBetween：日历跨度（含首尾日）', () => {
  assert.equal(daysBetween(new Date('2026-08-20T23:00:00').getTime(), new Date('2026-08-21T01:00:00').getTime()), 2)
  assert.equal(daysBetween(new Date('2026-08-20T10:00:00').getTime(), new Date('2026-08-20T12:00:00').getTime()), 1)
})

test('percentile / median：空数组与常规值', () => {
  assert.equal(median([]), undefined)
  assert.deepEqual(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9)
  assert.equal(median([5, 1, 3]), 3)
})

test('isTokenDeltaChunk：text/reasoning delta 为 token，usage 不是', () => {
  assert.equal(isTokenDeltaChunk({ type: 'text-delta' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'reasoning-delta' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'usage' }), false)
  assert.equal(isTokenDeltaChunk(null), false)
})

// ---------- 折叠 ----------

test('折叠：规模/用量/TTFT/耗时/路由/异常/恢复全量正确', () => {
  const fold = foldStandard()
  const s = foldToStored(fold)
  assert.equal(s.turns, 4)
  assert.equal(s.steps, 4)
  assert.equal(s.calls, 4)
  assert.equal(s.events, 26)
  assert.equal(s.resumes, 1)
  assert.equal(s.seedEndSeq, 25)
  assert.equal(s.firstEventTime, 1_000)
  assert.equal(s.lastEventTime, 28_000)
  // totals：in 10000+12000+40000+20000；cacheR 50000+58000+2000+45000；out 800+600+500+400
  assert.deepEqual(s.totals, {
    inputTokens: 82_000, outputTokens: 2_300, cacheReadTokens: 155_000, cacheWriteTokens: 0, reasoningTokens: 0,
  })
  // turnEnds：completed ×3 + error ×1
  assert.deepEqual(s.turnEnds, { completed: 3, error: 1 })
  // 路由：仅一次 request/context 容量变更
  assert.equal(s.routeChanges.length, 1)
  assert.equal(s.routeChanges[0].contextWindow, 131_072)
  // 压缩：1 次自动，耗时 1000ms，pressureBefore=(1,0) 的占用
  assert.equal(s.compactions.length, 1)
  const comp = s.compactions[0]
  assert.equal(comp.manual, false)
  assert.equal(comp.durationMs, 1_000)
  assert.equal(comp.pressureBefore, 70_000)
  assert.equal(comp.error, undefined)
  // 明细：4 条；TTFT 只在 step(0,0)（有 text-delta）；duration 全 3000ms
  assert.equal(s.callDetails.length, 4)
  const first = s.callDetails[0]
  assert.equal(first.ttft, 500)
  assert.equal(first.duration, 3_000)
  assert.equal(first.pressure, 60_000)
  assert.equal(first.contextWindow, null) // (0,0) 时容量记录未到
  assert.equal(s.callDetails[1].contextWindow, 131_072)
  assert.equal(s.callDetails[1].pressure, 70_000)
  assert.equal(s.callDetails[2].pressure, 42_000)
  assert.equal(s.callDetails[3].pressure, 65_000)
})

test('折叠：同步骤 usage 替换（chunk → message 最终样本），不重复计数', () => {
  const fold = foldStandard()
  assert.equal(foldToStored(fold).calls, 4)
  // (2,0)：chunk out=60 被 message out=500 替换
  const call = foldToStored(fold).callDetails[2]
  assert.equal(call.usage.outputTokens, 500)
  assert.equal(call.pressure, 42_000)
})

test('折叠：无 usage 的调用记 noUsage 记录（失败/中断步骤），calls 不增', () => {
  const events = [
    ev(0, 'turn/start', 1_000, { turn: 0 }),
    ev(1, 'step/start', 2_000, { turn: 0, step: 0 }),
    ev(2, 'assistant/chunk', 2_500, { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'x' } }),
    ev(3, 'assistant/message', 9_000, { turn: 0, step: 0, message: { source: { provider: 'p1', model: 'm1' } } }),
    ev(4, 'turn/end', 10_000, { turn: 0, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
  ]
  const fold = foldStandard(events)
  const s = foldToStored(fold)
  assert.equal(s.turns, 1)
  assert.equal(s.steps, 1)
  assert.equal(s.calls, 0)
  assert.equal(s.callDetails.length, 1)
  assert.equal(s.callDetails[0].noUsage, true)
  assert.equal(s.callDetails[0].ttft, 500)
  assert.equal(s.callDetails[0].duration, 7_000)
  assert.deepEqual(s.turnEnds, { aborted: 1 })
})

test('折叠：seq 守卫去重（实时重复投递幂等）', () => {
  const events = standardEvents()
  const fold = createQualityFold({ createdAt: 0 })
  replayEvents(fold, events)
  const before = foldToStored(fold)
  // 重放一条旧事件（seq ≤ lastSeq）+ 一条新事件
  foldQualityEvent(fold, ev(9, 'assistant/chunk', 99_000, { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 1 } } }))
  foldQualityEvent(fold, ev(26, 'turn/start', 29_000, { turn: 4 }))
  const after = foldToStored(fold)
  assert.equal(after.calls, before.calls + 0) // 旧事件被跳过
  assert.equal(after.turns, before.turns + 1) // 新事件生效
  assert.equal(after.events, before.events + 1)
})

test('折叠：手动压缩（sourceCommandId）与压缩失败（error）', () => {
  const events = [
    ev(0, 'compaction/start', 1_000, { compactionId: 'manual-1', sourceCommandId: 'cmd-1', turn: null }),
    ev(1, 'compaction/end', 4_000, { compactionId: 'manual-1', sourceCommandId: 'cmd-1', turn: null, error: 'provider failed' }),
  ]
  const fold = foldStandard(events)
  const comp = foldToStored(fold).compactions[0]
  assert.equal(comp.manual, true)
  assert.equal(comp.durationMs, 3_000)
  assert.equal(comp.error, 'provider failed')
})

test('折叠：中断压缩（重放结束未闭合）记为 endTime=null', () => {
  const events = [
    ev(0, 'turn/start', 1_000, { turn: 0 }),
    ev(1, 'compaction/start', 2_000, { compactionId: 'auto-1', turn: null }),
    ev(2, 'turn/end', 5_000, { turn: 0, reason: { kind: 'completed' } }),
  ]
  const fold = foldStandard(events)
  const comp = foldToStored(fold).compactions[0]
  assert.equal(comp.endTime, null)
  assert.equal(comp.durationMs, null)
})

test('折叠：detailLimit 裁剪最旧并标记 truncated', () => {
  const fold = foldStandard(standardEvents(), { detailLimit: 2 })
  const s = foldToStored(fold)
  assert.equal(s.callDetails.length, 2)
  assert.equal(s.detailsTruncated, true)
  assert.equal(s.callDetails[0].turn, 2) // 保留最近两条（turn 2、3）
  assert.equal(s.calls, 4) // 聚合统计不受裁剪影响
})

test('折叠：路由变更只在 route/容量变化时记录', () => {
  const events = [
    ev(0, 'request/context', 1_000, { provider: 'p1', model: 'm1' }),
    ev(1, 'request/context', 2_000, { provider: 'p1', model: 'm1' }), // 无变化 → 不记录
    ev(2, 'request/context', 3_000, { provider: 'p1', model: 'm2' }), // 换模 → 记录
    ev(3, 'request/context', 4_000, { provider: 'p1', model: 'm2', contextWindow: 64_000 }), // 容量变化 → 记录
  ]
  const fold = foldStandard(events)
  const routes = foldToStored(fold).routeChanges
  assert.equal(routes.length, 3)
  assert.deepEqual(routes.map(r => r.model), ['m1', 'm2', 'm2'])
  assert.equal(routes[2].contextWindow, 64_000)
})

// ---------- 报告 ----------

test('报告：上下文/缓存/延迟/压缩/异常全字段正确', () => {
  const fold = foldStandard()
  const stored = foldToStored(fold)
  const report = buildSessionReport('sess-1', stored, { now: 30_000 })

  assert.equal(report.sessionId, 'sess-1')
  assert.equal(report.cwd, '/work/gyra')
  assert.equal(report.scale.turns, 4)
  assert.equal(report.scale.days, 1)
  assert.equal(report.scale.seedEndSeq, 25)
  assert.equal(report.totalTokens, 239_300)

  // 上下文：峰值 70000 @ 131072（53.4%）；末次 65000（49.6%）
  assert.equal(report.context.peakPressure, 70_000)
  assert.equal(report.context.peakContextWindow, 131_072)
  assert.ok(Math.abs(report.context.peakRatio - 70_000 / 131_072) < 1e-9)
  assert.equal(report.context.lastPressure, 65_000)
  assert.ok(Math.abs(report.context.lastRatio - 65_000 / 131_072) < 1e-9)
  // 压缩水位 = 压缩前占用 70000 / 131072
  assert.ok(Math.abs(report.context.compactionWatermark - 70_000 / 131_072) < 1e-9)
  // 每调用增量 = (65000-60000)/3
  assert.ok(Math.abs(report.context.perCallIncrement - 5_000 / 3) < 1e-6)
  // 免压缩剩余 = (70000-65000)/(5000/3) = 3
  assert.equal(report.context.callsUntilCompaction, 3)
  // 建议窗口 = ceil(70000×1.25/1024)×1024 = 88064
  assert.equal(report.context.suggestedWindow, 88_064)

  // 缓存：cacheR 155000 / prompt 237000；断裂 1 次（0.829 → 0.048）
  assert.equal(report.cache.cacheReadTokens, 155_000)
  assert.equal(report.cache.promptTokens, 237_000)
  assert.ok(Math.abs(report.cache.ratio - 155_000 / 237_000) < 1e-9)
  assert.equal(report.cache.breaks, 1)

  // 延迟：TTFT 仅 1 次采样 500ms；步耗时全 3000ms；输出速率 2300/12s
  assert.equal(report.latency.ttft.count, 1)
  assert.equal(report.latency.ttft.median, 500)
  assert.equal(report.latency.stepMs.median, 3_000)
  assert.equal(report.latency.stepMs.max, 3_000)
  assert.ok(Math.abs(report.latency.outputPerSec - 2_300 / 12) < 0.01)

  // 压缩：pressureAfter = end 后最近调用 (2,0) 的占用 42000
  assert.equal(report.compactions.length, 1)
  assert.equal(report.compactions[0].pressureAfter, 42_000)

  // 异常轮次
  assert.deepEqual(report.turnEnds, { completed: 3, error: 1 })
})

test('报告：慢调用 TOP 按 duration 降序且限条数', () => {
  const fold = foldStandard()
  const report = buildSessionReport('s', foldToStored(fold), { now: 0, slowCallLimit: 2 })
  assert.equal(report.slowCalls.length, 2)
  const durations = report.slowCalls.map(c => c.duration)
  assert.deepEqual(durations, [3_000, 3_000])
})

test('报告：contextTrace 合并调用/压缩/路由时间线，按时间正序', () => {
  const fold = foldStandard()
  const report = buildSessionReport('s', foldToStored(fold), { now: 0 })
  const trace = report.contextTrace
  // 标准会话时间线：call@5000, route@8500, call@11000, compaction@13000(end), call@19000, call@25000
  assert.equal(trace.length, 6)
  assert.deepEqual(trace.map(p => p.kind), ['call', 'route', 'call', 'compaction', 'call', 'call'])
  assert.ok(trace.every((p, i) => i === 0 || trace[i - 1].time <= p.time), '时间正序')
  const comp = trace.find(p => p.kind === 'compaction')
  assert.equal(comp.kind, 'compaction')
  if (comp.kind === 'compaction') {
    assert.equal(comp.time, 13_000) // 用 endTime 定位
    assert.equal(comp.pressureBefore, 70_000)
    assert.equal(comp.manual, false)
  }
  const call0 = trace[0]
  assert.equal(call0.kind, 'call')
  if (call0.kind === 'call') {
    assert.equal(call0.pressure, 60_000)
    assert.ok(Math.abs(call0.cacheRatio - 50_000 / 60_000) < 1e-9)
    assert.equal(call0.ttft, 500)
    assert.equal(call0.duration, 3_000)
  }
  const route = trace.find(p => p.kind === 'route')
  assert.equal(route.kind, 'route')
  if (route.kind === 'route') {
    assert.equal(route.routeLabel, 'p1/m1')
    assert.equal(route.contextWindow, 131_072)
  }
})

test('报告：contextTrace 限最近 N 点（limit 参数）', () => {
  const stored = foldToStored(foldStandard())
  const trace2 = buildContextTrace(stored.callDetails, stored.compactions, stored.routeChanges, 3)
  assert.equal(trace2.length, 3)
  assert.equal(trace2[0].time, 13_000) // 最近 3 点：compaction@13000, call@19000, call@25000
})

test('报告：无窗口记录时占用率为 null、建议窗口仍给出', () => {
  const events = standardEvents().filter(e => e.type !== 'request/context')
  const fold = foldStandard(events)
  const report = buildSessionReport('s', foldToStored(fold), { now: 0 })
  assert.equal(report.context.peakContextWindow, null)
  assert.equal(report.context.peakRatio, null)
  assert.equal(report.context.compactionWatermark, null) // 无窗口无法算水位
  assert.equal(report.context.callsUntilCompaction, null)
  assert.equal(report.context.suggestedWindow, 88_064) // ceil(70000×1.25/1024)=86 → 86×1024
})

test('列表报告：cwd 过滤、最近活跃排序、limit', () => {
  const DAY_A = new Date('2026-08-20T10:00:00').getTime()
  const DAY_B = new Date('2026-08-21T09:30:00').getTime()
  const NOW = new Date('2026-08-21T12:00:00').getTime()

  const state = emptyState()
  const s1 = foldToStored(foldStandard())
  s1.firstEventTime = DAY_A - 3_600_000
  s1.lastEventTime = DAY_A
  s1.lastActivity = DAY_A
  state.sessions['s1'] = s1
  const s2 = foldToStored(foldStandard())
  s2.cwd = '/work/other'
  s2.firstEventTime = DAY_B - 3_600_000
  s2.lastEventTime = DAY_B
  s2.lastActivity = DAY_B
  state.sessions['s2'] = s2

  const report = buildListReport(state, { now: NOW, limit: 5 })
  assert.equal(report.sessionCount, 2)
  assert.equal(report.rows[0].sessionId, 's2') // 最近活跃在前
  assert.equal(report.rows[0].cwd, '/work/other')

  const byCwd = buildListReport(state, { now: NOW, cwd: 'gyra' })
  assert.equal(byCwd.sessionCount, 1)
  assert.equal(byCwd.rows[0].sessionId, 's1')

  const byDays = buildListReport(state, { now: NOW, days: 1 })
  assert.equal(byDays.sessionCount, 1) // 只有 08-21 活跃的 s2 在窗口
  assert.equal(byDays.rows[0].sessionId, 's2')

  const byId = buildListReport(state, { now: NOW, sessionId: 's1' })
  assert.equal(byId.sessionCount, 1)
})

// ---------- 持久化 ----------

test('持久化：saveState/loadState 往返一致（含明细与压缩）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sq-'))
  const file = stateFilePath(dir)
  try {
    const state = emptyState()
    state.sessions['s1'] = foldToStored(foldStandard())
    saveState(file, state)
    const loaded = loadState(file)
    assert.equal(loaded.version, 1)
    assert.deepEqual(loaded.sessions['s1'], state.sessions['s1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('持久化：损坏/缺失文件返回空状态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sq-'))
  try {
    assert.deepEqual(loadState(join(dir, 'missing.json')), emptyState())
    writeFileSync(join(dir, 'bad.json'), '{not json', 'utf8')
    assert.deepEqual(loadState(join(dir, 'bad.json')), emptyState())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- 渲染 ----------

test('渲染：单会话报告包含关键中文段', () => {
  const fold = foldStandard()
  const report = buildSessionReport('sess-1', foldToStored(fold), { now: 30_000 })
  const text = renderSessionReport(report)
  assert.ok(text.includes('【会话质量分析】sess-1（/work/gyra）'))
  assert.ok(text.includes('4 轮 / 4 步 / 4 次有用量调用'))
  assert.ok(text.includes('峰值 68.4K'))
  assert.ok(text.includes('TTFT 中位 500 ms'))
  assert.ok(text.includes('压缩：1 次'))
  assert.ok(text.includes('上下文轨迹（最近 6 点，时间正序）：'))
  assert.ok(text.includes('前缀断裂 1 次'))
  assert.ok(text.includes('error 1'))
})

test('渲染：列表报告包含每会话摘要', () => {
  const state = emptyState()
  state.sessions['s1'] = foldToStored(foldStandard())
  const report = buildListReport(state, { now: 100_000 })
  const text = renderListReport(report)
  assert.ok(text.includes('【会话质量列表】'))
  assert.ok(text.includes('s1'))
  assert.ok(text.includes('4 轮/4 步/4 调用'))
})
