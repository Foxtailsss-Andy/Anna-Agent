# Crew 视觉级复刻与开发 · 验收记录(F6 收轮 + 终审修复)

> 由 F6 收轮工程师(Opus)整理,2026-07-20;**终审修复片(Opus)追加 §8,2026-07-20**。
> 记账口径:00-master-plan.md 由把关人统一维护,本文件只记 F6 收轮 + 终审修复事实。
> §1 的四门数字为**合并前最终态**(含终审修复);F6 收轮当时数字见 §8 增量分解。

## 1. 四门终验(worktree `Anna-crew`,分支 feat/crew-build)

| 门 | 命令 | 结果(合并前最终) |
|---|---|---|
| pytest | `.venv/Scripts/python.exe -m pytest -q` | **780 passed**(F6 774 + 终审修复 6) |
| typecheck | `npm run typecheck` | **0 错** |
| vitest | `npm run test` | **318 passed**(30 files;F6 308 + 终审修复 10) |
| build | `npm run build` | **✓ built**(dist 产出,e2e 由后端托管) |
| e2e | `node scripts/live-crew-e2e.mjs` | **34 步全 PASS / 0 FAIL / 14 截图**(run-agent 改走 UI「执行」路径) |

新增测试(F6 收轮):后端 `tests/crew/test_inbox_and_approvals.py`(+2:`origin` / `artifact_version`);
前端 `pages/crew/__tests__/inboxModel.test.ts`(+5:`reworkVersionPill` ×3 / `isChannelGrown` ×2)。
新增测试(终审修复):见 §8。

## 2. 各片 commit 索引(feat/crew-build)

| 片 | commit | 说明 |
|---|---|---|
| B1a | 31ce1a2 | 频道+通知+事件桥+功能迭代模板+2人3Agent seed |
| F1 | e3afd64 | 第三段外壳+折叠导轨+页面骨架+api client |
| B2 | 90db3bc / 176bc97 | run_subagent + 后台 run(run_store/frame_journal) |
| F2 | b074055 | Work Graph 画布(七态/门/边/制图桌/生长四幕) |
| B1b | 1526aff | 项目共识 memory scope + worker 注入 + 命中审计 |
| B3 | 27911be | +任务两段式 + 收件箱聚合 + 报销投影 + gate |
| B4 | bb138f5(+ b2c5781 契约) | artifact 版本历史 + submitted 待审态 + kind=review 行 |
| F3 | 589edaf | 频道列(编年脊线+五卡族+composer) |
| F4 | 01778a3 | 任务抽屉 + 轻检视双卡 + 共识面板 + 列表视图 |
| F5 | e47b120 | 收件箱三组 + 通知铃/弹卡 + 花名册 + 模板 |
| **F6-1** | **7710339** | 清理留债 + inbox 卡补 origin/版本(本轮) |
| **F6-2** | (本次提交) | 剧本 e2e + 走查归档 + 验收记录(本轮) |

## 3. F6 工作项完成状态

1. **清理清单(F4/F5 留债)** — 全清:
   - `inspect/actions.ts` 的 assign/start/submit 并回 `lib/api/crew.ts`,`actions.ts` 删除,`CrewProjectDetailPage` 改 import crew.ts。
   - `crewModel.ts` CrewTask 补 `run_ref` 正式字段;`inspect/helpers.ts` 删 `(task as {...})` 局部 cast(`artifact_versions` 此前已镜像)。
   - 七态章:见 §5 裁定(部分统一——共用图元抽出,外框维持双实现)。
2. **后端小补 inbox +origin/artifact_version** — 完成(TDD RED→GREEN):`inbox.py` todo 卡带 `origin`(channel→前端「由频道生长」行)+ 最新版本号(返工卡 v{n}→v{n+1} pill);前端 `TodoCard` 类型 + `CrewInboxPage` 呈现(OriginRow / 版本 pill,CSS 走 token 双主题)。e2e 与截图 s3/s3d 实证「由频道生长」行落地。
3. **深色逐屏核对** — 见 §6:核对为主,**结论清白零改**(F1–F5 已由 token 体系正确落深色)。
4. **剧本 e2e + 走查归档** — `scripts/live-crew-e2e.mjs`;18 API 步 + 14 截图全 PASS(§4)。
5. **全门终验 + 验收记录** — 见 §1 + 本文件。

## 4. 剧本 e2e(`scripts/live-crew-e2e.mjs`)

起后端(uvicorn + 隔离 temp state/memory/runs DB + 真 runtime.json 模型配置),真 API 走剧本 →
**run-agent 经 Playwright 点击 UI「执行」按钮触发**(终审 #1)→ Playwright 无头浅/深截图 → 收尾杀后端。
**终审修复后运行:34 步全 PASS / 0 FAIL / 14 截图。**
模型本次**可达**,run-agent 走真跑(→ submitted);模型缺席时落 blocked,脚本对两路皆判走通。

| # | 步骤 | 结果 |
|---|---|---|
| 1 | backend-ready(uvicorn @127.0.0.1:8099) | PASS |
| 2 | model-config | PASS(configured,真跑) |
| 3 | login-boss | PASS |
| 4 | create-project(功能迭代模板) | PASS(8 任务·3 门) |
| 5 | ai-decompose(营销物料;模型缺席回退不算失败) | PASS(6 任务) |
| 6 | smart-assign(suggest→逐条 assign) | PASS(派 8 人;design→Agent·Design) |
| 7 | brief-submit | PASS(→ done) |
| 8 | prd-submit-v1 | PASS(→ submitted) |
| 9 | prd-reject(批注注入) | PASS(→ rework) |
| 10 | prd-resubmit-v2 | PASS(versions=2) |
| 11 | prd-approve-unlock | PASS(prd=done · design=**assigned**,agent 待执行) |
| 12 | channel-review-rows | PASS(13 行,含 review/event) |
| 13 | channel-say-mention(@Andy) | PASS |
| 14 | channel-grow-task(+任务确认→图长新节点) | PASS(origin=channel) |
| 15 | **browser-ready**(Playwright 拉起,run-agent+截图共用 page) | PASS |
| 16 | **run-agent(设计稿)· UI 路径** | PASS(**双击节点开抽屉→点「执行」**→真跑→submitted·2 频道行) |
| 17 | login-andy | PASS |
| 18 | andy-inbox | PASS(待我做 2·生长卡有·@我 1) |
| 19 | andy-notifications | PASS(未读 3) |
| 20–34 | 14 屏截图(浅/深) | PASS ×15(含 popover/抽屉裁定项;s7 抽屉 trace = UI「执行」产出) |

> 步 16 是终审 #1 的证据:run-agent 不再直打 API,而是走 `runAgentViaUI`(双击画布节点开抽屉→
> `getByRole("button", {name:"执行"})` 点击)。s7「抽屉·dark」截图的真 run_subagent trace 从此是
> UI 可复现路径(设计 assigned+agent → drawerOps 主按钮=执行)。

### 截图索引(`walkthrough/`)

F6(14 屏):
- 三区:`crew-s1-threezone-light.png` / `crew-s1d-threezone-dark.png`
- 收件箱 Boss:`crew-s2-inbox-boss-light.png` / `crew-s2d-inbox-boss-dark.png`
- 收件箱 Andy:`crew-s3-inbox-andy-light.png` / `crew-s3d-inbox-andy-dark.png`
- 通知铃弹卡:`crew-s4-bell-andy-light.png` / `crew-s4d-bell-andy-dark.png`
- 花名册:`crew-s5-roster-light.png` / `crew-s5d-roster-dark.png`
- 模板:`crew-s6-templates-light.png` / `crew-s6d-templates-dark.png`
- 抽屉(深,含真 run trace):`crew-s7-drawer-dark.png`
- 轻检视 popover(浅):`crew-s8-popover-light.png`

F2 留存(7 屏,一并归档):`f2-s1..s6`(初始/执行/评审浅深/返工/解锁/点名环)。

关键实证:s1/s1d 三区 = 画布七态 + 供电边流入设计稿 + 频道五卡族 + Boss 米白纸气泡;
s2d Boss 待我审 = 金菱「设计评审」卡;s3/s3d Andy「由频道生长」行(F6 补字段落地);
s7 抽屉 = 真 run_subagent 执行 trace(回合→步骤→模型真产出)。

## 5. 七态章统一裁定(F4⑨ 评估)

**裁定:部分统一——共用内层图元,外框维持双实现。**

- `graph/TaskNode.tsx` 的 `StateBadge`(16px·`crewg-badge`·含落笔动画,ChartingTable.css/F2 所有权)
  与 `inspect/StateSeal.tsx` 的 `StateSeal`(13px·`ir-insp-seal`,inspect.css/F4 所有权)图元(色盲
  安全 SVG 笔画)字节相同 → 抽 `pages/crew/stateSealGlyph.tsx` 供两处 import,消除坐标重复
  (形状语汇是一套系统,1c;两处必须同形,避免勾/回环/叹号在一处改另一处漏)。
- **不硬统一外框**,理由:①硬规格尺寸不同(16px 画布章 per 1c vs 13px inspect 章);
  ②CSS 所有权分属两文件、各带自己的深色 var;③画布章独有落笔(ink)动画,inspect 无。
  强行合并会把画布样式耦合进 inspect,得不偿失。以 `innerRingClassName`/`donePathClassName`
  两参承接两处前缀差异。

## 6. 深色逐屏核对结论

**结论:核对清白,零 CSS 改动。** F1–F5 已把深色做对,F6 走 static + 视觉双重核对确认:

- **静态**:crew/shell 全部 CSS 无硬编码主题色(仅 `#fff` 作彩底 SVG 描边=主题无关);
  JSX 内联 SVG 一律 `currentColor`;`tokens.css` 深色值齐全且合 1b
  (`--surface`#232328/`--surface-2`#1E1E22 · `--iris`#8B8ED9 · `--user`#EFEDE5 · `--gold`#A6996F ·
  `--delegate`#B87FD4);组件级 var 深色覆盖到位(channel.css `--chan-paper`/`--chan-gold-line`、
  inspect.css `--insp-*`、ChartingTable.css F2 已落)。
- **视觉**(7 屏深色截图逐屏核对,对照 1b):纸面 say=米白 #EFEDE5+墨字(s1d Boss 气泡)✓;
  附件卡=#232328→#1E1E22 暗渐(s1d/s7)✓;铃徽标=iris #8B8ED9(s4d)✓;金线=#A6996F 系
  (s1d 设计评审门 / s2d 评审卡金菱 / s6d 模板金门)✓;iris 亮化 + 供电边亮 iris(s1d)✓;
  抽屉/popover/共识/列表共用 inspect.css 已验深色 var 组(s7 抽屉深色实证,同文件其余同源可信)。

**重点覆盖**:收件箱(双视角浅深)、铃与弹卡、面板、花名册、模板、抽屉、popover、频道五卡、
画布(F2 已做)全部核对通过。

## 7. 已知边界 / 偏差(F6)

- **F6①(裁定)** 七态章部分统一(§5)——共用图元,外框双实现,附理由。
- **F6②** inbox `artifact_version` 为「最新已提交版本号」,前端 `reworkVersionPill` 渲染
  `v{n}→v{n+1}`(返工即将产出下一版);无版本历史则不带字段(零捏造)。origin 落全部 todo 卡
  (assigned/queued/rework),channel→OriginRow。
- **F6③(观察,非本轮修)** 成员(Andy)侧栏项目子列表为空(`list_projects` 按 owner 归集,
  见 s4d 背景)——成员默认落点=收件箱(1e),经收件箱/通知深链进画布,功能不缺;是否让成员在
  侧栏看到参与项目属产品取向题,留把关人/后续轮判定,**不在 F6 范围**(F1 既有行为,未改鉴权)。
- **F6④(e2e 纪律)** 脚本隔离 temp state/memory/runs DB,不污染 worktree `.anna`;
  收尾 `taskkill /T /F` 杀后端进程树 + 删 temp 目录;端口默认 8099(`CREW_E2E_PORT` 可覆盖)。
- **F6⑤** 走查登录态经 localStorage 注入 token（免登录桌面下 Crew=诚实空态,承 F1 裁定);
  深浅主题经 `localStorage['anna.theme']` 切换后 reload。

## 8. 终审修复(合并前最后一批,Opus,2026-07-20)

把关人终审裁定 6 findings(00-master-plan「终审」段,commit dad7651):#1–#4/#6 必修,#5 记 P1。
逐项 TDD(先补失败测试再修),两笔限定路径提交。四门最终:**780 pytest / 318 vitest / tsc 0 / build ✓ / e2e 34 步 PASS**。

### 8.1 findings 处置表

| # | 严重度 | 问题 | 修法 | 测试证据 |
|---|---|---|---|---|
| #1 | 高 | run-agent 无 UI 触发入口(e2e 直打 API 绕过) | 显式「执行」按钮三入口(抽屉/轻检视 dossier/列表行尾),条件=agent-kind assignee 且 status∈{assigned,rework};`lib/api/crew.ts` +`runAgentTask`、`inspectModel` +`canRunAgent`/`withAgentRun`、`useTaskOps` +`execute` op;e2e run-agent 改 Playwright 点「执行」 | vitest `canRunAgent`×7 + `withAgentRun`×3;e2e 步 16「UI「执行」→真跑→submitted」 |
| #2 | 中 | 通知幂等键漏收件人→多 @ 只通知第一人 | `_emit_notification` 键 `{kind}:{task_id}:{ref}`→`{kind}:{task_id}:{to}:{ref}` | `test_say_notifies_every_mentioned_recipient`(一条 say @两人 → 各 1 条) |
| #3 | 中 | 同命令行二次 confirm 重复建任务 | `confirm_drafts` 开头查 `created_from_message_id==source_message_id` 命中→返回现 project(200 幂等) | `test_confirm_is_idempotent_by_source_message`(二次 confirm 不增任务/频道行/通知/审计) |
| #4 | 中(#1 修后升必修) | 重叠 run-agent 双跑 | manager 按 task_id 记在飞 run;`submit` 命中活跃 run→返既有 run_ref(200 幂等),run 抵终态于 `_drive` 清理 | `test_run_agent_submit_dedupes_in_flight_run`(事件门控 executor:两 submit 同 run_ref、executor 只跑 1 次) |
| #5 | P1(不修) | 崩溃悬置 running 帧无终点 | **已知边界**:进程崩溃后遗留 running 帧无终结器;记跟进(见 8.2)——非本轮修 | — |
| #6 | 顺修 | 投影 locked 误当空表 | `approvals_projection` 抽 `_read_run_payloads`;`no such table`→[](不重试)、`locked` 等→短等重试一次、仍失败→[] 且 WARNING(不静默吞未知失败) | `test_projection_no_such_table_...` / `..._retries_once_on_locked_...` / `..._persistent_lock_returns_empty_but_warns` |

### 8.2 已知边界 #5(P1,合并后跟进)

后台 run 若在进程崩溃/强杀时正处 running,其 run_store 记录与最后一帧停在非终态,无重启期的
终结器把它收敛为 `failed`(L3 断线恢复覆盖正常断线,不覆盖“崩溃时正在 running”这一窗)。当前不阻塞:
run-agent 的正常失败路径已 `blocked`+阻塞行(绝不假完成),此仅限崩溃窗;裁定记 **P1**,建议后续轮加
启动期悬挂-run 清扫(把非终态孤儿 run 标 `failed` 并补一条终帧)。

### 8.3 新增测试清单

- 后端(+6):`tests/crew/test_channel_and_notify.py::test_say_notifies_every_mentioned_recipient`;
  `tests/crew/test_channel_command.py::test_confirm_is_idempotent_by_source_message`;
  `tests/api/test_crew_api.py::test_run_agent_submit_dedupes_in_flight_run`;
  `tests/crew/test_inbox_and_approvals.py` ×3(no-such-table / locked-retry / persistent-lock-warns)。
- 前端(+10):`inspect/__tests__/inspectModel.test.ts` `canRunAgent`×7 + `withAgentRun`×3。

### 8.4 提交(两笔,限定路径)

- ①后端 #2/#3/#4/#6:`services/crew/app/service.py`、`services/api/app/routes/crew.py`、
  `services/crew/app/approvals_projection.py` + 三后端测试文件。
- ②前端 #1 + e2e + 验收:`apps/desktop/src/**`(api/inspect/DetailPage/css)+ `scripts/live-crew-e2e.mjs`
  + 本文件。
