# Anna Jev Crew Preview · SPEC

版本：JEV-PREVIEW-1.0 · 2026-09-21 · 状态：开发合同已定，功能尚未验收。

基线：`e2e603cbc70de5fddaeb4036e001cbaba4e4da0c`。工作树：`$ANNA_REPO_ROOT`。分支：`codex/jev-crew-preview-20260921`。

本 SPEC 覆盖研究稿 v0.1 中与本期冲突的范围：先交付 **MemberPicker 中一个未指派任务的建议 → 人工采纳 → 既有 Crew 状态与执行回读**。用户已授权立即开发、真实评测及多 Session/SubAgent；规划、审定、验收使用 Astra xhigh，编码与实现测试使用 Luna high，后者覆盖旧 AGENTS 中的 Luna xhigh。验收见 [ACCEPTANCE.md](ACCEPTANCE.md)，执行分工以同目录 EXECUTION/STATUS 为准。

## 1. 目标、范围和术语

用户在既有任务抽屉或节点浮层的 MemberPicker 中点击「建议人选」，看到一个可核实来源的建议或明确的待定状态，再决定采纳或手动选择。打开 Picker 本身不调用模型；生成建议不指派、不发频道消息、不通知成员、不启动 Worker。

本期仅覆盖 `assignee_member_id == null`、非 gate、`status ∈ {todo, blocked}` 的一个任务。已有改派、已指派任务、评审门、运行/提交/待审/返工/完成任务不参与建议；其原有手动操作保持原状。`blocked` 可预派，必须显示等待依赖，不提前运行。

术语沿用根 CONTEXT：Anna 仍为一个 Agent；Worker Profile 仍由 Host 调度；Assignment 是明确承诺。本次 **assignment suggestion** 是尚未采纳的候选建议；`decision_id` 关联一次判断请求，**不是 `run_id`**。Jev 的一次 inference 不自动成为 Agent Run，不伪装为 tool call，也不进入 Channel Memory。采纳后的 `crew.task.assign` 才是业务事实；Worker Run 继续使用现有真实 `run_ref`。

不纳入：项目批量面板、自动 LLM 回退、后台 shadow 产品、设置页、通用模型路由/多供应商平台、DAG 生成、自动评审、下游自动派工替换、OMP 升级、300 条标注例前置、安装包与 Windows/Linux 发布验收。Jev 失败时停在手动选择，不悄悄再调用生成模型。

## 2. 架构定案及源码依据

```text
MemberPicker：明确点击、展示、人工采纳
  → Python Crew API：既有会话/工作区鉴权，可信任务与 roster 快照
    → Node Product Host：受 service token 保护的一次 typed decision 请求
      → Jev：一次 Choice，包含弃权选项，无工具与外部写入
    ← 结构化结果、真实来源、脱敏 inference 元数据
  ← 短期建议记录（尚未形成 Assignment）
  → 既有 assign API 的可选 decision_id 分支
    → CrewService + Store：当前状态重验、原子条件指派与 receipt
    → commit 后沿用 _autorun；真实执行状态从任务回读
```

**选择 Host 内一次有界请求，不新增 Agent Run。** 复用 Host 进程、服务鉴权、受保护配置及 HTTP 能力；不另设进程、调度器或执行 authority。Python 只拥有业务读取、建议短期缓存及用户明确采纳后的 CRUD，不拥有 Jev SDK、模型凭据或模型重试/回退策略。Host 是唯一模型请求与取消 authority；有副作用的 Worker 执行仍走既有 Host Run。

| 基线源码 | 对本次设计的约束 |
| --- | --- |
| `apps/desktop/src/pages/crew/inspect/MemberPicker.tsx:11` | 现有小组件已共用于抽屉/浮层，P0 在这里增加可选建议区。 |
| `apps/desktop/src/pages/crew/inspect/useTaskOps.ts:140` | 当前选人即调用 assign；建议生成必须与此动作分离。 |
| `services/api/app/routes/crew.py:466`、`:715` | 现有授权基线是当前会话的工作区与任务状态；不凭空声明已有 owner-only 指派权限。 |
| `services/api/app/routes/crew.py:1282`、`:439` | 项目级旧建议与 `_auto_advance` 共享 matcher；新显式入口独立注入，不修改共享 matcher。 |
| `services/business/host_runtime.py:54`、`:134` | 旧规划 bridge 构造 ProductTask 并把结果转为 ModelToolCall，不能直接接收 Jev Choice。 |
| `apps/harness-service/src/product-facade.ts:237`、`:892`、`:1008` | 既有 ProductTask 有 submit/get/stop，但绑定的是完整 Run。 |
| `apps/harness-service/src/product-facade.ts:1447` | 现有 Run result 投影依赖真实 OMP transcript/tool response/usage，不可制造这些事件适配 Jev。 |
| `packages/harness-v2/src/kernel-descriptor.ts:48`、`apps/harness-service/src/production.ts:727` | 原生 Run 复用还涉及仅 pi/omp 的 descriptor 与主模型 preflight；本期不扩这组核心合同。 |
| `apps/harness-service/src/product-facade.ts:184`、`:227` | 新内部判断路由置于既有 `/_harness/` 服务鉴权之后。 |
| `services/crew/app/store.py:144`、`:484`、`:512` | 已有项目事务/CAS与幂等消息写入能力；本期仅原子写任务+audit receipt，commit后通知，不新增建议表或伪造execution receipt。 |
| `services/crew/app/service.py:237`、`:282` | 旧 assign 在 save 前发送频道/通知，且同员重派仅覆盖串行情形；新建议采纳分支必须原子化，不能把旧逻辑视为并发保证。 |
| `services/crew/app/lifecycle.py:109`、`services/crew/app/service.py:1057` | 保留 gate/状态/依赖规则及 commit 后既有 Worker 自动触发。 |

旧 `POST /suggest-assignments` 只作为既有行为与评测对照。其 `source` 当前由旧配置推断（`routes/crew.py:1291`），不能作为「实际调用主模型」的证据。本期无需修改旧接口行为。

## 3. 配置与 Host 边界（JEV-R01）

- `ANNA_JEV_ENABLED=1` 显式开启；缺省关闭。关闭或未配置时保留手动 Picker。
- `ANNA_JEV_API_KEY_FILE` 指向主控准备的受保护本地文件，内容为纯 UTF-8 Key。Node Host 读取并在内存中使用；不把 Key 放参数、源码、日志、响应或 ProductTask context。
- P0 固定请求模型 `jev-1.13.0`、官方 HTTPS endpoint `https://api.typesafe.ai/v1/systemone`。实际响应模型另记，缺失写 null；不能把请求版本冒充实际返回版本。
- 不增加通用endpoint、任意模型选择或前端Key输入。测试通过依赖注入的transport代替外网；真实评测由Astra主控在用户已授权总预算内审定命令后执行，不需要逐次再请用户确认。
- `runtime-service.mjs:197/229` 的 `ordinaryEnv` 会进入 Python；上述 Jev 变量必须先析出，只传 `hostEnv`。Key 文件路径加入 Host `protectedPaths` 及文件能力保护。不能因为文件可被本机进程访问就声称达到了 OS 沙箱隔离。
- 现有生成模型配置独立保留。Jev 无需配置生成模型即可响应；Host 启动仍遵循当前受验证 OMP 环境要求，不能为 Jev 擅自升级或更换 Runtime。
- 启用时开发说明明确：明确点击后会向 TypeSafe 发送下述任务与候选摘要。无后台发送。

## 4. 输入、决策和结果（JEV-R02）

### 4.1 可信快照

API 只接收项目/任务路径与客户端生成的 UUID `request_id`。成员、角色、任务内容、source、模型配置、建议人选都由服务器读取，不接受浏览器提供。

候选使用既有 `identity.list_members(session.workspace_id)`，与当前 MemberPicker 工作区 roster 一致。没有项目级成员权限表时不声称存在该能力。合法候选仅实际 Account，`kind ∈ {human, agent}`，ID 必须在当前工作区；不含系统 `anna` Actor。不将 role 相等当作权限。

发送给 Jev：项目目标；任务 title、description、role_required、acceptance_criteria；候选的本次局部 ID、role、kind。真实 member ID 在 Host 请求边界保留映射，但 provider options 优先使用 `c1…cN` 和保留值 `abstain`。不发送姓名、email、凭据、频道历史、记忆或其他任务正文。不编造技能、资历、工时、负载和过往成功率；现有字段以 `schemas.py:26` 和 `identity/schemas.py:17` 为准。

首期最多 20 个候选。超过时返回 `candidate_limit_exceeded`，不静默裁剪、不分批排名。序列化 provider state 上限 16 KiB UTF-8，超出返回 `input_too_large`，不截断为另一项任务。缺失可选正文按空/无资料处理，不新增表单必填要求。

服务器保存的相关事实指纹包含：workspace/project/task ID、项目 owner/goal、任务 title/description/role/acceptance/status/assignee/is_gate/depends_on、直接依赖 ID 与 status、排序后的候选 ID/role/kind。无关频道新消息、display_name 和整个项目版本不参与建议过期判断。原子提交仍使用当前 store 事务/CAS，而不是依赖浏览器 hash。

### 4.2 最小决策政策 `crew-assignee-v1`

1. 在模型调用前检查对象/状态/候选与长度。零合法候选 → `abstained/no_candidates`。
2. 非空 role_required 恰好有一个合法精确角色匹配 → `suggested/role_rule`；必须标明零 Jev 调用。
3. 其余情况用一次 Choice：从当前合法候选或 `abstain` 中选一个。固定问题要求只依据现有资料；缺少区分信息、无合适候选则弃权。P0 不增加 Noul/Score 链或生成式解释。
4. 如果某个建议与另一候选具有相同的语义资料 `(role, kind)`，无法凭模型看到的资料区分两人，结果收窄为 `abstained/insufficient_information`，不按姓名、输入顺序或 ID 猜能力。整个 roster 无区分信息也可在调用前弃权。
5. Choice 必须映射本次闭集；缺失/重复答案、未知 option、非有限或越界的实际概率等均为 `invalid_response`。只记录 provider 实际返回的概率/confidence，缺失为 null。不预设未经校准的 0.8/0.9 阈值，不将 confidence 写成成功率。
6. 网络/格式/服务错误 → `unavailable`。零自动 retry、零自动 LLM fallback。用户可以重新点击，产生新 decision_id，或直接手动选人。

UI 理由由事实模板形成，例如「任务登记角色：设计；成员登记角色：设计，类型：Human」。不要让 Jev 生成任意理由，也不要把跨角色匹配写成已证实的胜任能力。

### 4.3 受保护的 Host 合同

新增 `POST /_harness/crew/assignee-decision`，只接受既有 service token。请求是严格 schema，拒绝额外 credential、endpoint、tool 或任意参数：

本路由最多4个在途请求，无等待队列，满额返回429 `jev_busy`且不调用provider；所有退出路径释放占位。HTTP请求body最多32 KiB，provider响应最多64 KiB（读流累计字节达到上限即终止），超限分别返回413 `input_too_large`或归一化`invalid_response`。这只是该路由的局部限制，不改全局网关。

`decision_id`为标准UUID文本；workspace/actor/project/task/candidate ID为1–128字符的非空文本，不含控制字符；`input_hash`为64个小写hex；question_version固定字面量。候选ID必须互异；候选最多20个加1个内部abstain选项；所有正文受16 KiB state/32 KiB body双上限。返回模型/请求ID最多128字符，概率map只能含本次闭集且最多21项，归一化输出上限16 KiB；不转发任意provider额外字段。

```ts
type AssigneeDecisionInput = {
  schema_version: 1;
  decision_id: string;
  workspace_id: string;
  actor_user_id: string;
  project_id: string;
  task_id: string;
  input_hash: string;
  question_version: "crew-assignee-v1";
  state: {
    project_goal: string;
    task: { title: string; description: string; role_required: string; acceptance_criteria: string | null };
    candidates: Array<{ id: string; role: string; kind: "human" | "agent" }>;
  };
};
type AssigneeDecisionResult = {
  schema_version: 1;
  decision_id: string;
  status: "suggested" | "abstained" | "unavailable";
  member_id: string | null;
  reason_code: string;
  source: "jev" | "none";
  meta: {
    question_version: "crew-assignee-v1";
    requested_model: "jev-1.13.0";
    returned_model: string | null;
    provider_request_id: string | null;
    started_at: string;
    ended_at: string;
    elapsed_ms: number;
    input_tokens: number | null;
    output_tokens: number | null;
    confidence: number | null;
    probabilities: Record<string, number> | null;
    provider_calls: number;
    retry_count: 0;
    error_code: string | null;
  };
};
```

该结构是 Anna 归一化合同，不是假定的 TypeSafe wire JSON。JEV-01 实现前核对研究材料链接的官方 API/SDK 当前字段，并保留版本/来源；遇到字段不一致如实修 adapter，不能让 fixture 自证虚构协议。公共生产 Host seam 的单元/集成测试使用该同一 client 与 validator。

Host一次总预算4,000 ms，自通过服务鉴权并占用本路由slot开始，覆盖读入body、校验、网络等待和读响应，零retry；不因分阶段重新计时延长。该数字是首轮交互上限，不是已测性能承诺；修改需新配置指纹并重跑对应轮。缺失配置不访问provider。401/403 → `jev_auth_failed`；provider429 → `jev_rate_limited`；5xx → `jev_unavailable`；网络 → `jev_network_error`；超时 → `jev_timeout`；错误body不透传UI/日志。鉴权/请求结构错误用HTTP401/400；可归一化provider失败用上述result状态。

HTTP 断开、显式上游取消、Host 关闭或预算到期向同一 provider fetch 传 AbortSignal；取消后不能发布可采纳结果。不能承诺 provider 未处理请求或不计费。Jev 不经过 OMP model transport，也不生成 `omp.*`、`execute_tool`、Worker Run 或伪造 token。

## 5. 公共 API、缓存与取消（JEV-R03）

新增单任务 `POST /api/crew/projects/{project_id}/tasks/{task_id}/assignment-suggestions`，body `{request_id: UUID}`。成功处理返回 200：

```ts
type AssignmentSuggestion = {
  decision_id: string; // 本次 request_id
  project_id: string;
  task_id: string;
  status: "suggested" | "abstained" | "unavailable";
  source: "role_rule" | "jev" | "none";
  member_id: string | null;
  reason_code: string;
  expires_at: string;
  evidence: { task_role: string; member_role: string | null; member_kind: string | null };
  meta: AssigneeDecisionResult["meta"] | null; // 规则路径无 provider 元数据
};
```

会话/工作区使用原 `_session`/`_guard_project`。**P0权限定案：当前已认证工作区成员（包括既有local session）可为同工作区可见项目请求并采纳建议，遵循当前手动assign权限；不额外限定owner，也不把workspace校验描述成owner授权。** 缺会话401；项目/任务不属于当前工作区或不存在404；gate/不合格状态/已有assignee 409；非法body 422。服务端必须验证推荐与采纳的member为当前workspace的合法Account，不能继承旧assign的成员校验缺口。权限不足时不能因模型建议获得额外授权。

新增独立建议 collaborator，仅用于这个显式路由，不替换 `CrewMatchingService` 和 `crew._propose_assignments`。其进程内短期记录按 `(workspace, actor, project, task, decision_id)` 绑定，持有请求状态、相关事实快照、返回值及取消标记；建议 TTL 为 5 分钟，最多 128 个活跃/未过期记录。清理过期记录；满额返回 503，不驱逐正在等待的请求。此限制是防止局部请求泄漏，不是新队列产品。

相同 scope/id 的并发生成共用一个请求；已完成则读回同一结果，已取消不可重启。切换项目或 actor 不能读回另一 scope 的结果。同一进程内保持上述重复语义；重启不声称模型请求 exactly-once，未采纳建议全部过期。已采纳的 durable receipt 另见下节。

新增 `DELETE /api/crew/projects/{project_id}/tasks/{task_id}/assignment-suggestions/{decision_id}`。先鉴权；未开始也记短期取消 tombstone，解决 cancel 先于 POST 抵达的竞态。取消 pending 时终止等待并尝试取消 Host HTTP，取消 ready 时使结果不可采纳；已采纳则只回 `already_applied`，不撤销 Assignment。迟到的结果只能记录 canceled，不复活建议。

前端在发 POST 前生成 id；请求中禁止再次点击生成，关闭/Esc/点击外部/切换任务与项目/unmount 时 abort 并以该 id 发 cancel。新一轮使用新 id；响应只有在组件仍打开且 scope/id 匹配时才显示。浏览器超时兜底 6 秒。取消请求因网络丢失时，由 Host 4 秒上限与建议 TTL 收束；UI 不将其宣称为已确认服务端停止。

## 6. 原子采纳、幂等及执行边界（JEV-R04）

扩展现有 assign body：`{member_id: string, decision_id?: UUID}`。无 decision_id 的旧手动分支保持原逻辑。有 decision_id 才调用新的 `CrewService.assign_from_suggestion` 公共 seam；响应保留原 CrewProject 形状，成功后立即 refresh。

采纳要求：建议属当前 scope、状态 suggested、未过期/未取消、member_id 与服务器建议完全相同。用户改选另一人走原手动 assign，不把人工选择记成采纳 Jev。前端不能提供或覆盖 snapshot、source、input_hash。

新采纳分支按以下顺序执行：

1. 当前会话/项目授权复核。先在已有 project.audit_events 找本 actor/task/decision 的持久 receipt；相同 member 已采纳则返回当前项目，**不重新通知、写事件或调 `_autorun`**，即使任务后来 running/done、短期缓存丢失或进程已重启。相同 decision 改 member 返回 409 `suggestion_conflict`。
2. 首次采纳必须命中有效短期建议；缺失返回 409 `suggestion_expired`。从 Identity 重新读当前 roster，并在 Crew store 事务中重新读取项目/任务；比较相关事实指纹、任务仍未指派、非 gate、todo/blocked、成员仍有效、候选信息仍一致。任一改变返回 409 `suggestion_stale`，不执行副作用。普通新频道消息不使建议过期。
3. 在一个 `BEGIN IMMEDIATE` 事务中调用既有 `lifecycle.assign_task`，原子写任务与 `crew.task.assign` 审计/receipt。receipt payload 增加 decision_id、actor_user_id、member_id、source、input_hash、question_version、decision记录引用；不存Key或完整模型正文。
4. commit成功后，仅首次实际写入走既有频道/通知和 `_autorun` helpers，均为best-effort，稳定message ID与notification idempotency_key由receipt派生。通知写入与Worker dispatch不在项目事务中，任一失败不将指派改判为未提交；各项异常分别记录，不能让通知异常阻止余下正常触发尝试。Human不运行；blocked Worker等待依赖；就绪Worker按现有auto-pilot配置运行。Jev开关不更改auto-pilot配置。

复用已有 `update_project` 的项目事务/CAS，receipt留在project.audit_events；只允许为no-change duplicate做必要的小改动，不为同事务通知重构store。不要复用 `apply_execution_projection` 冒充执行事件，不新增持久表、outbox系统或通用工作流。测试从 `assign_from_suggestion`/HTTP 跨越同一事务seam，不能只测内部hash。并发duplicate必须在事务内再次检查receipt，只有首次insert的调用在commit后发送通知/派工。

取消与首次采纳在短期记录锁下排序；cancel 先完成则拒绝，采纳已提交则 cancel 不撤销。锁不得跨模型网络请求；记录状态与 durable receipt 的冲突以已提交业务事实为准。事务中异常不得留下频道/通知或派工；正常并发重复采纳只允许一项 committed receipt 与一轮自动触发。

**明确边界：** 这里保证建议条件指派和持久重复请求去重，不保证commit后频道/通知/Worker dispatch的崩溃恢复exactly-once。commit已成功但这些effects失败/进程中断，Assignment仍成立，UI只能说「已指派」，通过实际任务/Host状态显示未启动或失败；重复采纳不尝试补发通知或补派，用户沿既有任务执行入口处理。不能因dispatch失败回滚已提交指派或报告任务完成。

Identity 与 Crew 在默认配置下可能使用不同数据库（`main.py:455/461`）；P0 做紧邻提交的真实成员复核，不声称跨数据库撤权的分布式原子性。测试覆盖采纳前已发生的移除/角色变化；严格跨库同步撤权留为已知边界。

## 7. UI 与观测（JEV-R05 / JEV-R06）

MemberPicker 增加可选 task/project context 与建议 action；手动成员列表始终可用。只在符合 P0 资格时展示「建议人选」，读取 existing members 做展示映射，不另建候选编辑器。加载、建议、待定、不可用、过期各有明确状态；生成响应不得调用 onPick。

建议显示人选、事实模板、实际来源「角色规则」或「Jev」，并提示尚未指派。显示实际Host `meta.elapsed_ms`，标签为「判断耗时」，不称浏览器E2E；规则路径写「未调用模型」，缺失耗时不补0。「采纳指派」提交后禁用；用同步ref/等价机制防止React setState前的双击。采纳成功刷新并关闭；失败保留可理解错误、刷新任务、保留手动操作。就绪Worker提示采纳后按现有策略开始执行；blocked明示等待依赖。禁止把生成成功显示为任务执行成功。不为耗时新增dashboard。

Host 对真实 inference 输出脱敏结构化记录：decision_id、input_hash、question_version、请求/返回模型、实际请求 ID（若有）、起止时间/耗时、provider_calls、retry_count、结果/错误码、实际 usage；无值为 null。建议采纳 receipt 关联同一 decision_id。初期可用专用 JSONL 日志/注入 sink，不新增 DB 表或完整 Trace 页面；完整 state 不写日志。模型内容属于不可信数据，错误正文不透传。按根 CONTEXT 使用 inference/attribute/error.type 术语，JSON 结构记录不冒充 OTel 标量 attribute 或现有 canonical Agent Trace。

## 8. 开发票与退出条件

| 票 | 独占范围建议 | 可见产物与退出条件 |
| --- | --- | --- |
| JEV-01 | Host typed client/validator、受保护 route、main/launcher 凭据隔离、相关测试、冻结评测工具与 fixture | 可通过真实Host seam取得Jev决策及脱敏记录；冻结32例，其中8开发smoke+24独立heldout；无主模型配置也能运行Jev。此票不修改Crew UI或旧matcher。 |
| JEV-02 | 独立 Crew suggestion collaborator、API、Host client bridge、Crew service/store 原子采纳、MemberPicker 及最小 wiring、相关测试 | 单任务 UI 完成真实建议与采纳；陈旧/重复/取消/自动推进隔离通过，真实 Worker 证据与仅指派证据分开。 |
| JEV-03 | 固定版本完整对照、实际浏览器流程、证据/README/release 草稿、必要且有证据的阻断修复 | 冻结轮结果透明、回归检查完成、可复现 demo；未达到优势门槛仍如实发布受限 preview 描述，不宣称全面提速或生产质量。 |

串行集成，不让多 Writer 同改 product-facade、crew route/service、MemberPicker。每票固定 base SHA、Spec/AC IDs、owned files、依赖及证据；Luna 交付后由独立 Astra 审定，不能自验收。禁止因为首票只涉及 Host 就宣布产品完成。

建议文件ownership（确切清单由主控EXECUTION冻结；同票内也只准一个Writer拥有共享文件）：

| 票 | 建议新增模块/公共测试 | 最小现有wiring |
| --- | --- | --- |
| JEV-01 | `apps/harness-service/src/jev-decision.ts`（typed client/validator与一次请求）；`apps/harness-service/test/jev-decision.test.ts`（真实Host HTTP+fake provider）；`scripts/jev-crew-eval.mjs`；`evals/jev-crew/fixtures/{development,heldout}.json` | `apps/harness-service/src/product-facade.ts`、`apps/harness-service/src/main.ts`；`apps/desktop/electron/runtime-service.mjs`及对应env隔离测试。日志sink与force-Jev仅采用窄接口，不另建平台。 |
| JEV-02 | `services/crew/app/assignment_suggestions.py`（独立collaborator）；`tests/api/test_crew_assignment_suggestions.py`；`tests/crew/test_assignment_suggestions.py`；`apps/desktop/src/pages/crew/inspect/__tests__/MemberPicker.test.tsx` | `services/business/harness_client.py`、`services/api/app/main.py`及`routes/crew.py`、`services/crew/app/service.py`（store仅必要no-change支持）；`apps/desktop/src/lib/api/crew.ts`、`inspect/MemberPicker.tsx`、`inspect/types.ts`、`inspect/useTaskOps.ts`、`inspect/TaskDrawer.tsx`、`inspect/NodeInspectPopover.tsx`、`CrewProjectDetailPage.tsx`及既有样式文件的局部补充。 |
| JEV-03 | `evals/jev-crew/<eval_round_id>/`脱敏证据与报告；必要的脚本对照组；README/release草稿 | 只修有验收证据的阻断项，范围变更先由Astra更新Spec/AC。 |

## 9. 已知未知与变更纪律

- 本文核对的是上述源码基线；编写时未调用 Jev、未取得真实延时/usage、未跑新功能测试。性能、质量和 CJK 能力只能由冻结实测填写。
- 官方wire格式/SDK当前行为由JEV-01对照公开资料及真实响应验证；fixture与真实调用分开记证据。主控已确认当前生成模型配置存在，尚未以API验证可用；若运行时无法调用，按AC标blocked，不用fixture替代。
- 当前候选资料贫乏是产品事实；小样本无法证明招聘/排班/生产级能力，不新增虚构 skills 或成员档案来制造演示优势。
- Node Host 有界请求是这轮范围定案。以后若需要跨重启恢复的完整决策 Run，再单独审定 typed result、kernel 身份、canonical event 和 resume 合同；不得在本期暗中实现。
