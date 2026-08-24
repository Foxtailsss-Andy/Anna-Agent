# ADR-003 · Trace 装配与术语定案（Trace 轮，2026-08-06）

状态：已采纳（Trace 轮四门绿后生效）。上承 ADR-001（治理层自有、引擎按件取用）、ADR-002（模型负责想、代码负责管；每个模型输出过代码门）。

## 决策 1 · Trace 用纯读装配器，不在 loop 内埋 span

**取舍**：在 `agent_loop` / `stream_model` 内原生产生 OTel span（改写路径、随处埋点） vs 事后从 journal + audit 归并（零写路径改动）。

**采纳后者**。理由：①chat 的 journal 里 audit 早已以 `{"type":"event"}` 帧与过程帧穿插落库（`AuditFrameWatermark`，event_stream.py:45），数据本就齐全，缺的只是归并；②重定位轮 Phase B 将动 loop 契约（async dispatch / failed_resumable / 统一 registry），观测层必须是重构前后**不动的那条缝**——先装灯再开刀；③纯读装配可确定性单测（gate 9 条），loop 内埋点不能。代价：旧 run 的行级 `created_at` 只有秒粒度——已由 T1b 在 `FrameJournal.append` 盖毫秒 `ts`（附加字段，L3a「未知字段被消费者忽略」契约）根治新 run。

**可逆性**：装配器无任何写副作用，删除即回到帧流现状；T3（OTLP exporter）无限期后置，JSONL/SQLite 永远是事实源。

## 决策 2 · 术语全面采用 OTel / GenAI semconv / ADLC，弃用自造词

**取舍**：延续项目自造词（曾用：本体论、溶解、侧影、自省）vs 对齐行业标准词汇。

**采纳标准词**（用户 2026-08-05 裁定："我们在解决工程问题，不是哲学问题"）。基准三源：OTel Trace 模型（Cloudflare Workers Traces 遵循之）、`open-telemetry/semantic-conventions-genai`（六属性已实取确认：`gen_ai.operation.name` / `request.model` / `usage.input_tokens` / `tool.name` / `agent.name` / `conversation.id`）、Cloudflare ADLC 六性质（Programmatic / Horizontally scalable / Reproducible / Real-time push / Atomic / **Permissioned** / **Self-improving**）。

**弃用词 → 替代**：本体论→架构；溶解→服务收敛；侧影→run profile；自省→agent-facing telemetry。全仓术语契约落在根 [CONTEXT.md](../../CONTEXT.md)，改词先改那里。

**Q6 专项**：`gen_ai.conversation.id` 语义 = 会话。Anna 的 thread（一 thread 多 run，`list_thread_runs`）正合此义，故 conversation.id = thread_id、无 thread 回落 run_id；`trace_id` 恒 = run_id。二者不可混用。

## 决策 3 · 重定位轮 D1/D2 认账（ERP 降级）

2026-08-05 拍板：早期把 Anna 设计成服务 ERP 的 workflow 工具是**错误核心设定**；Anna 本身 = Agent。D1 = 结构性重构保内核收外壳（否决：全量重写 / 继续补丁 / Pi 换 loop——Pi 定位为 sub-agent 分包商）。D2 = 域**全溶解**：finance/hiker → MCP connector + 只读 profile；报销审批泛化为 permission mode（ask）后域服务退役；Create 保留 single-call 原语；demo-erp / Hiker **连接器全部保留**（演示资产）。**成本预认**：885+ 测试中域行为 pin 的改写是迁移大头，strangler 分批消化，不大爆炸。判断力轮立场不变：能力升级不得跑在权限谱前面。

## 附注（复审沉淀的三条语义精化）

① **审批挂起的孤儿渲染**：`awaiting_approval` 时 root status=unset，但仍开着的工具 span 按 §5.7 收尾规则标 `anna.orphaned` + error——"run 未定、工具失败"对健康暂停略显重。属已知呈现语义，后续若刺眼再精化（终局帧为 awaiting_approval 时跳过孤儿标错）。
② **span event attributes = 标量字段**：统一经 `add_event` 标量过滤（OTel 属性合法性 + 去调用方别名）。`plan.updated` 的 `items` 列表等非标量不入 event attributes——原文仍在帧 journal，零丢失指帧层不指属性层。
③ **未修的已知极端**：`model.call.failed` 若在 `completed` 之后到达（streaming_model 单终局契约下实际不可达），`error.type` 会写在已闭合 ok 的 span 上——记录不修。

## 落地物

- 装配器 `services/runtime/app/trace_assembler.py` + gate `tests/gates/test_gate_trace.py`（9）
- `GET /api/chat/runs/{run_id}/trace`（鉴权同 `get_chat_run`）
- 前端 `traceSpans.ts`（纯归约）+ `TraceWaterfall/TraceDrawer` + HomePage「执行过程」入口
- `FrameJournal.append` 毫秒 `ts`（T1b）
- 根 `CONTEXT.md`（术语契约 + 九跳链路 + TraceDoc 契约）
