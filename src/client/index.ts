/**
 * dsh-session-quality-xg 客户端入口：安装看板样式，并在 conversation.view 列表槽注册
 * "会话质量"页签（id 'session-quality'，order 21，排在 chat/trajectory/token-stats 之后）。
 *
 * 数据来自宿主 REST API（/session-quality/api/list|report），组件挂载期间 5s 轮询，
 * 页签切走即卸载（列表槽 only: 单显渲染），轮询随之停止。
 *
 * 布局：会话列表（窗口/项目过滤）→ 会话详情（指标卡片 + 上下文轨迹时间线 +
 * 压缩明细 + 慢调用 TOP + 路由变更）。颜色全部走 DSH 主题 token，浅色/深色自适应。
 */

import { SessionQualityView } from './SessionQualityView.tsx'

/** 结构性 slots 服务面（与运行时 SlotRegistry 一致；仅取本插件用到的方法） */
type SlotsService = {
  inject(key: string, callback: () => void | (() => void)): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** 结构性客户端根上下文面（仅取本插件用到的字段） */
type ClientContext = {
  slots: SlotsService
  effect(dispose: () => void, label?: string): void
}

const STYLES = `
.sqs-root { display: flex; flex-direction: column; gap: 14px; height: 100%; overflow-y: auto; padding: 16px 20px; box-sizing: border-box; }
.sqs-root * { box-sizing: border-box; }
.sqs-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.sqs-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #ffffff); }
.sqs-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); margin-top: 2px; }
.sqs-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sqs-window { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06)); }
.sqs-window button { border: 0; background: transparent; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer; line-height: 1.4; }
.sqs-window button:hover { color: var(--dsw-alias-label-primary, #ffffff); }
.sqs-window button.active { background: var(--dsw-alias-brand-primary, #ff7a1a); color: #ffffff; }
.sqs-cwd { background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.06)); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); border-radius: 8px; color: var(--dsw-alias-label-primary, #ffffff); font-size: 12px; padding: 5px 10px; width: 180px; outline: none; }
.sqs-cwd::placeholder { color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); }
.sqs-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.sqs-card { background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); border-radius: 10px; padding: 12px 14px; min-width: 0; }
.sqs-card-label { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); }
.sqs-card-value { font-size: 20px; font-weight: 600; margin-top: 4px; color: var(--dsw-alias-label-primary, #ffffff); font-variant-numeric: tabular-nums; }
.sqs-card-sub { font-size: 11px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); margin-top: 4px; }
.sqs-warn { color: var(--dsw-alias-state-error-primary, #ff5c5c); }
.sqs-panel { background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.04)); border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.sqs-panel-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #ffffff); margin-bottom: 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.sqs-muted { color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); font-size: 11px; font-weight: 400; }
.sqs-table { width: 100%; border-collapse: collapse; font-size: 12px; color: var(--dsw-alias-label-primary, #ffffff); }
.sqs-table th { text-align: left; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); font-weight: 400; padding: 4px 6px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); white-space: nowrap; }
.sqs-table td { padding: 5px 6px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.06)); font-variant-numeric: tabular-nums; }
.sqs-table tr:last-child td { border-bottom: 0; }
.sqs-row { cursor: pointer; }
.sqs-row:hover td { background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.04)); }
.sqs-ellipsis { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sqs-detail { display: flex; flex-direction: column; gap: 14px; }
.sqs-detail-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.sqs-back { border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)); background: transparent; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; line-height: 1.4; }
.sqs-back:hover { color: var(--dsw-alias-label-primary, #ffffff); }
.sqs-trace { display: flex; align-items: stretch; gap: 2px; height: 150px; overflow-x: auto; }
.sqs-trace-col { flex: 0 0 14px; display: flex; flex-direction: column; min-width: 0; }
.sqs-trace-wrap { flex: 1; display: flex; align-items: flex-end; justify-content: center; min-height: 0; }
.sqs-trace-bar { width: 9px; background: var(--dsw-alias-brand-primary, #ff7a1a); border-radius: 2px 2px 0 0; opacity: 0.85; }
.sqs-trace-bar:hover { opacity: 1; }
.sqs-trace-marker { font-size: 12px; line-height: 12px; color: var(--dsw-alias-state-success-primary, #4cd964); margin-bottom: 2px; }
.sqs-trace-failed { color: var(--dsw-alias-state-error-primary, #ff5c5c); }
.sqs-trace-route { border-left: 1px dashed var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.15)); }
.sqs-trace-label { height: 14px; font-size: 9px; line-height: 14px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.45)); text-align: center; white-space: nowrap; overflow: hidden; }
.sqs-empty { font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.55)); padding: 18px 0; text-align: center; }
.sqs-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #ff5c5c); }
@media (max-width: 900px) {
  .sqs-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
`

function installStyles(): void {
  const tagId = 'session-quality'
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-session-quality-xg'
    tag.dataset.pluginCss = tagId
    tag.textContent = STYLES
    document.head.appendChild(tag)
  }
}

/** 硬依赖：slots 服务就绪后 fiber 才执行 apply（shell 核心保证提供） */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(installStyles, 'session-quality:styles')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'session-quality',
    order: 21,
    label: '会话质量',
  }, SessionQualityView))
}
