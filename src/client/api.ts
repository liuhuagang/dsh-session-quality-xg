/**
 * dsh-session-quality-xg 客户端 API 层：/session-quality/api/list|report 的类型与取数。
 * 形状与宿主端 logic.SessionListReport / SessionQualityReport 保持一致（JSON 边界）。
 */

export interface UsageBuckets {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface SessionSummaryRow {
  sessionId: string
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

export interface SessionListReport {
  generatedAt: number
  windowDays: number | null
  sessionCount: number
  trackedSessionCount: number
  rows: SessionSummaryRow[]
}

export interface CallRecord {
  turn: number
  step: number
  time: number
  ttft: number | null
  duration: number | null
  pressure: number
  contextWindow: number | null
  noUsage: boolean
  usage: UsageBuckets
  routeLabel: string
}

export interface CompactionRecord {
  id: string
  startTime: number
  endTime: number | null
  durationMs: number | null
  error?: string
  manual: boolean
  pressureBefore: number | null
  pressureAfter: number | null
}

export interface RouteChange {
  time: number
  provider: string
  model: string
  contextWindow: number | null
}

export type TracePoint =
  | {
    kind: 'call'
    time: number
    turn: number
    step: number
    pressure: number
    contextWindow: number | null
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
    pressureBefore: number | null
  }
  | {
    kind: 'route'
    time: number
    routeLabel: string
    contextWindow: number | null
  }

export interface SessionQualityReport {
  generatedAt: number
  sessionId: string
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
    peakRatio: number | null
    lastPressure: number
    lastRatio: number | null
    peakContextWindow: number | null
    compactionWatermark: number | null
    perCallIncrement: number | null
    callsUntilCompaction: number | null
    suggestedWindow: number | null
  }
  cache: {
    cacheReadTokens: number
    promptTokens: number
    ratio: number | null
    breaks: number
  }
  latency: {
    ttft: { count: number; min: number | null; median: number | null; p90: number | null; max: number | null }
    stepMs: { count: number; min: number | null; median: number | null; p90: number | null; max: number | null }
    outputPerSec: number | null
  }
  slowCalls: CallRecord[]
  compactions: CompactionRecord[]
  contextTrace: TracePoint[]
  turnEnds: Record<string, number>
}

export function fetchList(days: number | null, cwd: string, limit: number): Promise<SessionListReport> {
  const params = new URLSearchParams()
  if (days !== null && days > 0) params.set('days', String(days))
  if (cwd.trim().length > 0) params.set('cwd', cwd.trim())
  params.set('limit', String(limit))
  return fetch(`/session-quality/api/list?${params.toString()}`, { headers: { accept: 'application/json' } })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<SessionListReport>
    })
}

export function fetchReport(sessionId: string): Promise<SessionQualityReport> {
  return fetch(`/session-quality/api/report?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<SessionQualityReport>
    })
}
