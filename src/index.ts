/**
 * dsh-session-quality-xg：跨会话质量分析插件。
 *
 * 数据源：会话日志（durable log）事件流 —— 与 dsh-token-stats 同构：
 *   - session/created：会话公告时批量重放整段内存日志（含恢复会话的全部
 *     历史），折叠结果整体替换状态中该会话的条目（日志是 source of truth）
 *   - session/event：实时增量折叠（seq 守卫去重，批量重放与增量天然幂等）
 *
 * 质量维度（每会话）：
 *   - 规模：轮次 / 步骤 / 模型调用 / 事件数 / 时间跨度 / 恢复标记
 *   - 上下文占用轨迹：每次调用的 prompt 侧占用（input+cacheR+cacheW，
 *     token-meter 口径）、contextWindow 档位、峰值与峰值占用率、每调用增量、
 *     压缩触发水位观测、预计免压缩剩余调用数、建议最小窗口
 *   - 性能：TTFT（step/start → 首个 token-delta）、步总耗时、输出速率、慢调用 TOP
 *   - 缓存质量：prompt 侧 cacheRead 占比、前缀断裂次数
 *   - 压缩：compaction/start..end 对（耗时/失败/手动自动/压缩前后占用）
 *   - 模型路由变更序列（request/context）与恢复次数
 *   - 异常轮次：turn/end reason.kind 分布（error/aborted/blocked/max-tokens/…）
 *
 * 持久化：<dir>/session-quality.json（默认 ~/.dsh/session-quality/），防抖写盘，
 * 进程重启后恢复累计值；会话再次激活时由批量折叠刷新其条目。
 *
 * 查询面：
 *   - 模型工具 session_quality —— 不指定 sessionId：列表模式（按 cwd/days/
 *     limit 过滤，返回每会话聚合摘要，可先按项目定位会话再逐个深挖）；
 *     指定 sessionId：单会话详情报告（规模/上下文/缓存/TTFT/压缩/异常/
 *     慢调用/上下文轨迹时间线）
 *   - REST API /session-quality/api/list|report（Web 看板数据源）
 *
 * tools / webServer 服务声明为 inject 硬依赖：composition 树并行激活所有
 * 条目，不等待的话 apply 执行时服务可能尚未就绪（注册静默丢失）。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: 引入 webServer 服务的模块增强（ctx.webServer 类型）。
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  buildListReport,
  buildSessionReport,
  createQualityFold,
  foldQualityEvent,
  foldToStored,
  loadState,
  renderListReport,
  renderSessionReport,
  replayEvents,
  saveState,
  stateFilePath,
  type QualityState,
  type SessionListReport,
  type SessionQualityReport,
} from './logic.js'

export const name = 'dsh-session-quality-xg'

/** 硬依赖：tools / webServer 服务就绪后 fiber 才执行 apply（DSH composition 保证提供） */
export const inject = ['tools', 'webServer']

const API_PREFIX = '/session-quality/api'

// ---------- session_quality 工具输出 schema（与 logic 报告形状一致） ----------

const usageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    inputTokens: { type: 'integer' },
    outputTokens: { type: 'integer' },
    cacheReadTokens: { type: 'integer' },
    cacheWriteTokens: { type: 'integer' },
    reasoningTokens: { type: 'integer' },
  },
} as const

const routeChangeSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    time: { type: 'integer' },
    provider: { type: 'string' },
    model: { type: 'string' },
    contextWindow: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  },
} as const

const callRecordSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turn: { type: 'integer' },
    step: { type: 'integer' },
    time: { type: 'integer' },
    ttft: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    duration: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    pressure: { type: 'integer' },
    contextWindow: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    noUsage: { type: 'boolean' },
    usage: usageSchema,
    routeLabel: { type: 'string' },
  },
} as const

const compactionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    startTime: { type: 'integer' },
    endTime: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    durationMs: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    error: { type: 'string' },
    manual: { type: 'boolean' },
    pressureBefore: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    pressureAfter: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  },
} as const

/** 上下文轨迹时间线点（调用/压缩/路由合并；字段按 kind 各取所需） */
const tracePointSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['call', 'compaction', 'route'] },
    time: { type: 'integer' },
    turn: { type: 'integer' },
    step: { type: 'integer' },
    pressure: { type: 'integer' },
    contextWindow: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    cacheRatio: { oneOf: [{ type: 'number' }, { type: 'null' }] },
    ttft: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    duration: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    noUsage: { type: 'boolean' },
    durationMs: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    manual: { type: 'boolean' },
    error: { type: 'string' },
    pressureBefore: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    routeLabel: { type: 'string' },
  },
} as const

const latencySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'integer' },
    min: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    median: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    p90: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    max: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
  },
} as const

const sessionReportSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'integer' },
    sessionId: { type: 'string' },
    cwd: { type: 'string' },
    agentPreset: { type: 'string' },
    createdAt: { type: 'integer' },
    lastActivity: { type: 'integer' },
    scale: {
      type: 'object',
      additionalProperties: false,
      properties: {
        turns: { type: 'integer' },
        steps: { type: 'integer' },
        calls: { type: 'integer' },
        noUsageCalls: { type: 'integer' },
        events: { type: 'integer' },
        firstEventTime: { type: 'integer' },
        lastEventTime: { type: 'integer' },
        days: { type: 'integer' },
        seedEndSeq: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        resumes: { type: 'integer' },
        detailsTruncated: { type: 'boolean' },
      },
    },
    totals: usageSchema,
    totalTokens: { type: 'integer' },
    routes: { type: 'array', items: routeChangeSchema },
    context: {
      type: 'object',
      additionalProperties: false,
      properties: {
        peakPressure: { type: 'integer' },
        peakRatio: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        lastPressure: { type: 'integer' },
        lastRatio: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        peakContextWindow: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        compactionWatermark: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        perCallIncrement: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        callsUntilCompaction: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
        suggestedWindow: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      },
    },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cacheReadTokens: { type: 'integer' },
        promptTokens: { type: 'integer' },
        ratio: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        breaks: { type: 'integer' },
      },
    },
    latency: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ttft: latencySchema,
        stepMs: latencySchema,
        outputPerSec: { oneOf: [{ type: 'number' }, { type: 'null' }] },
      },
    },
    slowCalls: { type: 'array', items: callRecordSchema },
    compactions: { type: 'array', items: compactionSchema },
    contextTrace: { type: 'array', items: tracePointSchema },
    turnEnds: {
      type: 'object',
      additionalProperties: false,
      properties: {
        completed: { type: 'integer' },
        aborted: { type: 'integer' },
        blocked: { type: 'integer' },
        error: { type: 'integer' },
        'max-tokens': { type: 'integer' },
        interrupted: { type: 'integer' },
        unknown: { type: 'integer' },
      },
    },
  },
} as const

const summaryRowSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sessionId: { type: 'string' },
    cwd: { type: 'string' },
    agentPreset: { type: 'string' },
    createdAt: { type: 'integer' },
    lastActivity: { type: 'integer' },
    turns: { type: 'integer' },
    steps: { type: 'integer' },
    calls: { type: 'integer' },
    totalTokens: { type: 'integer' },
    peakPressure: { type: 'integer' },
    peakContextWindow: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    compactions: { type: 'integer' },
    turnErrors: { type: 'integer' },
    routes: { type: 'array', items: { type: 'string' } },
  },
} as const

const listReportSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'integer' },
    windowDays: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    sessionCount: { type: 'integer' },
    trackedSessionCount: { type: 'integer' },
    rows: { type: 'array', items: summaryRowSchema },
  },
} as const

/** 插件配置（cordis.patch.yml 中 config 字段） */
export interface Config {
  /** 总开关；false 时不监听、不注册工具，默认 true */
  enabled?: boolean
  /** 状态目录，默认 ~/.dsh/session-quality（状态文件 session-quality.json） */
  dir?: string
  /** 每次模型调用输出一条终端监控行，默认 true */
  logCalls?: boolean
  /** 状态写盘防抖（毫秒），默认 2000 */
  flushMs?: number
  /** 每会话调用明细条数上限，超出裁剪最旧，默认 2000 */
  detailLimit?: number
  /** 压缩水位余量系数：建议窗口 = 峰值占用 × (1 + headroom)，默认 0.25 */
  headroom?: number
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return

  const dir = config.dir ?? join(homedir(), '.dsh', 'session-quality')
  const stateFile = stateFilePath(dir)
  const flushMs = config.flushMs ?? 2000
  const logCalls = config.logCalls !== false
  const detailLimit = config.detailLimit ?? 2000
  const headroom = config.headroom ?? 0.25

  const state: QualityState = loadState(stateFile)
  const folds = new Map<string, ReturnType<typeof createQualityFold>>()

  // ---------- 状态写盘（防抖 + 卸载兜底） ----------

  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let dirty = false
  function flushNow(): void {
    if (!dirty) return
    dirty = false
    try {
      saveState(stateFile, state)
    } catch (error) {
      dirty = true // 写失败保持脏标记，交给下一轮防抖重试
      console.warn(`[session-quality] state save failed: ${String(error)}`)
    }
  }
  function scheduleFlush(): void {
    dirty = true
    if (flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      flushNow()
    }, flushMs)
    ;(flushTimer as { unref?: () => void }).unref?.()
  }

  ctx.effect(() => {
    return () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
      flushNow()
    }
  }, 'session-quality:state')

  // ---------- Web 看板 API（webServer 为 inject 硬依赖，apply 时必然就绪） ----------

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      connection: 'close',
    })
    res.end(JSON.stringify(body))
  }

  /** 正整数查询参数；缺失/非法返回 undefined，超出 [min,max] 截断到边界 */
  function intParam(value: string | null, min: number, max: number): number | undefined {
    if (value === null) return undefined
    const n = Number(value)
    if (!Number.isInteger(n)) return undefined
    return Math.max(min, Math.min(max, n))
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === `${API_PREFIX}/list`) {
          const days = intParam(url.searchParams.get('days'), 1, 3650)
          const limit = intParam(url.searchParams.get('limit'), 1, 100)
          json(res, 200, buildListReport(state, {
            days,
            cwd: url.searchParams.get('cwd') ?? undefined,
            limit,
            now: Date.now(),
          }))
          return
        }
        if (url.pathname === `${API_PREFIX}/report`) {
          const id = url.searchParams.get('sessionId')?.trim()
          if (id === undefined || id.length === 0) {
            json(res, 400, { error: 'sessionId query parameter is required' })
            return
          }
          const candidates = Object.entries(state.sessions)
            .filter(([sid]) => sid === id || sid.startsWith(id))
          if (candidates.length === 0) {
            json(res, 404, { error: `no tracked session matches "${id}"` })
            return
          }
          candidates.sort((a, b) => b[1].lastActivity - a[1].lastActivity)
          const [sid, session] = candidates[0]!
          json(res, 200, buildSessionReport(sid, session, { now: Date.now(), headroom, slowCallLimit: 5 }))
          return
        }
        json(res, 404, { error: 'not found' })
      } catch (error) {
        json(res, 500, { error: String(error) })
      }
    },
  }), 'session-quality:api')

  // ---------- 折叠管线 ----------

  const metaOf = (session: Session) => ({
    cwd: session.header.cwd,
    agentPreset: session.header.agentPreset,
    createdAt: session.header.createdAt,
  })

  function foldFor(id: string, session: Session) {
    let fold = folds.get(id)
    if (fold === undefined) {
      fold = createQualityFold(metaOf(session), { detailLimit })
      folds.set(id, fold)
    }
    return fold
  }

  /** 一次调用完成 → 状态镜像 + 终端监控行 */
  function publishFold(id: string, fold: ReturnType<typeof createQualityFold>): void {
    state.sessions[id] = foldToStored(fold)
  }

  // ---------- 监听器 ----------

  /**
   * 会话公告：批量重放整段内存日志（恢复会话携带全部历史），折叠结果整体
   * 替换状态条目。监听器异常不得 veto 发布，整体兜底。
   */
  ctx.on('session/created', (session: Session) => {
    try {
      const id = String(session.id)
      const fold = createQualityFold(metaOf(session), { detailLimit })
      folds.set(id, fold)
      replayEvents(fold, session.events, { detailLimit })
      publishFold(id, fold)
      const s = fold.stored
      console.log(
        `[session-quality] session ${id} ready: ${s.turns} turns, ${s.steps} steps, ${s.calls} calls`
        + `${s.compactions.length > 0 ? `, ${s.compactions.length} compactions` : ''}`
        + `${s.resumes > 0 ? `, ${s.resumes} resumes` : ''}`,
      )
      if (s.events > 0) scheduleFlush()
    } catch (error) {
      console.warn(`[session-quality] session/created fold failed: ${String(error)}`)
    }
  })

  /** 实时事件流：增量折叠所有会话的日志追加（seq 守卫去重）。 */
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    try {
      const id = String(session.id)
      const fold = foldFor(id, session)
      const before = fold.stored.calls
      foldQualityEvent(fold, event)
      publishFold(id, fold)
      if (logCalls && fold.stored.calls > before) {
        const last = fold.stored.callDetails[fold.stored.callDetails.length - 1]
        console.log(
          `[session-quality] call session=${id} turn=${last.turn} step=${last.step}`
          + ` ctx=${last.pressure} window=${last.contextWindow ?? '-'}`
          + ` ttft=${last.ttft ?? '-'}ms dur=${last.duration ?? '-'}ms`
          + ` out=${last.usage.outputTokens} [${last.routeLabel}]`,
        )
      }
      scheduleFlush()
    } catch (error) {
      console.warn(`[session-quality] session/event listener failed: ${String(error)}`)
    }
  })

  // ---------- 查询工具（tools 为 inject 硬依赖，apply 时必然就绪） ----------

  ctx.tools.register(defineTool({
    name: 'session_quality',
    description: '分析会话质量（规模/上下文占用轨迹/缓存命中/首字延迟/压缩事件/模型切换/异常轮次）。不指定 sessionId 时返回会话列表摘要（可按项目 cwd 过滤定位）；指定后返回单会话完整质量报告与档位适配数据。当用户询问会话质量、上下文使用情况、压缩、TTFT、慢调用、上下文档位选择时使用。',
    parameters: {
      sessionId: { type: 'string', description: '目标会话 id（精确或前缀匹配）；省略 = 列表模式' },
      cwd: { type: 'string', description: '工作目录子串过滤（列表模式按项目定位会话）' },
      days: { type: 'integer', description: '只统计最近 N 个自然日活跃的会话（含今天）；省略 = 全部历史' },
      limit: { type: 'integer', description: '列表模式行数上限，默认 10，最大 100' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['detail', 'list'] },
          detail: sessionReportSchema,
          list: listReportSchema,
        },
      },
      render: (_args, value) => {
        const v = value as { mode: 'detail' | 'list'; detail?: SessionQualityReport | null; list?: SessionListReport | null }
        const text = v.mode === 'detail' && v.detail !== undefined && v.detail !== null
          ? renderSessionReport(v.detail)
          : renderListReport(v.list ?? { generatedAt: 0, windowDays: null, sessionCount: 0, trackedSessionCount: 0, rows: [] })
        return [{ type: 'text' as const, text }]
      },
    },
    isConcurrencySafe: () => true,
    execute(args) {
      const now = Date.now()
      const idFilter = args.sessionId?.trim()
      if (idFilter !== undefined && idFilter.length > 0) {
        // 详情模式：精确或前缀匹配，匹配多个时取最近活跃者
        const candidates = Object.entries(state.sessions)
          .filter(([id]) => id === idFilter || id.startsWith(idFilter))
        if (candidates.length === 0) {
          return Promise.resolve({
            mode: 'list' as const,
            list: buildListReport(state, { days: args.days, now, limit: args.limit ?? 10 }),
          })
        }
        candidates.sort((a, b) => b[1].lastActivity - a[1].lastActivity)
        const [sid, session] = candidates[0]!
        const report = buildSessionReport(sid, session, { now, headroom, slowCallLimit: 5 })
        return Promise.resolve({ mode: 'detail' as const, detail: report })
      }
      return Promise.resolve({
        mode: 'list' as const,
        list: buildListReport(state, { days: args.days, cwd: args.cwd, limit: args.limit, now }),
      })
    },
    presentCall: args => ({ card: 'generic', title: '分析会话质量', kind: 'other', rawInput: args }),
  }))

  console.log(
    `[session-quality] started: dir=${dir} trackedSessions=${Object.keys(state.sessions).length}`
    + ` logCalls=${logCalls} flushMs=${flushMs} detailLimit=${detailLimit}`,
  )
}
