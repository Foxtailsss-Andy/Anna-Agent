# Crew 视觉级复刻与开发 · 实施总纲

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 执行纪律(用户指定):**Fable 5 统领规划与把关,Opus 4.8 执行**;每片 = 实现 → 两级复审(规格忠实度 + 代码质量)→ 修复 → 四门 → commit。

**Goal:** 在 `feat/crew-build`(独立 worktree, base=f542a38 含长跑轮 L1-L5)上,把已拍板的 Crew PRD v1.0 + Claude Design 返稿(设计稿 v2 十屏)落成可真流走查的产品:后端(频道/通知/共识 Memory/真引擎 worker/收件箱/报销投影)+ 前端视觉级复刻(第三段外壳/Work Graph 画布/频道/抽屉+轻检视/收件箱/铃/花名册/模板/深色)。

**Architecture:** 后端沿既有 crew 域(`lifecycle.py` 纯状态机 + `CrewService._append_event` 审计挂点)扩展——频道行与通知由**同一 transition 调用点**派生(单一事实源,零捏造);Agent 执行走 `run_subagent`(隔离 QueryEngine)+ 长跑轮 `run_store`/`frame_journal` 后台机制。前端在 Iris 外壳上加第三段,画布 = React Flow + elkjs 自定义节点(HTML 卡)。

**Tech Stack:** Python 3.12 / FastAPI / SQLite;React 19 + TS 5.9 + Vite 7 + vitest 4;新增 `@xyflow/react` + `elkjs`(均 MIT)。字体 @fontsource 三栈已随包。

## 设计权威(按优先级)

1. `docs/design/2026-07-17-crew-return/Crew-组织协同-设计稿 v2.dc.html`(**像素事实源**;行段:2a 轻检视 54-218 / 2b 折叠导轨 219-356 / 1a 三区浅色 384-813 / 1b 深色 814-1215 / 1c 七态与生长 1216-1402 / 1d 频道五卡族 1403-1535 / 1h 任务抽屉 1536-1632 / 1e 收件箱 1633-1752 / 1f 通知铃 1753-1825 / 1g 花名册与模板 1826-1959)
2. `docs/design/2026-07-17-crew-return/设计说明-Crew增补.dc.html`(token/组件规格/动效表/六命题裁决——工程契约)
3. `docs/superpowers/plans/2026-07-17-crew-build/01-extract-1a-1b.md`、`02-extract-1c-1h.md`(蒸馏提取,便于速查;与原稿冲突时**以原稿为准**)
4. `docs/product/Anna_Crew_PRD_V1_0.md`(功能事实源,已拍板)

**返稿校对结论(brief §8,Fable 已核)**:红线全过——无 emoji;双主题(1a/1b);token 全部由既有色派生无新主色(金线预算=活跃门+生长第四幕,频道评审卡与门共用);reduced-motion 全表;不存在的东西未画(无在场点/已读回执/子线程/表情);七态+门三态齐;五卡族齐;React Flow 可落地性声明在尾注。设计期 Google Fonts 仅预览用,落地必须走 @fontsource(已随包)。

## Global Constraints(每个任务隐含)

- **零捏造**:UI 一切状态来自后端真事件;频道行/通知/图变化同源于状态机 transition + audit;计数为零隐藏 chip;空态即空态;禁止演示用假数据写死。
- **emoji 全禁**(产品 UI);图标=内联 SVG 1.5px 描边 currentColor。
- **iris #575BC4 唯一主色**;金 `--gold` 每屏至多两处(活跃评审门描边 + 生长第四幕金线);Agent 身份色 `--delegate`。
- **双主题**:所有新 UI 必须浅/深两态可用(深色非反相,`[data-theme="dark"]`);新 token 双值(B/F1 落 tokens.css)。
- **动效**:呼吸=全屏唯一(焦点执行节点);所有动效对应真事件;`prefers-reduced-motion` 按设计说明 §四降级表。
- **文案**:用设计稿/PRD 的真实中文文案;禁 lorem;Anna 口吻=陈述事实,永不用感叹号。
- **权限**:Boss/成员两档(评审/改派/确认下推=Boss);workspace 隔离沿 identity session。
- **四门**:`npm run typecheck`(0 错)/ `npm run test` / `npm run build` / `.venv/Scripts/python -m pytest`(全绿)——worktree 内 node_modules/.venv 为 junction,直接可用。
- **commit**:每任务收尾 commit 到 feat/crew-build,信息用中文、`feat(crew): ...`/`test(crew): ...` 式,尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **不改**:reimbursement 业务逻辑(只读投影)、chat/finance/hiker 面、判断力轮涉及的 `services/chat/app/capability.py`(如需 delegate 接线放 `services/runtime/`,不碰 chat capability)。

## 依赖序与波次

```
波1: B1a ✅ 31ce1a2  ∥  F1 ✅ e3afd64(165 vitest/三门绿/shell_hosting 闭合)
波2: B2 ✅ 90db3bc+176bc97(Fable 代验:契约锚点齐+729 pytest 全绿)∥ F2 ✅ b074055(207 vitest/三门/真机 S1-S6)
波2.5: B1b ✅ 1526aff(739 pytest)
波3: B3 ✅ 27911be(758 pytest;含 memory search scope 裁定落地)
波3.5: B4(后端补给:artifact 版本历史 + submit→submitted 待审态,评审门通过才 done)——F2 偏差③⑥的裁定补片,在 B3 后(同文件)
波4: F3 ✅ 589edaf ∥ B4 ✅ bb138f5;F4 ✅ 01778a3(+30 测试;LoopCard 原件复用+薄适配)∥ F5 ✅ e47b120(303 vitest;双视角真机+弹卡收铃实测)
波5: F6 ✅ 7710339+d0a34e2+febaed3 → 终审 ✅(READY WITH FIXES,6 findings:3 CONFIRMED)→ 修复 ✅ 272ecb0+8377cff(五项必修全落,#1 执行按钮三入口+e2e 改 UI 路径)

**🔧 真机验收修复(2026-07-20,91b8c9f)**:用户真机走查报 401 + 看不到画布。根因=**Crew/team 是全 app 唯一硬要 Bearer token 的 surface**(chat/finance/create 均以 local-runtime 身份 token-less 工作),桌面默认免登录→无 token→Crew 全 401→前端降级空态→无项目→无画布。**这推翻了我早先「免登录=诚实空态」的裁定**(那是错的:本地桌面用户就是真实身份,理应能用自己的 Crew)。修:crew._session / auth._require_session 在 local_session provider 接线时(main.py)回落本地身份,跨 workspace 隔离不变(异 workspace token 仍 404);demo 机 runtime.json 本地用户对齐 ws_crew_demo 的 Boss(本地文件不入库)。781 pytest(+1 覆盖回落+隔离)。真机验证:免登录 session=ws_crew_demo/Boss、crew/projects 200、team 列 5 员、建项目 8 任务 3 门 DAG 正常。**走查从此免登录直接可用**(单窗口即 Boss;多用户角色扮演仍可登录切换)。

**🏁 收轮(2026-07-20,Fable 终验)**:四门独立复核 **780 pytest / tsc 0 / 318 vitest / build ✓**;e2e 34 步全 PASS(run-agent 走 UI);14+7 截图归档;03-acceptance.md 终态。分支 feat/crew-build 共 **30 commit**(11 功能+1 修复×2+归档+勾账),**READY——待用户验收合 main**(项目惯例)。遗留:#5 悬挂 run 清扫 P1 / 成员项目列表 P1 / auto-run-on-assign 产品取向题 / 值守轮集成(催收派办 P1)。

**终审(fresh Opus,已交卷)**:审计七面(状态机接缝/后台并发/B3 幂等/端点鉴权/前端接缝/零捏造/卫生),鉴权清白(frames 有 workspace 404 护栏)、零捏造达标、状态机健全。Findings:#1 CONFIRMED 高=run-agent 无 UI 触发入口(未登记范围缺口,e2e 直打 API 绕过)——**裁定:必修,显式触发**(抽屉/轻检视/列表行「执行」按钮,agent-kind assignee 且 assigned|rework;auto-run-on-assign 记 P1 产品取向题);#2 CONFIRMED 中=通知幂等键漏收件人→多 @ 只通知第一人——必修;#3 CONFIRMED 中=同命令行二次 confirm 重复建任务——必修(created_from 短路);#4 PLAUSIBLE=重叠 run-agent 双跑——#1 修后 UI 可达,升级必修(在飞去重);#5 PLAUSIBLE=崩溃悬置 running 帧无终点——**记跟进 P1**(03-acceptance 已知边界);#6 PLAUSIBLE=投影 locked 误当空表——顺修(区分 no such table)。

**F6(已验收)**:①七态章部分统一(共用 stateSealGlyph 内层,外框双实现有理:尺寸/所有权/落笔动画);②artifact_version 无历史不带字段;③**裁定(Fable)**:成员侧栏项目子列表为空=F1 既有 owner 归集行为,剧本叙事本就走「成员从通知/收件箱深链进入」(1e),功能不缺——「成员列出参与项目」记 **P1 增强**不阻塞;④e2e 隔离 temp DB+杀进程树;⑤走查登录态=localStorage 注入 token(承免登录裁定)。
```

---

### Task B1a: 频道 + 通知 + 事件桥 + seed 更新

**Files:**
- Modify: `services/crew/app/schemas.py`(+ChannelMessage/Notification dataclass,Task +`origin`/`created_from_message_id` 字段,默认 `origin="sop"`)
- Modify: `services/crew/app/store.py`(+`channel_messages`/`notifications` 两表:`_ensure_schema` 内 CREATE TABLE IF NOT EXISTS;+append/list 方法)
- Modify: `services/crew/app/service.py`(`_append_event` 处派生频道行+通知;`say`/`list_channel`/`list_notifications`/`mark_read` 新方法)
- Modify: `services/crew/app/sop_templates.py`(「产品设计」→「功能迭代与设计」8 节点;「营销物料」保留)
- Modify: `services/identity/app/seed.py`(DEMO_ACCOUNTS → Boss/Andy 两人 + Agent·Scribe/Agent·Design/Agent·Check 三 agent,kind 区分,role=职能)
- Modify: `services/api/app/routes/crew.py`(+4 端点,见 Produces)
- Test: `tests/crew/test_channel_and_notify.py`(新)+ 既有 tests/crew、tests/identity 全绿(模板/seed 变更连带修改断言)

**Interfaces:**
- Consumes: `CrewService._append_event(project, kind, payload)`(现有审计挂点,service.py:178)、`lifecycle` 迁移函数、`SQLiteCrewStore._ensure_schema`。
- Produces(后续任务依赖,签名固定):
  - `ChannelMessage`: `{id:str, project_id:str, workspace_id:str, seq:int, author_kind:"anna"|"member", author_member_id:str|None, kind:"event"|"artifact"|"review"|"say"|"command", body:str, task_id:str|None, run_ref:str|None, mentions:list[str], audit_ref:str, created_at:str}`
  - `Notification`: `{id:str, workspace_id:str, to_member_id:str, kind:"assigned"|"mention"|"review_due"|"rejected"|"blocked"|"approval"|"unlocked", title:str, deep_link:str, project_id:str|None, task_id:str|None, read_at:str|None, idempotency_key:str, created_at:str}`
  - `CrewService.say(project_id, author_member_id, body, mentions) -> ChannelMessage`
  - `CrewService.list_channel(project_id) -> list[ChannelMessage]`(seq 升序)
  - `CrewService.list_notifications(workspace_id, member_id, unread_only=False)` / `mark_read(notification_id, member_id)`
  - API:`GET /api/crew/projects/{id}/channel`、`POST /api/crew/projects/{id}/channel`(body/mentions)、`GET /api/crew/notifications?unread=1`、`PATCH /api/crew/notifications/{nid}/read`(Bearer + workspace 隔离,沿既有 crew 路由模式)
- 事件桥规则(单一事实源):assign→(event 行 @assignee + assigned 通知)、submit→(artifact 行 + review_due 通知给 Boss)、review approved→(event 行 + 下游 recompute 后新 ready 任务的 assignee 发 unlocked 通知)、rejected→(event 行含批注 + rejected 通知)、run_agent 产出→artifact 行。`audit_ref` = `"#a" + str(audit_seq)`(与 `_append_event` 写入的审计条目一一对应);通知 `idempotency_key = f"{kind}:{task_id}:{audit_ref}"` 去重。

- [ ] **Step 1(RED)**:写 `tests/crew/test_channel_and_notify.py` 失败测试(核心断言,补齐 import/fixture 沿 tests/crew 现有风格):

```python
def test_assign_emits_channel_event_and_notification(svc, project):
    svc.assign(project.id, task1.id, "acc_andy")
    ch = svc.list_channel(project.id)
    assert ch[-1].kind == "event" and "acc_andy" in ch[-1].mentions
    assert ch[-1].audit_ref.startswith("#a")
    notes = svc.list_notifications(project.workspace_id, "acc_andy", unread_only=True)
    assert notes and notes[0].kind == "assigned" and notes[0].task_id == task1.id

def test_notification_idempotent_and_read_lifecycle(svc, project): ...
def test_say_appends_message_with_mentions(svc, project): ...
def test_channel_isolated_by_workspace(svc): ...
def test_template_feature_iteration_has_8_nodes_and_3_gates(): ...
def test_seed_has_two_humans_three_agents(): ...
```

- [ ] **Step 2**:`pytest tests/crew/test_channel_and_notify.py -x` 确认 FAIL(AttributeError/ImportError)。
- [ ] **Step 3(GREEN)**:按 Produces 契约实现;模板 8 节点=需求简报(产品)→PRD 起草(文案)→PRD 评审◇(产品)→设计稿(设计)→设计评审◇(产品+工程)→实施(工程)→代码评审◇(产品)→验收合并(产品),门带 `acceptance_criteria` 真文案;seed=`acc_boss`(Boss/产品/boss/human)、`acc_andy`(Andy/工程/member/human)、`acc_agent_scribe`(Agent·Scribe/文案/member/agent)、`acc_agent_design`(Agent·Design/设计/member/agent)、`acc_agent_check`(Agent·Check/验收/member/agent)。
- [ ] **Step 4**:全量 `pytest` 修连带(旧模板名/旧 seed 断言),四门全绿。
- [ ] **Step 5**:commit `feat(crew): B1a 频道+通知+事件桥(单一事实源)+功能迭代模板+2人3Agent seed`。

### Task B1b: 项目共识 Memory(scope 扩展 + 注入 + 命中审计)

**Files:**
- Modify: `services/memory/app/schemas.py` / `store.py`(+`scope:"workspace"|"project"` 与 `project_id` 列,缺省 workspace;`list_items(workspace_id, scope=None, project_id=None)`)
- Modify: `services/api/app/routes/crew.py`(+`GET/PUT/DELETE /api/crew/projects/{id}/memory`,PUT=upsert `{id?, kind:"约束"|"口径"|"决策", text}`,Boss-only 写)
- Modify: `services/crew/app/agent_worker.py`(组 prompt 时注入该项目共识条目,编号列出;audit payload +`memory_hits:[item_id,...]`)
- Test: `tests/memory/test_project_scope.py`、`tests/crew/test_consensus_injection.py`

**Interfaces:** Consumes B1a 的 schema 风格;Produces `BusinessMemoryStore.list_items(workspace_id, scope="project", project_id=...)`,F4 的共识 chips 与 trace 溯源读 `memory_hits`。

- [ ] Step 1(RED):`test_scope_defaults_to_workspace_backcompat`(旧行 scope 缺省仍可读)/ `test_project_items_isolated` / `test_worker_prompt_contains_consensus_and_audits_hits`(fake model 捕获 prompt,断言含「登录页只在远程 4xx」样例与 audit 的 memory_hits)。
- [ ] Step 2:确认 FAIL → 实现(SQLite `ALTER TABLE ... ADD COLUMN` 兼容既有库)→ 全量 pytest 绿。
- [ ] Step 3:commit `feat(crew): B1b 项目共识 memory scope+worker 注入+命中审计`。

### Task B2: 真引擎 worker(run_subagent + 后台 run + run_ref)

**Files:**
- Create: `services/runtime/app/engine/delegate.py`
- Modify: `services/crew/app/agent_worker.py`(`_produce` 弃单发,走 run_subagent;role→handler 映射表)
- Modify: `services/crew/app/service.py` + `services/crew/app/schemas.py`(Task +`run_ref:str|None`;产出提交沿 submit 流)
- Modify: `services/api/app/routes/crew.py`(`POST .../run-agent` 改异步:立即返回 `{run_ref}`,后台执行;+`GET /api/crew/runs/{run_ref}/frames?from_seq=0` 复用 `frame_journal` 读取)
- Test: `tests/runtime/test_delegate.py`、`tests/crew/test_agent_worker_engine.py`

**Interfaces:**
- Produces:`run_subagent(*, handler_factory, prompt:str, settings, max_turns:int=8, permission_mode:str="readonly") -> SubagentResult(status:"completed"|"failed"|"exhausted", summary:str, turns_used:int, audit_events:list[dict])`(同步、隔离、不继承父对话;summary ≤2000 字截断标记)。
- 后台机制**必须复用长跑轮件**:`services/runtime/app/run_store.py`(注册 run,surface="crew")+ `frame_journal.py`(逐帧落 seq)+ `concurrency.py` 并发闸;实现前先读 `services/api/app/routes/chat.py` 的后台 run 模式并照搬(线程/任务派发方式以 chat 现行实现为准)。
- role→handler 映射:文案/产品/设计/验收 → chat capability 只读构造(不改 `services/chat/app/capability.py` 本体,用其公开构造函数);映射表放 `agent_worker.py` 顶部 dict,可扩展。
- 失败语义:模型不可用/耗尽 → 任务落 `blocked` + blocker 原因,**绝不假完成**;CrewAgentError 语义保留。

- [ ] Step 1(RED):delegate 三态(completed/exhausted/异常→failed)、隔离性(父历史不进子请求)、readonly 强制;worker:产出来自引擎 final、run_ref 写回任务、帧已入 journal、失败→blocked。
- [ ] Step 2:实现 → 全量 pytest 绿(709+ 基线不回归)。
- [ ] Step 3:commit `feat(crew): B2 run_subagent+worker 接真引擎,后台 run 走 run_store/frame_journal`。

### Task B3: 频道命令两段 + 收件箱聚合 + 报销投影 + crew gate

**Files:**
- Modify: `services/crew/app/service.py`(+`draft_tasks_from_message(project_id, text) -> list[TaskDraft]`(模型起草,模型缺席→确定性回退:单任务,title=text 截断,role=产品)、`confirm_drafts(project_id, drafts, confirmed_by) -> CrewProject`(建任务 origin="channel"+created_from_message_id,emit 生长 event+通知))
- Modify: `services/api/app/routes/crew.py`(+`POST .../channel/command`(返回 drafts)、`POST .../channel/command/confirm`、`GET /api/crew/inbox`、`GET /api/crew/approvals`)
- Create: `services/crew/app/approvals_projection.py`(只读查询 reimbursement 既有 store/audit → `[{run_id, applicant, amount, currency, step:"submitted"|"drafted"|"awaiting_approval"|"verified", deep_link}]`;实现前先读 `services/reimbursement/` 与其审批四件套的事实状态字段,**零写入**)
- Test: `tests/crew/test_channel_command.py`、`tests/crew/test_inbox_and_approvals.py`、Gate `tests/gates/test_gate_crew.py`

**Interfaces:** `TaskDraft = {title:str, role:str, depends_on:list[str], acceptance:str}`;inbox 返回 `{todo:[TaskCard], review:[ReviewCard], mentions:[MentionCard]}`(按当前 session member);gate 冒烟=建项目(功能迭代模板)→AI 拆解回退→派人→频道有事件→run-agent(fake model)→submit→reject→rework→approve→下游 ready+unlocked 通知,风格沿 `tests/gates/test_gate_continue.py`。

- [ ] Step 1(RED)→ Step 2 实现(命令起草提示词里给 1..N≤3、角色建议、验收标准;确认门=API 层 Boss 校验)→ Step 3 gate 绿+四门 → commit `feat(crew): B3 +任务两段式+收件箱+报销投影+gate`。

### Task F1: tokens 增量 + 第三段外壳 + 折叠导轨 + Crew 页面骨架

**Files:**
- Modify: `apps/desktop/src/styles/tokens.css`(设计说明 §二 全部新 token,浅/深双值,注释注明 Crew 增补)
- Modify: `apps/desktop/src/components/shell/AnnaShell.tsx` + `Sidebar.tsx` + `Sidebar.css`(SidebarSegment +"crew";三段 pill;Crew 段导航=收件箱(徽标)/项目(子列表+x/y 进度)/团队/SOP 模板;移除「Crew·组织」stub)
- Create: `apps/desktop/src/pages/crew/`(`CrewInboxPage.tsx`/`CrewProjectsPage.tsx`/`CrewProjectDetailPage.tsx`(骨架:面包屑条 52px(项目›名+SOP pill+视图切换条+共识·N pill)+ 健康条 60px + 画布占位 + 频道占位 328px)/`CrewTeamPage.tsx`/`CrewTemplatesPage.tsx` + 对应 css)
- Create: `apps/desktop/src/lib/api/crew.ts`(projects/templates/team/channel/notifications/inbox/memory/frames 全客户端,fetch 风格沿 `lib/api/chat.ts`)
- Modify: `apps/desktop/src/App.tsx`(crew section 路由)
- Test: `apps/desktop/src/pages/crew/__tests__/`(导航模型/徽标推导/进度 x/y 纯函数 vitest)

**视觉权威:2b(行 219-356)+ 1a 侧栏部分 + 02-extract 附录。** 折叠导轨:232⇄64 240ms (0.2,0,0,1),文字 120ms 先淡出、图标 30ms 错峰;竖排 segmented 三 icon(房/双泡/节点图,激活=白底 pill+iris);导航激活=soft 底+左缘 2px;徽标折叠保留;项目 hover 飞出层 240ms;tooltip 350ms 延迟;快捷键 `[`;`<1280` 自动折叠(手动优先);通知铃**不在本片**(F5)。数据全真:projects/templates/team 接既有 API,收件箱徽标接 B1a notifications(未 ready 时显示空,不造数)。

- [ ] Step 1(RED):徽标推导/导航模型 vitest → Step 2 实现 → Step 3 `npm run typecheck`+`test`+`build` 绿 → commit `feat(crew-fe): F1 第三段外壳+折叠导轨+页面骨架+api client`。

### Task F2: Work Graph 画布(视觉级复刻)

**Files:**
- Modify: `package.json`(+`@xyflow/react`、`elkjs` 最新稳定版;`npm install`)
- Create: `apps/desktop/src/pages/crew/graph/`:`CrewGraphCanvas.tsx`(装配+轮询 3-5s+diff)、`TaskNode.tsx`+`GateNode.tsx`(自定义节点)、`edges.ts`(三型边+供电流)、`useElkLayout.ts`(分层布局,并行纵向展开,过门折返第二行)、`graphMotion.ts`(生长四幕/点名环/焦点呼吸 reducer)、`ChartingTable.css`(制图桌五层)、`legend.tsx`、空态
- Modify: `CrewProjectDetailPage.tsx`(接画布+健康条真数据:进度 x/y·阻塞·等我处理·活跃 Agent,零值隐藏)
- Test: `graph/__tests__/`:elk 输入映射、七态→视觉类映射、焦点唯一性 reducer(最近 transition 获呼吸)、生长 diff 检测(新增节点/边→四幕队列)

**视觉权威:1a(384-813)+ 1c(1216-1402)+ 设计说明 §三/§四 + 01/02 附录。** 后端状态→七态映射(以 `services/crew/app/schemas.py` TaskStatus 实名为准):待就绪=依赖未满足(recompute_readiness 未 ready)/ 就绪待认领=ready 且未指派 / 执行中=已开始 / 已提交待审=submitted|in_review / 阻塞=blocked / 返工=rework / 完成=done。硬规格:节点 188×min66 r14;七态卡面×章双通道(形状:虚/空/实/菱/叹/环/勾);职能点 4px(产品 #55589E/设计 #9C56B8/工程 #3E9C82/验收 #B98A2F);执行中底部 2.5px barSweep 2.2s;门 44×44 rotate45 三态(金线活跃+goldPulse 4s);边 1.5px 实/dash 5 4/danger 返工上弧 dash 3 3;供电流=全图唯一 iris dash 5 7 1.1s 流向执行节点;制图桌五层(纸渐变/110px+22px 双尺网格 radial mask/双辉 blur64/顶纱 90px/inset10 工作框);生长四幕≈1.1s(让位 240ms 错峰 30→画入 300→显形 240→定名金线 320+晕 3s 淡出),新生节点带「由频道生长 · #audit」溯源行;呼吸=焦点唯一,无执行零呼吸;reduced-motion 全降级。缩放 0.5-1.5。

- [ ] Step 1(RED)四组纯函数测试 → Step 2 静态渲染(七态+门+边+底)→ Step 3 动效(四幕/供电/点名环/呼吸)→ Step 4 四门绿 → commit `feat(crew-fe): F2 Work Graph 画布——七态/门/边/制图桌/生长四幕`。

### Task F3: 项目频道列(编年史 + 五卡族 + composer)

**Files:** Create `apps/desktop/src/pages/crew/channel/`:`ChannelColumn.tsx`(328 宽,脊线,折叠为条)、`ChronicleLine.tsx`(event 行:结/serif 署名/时间 mono/@pill/锚点 chip/audit 号)、`ArtifactCard.tsx`/`ReviewCard.tsx`(通过/驳回+批注 → 调 review API)/`SayBubble.tsx`(--user 纸面)/`CommandDraftCard.tsx`(勾选行×N+「确认下推 · n 项」)、`Composer.tsx`(@成员选择/+任务/Ctrl+Enter)。Test:消息归类/勾选聚合/@解析 纯函数。

**视觉权威:1a 右列 + 1d(1403-1535)+ 02 附录。** 评审卡出现时它与画布活跃门指同一事实(金线预算共用);驳回批注随 rework 注入(B2 已通);锚点跳转=发全局事件让画布点名环接管(与 F2 的 graphMotion 总线约定:`window CustomEvent "crew:ring-call" {taskId}`,F2 监听)。

- [ ] RED→实现→四门→commit `feat(crew-fe): F3 频道列——编年史行+五卡族+composer`。

### Task F4: 任务抽屉 + 轻检视 Popover

**Files:** Create `apps/desktop/src/pages/crew/inspect/`:`TaskDrawer.tsx`(480 右滑 240ms,画布压暗 6%;头/署名+改派/验收标准/产物版本/trace=复用 `components/agent/LoopCard` 消费 `GET /api/crew/runs/{run_ref}/frames`/共识 chips=memory_hits/操作组随状态)、`NodeInspectPopover.tsx`(372,双卡态:Agent 执行白盒/人任务待就绪白盒,单击开、双击或「全档案」转抽屉、Esc/点空白关、近缘翻转、呼吸暂歇选中环接管)、`ConsensusPanel.tsx`(面包屑「共识·N」pill 点开的滑出面板:项目共识条目 list/upsert/delete,`[约束]/[口径]/[决策]` 三 kind chips,Boss-only 写,消费 B1b memory API)。Test:操作组状态映射/popover 定位翻转纯函数。

**视觉权威:1h(1536-1632)+ 2a(54-218)+ 02 附录。** 进度估算行必须带「按同类均值,非承诺」;字段全部来自 run frames/状态机,无一杜撰。

- [ ] RED→实现→四门→commit `feat(crew-fe): F4 任务抽屉+轻检视双卡`。

### Task F5: 收件箱 + 通知铃 + 花名册 + 模板

**Files:** `CrewInboxPage.tsx` 补全(三组/驳回引文条/排队解锁条件/报销 stepper 四步+去审批深链/空态);`CrewProjectDetailPage` 列表辅视图(视图切换条「列表」:任务行=状态章+标题+职能点+assignee+状态词,复用收件箱行卡语法;「看板·P1」维持 dashed 站位);Create `apps/desktop/src/components/shell/NotificationBell.tsx`(外壳右上 32px:徽标/弹卡≤3 驻留 6s 收进铃+徽标 pop/面板按项目分组/跨段单摆 ±9° 240ms 永不循环/深链导航);`CrewTeamPage.tsx`(P4 身份系统:人圆/Agent 方 r5·delegate 色·三 Agent 图元 三横|圆叠方|对勾;负载真值)+`CrewTemplatesPage.tsx`(模板卡+DAG 骨架小图)。Test:通知归位 reducer(弹卡→铃)/分组/深链解析。

**视觉权威:1e(1633-1752)+ 1f(1753-1825)+ 1g(1826-1959)+ 02 附录。** 铃挂 `AnnaShell` 顶层三段全程可见,登录后拉未读→弹卡。

- [ ] RED→实现→四门→commit `feat(crew-fe): F5 收件箱+通知铃+花名册+模板`。

### Task F6: 深色核对 + 剧本 seed + 真流走查 + 终审

**Files:** 全局深色审查(对照 1b 814-1215:画布深色制图桌/节点/频道/抽屉全过);Create `scripts/live-crew-e2e.mjs`(沿 `scripts/live-chat-e2e.mjs` 模式:起后端→登录 boss→建「登录页重设计」→AI 拆解→派人→fake/真模型 run-agent→频道评审驳回→返工→通过→下游解锁→通知断言→截图);Playwright 走查截图存 `docs/superpowers/plans/2026-07-17-crew-build/walkthrough/`。

- [ ] Step 1:深色逐屏核对修补 → Step 2:e2e 脚本绿 + 截图 → Step 3:四门+全 gate → Step 4:终审(见执行纪律:派一个 fresh Opus 复审 agent 全分支抓错)→ commit `feat(crew): F6 深色+真流走查+终审修复`。

---

## 每片执行纪律(subagent-driven)

1. 实现 agent(Opus)读:本计划该 Task + 设计权威指定行段 + 相关现有代码;TDD;四门;commit。
2. 复审一(规格忠实度):对照设计稿行段与本计划契约,列偏差。
3. 复审二(代码质量):照 `superpowers:requesting-code-review` 口径。
4. Fable 终检:抽查视觉还原与红线;不过则回炉。
5. 每片收尾更新本文件 checkbox + 偏差登记(在文末追加「偏差登记」节)。

## 偏差登记

**B1a(31ce1a2,已验收)**:①模板 id `product_design`→**`feature_iteration`**(语义化;已验证无其他消费者,**下游一律用新 id**);②设计评审=单审人「产品」(计划预许);③`acc_boss.role="产品"`(Boss 档由项目 ownership 推导,匹配引擎需要职能角色);④run_agent 内部 submit 解锁评审门时也发 review_due(单一事实源);⑤review_due 仅在 submit 真解锁评审门时发并指向该门(零捏造);⑥say 无审计→`audit_ref=""`、幂等 ref=消息 id(与设计稿一致:人话无 #a);⑦ChannelMessage/Notification 用 pydantic BaseModel 随现有 schema 风格;⑧CrewService 注入可选 member directory(main.py 属性注入)渲染真名,缺省回退 member_id;⑨unlocked 通知仅对已有 assignee 的新就绪任务发。**遗留**:`test_desktop_shell_hosting` 1 例环境性失败(worktree 无 dist/,F1 build 后复验闭合)。

**波次修订(Fable,2026-07-17)**:B1b 与 B2 同改 `agent_worker.py` 有文件冲突——波2 改为 **B2 ∥ F2**,B1b 顺延至 B2 之后(在真引擎的 prompt 组装处注入共识)。

**F1(e3afd64,已验收)**:①`--danger-wash` 新增(既有 `--danger-soft` 实底被消费,不覆盖);②新增 `--rail-tooltip-bg/-ink`(tooltip 黑底白字双主题恒定);③展开侧栏保持 248px(设计 232,避免波及 Home/Cowork 全局壳宽);④折叠动效=条件渲染+140ms 淡入近似(两端态精确,逐元素错峰编排留 F6 精修);⑤导轨头像走既有 iris 身份口径;⑥「团队」行不带计数(计数在团队页头);⑦健康条「等我处理」=submitted|in_review 骨架口径(F5 精化);⑧频道纯文本行/画布静态底/共识无计数=F3/F2/F4 站位。**集成观察→裁定(Fable)**:Crew 路由走 Bearer,桌面免登录(local-workspace)下 Crew 段=诚实空态——**设计使然**:组织协同需要身份,演示路径=登录态(双浏览器窗口双账号,PRD §16-R4 既定),F6 走查按此执行,不改后端鉴权。

**B1b(1526aff,已验收,739 pytest)**:①service.py/main.py 超计划 Files(命中审计挂点+装配的必然延伸);②`run_task` 返回 crew 层 `WorkerRunResult`(引擎 SubagentResult 不背 memory 概念,分层正确);③终帧带 memory_hits(F4 与 trace 同源读路);④`list_items` tiebreak 改 rowid DESC(修真 bug:Windows 时钟粒度下共识编号不确定);⑤add() 拒绝 workspace scope 带 project_id;⑥422/400/503 语义;⑦kind 直存 memory_type(scope 列即命名空间护栏)。**裁定(Fable)**:⑦条遗留的 `search()` 未过滤 project scope——**默认排除**(通用 workspace 检索不拉项目认知),并入 B3 附件实现。

**F2(b074055,已验收,207 vitest/三门/真机 S1-S6)**:①edges.tsx 含 JSX;②文案职能点用产品色(1a 原稿如此,不造新色相);③版本 pill 未渲染(后端无版本模型,零捏造)→**B4 补**;④活跃门审阅人头像未渲染(无 reviewer 模型;评审权=owner,F4/F5 可诚实渲染 owner 头像);⑤让位滑移期边瞬时(RF 边不可 CSS 过渡,≤240ms 瞬态);⑥「等我处理」chip 无数据(lifecycle submit 直落 done)→**B4 补 submitted 待审态**;⑦焦点退化=数组序最后 running(无开始时刻字段);⑧reduced-motion 生长静态描边 3s 关键帧持稳;⑨点名环期间状态词保持真值(不用样例「点名中」,运行时诚实优先);⑩走查截图 untracked 留 F6 正式化。深色画布变量落组件级 CSS vars(ChartingTable.css),不扰全局 tokens。

**B3(27911be,已验收,758 pytest)**:①lifecycle 预派(blocked 可先记 assignee,解锁直落 assigned)——排队 lane 与 unlocked 通知因此为真;②ChannelMessage +payload 列(命令草案结构化存储,幂等迁移);③NotificationKind+=`grown`(**F5 需处理新 kind**);④draft 返回 (message, drafts) 元组;⑤confirm 服务端按命令行 payload 解析索引(客户端不可捏造)+双层 Boss 校验;⑥queued lane 按 assignee;⑦Boss=项目 owner(无 boss 旗标,审批通知发各项目 owner;无项目的 workspace 无审批通知,已文档化);⑧报销投影只读其 SQLite(跨 actor 需要,public db_path,零写入);⑨build_router 追加 keyword 参数。报销四步映射=最远确认里程碑,failed 排除(不假进度);审批通知在投影读取时生成,幂等 key=approval:{run_id}:{step}:{member}。

**B4 契约(Fable 裁定,2026-07-17)**:Task +`artifact_versions: list[{version:int, content:str, submitted_at:str}]`(submit/agent 产出追加,version 递增;现 `artifact` 字段保留=最新版内容,兼容);lifecycle:producer `submit` → `submitted`(待审),其下游评审门 `approve` 时 producer 落 `done`、`reject` 时照旧 `rework`;`recompute_readiness`/gate 就绪逻辑随之校准(gate ready 条件=上游 submitted|done,以现实现为准最小改);事件桥/通知文案不变;全量 pytest 修连带。API 返回带 versions;frames/审计不变。**追加(F3 发现的缺口,Fable 裁定归 B4)**:评审门转入活跃(review_due 判定点)时,事件桥同点落一条 `kind="review"` ChannelMessage(task_id=门,body 含「对象 · {producer} v{n}」,audit_ref 照规,同门同版本幂等一条;门过/驳后行保留=编年史不删)——评审卡从此有服务端事实背书,F3 只渲染不推导。

**F3(589edaf,已验收,233 vitest)**:①confirm 载荷照 B3 真端点 `{message_id, draft_indexes}`;②「已确认」态=任务血缘检测(created_from_message_id,比标志位诚实);③review 族纯渲染 B4 的 kind=review 行(不自造);④折叠=34px 竖条(保留可点重开);⑤纸面/金线为组件级 CSS var(tokens 在路径外,沿 F2 先例);⑥confirm 客户端 isOwner 门禁;review 钮不做客户端门禁——**裁定:维持端点开放给 workspace 成员**(符合「与 Andy 同审」双人审设计,1e 收件箱 Andy 亦有待我审;滥用防护属多租户 P2);⑦频道列表几何微调+删死样式;⑧artifact 摘要去重/取消=本地消隐/composer 单行。

**F5(e47b120,已验收,303 vitest/三门)**:①技能=职能确定性派生(roster 无 skills 列,计划预许);②批量已读=循环 PATCH;③F1 徽标源上提为 CrewNotificationsProvider(单一 5s 轮询,免登录不轮询不打 401);④收件箱「由频道生长」行缺 origin 字段未呈现→**F6 后端小补:inbox 卡 +origin/version**(1e 返工卡 v pill 同因);⑤返工卡版本 pill 暂以状态词替代(同④);⑥报销 stepper 纯函数已测,live 证据待 F6 剧本;⑦「今日 N 单」改「N 单·待命」(无逐日时间戳不臆造);⑧bellModel 命名避 Windows 大小写冲撞。

**F4(01778a3,已验收,+30 vitest/三门)**:①popover「暂停/自检」省略(后端无能力);②估算恒 null 只显真值(无同类历史源);③自检 dots/排队位省略;④assign/start/submit 局部 fetch 包装(crew.ts 属 F5 禁改)→**F6 清理:并回 crew.ts**;⑤run_ref 用 cast(共享类型未镜像)→**F6 清理:crewModel.ts 补 run_ref/artifact_versions 类型**;⑥去频道=点名节点近似(频道无滚动锚 API);⑦「没空」=频道 say @owner;⑧来源章=SOP 模板名;⑨StateSeal 于 inspect/ 独立实现(守画布所有权)→**F6 评估:七态章组件统一**;⑩popover 翻转 340px 估高(纯函数锁定)。真机走查诚实推迟 F6(登录态+F5 外壳落定后)。

**B4(bb138f5,已验收,772 pytest)**:①store 零改(版本走 project JSON payload,旧库缺省 [] 不回填);②review 行 audit_ref 共享触发 submit 的审计条目(诚实:评审因该提交而 due);③review 行/review_due 触发严格沿 B1a 门 todo 判定(预派门不触发,未扩大);④review 行幂等用确定性 message_id `{pid}:review:{gate}:v{version}`(ChannelMessage 无 idempotency_key 列)。状态机:submit=版本递增+(有门→submitted/无门→done);approve=producer 于通过时刻落 done;门就绪=上游∈{submitted,done};非门就绪=上游 done。

**B2(90db3bc+176bc97)**:代理在交报告前因进程退出中止,但工作已完整提交。Fable 代验:delegate.py(隔离 run_subagent,193 行)+ 双测试文件(236+216 行)+ 后台 manager(立即 run_ref/asyncio 驱动/frame_journal 写读/子引擎终帧吞并统一)+ 旧空壳测试文件由引擎版取代;**729 pytest 全绿**。细节 diff 复审并入波 3 的复审代理任务。
