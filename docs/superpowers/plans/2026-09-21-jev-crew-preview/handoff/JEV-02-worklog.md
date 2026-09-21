# JEV-02 工作记录

## 接管与合同

- Owner：`01a0c326-a317-7182-afa6-f2f50159160f`，Astra xhigh；2026-09-21收到源owner正式转移授权。
- 唯一工作树：`$ANNA_REPO_ROOT`；branch：`codex/jev-crew-preview-20260921`。
- Pre-change SHA：`dc4bf0f03604f8cf2f7e1ec838ef27b184a188cc`；接管时工作树干净。
- JEV-01 accepted code：`59579c38a8ac62f211559bbe5366ea39c063cc35`；r6八文件hash再次核对一致。
- JEV-02：R02—06 / AC06—15；公共测试seam由SPEC/AC预先批准，按TDD逐切片实现。完整32例四组对照、真实Worker终态与整仓最终检查留JEV-03。

## Writer与顺序

- `/root/jev02_coding`：`gpt-5.6-luna/high`，`fork_turns=none`。一名writer顺序完成建议/取消、原子采纳、MemberPicker；保留两个独立Astra审查槽。
- 第一切片：`assignment_suggestions.py`、`harness_client.py`、API `main.py/routes/crew.py`、新建议API/service测试及现有Host client测试。精确ownership见STATUS；无真实API调用权。
- Supervisor只写计划/验收记录并执行独立检查；产品代码、测试、评测工具实现全部由Luna负责。

## 接口核对与实施约束

- 原手动assign和旧matcher/自动推进不变。带decision_id的持久receipt重放必须先于首次采纳任务状态守卫，避免任务后续running/done时误拒绝重复请求。
- store已有BEGIN IMMEDIATE事务与CAS，仅允许必要的no-change duplicate支持，不扩展持久表/outbox。
- cancel与采纳共享短期记录锁序；record锁不跨Host网络等待。提交后频道/通知/dispatch分别best-effort，失败不能回滚已提交Assignment或阻断其他effect。
- 现有前端Vitest是node环境；仓库已有esbuild+Playwright真实渲染公共组件测试方式，可沿用而不新增DOM依赖。

## 实测预算起点

- Jev累计8请求；4151输入/371输出tokens；按官方单价估算`$0.000174342`，不是确认账单。
- 主模型0请求；reserved0、unknown=false；24 heldout未调用。
- 同一预算账：`$ANNA_STATE_ROOT/budget-ledger.json`。本票UI调用也必须预留、结算并延续此账；不会换Session归零。
- 真实Key/主模型配置仅由Host/评测程序按LAUNCH引用读取，Supervisor不cat配置。尚未执行JEV-02 live。

## 后端 r1 时的状态（历史）

后端第一/二切片已暂时交权并冻结为 `evals/jev-crew/jev02-backend-r1/candidate.sha256`，独立Standards/Spec审查正在进行；Luna仅继续第三切片前端。尚未验收全票或执行live。

## 原子采纳前的相关基线

- 主控运行 `./.venv/bin/python -m pytest -q tests/crew/test_crew_store.py tests/crew/test_auto_trigger.py tests/crew/test_channel_and_notify.py`：exit 0，38 passed in 0.76s。
- 日志：`evals/jev-crew/jev02-baseline/python-transitions.log`。运行后确认以上三测试及service/store/lifecycle相对pre-change均无diff；这是采纳切片前的行为基线，不是JEV-02验收结果。
- Playwright Chromium可执行文件已确认存在，前端真实渲染无需安装额外依赖。

## 第一切片开发中检查

- 主控运行 `./.venv/bin/python -m pytest -q tests/business/test_harness_client.py tests/crew/test_assignment_suggestions.py tests/api/test_crew_assignment_suggestions.py`：exit 0，19 passed，1项既有Starlette/httpx弃用提示。
- 日志：`evals/jev-crew/jev02-baseline/python-suggestions-development.log`。writer尚未冻结交权，此结果仅为开发中检查；容量/TTL/scope/依赖指纹等完整AC边界仍需补齐后验收。
- 实现中反馈：异步Host测试须使用async_transport；避免没有调用方的重复async别名；指纹须含直接依赖状态；非空角色及长度硬检查在规则路径同样适用。

## 后端r1固定候选

- 主控运行 `./.venv/bin/python -m pytest -q tests/business/test_harness_client.py tests/business/test_host_runtime.py tests/crew/test_assignment_suggestions.py tests/api/test_crew_assignment_suggestions.py tests/crew/test_crew_store.py tests/crew/test_auto_trigger.py tests/crew/test_channel_and_notify.py tests/api/test_crew_api.py`：exit 0，115 passed in 8.54s，53项既有FastAPI/Starlette弃用warning。
- 日志：`evals/jev-crew/jev02-backend-r1/python-tests.log`；前后10文件hash校验一致。该轮为固定后端候选，不是UI或live验收。
- Standards：`/root/jev02_standards_review`；Spec：`/root/jev02_spec_review`；两者 `gpt-6-astra/xhigh`、fork none，各自独立只读审查，不互读发现。
- Luna前端继续：已授权API/types/hook/MemberPicker/抽屉与浮层/Page接线、局部样式和Playwright真实渲染测试。后端写权暂收回，发现汇总后再授权修复。
- 采纳实现中已要求：复用原store事务的窄no-change分支、取消锁仅覆盖缓存复核/提交/采纳标记、effects在锁外、完整scope稳定effect ID。是否全部满足由独立审查核验。

## 后端r1独立审查

- Standards：1项P2 hard breach，工作线程直接cancel asyncio Task。reviewer公共suggest/cancel探针在asyncio debug模式报Non-thread-safe operation，exit1；其独立4文件pytest为38 passed/exit0。无其他需处理的smell。
- Spec：3项P2：同一跨线程取消错误（SPEC5/AC08）；16KiB计量使用真实ID内部state而非c1…cN provider state（SPEC4.1/AC07，16384B有效provider输入被16489B内部state误拒）；缓存canceled/conflict先于durable receipt拒绝（SPEC6/AC12，两个独立collaborator共用SQLite时已提交done receipt被旧tombstone阻断，普通单实例restart duplicate通过）。
- Spec额外本地fixture检查并发receipt、stale、Human/blocked/ready、无关消息/displayname、过期和effects独立失败均exit0；asyncio debug下取消测试挂起22.45秒，reviewer仅中断其自身测试，exit2。
- 两轴前后10文件hash均一致；未调用模型或读取秘密。三类修复已由owner恢复后端写权交给同一Luna，修复后必须新冻结轮复核。此处不把两轴报告合并为一轴或将测试绿色当验收通过。

## UI初稿主控反馈（未验收）

- ready结果不能清掉用于DELETE的request标识；关闭ready建议也要取消。
- scope变更必须用原project/task的cancel调用，不能用更新后的actions闭包取消旧任务；同时清空旧suggestion，核对返回project/task/decision。
- expires_at必须进入真实过期展示与采纳禁用；测试返回的decision_id应echo请求，正常路径fixture使用未过期时间。
- 展示尚未指派、member_kind事实、blocked等待/ready Worker执行提示；采纳pending禁用按钮，待定/不可用/过期区分。
- 真实render测试已开始写入；已要求如实记录哪些切片有RED证据，不得事后删实现伪造RED。

## UI实测环境准备

- 新建隔离目录 `$ANNA_STATE_ROOT/jev02-ui-r1/`，仅写入新空Host配置和合成business配置（独立state/runs/memory路径、demo身份）。未复制任何模型凭据、旧数据库或旧配置。
- 此准备命令exit0，未启动产品服务、未发送模型请求。计划用当前模板的合成Human任务通过真实UI生成Jev建议并采纳，Worker实测继续留JEV-03。
- 真正点击前仍需代码/测试/两轴检查，以及同一预算账的预留与结算；准备目录不构成live证据。

## 完整候选r2核验

- 固定20文件：`evals/jev-crew/jev02-contract-r2/candidate.sha256`。root复跑Playwright `node --test --test-timeout=15000 tests/frontend/jev_member_picker.test.mjs`：4 passed/exit0；`npx tsc --noEmit --pretty false`：exit0；`git diff --check`：exit0。
- root常规相关Python8文件suite：118 passed in 8.67s/exit0，日志`python-normal-tests.log`；两条新取消测试在PYTHONASYNCIODEBUG=1下2 passed/exit0，日志`python-cancel-debug.log`。
- 扩大全套到asyncio debug的首次运行未完成，root仅终止自己的PID76932，exit143，原日志`python-tests.log`保留。带faulthandler的debug复跑仍停在旧API测试shutdown，35秒自限exit143，日志`python-debug-rerun.log`。两个基线单case隔离探针通过，尚不能据此定性全组挂起；继续基线整文件对照，不修改断言或旧运行时。
- r2独立Standards确认原P2关闭，新增1项UI P2：ready取消后重开仍显示旧建议。
- r2独立Spec确认后端3项P2关闭，新增3项UI P2：上述ready重开问题；浮层打开期间过期未更新/采纳前未检查；提交后的采纳按钮未禁用（sync ref防双请求已有效）。server仍拒绝expired/canceled，不声称越过后端采纳保护。
- 三项UI修复已仅授权Luna原UI文件；后端保持冻结，修复后新轮补验。此时无live调用。

## r3与debug边界

- r3 root实际：真实render7 passed/exit0、tsc exit0、frontend build exit0（7.95s，既有大chunk提示）。20文件hash在`jev02-contract-r3/candidate.sha256`；后端与r2一致。
- 扩展debug挂起已确认可在本票pre-change基线复现：只读git-show模块加载替换所有本票修改的Python模块，完整旧`tests/api/test_crew_api.py`停在`test_source_message_start_execution_is_stable_across_project_versions`的Starlette shutdown；20秒faulthandler留栈，35秒自限exit143。日志`jev02-contract-r2/baseline-api-debug.log`包含实际基线模块hash；这项扩展检查不算通过，不改旧运行时。
- r3 Standards：0剩余。r3 Spec：原3项UI P2已关闭；剩1项P2（SPEC168-170/187、AC10/13）：采纳开始提前清request句柄，导致采纳等待中或409失败后Esc不发DELETE。已只派Luna修hook与相应真实render回归，保留有效期与原scope取消能力直到成功。
- 隔离服务已由当前owner启动：Host `http://127.0.0.1:49780`，business `http://127.0.0.1:49781`，owner launcher PID81665、Host81669、business81668，exec session41619。仅这些本票服务归本任务管理；尚无JEV-02模型请求。待代码gate通过后才预留预算并点击建议。

## r4/r5交叉状态复核

- r4 root：真实render9 passed/exit0、tsc/build exit0；Standards 0；Spec原取消句柄项关闭，但旧采纳成功响应可清新project/task请求并关闭新Picker。
- r5加入operation generation及Page的带decision_id刷新project guard；root实际10 render/tsc/build均exit0（日志`jev02-contract-r5/`）。Standards复现新scope遗留busy；Spec确认跨project/task已修、同scope关闭重开新request_id仍可能被旧success覆盖，并确认busy问题。
- 两项已仅交Luna在hook/render测试中修：关闭/新轮/切scope使旧adoption失效；每个callback只作用自己的request/operation；清理旧busy不影响新操作busy。没有扩展manual派工策略。
- 隔离环境通过现有POST projects+marketing_collateral模板建立合成`proj_1/task_1_brief`，初始todo未指派，role_required=PM；business状态完全隔离。`project-before.json`留证。浏览器已登录内置demo身份并打开该任务节点，尚未点击建议，未消费Jev。

## r6/r7 最终代码门禁

- r6 root：真实render11 passed、tsc/build exit0；原跨scope/同scope旧adoption问题已修。Spec补验发现采纳pending时仍可生成新建议，可能遗留busy；仅派Luna在MemberPicker/hook及已有render回归加入禁用与同步ref守卫。
- r7冻结20文件：`evals/jev-crew/jev02-contract-r7/candidate.sha256`。root运行 `node --test --test-timeout=15000 tests/frontend/jev_member_picker.test.mjs`：11 passed/exit0，`npx tsc --noEmit --pretty false`：exit0，`npm run build`：exit0，`git diff --check`：exit0。build仅有既有大chunk提示。
- 后端10文件r2至r7逐项hash一致，沿用root的118 passed及2条asyncio debug取消回归证据，不因纯UI变化重复整套后端检查。JEV-01 Host八文件仍与accepted r6一致。
- r7独立Standards与Spec均0剩余代码/fixture门禁findings。Standards另跑真实render定向探针exit0，确认采纳中不可重新生成、完成后busy=false；未将读取root的typecheck/build日志说成reviewer独立重跑。
- Writer报告实际RED包括初始建议模块缺失（pytest exit4）、store no-change行为测试失败、真实Chromium crypto.randomUUID与localStorage origin错误、初版取消/迟到超时以及审查发现复现。部分早期RED仅留对话执行记录，没有独立日志文件；这些开发环境错误不等同全部业务需求都有完整独立RED日志。没有事后删实现伪造RED。
- 全部产品/测试实现由同一Luna high完成。Supervisor只执行检查、处理证据与文档；全部20文件写权已交回，无writer遗留进程。

## jev02-ui-r1 真实闭环与预算结算

- 在r7源文件与build指纹固定后，真实浏览器点击 `task_1_brief` 的建议按钮。默认路径实际调用生产Host与Jev，未用force覆盖；PM与产品角色不同，未走精确规则。
- Jev实际模型 `jev-1.13.0`，decision `9f664eca-7ccb-4dce-aa85-678521ecca11`，Host判断耗时667ms，648输入/68输出tokens，1请求/0retry，source=jev，选择Human `acc_boss`。生成后任务仍未指派；UI点击采纳后API/SQLite回读assigned、run_ref=null与同decision持久receipt。
- 顺序重复采纳HTTP200，receipt/频道/通知各1，cancel-after-commit为already_applied；Host canonical events为0。
- 第二次真实UI走唯一文案role规则，显示未调用模型；采纳给blocked的Agent·Scribe后仍blocked且run_ref=null。总receipt/频道/通知各2、Jev记录仍1、主模型调用0。截图和原始读回见 `evals/jev-crew/jev02-ui-r1/REPORT.md`。
- 实际UI点击由监督agent执行，不声称用户本人点击；667ms仅Host inference耗时，不是E2E；provider confidence不作业务成功率。
- 同一账累计Jev9请求，4799输入/439输出tokens，估算累计$0.000201558，reserved0、unknown=false；主模型0请求。剩491次Jev请求、约$1.999798442 Jev额度、100次主模型请求、约$9.999798442总额度。不是确认账单。24 heldout仍未调用。
- 当前owner启动的launcher PID81665收到TERM后exec session41619返回exit0与stopped；Host81669/business81668随launcher正常关闭，临时浏览器tab已关闭。合成state及证据保留；未终止其他任务进程。

## 未验证边界

AC16 ready Worker真实执行终态、固定32例A/B/C/D、最终整仓检查、公开首页/发布草稿留JEV-03。不可用/取消/并发/ready Worker policy目前为确定性公共接口或真实render证据，不冒充真实模型执行。扩大的asyncio debug全套仍为基线可复现的shutdown挂起，保留原失败/超时日志，不计通过；常规相关118及新debug取消2通过。未验安装包、Windows/Linux或远程发布。

## 最终独立验收与提交检查

- Spec独立核对原始JSON、5张截图与报告后确认AC15通过；20文件/build manifest及两组JSON一致性断言exit0。两轴结论和证据层次汇总于 `evals/jev-crew/jev02-contract-r7/REVIEW.md`。
- r7源码20/20、JEV-01源码8/8、当前build、SPEC/AC和两份冻结fixture hash均再次核对一致；公开证据秘密模式扫描无候选命中，未读取实际Key。
- 包含原始日志的 `git diff --cached --check` 返回exit2，仅四份pytest日志自带的弃用warning末尾空白；源代码/文档检查exit0。原始日志字节保留，未为使检查绿色改写实际输出。四份日志为 `jev02-backend-r1/python-tests.log`、`jev02-contract-r2/{baseline-active-agent-debug.log,baseline-debug-probe.log,python-normal-tests.log}`。
