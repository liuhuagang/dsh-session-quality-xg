/**
 * dsh-session-quality-xg 纯逻辑层：会话质量事件折叠、聚合与报告构建。
 *
 * 数据源：会话日志（durable log）事件流 —— 批量重放（session.events 全量）
 * 与实时增量（session/event）用同一折叠函数，seq 守卫保证幂等：
 *
 *   - turn/start、turn/end（reason.kind）→ 轮次规模与异常终止原因分布
 *   - step/start → 步骤开始（模型调用边界）；assistant/chunk 首个 token-delta
 *     印章 TTFT（首字延迟）；assistant/message 关闭步骤（总耗时 + 最终 usage）
 *   - assistant/chunk(usage) 与 assistant/message(usage) → token 用量
 *     （同 turn/step 替换语义，与 DSH token-meter 一致）
 *   - request/context（route 或 capacity 变化时记录）→ 模型路由与 contextWindow
 *     档位变更序列；request/header(reason=resume) → 恢复次数
 *   - compaction/start .. end → 压缩事件（耗时/失败/手动自动/压缩前后占用）
 *   - session/end-seed → 种子边界（恢复会话的历史前缀）
 *
 * 上下文占用口径（与 token-meter 的 contextPressure 投影一致）：
 * pressure = inputTokens + cacheReadTokens + cacheWriteTokens（prompt 侧）；
 * contextWindow 取该调用最近的 request/context 记录；占用率 = pressure / window。
 *
 * 本文件只依赖 Node 内置模块，不依赖 cordis/dsh 包，可独立单元测试。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------- 基础类型 ----------

/** Token 用量桶（五字段恒在；缺失字段归一化为 0） */
export interface UsageBuckets {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

/** 一个模型路由（provider/model） */
export interface RouteKey {
  provider: string
  model: string
}

/** 一次模型调用（一步）的质量记录 */
export interface CallRecord {
  turn: number
  step: number
  /** 完成时间（assistant/message 或 closeStep 的时间，ms） */
  time: number
  /** 首字延迟：step/start → 首个 token-delta chunk（ms）；未知为 null */
  ttft: number | null
  /** 步骤总耗时：step/start → assistant/message（ms）；未知为 null */
  duration: number | null
  /** 该调用 prompt 侧上下文占用（input + cacheR + cacheW）；无用量为 0 */
  pressure: number
  /** 该调用生效的 contextWindow；未知为 null */
  contextWindow: number | null
  /** 该步骤无 usage 上报（失败/中断调用），性能统计仍计入 */
  noUsage: boolean
  usage: UsageBuckets
  routeLabel: string
}

/** 一次压缩事件（compaction/start..end 对） */
export interface CompactionRecord {
  id: string
  startTime: number
  /** 完成时间；未闭合（中断）为 null */
  endTime: number | null
  /** 耗时（ms）；未闭合为 null */
  durationMs: number | null
  /** 失败原因（compaction/end.error）；成功无此字段 */
  error?: string
  /** true = 手动（带 sourceCommandId），false = 自动触发 */
  manual: boolean
  /** 压缩开始前最近一次调用的上下文占用；无观测为 null */
  pressureBefore: number | null
}

/** 一次模型路由/容量变更（request/context 事件） */
export interface RouteChange {
  time: number
  provider: string
  model: string
  contextWindow: number | null
}

/** 持久化的单会话质量统计（日志折叠结果；日志本身是 source of truth） */
export interface StoredQualitySession {
  cwd?: string
  agentPreset?: string
  /** 会话标题（session/title 事件折叠所得；无标题事件时为 undefined） */
  title?: string
  createdAt: number
  lastActivity: number
  /** 折叠处理的事件数（seq 去重后） */
  events: number
  turns: number
  steps: number
  /** 有 usage 样本的完成调用数 */
  calls: number
  /** 种子边界 seq（恢复会话的历史前缀）；无种子为 null */
  seedEndSeq: number | null
  /** request/header(reason=resume) 次数 */
  resumes: number
  totals: UsageBuckets
  /** 调用明细（keepDetails=true 时持久化；超上限裁剪最旧） */
  callDetails: CallRecord[]
  detailsTruncated: boolean
  compactions: CompactionRecord[]
  routeChanges: RouteChange[]
  /** turn/end reason.kind → 次数 */
  turnEnds: Record<string, number>
  firstEventTime: number
  lastEventTime: number
}

/** 全量状态（session-quality.json 内容） */
export interface QualityState {
  version: 1
  sessions: Record<string, StoredQualitySession>
}

/** 折叠过程中的单会话可变状态（内存态，不落盘） */
export interface QualityFold {
  meta: { cwd?: string; agentPreset?: string; createdAt: number }
  stored: StoredQualitySession
  /** 最近处理事件 seq（实时增量去重） */
  lastSeq: number
  route: RouteKey | null
  contextWindow: number | null
  /** 最近一次 usage 样本（同 turn/step 替换槽） */
  lastUsage: { turn: number; step: number; usage: UsageBuckets; time: number } | null
  /** step/start 打开的步骤（key = turn\0step → 开始时间） */
  openSteps: Map<string, number>
  /** 首 token-delta 印章（key = turn\0step → 时间） */
  firstTokens: Map<string, number>
  /** 进行中的压缩 */
  openCompaction: {
    id: string
    startTime: number
    manual: boolean
    pressureBefore: number | null
  } | null
  /** 最近一次调用 pressure（压缩前后对比锚点） */
  lastPressure: number | null
  /** 调用明细条数上限 */
  detailLimit: number
}

/** 可折叠事件的结构性形状（真实 SessionEvent 满足此形状；逻辑层不 import 类型包） */
export interface FoldableEvent {
  type: string
  seq: number
  time: number
  data: unknown
}

// ---------- 基础工具 ----------

export function emptyUsage(): UsageBuckets {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

export function addUsage(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  }
}

export function subUsage(a: UsageBuckets, b: UsageBuckets): UsageBuckets {
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens - b.reasoningTokens,
  }
}

export function usageEqual(a: UsageBuckets, b: UsageBuckets): boolean {
  return a.inputTokens === b.inputTokens
    && a.outputTokens === b.outputTokens
    && a.cacheReadTokens === b.cacheReadTokens
    && a.cacheWriteTokens === b.cacheWriteTokens
    && a.reasoningTokens === b.reasoningTokens
}

/** 计费/分析口径的总量：输入三桶 + 输出；推理已含在输出内 */
export function totalTokens(u: UsageBuckets): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens + u.outputTokens
}

/** prompt 侧上下文占用（与 token-meter contextPressure 口径一致） */
export function pressureOf(u: UsageBuckets): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens
}

/** 本地时区日期键 YYYY-MM-DD */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 日历跨度天数（含首尾日） */
export function daysBetween(a: number, b: number): number {
  const dayA = new Date(`${dayKey(a)}T00:00:00`).getTime()
  const dayB = new Date(`${dayKey(b)}T00:00:00`).getTime()
  return Math.max(1, Math.round(Math.abs(dayB - dayA) / 86_400_000) + 1)
}

/** 路由展示名 */
export function routeLabel(route: RouteKey | null): string {
  return route === null ? 'unknown' : `${route.provider}/${route.model}`
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** provider/model 对守卫（两字段均为非空字符串） */
export function isRoutePair(value: unknown): value is RouteKey {
  if (typeof value !== 'object' || value === null) return false
  const pair = value as Record<string, unknown>
  return typeof pair['provider'] === 'string' && pair['provider'].length > 0
    && typeof pair['model'] === 'string' && pair['model'].length > 0
}

/**
 * 归一化一条 TokenUsage 记录；非法（缺必填字段/负数/非数值）返回 null。
 * 可选桶缺失补 0 —— 聚合桶五字段恒在。
 */
export function normalizeUsage(raw: unknown): UsageBuckets | null {
  if (typeof raw !== 'object' || raw === null) return null
  const u = raw as Record<string, unknown>
  const inputTokens = u['inputTokens']
  const outputTokens = u['outputTokens']
  if (!isFiniteNumber(inputTokens) || inputTokens < 0) return null
  if (!isFiniteNumber(outputTokens) || outputTokens < 0) return null
  const optional = (v: unknown): number => (isFiniteNumber(v) && v >= 0 ? v : 0)
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: optional(u['cacheReadTokens']),
    cacheWriteTokens: optional(u['cacheWriteTokens']),
    reasoningTokens: optional(u['reasoningTokens']),
  }
}

/** 步骤复合键（turn/step → 唯一键） */
export function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

/** token-delta chunk 判定（与 DSH assistant-timing 的 isTokenDelta 一致） */
export function isTokenDeltaChunk(chunk: unknown): boolean {
  if (typeof chunk !== 'object' || chunk === null) return false
  const type = (chunk as Record<string, unknown>)['type']
  return type === 'text-delta' || type === 'reasoning-delta'
}

// ---------- 折叠 ----------

export interface FoldOptions {
  /** 调用明细条数上限；超出裁剪最旧并标记 detailsTruncated，默认 2000 */
  detailLimit?: number
}

/** 新建一个会话折叠器 */
export function createQualityFold(
  meta: { cwd?: string; agentPreset?: string; createdAt: number },
  opts: FoldOptions = {},
): QualityFold {
  const detailLimit = Math.max(1, Math.floor(opts.detailLimit ?? 2000))
  return {
    meta,
    stored: {
      ...meta.cwd === undefined ? {} : { cwd: meta.cwd },
      ...meta.agentPreset === undefined ? {} : { agentPreset: meta.agentPreset },
      createdAt: meta.createdAt,
      lastActivity: 0,
      events: 0,
      turns: 0,
      steps: 0,
      calls: 0,
      seedEndSeq: null,
      resumes: 0,
      totals: emptyUsage(),
      callDetails: [],
      detailsTruncated: false,
      compactions: [],
      routeChanges: [],
      turnEnds: {},
      firstEventTime: 0,
      lastEventTime: 0,
    },
    lastSeq: -1,
    route: null,
    contextWindow: null,
    lastUsage: null,
    openSteps: new Map(),
    firstTokens: new Map(),
    openCompaction: null,
    lastPressure: null,
    detailLimit,
  }
}

/** 裁剪调用明细（保留最近 detailLimit 条） */
function trimDetails(fold: QualityFold, limit: number): void {
  const d = fold.stored.callDetails
  if (d.length > limit) {
    d.splice(0, d.length - limit)
    fold.stored.detailsTruncated = true
  }
}

/**
 * 应用一条 usage 样本（同 turn/step 替换语义，与 token-meter 一致）：
 * 已有同步骤样本 → 减旧加新（totals 与明细末尾记录原地替换）；
 * 新步骤 → 追加明细记录、calls +1、totals 加新。
 */
function applyUsageSample(fold: QualityFold, turn: number, step: number, time: number, usage: UsageBuckets): void {
  const s = fold.stored
  const previous = fold.lastUsage !== null && fold.lastUsage.turn === turn && fold.lastUsage.step === step
    ? fold.lastUsage
    : null
  if (previous !== null && usageEqual(previous.usage, usage)) return
  if (previous !== null) {
    fold.stored.totals = subUsage(fold.stored.totals, previous.usage)
    const last = s.callDetails[s.callDetails.length - 1]
    if (last !== undefined) last.usage = usage
  } else {
    s.calls += 1
    s.callDetails.push({
      turn,
      step,
      time,
      ttft: null,
      duration: null,
      pressure: pressureOf(usage),
      contextWindow: fold.contextWindow,
      noUsage: false,
      usage,
      routeLabel: routeLabel(fold.route),
    })
  }
  fold.stored.totals = addUsage(fold.stored.totals, usage)
  fold.lastUsage = { turn, step, usage, time }
  fold.lastPressure = pressureOf(usage)
  s.lastActivity = Math.max(s.lastActivity, time)
  trimDetails(fold, fold.detailLimit)
}

/**
 * 关闭一步（assistant/message）：补 TTFT/总耗时；该步骤无 usage 样本时
 * 也追加一条 noUsage 记录（失败/中断调用，性能统计仍计入）。
 */
function closeStep(fold: QualityFold, turn: number, step: number, time: number): void {
  const s = fold.stored
  const key = stepKey(turn, step)
  const startTime = fold.openSteps.get(key) ?? null
  const firstToken = fold.firstTokens.get(key) ?? null
  const ttft = startTime !== null && firstToken !== null ? firstToken - startTime : null
  const duration = startTime !== null ? time - startTime : null
  fold.openSteps.delete(key)
  fold.firstTokens.delete(key)

  const last = s.callDetails[s.callDetails.length - 1]
  if (last !== undefined && last.turn === turn && last.step === step && !last.noUsage) {
    last.time = time
    last.ttft = ttft
    last.duration = duration
  } else {
    s.callDetails.push({
      turn,
      step,
      time,
      ttft,
      duration,
      pressure: 0,
      contextWindow: fold.contextWindow,
      noUsage: true,
      usage: emptyUsage(),
      routeLabel: routeLabel(fold.route),
    })
    trimDetails(fold, fold.detailLimit)
  }
  s.lastActivity = Math.max(s.lastActivity, time)
}

/**
 * 把一条会话事件折进质量状态（原地修改；批量重放与实时增量共用）。
 * seq 守卫：seq ≤ lastSeq 的事件跳过（重放后再收到实时重复投递时幂等）。
 */
export function foldQualityEvent(fold: QualityFold, event: FoldableEvent): void {
  const s = fold.stored
  if (event.seq <= fold.lastSeq) return
  fold.lastSeq = event.seq
  s.events += 1
  if (s.firstEventTime === 0) s.firstEventTime = event.time
  s.lastEventTime = event.time

  const data = event.data
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>

  switch (event.type) {
    case 'turn/start': {
      s.turns += 1
      break
    }
    case 'turn/end': {
      const reason = d['reason']
      const kind = typeof reason === 'object' && reason !== null
        ? String((reason as Record<string, unknown>)['kind'] ?? 'unknown')
        : 'unknown'
      s.turnEnds[kind] = (s.turnEnds[kind] ?? 0) + 1
      break
    }
    case 'step/start': {
      if (!isFiniteNumber(d['turn']) || !isFiniteNumber(d['step'])) break
      s.steps += 1
      fold.openSteps.set(stepKey(d['turn'], d['step']), event.time)
      break
    }
    case 'assistant/chunk': {
      if (!isFiniteNumber(d['turn']) || !isFiniteNumber(d['step'])) break
      const turn = d['turn']
      const step = d['step']
      const chunk = d['chunk']
      if (typeof chunk !== 'object' || chunk === null) break
      const c = chunk as Record<string, unknown>
      if (c['type'] === 'usage') {
        const usage = normalizeUsage(c['usage'])
        if (usage === null) break
        applyUsageSample(fold, turn, step, event.time, usage)
      } else if (isTokenDeltaChunk(chunk)) {
        const key = stepKey(turn, step)
        if (!fold.firstTokens.has(key)) fold.firstTokens.set(key, event.time)
      }
      break
    }
    case 'assistant/message': {
      if (!isFiniteNumber(d['turn']) || !isFiniteNumber(d['step'])) break
      const turn = d['turn']
      const step = d['step']
      const usage = normalizeUsage(d['usage'])
      if (usage !== null) applyUsageSample(fold, turn, step, event.time, usage)
      // message.source 是权威路由（若提供则更新当前路由）
      const message = d['message']
      const source = typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)['source']
        : null
      if (isRoutePair(source)) fold.route = { provider: source.provider, model: source.model }
      closeStep(fold, turn, step, event.time)
      break
    }
    case 'request/context': {
      const provider = d['provider']
      const model = d['model']
      if (typeof provider !== 'string' || typeof model !== 'string') break
      const contextWindow = isFiniteNumber(d['contextWindow']) ? d['contextWindow'] : null
      const changed = fold.route === null || fold.route.provider !== provider || fold.route.model !== model
        || fold.contextWindow !== contextWindow
      if (!changed) break
      fold.route = { provider, model }
      fold.contextWindow = contextWindow
      s.routeChanges.push({ time: event.time, provider, model, contextWindow })
      break
    }
    case 'request/header': {
      // data 形状：{ header: EpochHeader; reason: 'initial' | 'resume' | 'change' }
      if (d['reason'] === 'resume') s.resumes += 1
      break
    }
    case 'session/end-seed': {
      s.seedEndSeq = event.seq
      break
    }
    case 'session/title': {
      // 会话标题：最新 session/title 事件胜出（与 DSH 标题投影一致）
      const title = d['title']
      if (typeof title === 'string' && title.trim().length > 0) s.title = title.trim()
      break
    }
    case 'compaction/start': {
      const id = typeof d['compactionId'] === 'string' ? d['compactionId'] : `unknown-${event.seq}`
      fold.openCompaction = {
        id,
        startTime: event.time,
        manual: typeof d['sourceCommandId'] === 'string',
        pressureBefore: fold.lastPressure,
      }
      break
    }
    case 'compaction/end': {
      const open = fold.openCompaction
      if (open === null) break // 孤立 end（无 open 的异常日志），跳过
      fold.openCompaction = null
      s.compactions.push({
        id: open.id,
        startTime: open.startTime,
        endTime: event.time,
        durationMs: event.time - open.startTime,
        ...typeof d['error'] === 'string' ? { error: d['error'] } : {},
        manual: open.manual,
        pressureBefore: open.pressureBefore,
      })
      break
    }
    default:
      break
  }
}

/** 批量重放整段事件（会话公告/恢复时使用）；重放结束返回 fold */
export function replayEvents(
  fold: QualityFold,
  events: readonly FoldableEvent[],
  opts: FoldOptions = {},
): QualityFold {
  for (const event of events) foldQualityEvent(fold, event)
  // 重放结束仍未闭合的压缩 = 中断压缩（记录 durationMs=null），不留 open 态
  const open = fold.openCompaction
  if (open !== null) {
    fold.openCompaction = null
    fold.stored.compactions.push({
      id: open.id,
      startTime: open.startTime,
      endTime: null,
      durationMs: null,
      manual: open.manual,
      pressureBefore: open.pressureBefore,
    })
  }
  // 未闭合的步骤不落盘（中断的调用），直接清空
  fold.openSteps.clear()
  fold.firstTokens.clear()
  trimDetails(fold, opts.detailLimit ?? 2000)
  return fold
}

/** 折叠器 → 持久化会话质量（丢弃内存态） */
export function foldToStored(fold: QualityFold): StoredQualitySession {
  return {
    ...fold.meta.cwd === undefined ? {} : { cwd: fold.meta.cwd },
    ...fold.meta.agentPreset === undefined ? {} : { agentPreset: fold.meta.agentPreset },
    ...fold.stored.title === undefined ? {} : { title: fold.stored.title },
    createdAt: fold.meta.createdAt,
    lastActivity: fold.stored.lastActivity,
    events: fold.stored.events,
    turns: fold.stored.turns,
    steps: fold.stored.steps,
    calls: fold.stored.calls,
    seedEndSeq: fold.stored.seedEndSeq,
    resumes: fold.stored.resumes,
    totals: fold.stored.totals,
    callDetails: fold.stored.callDetails,
    detailsTruncated: fold.stored.detailsTruncated,
    compactions: fold.stored.compactions,
    routeChanges: fold.stored.routeChanges,
    turnEnds: fold.stored.turnEnds,
    firstEventTime: fold.stored.firstEventTime,
    lastEventTime: fold.stored.lastEventTime,
  }
}

// ---------- 状态持久化 ----------

export const STATE_VERSION = 1

/** 状态文件路径：<dir>/session-quality.json */
export function stateFilePath(dir: string): string {
  return join(dir, 'session-quality.json')
}

/** 空状态 */
export function emptyState(): QualityState {
  return { version: 1, sessions: {} }
}

/** 宽松校验单会话记录；非法返回 null */
export function sanitizeStoredSession(value: unknown): StoredQualitySession | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  const totals = normalizeUsage(v['totals'])
  if (totals === null) return null

  const callDetails: CallRecord[] = []
  const detailsRaw = v['callDetails']
  if (Array.isArray(detailsRaw)) {
    for (const item of detailsRaw) {
      if (typeof item !== 'object' || item === null) continue
      const c = item as Record<string, unknown>
      if (!isFiniteNumber(c['turn']) || !isFiniteNumber(c['step']) || !isFiniteNumber(c['time'])) continue
      const usage = normalizeUsage(c['usage'])
      if (usage === null) continue
      callDetails.push({
        turn: c['turn'],
        step: c['step'],
        time: c['time'],
        ttft: isFiniteNumber(c['ttft']) ? c['ttft'] : null,
        duration: isFiniteNumber(c['duration']) ? c['duration'] : null,
        pressure: isFiniteNumber(c['pressure']) && c['pressure'] >= 0 ? c['pressure'] : 0,
        contextWindow: isFiniteNumber(c['contextWindow']) ? c['contextWindow'] : null,
        noUsage: c['noUsage'] === true,
        usage,
        routeLabel: typeof c['routeLabel'] === 'string' ? c['routeLabel'] : 'unknown',
      })
    }
  }

  const compactions: CompactionRecord[] = []
  const compRaw = v['compactions']
  if (Array.isArray(compRaw)) {
    for (const item of compRaw) {
      if (typeof item !== 'object' || item === null) continue
      const c = item as Record<string, unknown>
      if (typeof c['id'] !== 'string' || !isFiniteNumber(c['startTime'])) continue
      compactions.push({
        id: c['id'],
        startTime: c['startTime'],
        endTime: isFiniteNumber(c['endTime']) ? c['endTime'] : null,
        durationMs: isFiniteNumber(c['durationMs']) ? c['durationMs'] : null,
        ...typeof c['error'] === 'string' ? { error: c['error'] } : {},
        manual: c['manual'] === true,
        pressureBefore: isFiniteNumber(c['pressureBefore']) ? c['pressureBefore'] : null,
      })
    }
  }

  const routeChanges: RouteChange[] = []
  const routeRaw = v['routeChanges']
  if (Array.isArray(routeRaw)) {
    for (const item of routeRaw) {
      if (typeof item !== 'object' || item === null) continue
      const r = item as Record<string, unknown>
      if (typeof r['provider'] !== 'string' || typeof r['model'] !== 'string' || !isFiniteNumber(r['time'])) continue
      routeChanges.push({
        time: r['time'],
        provider: r['provider'],
        model: r['model'],
        contextWindow: isFiniteNumber(r['contextWindow']) ? r['contextWindow'] : null,
      })
    }
  }

  const turnEnds: Record<string, number> = {}
  const turnRaw = v['turnEnds']
  if (typeof turnRaw === 'object' && turnRaw !== null) {
    for (const [kind, count] of Object.entries(turnRaw as Record<string, unknown>)) {
      if (isFiniteNumber(count) && count >= 0) turnEnds[kind] = count
    }
  }

  return {
    ...typeof v['cwd'] === 'string' ? { cwd: v['cwd'] } : {},
    ...typeof v['agentPreset'] === 'string' ? { agentPreset: v['agentPreset'] } : {},
    ...typeof v['title'] === 'string' && v['title'].length > 0 ? { title: v['title'] } : {},
    createdAt: isFiniteNumber(v['createdAt']) ? v['createdAt'] : 0,
    lastActivity: isFiniteNumber(v['lastActivity']) && v['lastActivity'] >= 0 ? v['lastActivity'] : 0,
    events: isFiniteNumber(v['events']) && v['events'] >= 0 ? v['events'] : 0,
    turns: isFiniteNumber(v['turns']) && v['turns'] >= 0 ? v['turns'] : 0,
    steps: isFiniteNumber(v['steps']) && v['steps'] >= 0 ? v['steps'] : 0,
    calls: isFiniteNumber(v['calls']) && v['calls'] >= 0 ? v['calls'] : 0,
    seedEndSeq: isFiniteNumber(v['seedEndSeq']) ? v['seedEndSeq'] : null,
    resumes: isFiniteNumber(v['resumes']) && v['resumes'] >= 0 ? v['resumes'] : 0,
    totals,
    callDetails,
    detailsTruncated: v['detailsTruncated'] === true,
    compactions,
    routeChanges,
    turnEnds,
    firstEventTime: isFiniteNumber(v['firstEventTime']) ? v['firstEventTime'] : 0,
    lastEventTime: isFiniteNumber(v['lastEventTime']) ? v['lastEventTime'] : 0,
  }
}

/**
 * 读取状态文件；不存在/损坏返回空状态。
 * 只做宽松校验：顶层形状 + 每个会话的关键字段；字段缺失的会话按空统计处理。
 */
export function loadState(file: string): QualityState {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return emptyState()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyState()
  }
  if (typeof parsed !== 'object' || parsed === null) return emptyState()
  const root = parsed as Record<string, unknown>
  const sessionsRaw = root['sessions']
  if (typeof sessionsRaw !== 'object' || sessionsRaw === null) return emptyState()
  const sessions: Record<string, StoredQualitySession> = {}
  for (const [id, value] of Object.entries(sessionsRaw as Record<string, unknown>)) {
    const stored = sanitizeStoredSession(value)
    if (stored !== null) sessions[id] = stored
  }
  return { version: 1, sessions }
}

/** 写状态文件（先写临时文件再原子改名，避免半截文件） */
export function saveState(file: string, state: QualityState): void {
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  renameSync(tmp, file)
}

// ---------- 报告 ----------

/** 分位数（p ∈ [0,1]，线性索引 floor(p×(n-1))）；空数组返回 undefined */
export function percentile(values: readonly number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[idx]
}

/** 中位数 */
export function median(values: readonly number[]): number | undefined {
  return percentile(values, 0.5)
}

/** 最近 N 条调用的平均上下文增量（每调用）；不足 2 条为 null */
export function perCallIncrement(calls: readonly CallRecord[]): number | null {
  const usable = calls.filter(c => !c.noUsage && c.pressure > 0)
  if (usable.length < 2) return null
  const recent = usable.slice(-Math.min(10, usable.length))
  const first = recent[0]
  const last = recent[recent.length - 1]
  const delta = last.pressure - first.pressure
  return delta / Math.max(1, recent.length - 1)
}

export interface QualityReportOptions {
  /** "现在"（窗口计算） */
  now: number
  /** 压缩触发水位余量系数：建议窗口 = 峰值占用 × (1 + headroom)，默认 0.25 */
  headroom?: number
  /** 慢调用 TOP 条数，默认 5 */
  slowCallLimit?: number
}

export interface LatencyStats {
  count: number
  min: number | null
  median: number | null
  p90: number | null
  max: number | null
}

/** 上下文轨迹时间线点：调用 / 压缩 / 路由变更 合并序列 */
export type ContextTracePoint =
  | {
    kind: 'call'
    time: number
    turn: number
    step: number
    /** prompt 侧上下文占用；无用量（失败/中断调用）为 0 */
    pressure: number
    contextWindow: number | null
    /** cacheRead 占 pressure 比例（0~1）；pressure 为 0 时 null */
    cacheRatio: number | null
    ttft: number | null
    duration: number | null
    noUsage: boolean
  }
  | {
    kind: 'compaction'
    time: number
    durationMs: number | null
    manual: boolean
    error?: string
    /** 压缩前最近一次调用占用（压缩后占用见下一点调用） */
    pressureBefore: number | null
  }
  | {
    kind: 'route'
    time: number
    routeLabel: string
    contextWindow: number | null
  }

/**
 * 构建合并时间线（调用/压缩/路由变更按时间排序，取最近 limit 点）。
 * 压缩点用 endTime（或 startTime）定位；调用点含缓存命中率。
 */
export function buildContextTrace(
  calls: readonly CallRecord[],
  compactions: readonly CompactionRecord[],
  routeChanges: readonly RouteChange[],
  limit = 24,
): ContextTracePoint[] {
  const points: ContextTracePoint[] = []
  for (const c of calls) {
    points.push({
      kind: 'call',
      time: c.time,
      turn: c.turn,
      step: c.step,
      pressure: c.pressure,
      contextWindow: c.contextWindow,
      cacheRatio: c.pressure > 0 ? c.usage.cacheReadTokens / c.pressure : null,
      ttft: c.ttft,
      duration: c.duration,
      noUsage: c.noUsage,
    })
  }
  for (const comp of compactions) {
    points.push({
      kind: 'compaction',
      time: comp.endTime ?? comp.startTime,
      durationMs: comp.durationMs,
      manual: comp.manual,
      ...comp.error === undefined ? {} : { error: comp.error },
      pressureBefore: comp.pressureBefore,
    })
  }
  for (const r of routeChanges) {
    points.push({
      kind: 'route',
      time: r.time,
      routeLabel: `${r.provider}/${r.model}`,
      contextWindow: r.contextWindow,
    })
  }
  points.sort((a, b) => a.time - b.time)
  return points.slice(-Math.max(1, Math.min(limit, 200)))
}

export interface SessionQualityReport {
  generatedAt: number
  sessionId: string
  /** 会话标题（无标题事件时省略） */
  title?: string
  cwd?: string
  agentPreset?: string
  createdAt: number
  lastActivity: number
  scale: {
    turns: number
    steps: number
    calls: number
    noUsageCalls: number
    events: number
    firstEventTime: number
    lastEventTime: number
    days: number
    seedEndSeq: number | null
    resumes: number
    detailsTruncated: boolean
  }
  totals: UsageBuckets
  totalTokens: number
  routes: RouteChange[]
  context: {
    peakPressure: number
    /** 峰值占用率（0~1）；无 contextWindow 为 null */
    peakRatio: number | null
    lastPressure: number
    /** 末次占用率；无 contextWindow 为 null */
    lastRatio: number | null
    peakContextWindow: number | null
    /** 压缩触发水位观测：各次压缩前占用率的中位数；无观测为 null */
    compactionWatermark: number | null
    /** 每调用上下文增量（最近样本，tokens）；不足为 null */
    perCallIncrement: number | null
    /** 免压缩剩余调用数估算：(窗口×水位 − 末次占用) ÷ 每调用增量；不可估为 null */
    callsUntilCompaction: number | null
    /** 建议最小 contextWindow（峰值 × (1+headroom)，向上取整到 1K） */
    suggestedWindow: number | null
  }
  cache: {
    cacheReadTokens: number
    promptTokens: number
    /** cacheRead 占 prompt 比例（0~1）；无 prompt 为 null */
    ratio: number | null
    /** 前缀断裂次数：相邻调用 cacheR 占比从 ≥0.5 骤降至 ≤0.2 */
    breaks: number
  }
  latency: {
    ttft: LatencyStats
    stepMs: LatencyStats
    /** 输出速度估计：输出 tokens ÷ 有耗时的调用时长合计（tok/s）；无数据为 null */
    outputPerSec: number | null
  }
  slowCalls: CallRecord[]
  compactions: (CompactionRecord & { pressureAfter: number | null })[]
  /** 合并时间线：最近调用/压缩/路由变更点（默认 24 点） */
  contextTrace: ContextTracePoint[]
  turnEnds: Record<string, number>
}

/**
 * 从状态构建单会话质量报告。
 * 慢调用按 duration 降序；compaction 的 pressureAfter 取 end 后最近一次调用占用。
 */
export function buildSessionReport(sessionId: string, session: StoredQualitySession, opts: QualityReportOptions): SessionQualityReport {
  const headroom = opts.headroom ?? 0.25
  const slowLimit = Math.max(1, Math.floor(opts.slowCallLimit ?? 5))
  const calls = session.callDetails

  // 上下文轨迹（只统计有 usage 的调用）
  const withUsage = calls.filter(c => !c.noUsage && c.pressure > 0)
  let peakPressure = 0
  let peakContextWindow: number | null = null
  let lastPressure = 0
  for (const c of withUsage) {
    if (c.pressure > peakPressure) {
      peakPressure = c.pressure
      peakContextWindow = c.contextWindow
    }
    lastPressure = c.pressure
  }
  const peakRatio = peakContextWindow !== null && peakContextWindow > 0
    ? peakPressure / peakContextWindow
    : null
  const lastRatio = peakContextWindow !== null && peakContextWindow > 0
    ? lastPressure / peakContextWindow
    : null

  // 压缩水位观测：各压缩 start 前最近调用占用率
  const watermarkRatios: number[] = []
  for (const comp of session.compactions) {
    if (comp.pressureBefore === null) continue
    const window = peakContextWindow
    if (window !== null && window > 0) watermarkRatios.push(comp.pressureBefore / window)
  }
  const compactionWatermark = median(watermarkRatios) ?? null

  // 免压缩剩余调用数估算（口径：窗口 × 水位 − 末次占用）÷ 每调用增量
  const inc = perCallIncrement(calls)
  let callsUntilCompaction: number | null = null
  if (peakContextWindow !== null && peakContextWindow > 0 && compactionWatermark !== null && inc !== null && inc > 0) {
    callsUntilCompaction = Math.max(0, Math.floor((peakContextWindow * compactionWatermark - lastPressure) / inc))
  }
  const suggestedWindow = peakPressure > 0 ? Math.ceil((peakPressure * (1 + headroom)) / 1024) * 1024 : null

  // 缓存命中与前缀断裂
  let cacheReadTokens = 0
  let promptTokens = 0
  for (const c of withUsage) {
    cacheReadTokens += c.usage.cacheReadTokens
    promptTokens += c.pressure
  }
  let breaks = 0
  let prevRatio: number | null = null
  for (const c of withUsage) {
    const ratio = c.pressure > 0 ? c.usage.cacheReadTokens / c.pressure : 0
    if (prevRatio !== null && prevRatio >= 0.5 && ratio <= 0.2) breaks += 1
    prevRatio = ratio
  }

  // 延迟统计
  const ttfts = calls.filter(c => c.ttft !== null).map(c => c.ttft as number)
  const durations = calls.filter(c => c.duration !== null).map(c => c.duration as number)
  const ttftStats: LatencyStats = {
    count: ttfts.length,
    min: ttfts.length > 0 ? Math.min(...ttfts) : null,
    median: median(ttfts) ?? null,
    p90: percentile(ttfts, 0.9) ?? null,
    max: ttfts.length > 0 ? Math.max(...ttfts) : null,
  }
  const stepStats: LatencyStats = {
    count: durations.length,
    min: durations.length > 0 ? Math.min(...durations) : null,
    median: median(durations) ?? null,
    p90: percentile(durations, 0.9) ?? null,
    max: durations.length > 0 ? Math.max(...durations) : null,
  }
  let outputTokens = 0
  let durationSum = 0
  for (const c of calls) {
    if (c.noUsage) continue
    outputTokens += c.usage.outputTokens
    if (c.duration !== null) durationSum += c.duration
  }
  const outputPerSec = durationSum > 0 ? outputTokens / (durationSum / 1000) : null

  // 慢调用 TOP
  const slowCalls = [...calls]
    .filter(c => c.duration !== null)
    .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
    .slice(0, slowLimit)

  // 压缩（补 pressureAfter：end 后最近一次调用占用）
  const compactions = session.compactions.map(comp => {
    let after: number | null = null
    for (const c of withUsage) {
      if (comp.endTime !== null && c.time >= comp.endTime) {
        after = c.pressure
        break
      }
    }
    return { ...comp, pressureAfter: after }
  })

  return {
    generatedAt: opts.now,
    sessionId,
    ...session.title === undefined ? {} : { title: session.title },
    ...session.cwd === undefined ? {} : { cwd: session.cwd },
    ...session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset },
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    scale: {
      turns: session.turns,
      steps: session.steps,
      calls: session.calls,
      noUsageCalls: calls.length - session.calls,
      events: session.events,
      firstEventTime: session.firstEventTime,
      lastEventTime: session.lastEventTime,
      days: session.firstEventTime > 0 && session.lastEventTime > 0
        ? daysBetween(session.firstEventTime, session.lastEventTime)
        : 0,
      seedEndSeq: session.seedEndSeq,
      resumes: session.resumes,
      detailsTruncated: session.detailsTruncated,
    },
    totals: session.totals,
    totalTokens: totalTokens(session.totals),
    routes: session.routeChanges,
    context: {
      peakPressure,
      peakRatio,
      lastPressure,
      lastRatio,
      peakContextWindow,
      compactionWatermark,
      perCallIncrement: inc,
      callsUntilCompaction,
      suggestedWindow,
    },
    cache: {
      cacheReadTokens,
      promptTokens,
      ratio: promptTokens > 0 ? cacheReadTokens / promptTokens : null,
      breaks,
    },
    latency: { ttft: ttftStats, stepMs: stepStats, outputPerSec },
    slowCalls,
    compactions,
    contextTrace: buildContextTrace(calls, session.compactions, session.routeChanges, 24),
    turnEnds: session.turnEnds,
  }
}

/** 会话摘要（列表/聚合模式，不携带明细） */
export interface SessionSummaryRow {
  sessionId: string
  /** 会话标题（无标题事件时省略） */
  title?: string
  cwd?: string
  agentPreset?: string
  createdAt: number
  lastActivity: number
  turns: number
  steps: number
  calls: number
  totalTokens: number
  peakPressure: number
  peakContextWindow: number | null
  compactions: number
  turnErrors: number
  routes: string[]
}

/** 会话级摘要（供列表模式） */
export function summarizeSession(id: string, session: StoredQualitySession): SessionSummaryRow {
  const withUsage = session.callDetails.filter(c => !c.noUsage && c.pressure > 0)
  let peakPressure = 0
  let peakContextWindow: number | null = null
  for (const c of withUsage) {
    if (c.pressure > peakPressure) {
      peakPressure = c.pressure
      peakContextWindow = c.contextWindow
    }
  }
  return {
    sessionId: id,
    ...session.title === undefined ? {} : { title: session.title },
    ...session.cwd === undefined ? {} : { cwd: session.cwd },
    ...session.agentPreset === undefined ? {} : { agentPreset: session.agentPreset },
    createdAt: session.createdAt,
    lastActivity: session.lastActivity,
    turns: session.turns,
    steps: session.steps,
    calls: session.calls,
    totalTokens: totalTokens(session.totals),
    peakPressure,
    peakContextWindow,
    compactions: session.compactions.length,
    turnErrors: Object.entries(session.turnEnds)
      .filter(([kind]) => kind !== 'completed')
      .reduce((sum, [, n]) => sum + n, 0),
    routes: Array.from(new Set(session.routeChanges.map(r => `${r.provider}/${r.model}`))),
  }
}

/** 列表报告（按最近活跃排序） */
export interface SessionListReport {
  generatedAt: number
  windowDays: number | null
  sessionCount: number
  trackedSessionCount: number
  rows: SessionSummaryRow[]
}

export interface ListReportOptions {
  days?: number
  cwd?: string
  sessionId?: string
  limit?: number
  now: number
}

/**
 * 从状态构建会话列表报告（聚合摘要，不含明细）。
 * 过滤：sessionId（精确/前缀）、cwd（子串）、days（最近活跃窗口）。
 */
export function buildListReport(state: QualityState, opts: ListReportOptions): SessionListReport {
  const days = opts.days !== undefined && opts.days >= 1 ? Math.min(opts.days, 3650) : null
  const windowFrom = days === null ? null : dayKey(opts.now - (days - 1) * 86_400_000)
  const windowStartMs = windowFrom === null ? -Infinity : new Date(`${windowFrom}T00:00:00`).getTime()
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 10)), 100)
  const idFilter = opts.sessionId?.trim()
  const cwdFilter = opts.cwd?.trim()

  const matches = (id: string, session: StoredQualitySession): boolean => {
    if (idFilter !== undefined && id !== idFilter && !id.startsWith(idFilter)) return false
    if (cwdFilter !== undefined && (session.cwd === undefined || !session.cwd.includes(cwdFilter))) return false
    return true
  }

  const rows: SessionSummaryRow[] = []
  for (const [id, session] of Object.entries(state.sessions)) {
    if (session.lastActivity < windowStartMs) continue
    if (!matches(id, session)) continue
    if (session.calls <= 0 && session.turns <= 0) continue
    rows.push(summarizeSession(id, session))
  }
  rows.sort((a, b) => b.lastActivity - a.lastActivity || b.totalTokens - a.totalTokens)

  return {
    generatedAt: opts.now,
    windowDays: days,
    sessionCount: rows.length,
    trackedSessionCount: Object.keys(state.sessions).length,
    rows: rows.slice(0, limit),
  }
}

// ---------- 渲染（模型可见文本） ----------

const fmtInt = (n: number): string => n.toLocaleString('en-US')

const fmtMs = (ms: number | null): string => {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

const fmtDateTime = (ts: number): string => {
  if (ts <= 0) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 紧凑时间 HH:MM:SS（轨迹行用） */
const fmtTime = (ts: number): string => {
  if (ts <= 0) return '-'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const fmtRatio = (r: number | null): string => r === null ? '-' : `${(r * 100).toFixed(0)}%`

const fmtK = (n: number | null): string => n === null ? '-' : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : String(n)

/** 会话显示标签：有标题时 "标题（id）"，否则仅 id（提升可读性） */
export function sessionLabel(title: string | undefined, id: string): string {
  return title === undefined || title.length === 0 ? id : `${title}（${id}）`
}

/** 渲染单会话质量报告为中文摘要文本 */
export function renderSessionReport(report: SessionQualityReport): string {
  const lines: string[] = []
  const s = report.scale
  lines.push(`【会话质量分析】${sessionLabel(report.title, report.sessionId)}${report.cwd === undefined ? '' : `（${report.cwd}）`}`)
  lines.push(`规模：${s.turns} 轮 / ${s.steps} 步 / ${fmtInt(report.scale.calls)} 次有用量调用`
    + `${s.noUsageCalls > 0 ? `（${fmtInt(s.noUsageCalls)} 次无用量，含失败/中断）` : ''}`
    + ` / ${fmtInt(s.events)} 事件 / 跨度 ${s.days} 天（${fmtDateTime(s.firstEventTime)} → ${fmtDateTime(s.lastEventTime)}）`
    + `${s.seedEndSeq !== null ? ` / 恢复会话（种子 ${s.seedEndSeq}）` : ''}${s.resumes > 0 ? ` / 恢复 ${s.resumes} 次` : ''}`)

  if (report.routes.length > 0) {
    lines.push('模型路由（变更点）：')
    for (const r of report.routes) {
      lines.push(`  ${fmtDateTime(r.time)}  ${r.provider}/${r.model}${r.contextWindow === null ? '' : `（窗口 ${fmtK(r.contextWindow)}）`}`)
    }
  }

  const u = report.totals
  lines.push(`Token：输入 ${fmtInt(u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens)}`
    + `（未缓存 ${fmtInt(u.inputTokens)} · 缓存读 ${fmtInt(u.cacheReadTokens)} · 缓存写 ${fmtInt(u.cacheWriteTokens)}）`
    + ` / 输出 ${fmtInt(u.outputTokens)} / 合计 ${fmtInt(report.totalTokens)}`)

  const c = report.context
  const windowDesc = c.peakContextWindow === null ? '无窗口档位记录' : `窗口 ${fmtK(c.peakContextWindow)}`
  lines.push(`上下文占用：峰值 ${fmtK(c.peakPressure)}（${fmtRatio(c.peakRatio)} · ${windowDesc}）`
    + ` / 末次 ${fmtK(c.lastPressure)}（${fmtRatio(c.lastRatio)}）`
    + `${c.perCallIncrement !== null ? ` / 每调用增量约 ${fmtK(Math.round(c.perCallIncrement))}` : ''}`
    + `${c.compactionWatermark !== null ? ` / 压缩触发水位约 ${fmtRatio(c.compactionWatermark)}` : ''}`
    + `${c.callsUntilCompaction !== null ? ` / 预计免压缩剩余约 ${fmtInt(c.callsUntilCompaction)} 次调用` : ''}`
    + `${c.suggestedWindow !== null ? ` / 建议最小窗口 ${fmtK(c.suggestedWindow)}` : ''}`)

  const cache = report.cache
  lines.push(`缓存：prompt 侧缓存命中 ${fmtRatio(cache.ratio)}（读 ${fmtInt(cache.cacheReadTokens)} / ${fmtInt(cache.promptTokens)}）`
    + `${cache.breaks > 0 ? ` / 前缀断裂 ${cache.breaks} 次（缓存命中骤降）` : ''}`)

  const l = report.latency
  lines.push(`性能：TTFT 中位 ${fmtMs(l.ttft.median)}（P90 ${fmtMs(l.ttft.p90)} / max ${fmtMs(l.ttft.max)} / ${l.ttft.count} 次采样）`
    + ` / 步耗时中位 ${fmtMs(l.stepMs.median)}（P90 ${fmtMs(l.stepMs.p90)} / max ${fmtMs(l.stepMs.max)}）`
    + `${l.outputPerSec !== null ? ` / 输出速率约 ${l.outputPerSec.toFixed(0)} tok/s` : ''}`)

  if (report.slowCalls.length > 0) {
    lines.push('慢调用 TOP：')
    for (const call of report.slowCalls) {
      lines.push(`  turn=${call.turn} step=${call.step}  ${fmtMs(call.duration)}（TTFT ${fmtMs(call.ttft)}）`
        + `  上下文 ${fmtK(call.pressure)}${call.noUsage ? '  无用量' : `  输出 ${fmtInt(call.usage.outputTokens)}`}  ${call.routeLabel}`)
    }
  }

  if (report.compactions.length > 0) {
    lines.push(`压缩：${report.compactions.length} 次`
      + `（自动 ${report.compactions.filter(x => !x.manual).length} / 手动 ${report.compactions.filter(x => x.manual).length}）`)
    for (const comp of report.compactions) {
      lines.push(`  ${fmtDateTime(comp.startTime)}  耗时 ${fmtMs(comp.durationMs)}`
        + `  上下文 ${fmtK(comp.pressureBefore)} → ${fmtK(comp.pressureAfter)}`
        + `${comp.error === undefined ? '' : `  [失败: ${comp.error}]`}`
        + `${comp.manual ? '  [手动]' : '  [自动]'}`)
    }
  }

  if (report.contextTrace.length > 0) {
    lines.push(`上下文轨迹（最近 ${report.contextTrace.length} 点，时间正序）：`)
    for (const point of report.contextTrace) {
      if (point.kind === 'call') {
        const ratio = point.contextWindow !== null && point.contextWindow > 0 && point.pressure > 0
          ? `（${fmtRatio(point.pressure / point.contextWindow)}）`
          : ''
        lines.push(`  ${fmtTime(point.time)}  调用 t${point.turn}s${point.step}  上下文 ${fmtK(point.pressure)}${ratio}`
          + `${point.cacheRatio !== null ? `  缓存 ${fmtRatio(point.cacheRatio)}` : ''}`
          + `${point.ttft !== null ? `  TTFT ${fmtMs(point.ttft)}` : ''}`
          + `${point.duration !== null ? `  总 ${fmtMs(point.duration)}` : ''}`
          + `${point.noUsage ? '  [无用量]' : ''}`)
      } else if (point.kind === 'compaction') {
        lines.push(`  ${fmtTime(point.time)}  压缩（${point.manual ? '手动' : '自动'}）`
          + `  耗时 ${fmtMs(point.durationMs)}`
          + `${point.pressureBefore !== null ? `  压前 ${fmtK(point.pressureBefore)}` : ''}`
          + `${point.error === undefined ? '' : `  [失败: ${point.error}]`}`)
      } else {
        lines.push(`  ${fmtTime(point.time)}  路由 ${point.routeLabel}`
          + `${point.contextWindow === null ? '' : `（窗口 ${fmtK(point.contextWindow)}）`}`)
      }
    }
  }

  const abnormal = Object.entries(report.turnEnds).filter(([kind]) => kind !== 'completed')
  if (abnormal.length > 0) {
    lines.push(`异常轮次：${abnormal.map(([kind, n]) => `${kind} ${n}`).join(' / ')}`)
  } else if (Object.keys(report.turnEnds).length === 0) {
    lines.push('异常轮次：无 turn/end 记录')
  } else {
    lines.push('异常轮次：无（全部 completed）')
  }

  if (s.detailsTruncated) lines.push('（注：调用明细超出上限，仅保留最近部分，聚合统计不受影响）')
  return lines.join('\n')
}

/** 渲染会话列表报告为中文摘要文本 */
export function renderListReport(report: SessionListReport): string {
  const lines: string[] = []
  const windowDesc = report.windowDays === null ? '全部历史' : `最近 ${report.windowDays} 天`
  lines.push(`【会话质量列表】窗口：${windowDesc}，${report.sessionCount}/${report.trackedSessionCount} 个会话（有活动/已跟踪）`)
  if (report.rows.length === 0) {
    lines.push('（无匹配会话）')
    return lines.join('\n')
  }
  for (const row of report.rows) {
    const shortId = row.sessionId.length > 19 ? `${row.sessionId.slice(0, 19)}…` : row.sessionId
    const label = sessionLabel(row.title, shortId)
    const cwd = row.cwd === undefined ? '' : `  ${row.cwd}`
    lines.push(
      `  ${label}${cwd}  ${row.turns} 轮/${row.steps} 步/${fmtInt(row.calls)} 调用`
      + `  合计 ${fmtInt(row.totalTokens)} tokens`
      + `  峰值上下文 ${fmtK(row.peakPressure)}${row.peakContextWindow === null ? '' : `/${fmtK(row.peakContextWindow)}`}`
      + `${row.compactions > 0 ? `  压缩 ${row.compactions} 次` : ''}`
      + `${row.turnErrors > 0 ? `  异常轮 ${row.turnErrors}` : ''}`
      + `  路由 ${row.routes.join(', ')}`
      + `  最近 ${fmtDateTime(row.lastActivity)}`,
    )
  }
  return lines.join('\n')
}
