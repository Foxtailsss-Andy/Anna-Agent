# B 系列 · 后端接回路线(B0 可并本轮;B1-B3 后端梳理轮执行)

> 前端以 `lib/frames.ts`(v2)为唯一契约,归一化层(A2 §4)桥接现状。本文档定义后端逐步原生化 v2 的路线:
> **每合入一个 B 阶段,前端归一化层收缩一块,最终删除**。B1-B3 在「后端梳理轮」按 TDD 重新细化成切片计划,此处锁定方向、边界与验收口径。

## B0 · step 帧全 surface 覆盖(小,强烈建议并入本轮,R4 后即可)

**问题:** `step` 帧仅 Chat 发(handler 需定义 `humanize_step`;chat/app/capability.py:240-254 是唯一实现)。finance/hiker/reimbursement 的 LoopCard「当下」行与回合 intent 全空(A2 §3)。

**改动(3 个 handler,照 chat 模式各 ~15 行 + 测试):**
- `services/finance/app/capability.py`:补 `humanize_step`(intent 例:analyze→「正在核对您的问题与期间口径」;tool erp.query→「正在查询财务数据」;deliver→「正在整理回答」——**代码生成中文标签,ADR-002,非模型文本**)
- `services/hiker/app/capability.py`:同型(hiker.* 工具中文)
- `services/reimbursement/app/capability.py`:同型(单据/校验/提交语汇)

**TDD:** 每域一测(`tests/<domain>/test_*_stream_steps.py`):驱动一次假 provider 流 → 断言 SSE 序列含 `{"type":"step","phase","intent","turn"}` 且 intent 为预期中文;现有 pytest 不减绿。

**前端零改动**(归一化直通 step 帧);合入后 R5/R6 界面自动点亮「当下」行。

**验收:** `python -m pytest services/ tests/ -q` 全绿;财务副驾真跑可见 step intent。commit `feat(runtime): B0 — finance/hiker/reimbursement humanize_step(step 帧全覆盖)`。

## B1 · v2 帧原生化(引擎层,中)

**目标:** 引擎直接发 v2 词表,前端归一化层退化为直通校验。

| 改动 | 位置 | 要点 |
|---|---|---|
| `text_delta.text → delta`;吸收 chat 遗留 `delta` type | agent_loop.py:169 + chat 路由内联序列化统一迁 `_sse.py` | 帧版本协商:流请求加 `?frames=v2`(缺省 v1 兼容期) |
| `tool_start/tool_done` 带 `turn` + `ok` | agent_loop.py:242/244(loop 已知 turn;ok 从 dispatcher 返回值取) | ok 为引擎一手真值,替代前端审计查表 |
| `thinking` 帧 | streaming_model.py:240 `_parse_sse_line` 补解析 `reasoning_content` → 新 chunk 类型 → loop yield `{"type":"thinking","delta","turn"}` | 只透传 provider 真推理文本;provider 不报则无帧(诚实) |
| `plan.updated` 升一等帧 | chat/app/capability.py:194-199 处同时 yield 帧(审计照写) | plan 工具向 finance/reimbursement 注册与否 = 产品决策,默认不动 |
| `done.run` 统一增量字段 | 各 domain run schema | `usage{tokens,model}`(model.call.* 聚合,真报才填)+ `duration_ms`;artifacts/plan 无则空数组 |
| `error` 帧统一 | 各 orchestrator 终止路径收敛 | `{message, provider?, retryable?, consumed_tokens?}`;`retryable` 从 ModelProviderError 透出;done(failed) 与 error 二选一,契约写死 |

**验收:** 帧 fixture 对拍(后端新 e2e 采流 vs `lib/frames.ts` 类型逐帧校验);前端删 normalize 对应分支(fixture 测试同步瘦身);双版本兼容期后移除 v1。

## B2 · L3 下钻通道(新建,中大;设计源 = 《Runtime 三级下钻 Brief 2026-07-09》§6)

**现状:** 工具 args/result 原文不进 wire 不落库(审计只有 input_hash;result 只进模型历史)——**全部从零建**(A2 §5)。

1. **稳定 stepId**:loop 内为每个工具步生成 `step_id`(run 内单调),`tool_start/tool_done` 帧带上;
2. **凭证存储**:per-run 工具凭证表(SQLite,对齐 reimbursement state_store 模式):`{run_id, step_id, tool, args_text, result_text, exit_text, bytes, created_at}`;写入点 mcp_dispatcher(真原文,含 stdout);
3. **脱敏门(产出侧)**:落库前过 redaction(密钥/金额/PII 规则复用 services/api/app/redaction.py 扩展);`restricted` 视角:非 run owner/非开发者请求 → 只回脱敏摘要;
4. **预览通道**:`tool_done` 帧带 `drilldown{args_preview,result_preview,exit_text,bytes,truncated,restricted,contract}`(预览截断 ~2KB);
5. **懒加载端点**:`GET /api/<domain>/runs/{run_id}/steps/{step_id}/full` → 全文(脱敏后);前端 `fetchToolResult`(R2 留位)接通,LoopCard `onLoadFull` 即活;
6. **contract 字段**:工具合同版本+hash(tool registry 已有目录投影可取)。

**验收:** 前端零改造(帧带 drilldown → 箭头自动出现;truncated →「展开更多」自动可用);ACCEPTANCE §D 的 L3 三形态项从「待 B2」转打勾。

## B3 · 持久化 + 产物索引 + 断线恢复(中)

1. **ChatRun 落库**:`ChatOrchestrator._runs` 进程内存(chat/orchestrator.py:116)→ SQLite state store;历史跨重启存活(R4 历史空态即自然消失);
2. **统一产物索引**:跨域 artifacts 投影(chat run.artifacts + create drafts + 未来 code)+ `GET /api/artifacts` 列表/内容端点 → 产物中心 SourceFilter 的 Chat/Code 站位点亮;沙箱「存入产物中心」站位转真;
3. **SSE 断线恢复**:run 帧序列落库 + `GET .../runs/{id}/stream?from_seq=n` 重放通道;前端 useRunStream 加重连(当前断线 = chat run 直接 fail,A2 §4.3)。

**优先级建议:** B0(本轮)> B1 > B2 > B3(B2 依赖 B1 的 stepId/turn 铺垫;B3 独立可提前)。

## 与「后端梳理轮」的衔接

- 后端梳理轮开题时:以本文件 + A2 为输入重新 brainstorm(范围可能扩大到引擎抽象/域合并),B1-B3 逐个出 TDD 切片计划;
- 帧契约唯一事实源固定为前端 `apps/desktop/src/lib/frames.ts`(交接包出品)+ A2 映射表;后端任何帧改动必须先改 A2 再动代码;
- 兼容纪律:前端归一化层保证「v1/v2 混流也能渲染」(按帧形状分派),后端可逐 surface 灰度切 v2。
