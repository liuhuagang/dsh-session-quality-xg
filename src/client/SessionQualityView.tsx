/**
 * dsh-session-quality-xg 看板视图（conversation.view 的 "会话质量" 页签）。
 *
 * 布局：标题行（窗口切换 + cwd 过滤）→ 会话列表（点击进入详情）→ 详情视图：
 * 指标卡片行、上下文轨迹时间线（调用柱 + 压缩/路由标记）、压缩明细、
 * 慢调用 TOP、路由变更。颜色全部走 DSH 主题 token（见 index.ts 的 STYLES）。
 *
 * 数据：挂载期间每 5s 轮询宿主 REST API；页签切走即卸载停止轮询。
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import {
  fetchList,
  fetchReport,
  type CompactionRecord,
  type SessionListReport,
  type SessionQualityReport,
  type TracePoint,
} from './api.ts'

const POLL_MS = 5_000

// ---------- 格式化 ----------

function fmtK(n: number | null): string {
  if (n === null) return '-'
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`
  return String(n)
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function fmtRatio(r: number | null): string {
  return r === null ? '-' : `${(r * 100).toFixed(0)}%`
}

function fmtClock(t: number): string {
  const d = new Date(t)
  const p = (x: number) => `${x}`.padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDateTime(t: number): string {
  const d = new Date(t)
  const p = (x: number) => `${x}`.padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function shortSession(id: string): string {
  return id.length > 15 ? `${id.slice(0, 15)}…` : id
}

/** 会话标签：有标题显示 "标题 · 短id"，否则仅短 id */
function sessionCell(title: string | undefined, sessionId: string): ReactElement {
  if (title === undefined || title.length === 0) return <>{shortSession(sessionId)}</>
  return (
    <>
      {title}
      <span className="sqs-muted"> · {shortSession(sessionId)}</span>
    </>
  )
}

// ---------- 通用小组件 ----------

function Card({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }): ReactElement {
  return (
    <div className="sqs-card">
      <div className="sqs-card-label">{label}</div>
      <div className={warn === true ? 'sqs-card-value sqs-warn' : 'sqs-card-value'}>{value}</div>
      {sub !== undefined ? <div className="sqs-card-sub">{sub}</div> : null}
    </div>
  )
}

// ---------- 上下文轨迹图 ----------

interface TraceBar {
  key: string
  time: number
  kind: 'call' | 'compaction' | 'route'
  height: number
  label: string
  detail: string
  failed?: boolean
}

function buildTraceBars(trace: TracePoint[]): TraceBar[] {
  const calls = trace.filter(p => p.kind === 'call') as Array<Extract<TracePoint, { kind: 'call' }>>
  const maxPressure = calls.reduce((m, c) => Math.max(m, c.pressure), 1)
  return trace.map((p, i) => {
    if (p.kind === 'call') {
      const ratio = p.contextWindow !== null && p.contextWindow > 0 && p.pressure > 0
        ? ` ${((p.pressure / p.contextWindow) * 100).toFixed(0)}%`
        : ''
      return {
        key: `c-${i}`,
        time: p.time,
        kind: 'call' as const,
        height: Math.max(2, (p.pressure / maxPressure) * 100),
        label: `t${p.turn}s${p.step}`,
        detail: `${fmtClock(p.time)}  调用 t${p.turn}s${p.step}\n`
          + `上下文 ${fmtK(p.pressure)}${ratio}\n`
          + `缓存 ${fmtRatio(p.cacheRatio)}  TTFT ${fmtMs(p.ttft)}  总 ${fmtMs(p.duration)}`,
      }
    }
    if (p.kind === 'compaction') {
      return {
        key: `p-${i}`,
        time: p.time,
        kind: 'compaction' as const,
        height: 100,
        label: '压',
        failed: p.error !== undefined,
        detail: `${fmtClock(p.time)}  压缩（${p.manual ? '手动' : '自动'}）  耗时 ${fmtMs(p.durationMs)}\n`
          + `压前 ${fmtK(p.pressureBefore)}${p.error === undefined ? '' : `\n[失败] ${p.error}`}`,
      }
    }
    return {
      key: `r-${i}`,
      time: p.time,
      kind: 'route' as const,
      height: 0,
      label: 'R',
      detail: `${fmtClock(p.time)}  路由 ${p.routeLabel}${p.contextWindow === null ? '' : `（窗口 ${fmtK(p.contextWindow)}）`}`,
    }
  })
}

function TraceChart({ trace }: { trace: TracePoint[] }): ReactElement {
  const bars = useMemo(() => buildTraceBars(trace), [trace])
  if (bars.length === 0) return <div className="sqs-empty">（无轨迹数据）</div>
  return (
    <div className="sqs-trace">
      {bars.map(bar => (
        <div
          key={bar.key}
          className={`sqs-trace-col ${bar.kind === 'route' ? 'sqs-trace-route' : ''}`}
          title={bar.detail}
        >
          <div className="sqs-trace-wrap">
            {bar.kind === 'call' ? (
              <div className="sqs-trace-bar" style={{ height: `${bar.height}%` }} />
            ) : null}
            {bar.kind === 'compaction' ? (
              <div className={`sqs-trace-marker${bar.failed === true ? ' sqs-trace-failed' : ''}`}>↧</div>
            ) : null}
          </div>
          <div className="sqs-trace-label">{bar.label}</div>
        </div>
      ))}
    </div>
  )
}

// ---------- 详情视图 ----------

function DetailView({ report, onBack }: { report: SessionQualityReport; onBack: () => void }): ReactElement {
  const c = report.context
  const cache = report.cache
  const l = report.latency
  const failedCompactions = report.compactions.filter(x => x.error !== undefined).length
  const abnormal = Object.entries(report.turnEnds).filter(([kind]) => kind !== 'completed')
  return (
    <div className="sqs-detail">
      <div className="sqs-detail-head">
        <button className="sqs-back" onClick={onBack}>← 返回列表</button>
        <div className="sqs-title">{report.title ?? shortSession(report.sessionId)}</div>
        <div className="sqs-sub">
          {report.title !== undefined ? `${shortSession(report.sessionId)} · ` : ''}
          {report.cwd ?? ''} · {report.scale.turns} 轮 / {report.scale.steps} 步 /
          {fmtInt(report.scale.calls)} 调用 · {fmtDateTime(report.scale.firstEventTime)} → {fmtDateTime(report.scale.lastEventTime)}
          {report.scale.resumes > 0 ? ` · 恢复 ${report.scale.resumes}` : ''}
        </div>
      </div>

      <div className="sqs-cards">
        <Card label="峰值上下文" value={fmtK(c.peakPressure)} sub={`占用率 ${fmtRatio(c.peakRatio)} · 窗口 ${fmtK(c.peakContextWindow)}`} />
        <Card label="缓存命中" value={fmtRatio(cache.ratio)} sub={cache.breaks > 0 ? `前缀断裂 ${cache.breaks} 次` : '前缀稳定'} warn={cache.breaks > 0} />
        <Card label="TTFT 中位" value={fmtMs(l.ttft.median)} sub={`P90 ${fmtMs(l.ttft.p90)} · max ${fmtMs(l.ttft.max)}`} />
        <Card label="输出速率" value={l.outputPerSec === null ? '-' : `${l.outputPerSec.toFixed(0)} tok/s`} sub={`步耗时中位 ${fmtMs(l.stepMs.median)}`} />
        <Card
          label="压缩"
          value={`${report.compactions.length} 次`}
          sub={failedCompactions > 0 ? `失败 ${failedCompactions} 次` : '全部成功'}
          warn={failedCompactions > 0}
        />
        <Card
          label="建议最小窗口"
          value={fmtK(c.suggestedWindow)}
          sub={c.compactionWatermark !== null ? `压缩水位 ${fmtRatio(c.compactionWatermark)}` : undefined}
        />
        <Card
          label="免压缩剩余"
          value={c.callsUntilCompaction === null ? '-' : `${fmtInt(c.callsUntilCompaction)} 次`}
          sub={c.perCallIncrement !== null ? `每调用增量 ${fmtK(Math.round(c.perCallIncrement))}` : undefined}
        />
        <Card
          label="异常轮次"
          value={abnormal.length === 0 ? '无' : `${abnormal.length} 种`}
          sub={abnormal.map(([kind, n]) => `${kind} ${n}`).join(' / ')}
          warn={abnormal.length > 0}
        />
      </div>

      <div className="sqs-panel">
        <div className="sqs-panel-title">上下文轨迹（最近 {report.contextTrace.length} 点，时间正序）<span className="sqs-muted">柱=调用占用 · ↧=压缩（红=失败） · R=路由切换</span></div>
        <TraceChart trace={report.contextTrace} />
      </div>

      {report.compactions.length > 0 ? (
        <div className="sqs-panel">
          <div className="sqs-panel-title">压缩明细</div>
          <table className="sqs-table">
            <thead>
              <tr><th>时间</th><th>类型</th><th>耗时</th><th>压前 → 压后</th><th>结果</th></tr>
            </thead>
            <tbody>
              {report.compactions.map(comp => (
                <tr key={`${comp.id}-${comp.startTime}`}>
                  <td>{fmtDateTime(comp.startTime)}</td>
                  <td>{comp.manual ? '手动' : '自动'}</td>
                  <td>{fmtMs(comp.durationMs)}</td>
                  <td>{fmtK(comp.pressureBefore)} → {fmtK(comp.pressureAfter)}</td>
                  <td className={comp.error === undefined ? '' : 'sqs-warn'}>
                    {comp.error === undefined ? '成功' : `失败：${comp.error}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {report.slowCalls.length > 0 ? (
        <div className="sqs-panel">
          <div className="sqs-panel-title">慢调用 TOP</div>
          <table className="sqs-table">
            <thead>
              <tr><th>调用</th><th>总耗时</th><th>TTFT</th><th>上下文</th><th>输出</th></tr>
            </thead>
            <tbody>
              {report.slowCalls.map(call => (
                <tr key={`${call.turn}-${call.step}-${call.time}`}>
                  <td>t{call.turn}s{call.step}</td>
                  <td>{fmtMs(call.duration)}</td>
                  <td>{fmtMs(call.ttft)}</td>
                  <td>{fmtK(call.pressure)}</td>
                  <td>{call.noUsage ? '无用量' : fmtInt(call.usage.outputTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {report.routes.length > 0 ? (
        <div className="sqs-panel">
          <div className="sqs-panel-title">模型路由变更</div>
          <table className="sqs-table">
            <thead>
              <tr><th>时间</th><th>路由</th><th>窗口</th></tr>
            </thead>
            <tbody>
              {report.routes.map((r, i) => (
                <tr key={`${r.time}-${i}`}>
                  <td>{fmtDateTime(r.time)}</td>
                  <td>{r.provider}/{r.model}</td>
                  <td>{fmtK(r.contextWindow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}

// ---------- 列表视图 ----------

function ListView({
  list,
  onSelect,
  error,
}: {
  list: SessionListReport | null
  onSelect: (id: string) => void
  error: string | null
}): ReactElement {
  if (error !== null) return <div className="sqs-error">加载失败：{error}</div>
  if (list === null) return <div className="sqs-empty">加载中…</div>
  if (list.rows.length === 0) return <div className="sqs-empty">（无匹配会话）</div>
  return (
    <table className="sqs-table sqs-list">
      <thead>
        <tr>
          <th>会话</th><th>项目</th><th>规模</th><th>合计 tokens</th>
          <th>峰值上下文</th><th>压缩</th><th>异常</th><th>路由</th><th>最近活跃</th>
        </tr>
      </thead>
      <tbody>
        {list.rows.map(row => (
          <tr key={row.sessionId} className="sqs-row" onClick={() => onSelect(row.sessionId)}>
            <td className="sqs-ellipsis" title={row.title !== undefined ? `${row.title}（${row.sessionId}）` : row.sessionId}>
              {sessionCell(row.title, row.sessionId)}
            </td>
            <td className="sqs-ellipsis" title={row.cwd ?? ''}>{row.cwd ?? '-'}</td>
            <td>{row.turns} 轮/{row.steps} 步/{fmtInt(row.calls)}</td>
            <td>{fmtInt(row.totalTokens)}</td>
            <td>{fmtK(row.peakPressure)}<span className="sqs-muted">{row.peakContextWindow === null ? '' : `/${fmtK(row.peakContextWindow)}`}</span></td>
            <td>{row.compactions > 0 ? `${row.compactions} 次` : '-'}</td>
            <td className={row.turnErrors > 0 ? 'sqs-warn' : ''}>{row.turnErrors > 0 ? row.turnErrors : '-'}</td>
            <td className="sqs-ellipsis" title={row.routes.join(', ')}>{row.routes.slice(0, 2).join(', ')}</td>
            <td>{fmtDateTime(row.lastActivity)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ---------- 主视图 ----------

export function SessionQualityView(): ReactElement {
  const [days, setDays] = useState<number | null>(7)
  const [cwd, setCwd] = useState('')
  const [list, setList] = useState<SessionListReport | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<SessionQualityReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    const load = async () => {
      try {
        const body = await fetchList(days, cwd, 50)
        if (!disposed) {
          setList(body)
          setError(null)
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    const timer = window.setInterval(load, POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [days, cwd])

  useEffect(() => {
    if (selected === null) return
    let disposed = false
    const load = async () => {
      try {
        const body = await fetchReport(selected)
        if (!disposed) setDetail(body)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e))
      }
    }
    load()
    const timer = window.setInterval(load, POLL_MS)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [selected])

  const select = (id: string): void => {
    setSelected(id)
    setDetail(null)
  }

  const WINDOWS: Array<{ value: number | null; label: string }> = [
    { value: 1, label: '今日' },
    { value: 3, label: '3 日' },
    { value: 7, label: '7 日' },
    { value: null, label: '全部' },
  ]

  return (
    <div className="sqs-root">
      <div className="sqs-header">
        <div>
          <div className="sqs-title">会话质量</div>
          <div className="sqs-sub">规模 / 上下文占用 / 缓存 / TTFT / 压缩 / 异常（{POLL_MS / 1000}s 自动刷新）</div>
        </div>
        <div className="sqs-tools">
          <div className="sqs-window">
            {WINDOWS.map(w => (
              <button
                key={w.label}
                className={days === w.value ? 'active' : ''}
                onClick={() => setDays(w.value)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <input
            className="sqs-cwd"
            placeholder="项目目录过滤…"
            value={cwd}
            onChange={e => setCwd(e.target.value)}
          />
        </div>
      </div>

      {selected === null ? (
        <ListView list={list} onSelect={select} error={error} />
      ) : detail === null ? (
        <div className="sqs-empty">加载会话详情…</div>
      ) : (
        <DetailView report={detail} onBack={() => setSelected(null)} />
      )}
    </div>
  )
}
