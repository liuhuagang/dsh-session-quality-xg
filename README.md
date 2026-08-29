# dsh-session-quality-xg — 会话质量分析插件

> [!NOTE] 维护状态
> 本插件为 XG 系列内部工具，**仅供学习参考，不承诺维护**（issue 不保证响应）。
> 最新开发版维护于内网 GitLab XGDSHPlugins；本仓库为源码快照。

分析 DSH 会话质量：规模、上下文占用轨迹、缓存命中、首字延迟（TTFT）、
压缩事件、模型路由切换、异常轮次。与 `dsh-token-stats`（token 用量统计）
互补：token-stats 回答"花了多少 token"，本插件回答"会话质量如何、上下文
档位是否合适"。

## 数据源与机制

数据源为会话日志（durable log）事件流，与 dsh-token-stats 同构：

- `session/created`：会话公告时批量重放整段内存日志（含恢复会话的全部
  历史），折叠结果整体替换状态条目（日志是 source of truth）
- `session/event`：实时增量折叠；`seq` 守卫去重，批量重放与增量天然幂等
- 持久化：`~/.dsh/session-quality/session-quality.json`（防抖写盘，进程
  重启后恢复累计值；会话再次激活时批量折叠刷新）

折叠的事件类型（均为 DSH 会话日志标准事件）：

| 事件 | 产出指标 |
|------|---------|
| `turn/start` / `turn/end` | 轮次规模；异常终止原因分布（error/aborted/blocked/max-tokens/interrupted） |
| `step/start` + `assistant/chunk`(token-delta) + `assistant/message` | 步骤（模型调用）边界；TTFT（首字延迟）；步总耗时 |
| `assistant/chunk`(usage) / `assistant/message`(usage) | token 用量（同 turn/step 替换语义，与 token-meter 一致）；prompt 侧上下文占用 |
| `request/context` | 模型路由与 contextWindow 档位变更序列（只在 route/容量变化时记录） |
| `request/header`(reason=resume) | 会话恢复次数 |
| `compaction/start`..`end` | 压缩事件：耗时/失败/手动自动/压缩前后上下文占用 |
| `session/end-seed` | 种子边界（恢复会话的历史前缀） |

**上下文占用口径**（与 token-meter 的 contextPressure 投影一致）：
`pressure = inputTokens + cacheReadTokens + cacheWriteTokens`（prompt 侧），
`contextWindow` 取该调用最近的 `request/context` 记录，占用率 = pressure / window。

## 质量指标（每会话）

- **规模**：轮次 / 步骤 / 有用量调用（另计无用量调用=失败/中断） / 事件数 /
  时间跨度 / 恢复标记（种子 + resume 次数）
- **上下文轨迹**：峰值占用与峰值占用率、末次占用、每调用增量（近 10 次采样）、
  压缩触发水位（各次压缩前占用率中位数）、预计免压缩剩余调用数、建议最小窗口
  （峰值 × 1.25 向上取整到 1K）
- **缓存质量**：prompt 侧 cacheRead 占比；前缀断裂次数（相邻调用缓存命中
  从 ≥50% 骤降至 ≤20%，如换模/大工具结果重序列化/压缩后重置）
- **性能**：TTFT 中位数/P90/max；步耗时中位数/P90/max；输出速率估计
  （输出 tokens ÷ 有耗时调用时长）；慢调用 TOP
- **压缩**：次数（自动/手动）、每次耗时、失败原因、压缩前后上下文占用
- **路由**：provider/model/contextWindow 变更点序列
- **异常**：turn/end reason.kind 分布

## 查询工具

模型工具 `session_quality`：

- **不指定 sessionId**：列表模式 —— 按 `cwd`（工作目录子串，定位项目）、
  `days`（最近活跃窗口）、`limit` 过滤，返回每会话聚合摘要（规模/合计
  tokens/峰值上下文/压缩数/异常轮/路由），适合先按项目定位会话再深挖
- **指定 sessionId**（精确或前缀）：单会话完整质量报告（上述全部指标 +
  慢调用 TOP + 压缩明细 + 路由序列）

输出为结构化 JSON（工具 schema 精确描述），同时渲染为中文摘要文本。

## 配置（cordis.patch.yml）

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

## 构建 / 测试 / 部署

```bash
node scripts/build.mjs        # junction 补齐 + tsc → lib/ + 单元测试
node --test tests/            # 单独跑测试（需先构建）
```

部署：复制 `lib/` 与 `package.json` 到
`~/.dsh/profiles/web/node_modules/dsh-session-quality-xg/`，在
`cordis.patch.yml` 添加 insert 条目，重启 DSH。

## 典型用法示例

"分析一下 GyraSearch 项目的会话结果" →
`session_quality`（cwd=GyraSearch）列出该项目全部会话摘要 →
对重点会话 `session_quality`（sessionId=…）拿详情 →
结合各档位实测（contextWindow/占用率/TTFT/压缩水位）做档位研判。
