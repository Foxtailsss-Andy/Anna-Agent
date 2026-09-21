# JEV-01 Supervisor 工作记录

日期：2026-09-21。Owner：`01a0c2dd-b2cc-7223-b712-af209f26df14`。

## 固定起点与文件归属

- Worktree：`$ANNA_REPO_ROOT`。
- Branch：`codex/jev-crew-preview-20260921`；pre-change SHA：`503408e8f01a6b55b2c85f94cb94cd5b8b462bc3`。
- Owner 转移已明确授权；起点工作树干净；SPEC/AC hash 与 SPEC-REVIEW 相同。
- 本票：R01/R02/R06，AC01—05，AC17 fixture/smoke。24 heldout 不作开发测量。
- Writer：`/root/jev01_coding`，`gpt-5.6-luna/high`，`fork_turns=none`。
- 第一切片独占：`apps/harness-service/src/jev-decision.ts`、`apps/harness-service/src/product-facade.ts`、`apps/harness-service/src/main.ts`、`apps/harness-service/test/jev-decision.test.ts`、`apps/desktop/electron/runtime-service.mjs`、`tests/frontend/jev_runtime_env.test.mjs`。
- Supervisor 独占本计划的 STATUS/执行证据/交接文档；不实现产品代码、测试或评测工具。
- 独立数据切片：`/root/jev01_fixtures`，Luna high / fork none，仅写 `evals/jev-crew/fixtures/{development,heldout,manifest}.json`；R02/R06、AC17。数据合同已固定，文件不与 Host writer 交叉，按 SUPERVISOR 的独立集合例外并行；冻结前由 Astra 预审。两名 writer 均无 live 授权。

## 环境与起点检查

- Node `v24.12.0`，npm `11.6.2`，uv `0.11.7`，Python `3.12.13`。
- 本树执行 `npm ci`；未升级 package/lock。
- `uv sync --locked --extra dev`：exit 0，安装51项依赖到本树 `.venv`。
- `node --test tests/frontend/product_runtime.test.mjs`：exit 0，4 passed。
- `node --test tests/frontend/electron_runtime.test.mjs`：exit 1，15 passed / 6 failed。运行时产品代码尚无 diff。该历史 Preview 套件仍断言旧 preload mode/打包布局及旧配置结构；失败项包括 preload、package scripts、missing Host entry、branded executable、ASAR smoke、runtime info。保持历史失败，不修改旧断言来让本票通过。
- `npm run test --workspace=@anna/harness-service -- test/product-facade.test.ts`：exit 0，4 passed。
- `ANNA_OMP_BUN_ARCHIVE_URL=https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-darwin-aarch64.zip npm run harness:omp:prepare`：exit 0，独立准备固定 OMP runtime（Bun 1.3.14，21,465 manifest files），未触发模型。Manifest SHA256 `168da57a60493b094ea6b2525f312c3e05a6585ffc167cba2a7b9c5beb6719ec`；lock SHA256 `f5a96c28a0187d549959fbe33c78596198491df29be9ea18424bf814fea88ceb`。

## 官方协议核对

2026-09-21 读取 [官方 API](https://docs.typesafe.ai/api) 和 [官方 Models](https://docs.typesafe.ai/models)。

- 原生 HTTPS POST `/v1/systemone`，Bearer 鉴权。请求包含 state、model、具名 questions；Choice 使用 instructions 和 criteria。
- 响应由 model、具名 answers、usage 组成；Choice 提供 choice、probabilities、confidence，usage 使用 input_tokens/output_tokens。
- 固定请求版本 `jev-1.13.0`；响应实际版本另记。本产品不使用 SDK 默认重试。
- 官方输入价 `$0.042 / 1M tokens`，输出免费；价格日期为本次核对日。此为估算依据，不能声称 provider 账单已确认。

## 预算与 live 闸口

- 交接累计 Jev provider requests `0`、生成模型 provider requests `0`、估算支出 `$0`。
- 跨票上限：Jev `$2` 或500请求；生成模型100请求；全部模型 `$10`，对应上限先到即停止。
- 未向 Coding writer 开放真实调用。先审输入/标签、请求构造、工具的次数与费用约束，再授权单次 smoke；usage unknown 时保守记账并暂停新增批量请求。
- 凭据只由 Host/评测程序按 LAUNCH 引用读取。本次只核对文件 metadata（0600，父目录0700），未读取内容。

## 当前证据边界

尚无新功能通过、Jev连通/质量、UI采纳或Worker完成证据。后续实际命令、退出码和各轮记录逐项追加；本工作记录不能替代最终候选验收。

## Fixture 预审与冻结

Astra 主控独立读取全部32个输入/标签，已在任何 live 前修正自动化任务的无依据 Worker 偏好、正确候选恒排首位的顺序偏差，以及虚构批量 scope 的预检；后者改为真实 `is_gate=true` 任务字段。预审通过不代表模型效果通过。

- Development：8例（4可区分、2歧义、2无适合），7例 provider eligible，正确候选位置1/2各2例。
- Heldout：24例（12可区分、6歧义、6无适合），22例 provider eligible，正确候选位置1/2各6例。
- 合计29例有效模型输入、3例硬预检。相同(role,kind)候选无法区分必须弃权；不凭姓名/ID/顺序/虚构技能定标签。
- `development.json` SHA256：`badb37094dbe2cbda1f37482214847591592d9d61ce85651516c04b7384fdfbe`。
- `heldout.json` SHA256：`b1cbc119add5493bf0256825c10e81a3bd486428066028d04811c061f7654f66`。
- 主控独立复算 manifest hash、数量、候选正确位置，exit 0。Heldout 未调用，禁止用它调参。
- Fixture writer 已交回三文件权。后续独立切片授权该 writer 仅修改 `scripts/jev-crew-eval.mjs` 与 `scripts/jev-crew-eval.test.mjs`；实现固定开发集 smoke、生产 Host HTTP、持久预算和 CLI 公共边界测试，无 live 授权。

## 增量验证（非最终验收）

2026-09-21 15:59 Asia/Shanghai，Host writer 仍在补充验收边界；当前源文件快照通过以下检查。不得将此阶段结果当作最终候选全部 AC 通过。

- `npm run test --workspace=@anna/harness-service -- test/jev-decision.test.ts`：exit 0，8 passed，4.47秒。
- `node --test tests/frontend/jev_runtime_env.test.mjs`：exit 0，1 passed。
- 尚需补齐并发/名额释放、慢body、provider流大小、取消/关闭、格式错误及真实文件能力保护等合同证据，再做独立审查。

## Host 候选 r1 与独立 Standards 审查

- Luna 已交回六文件权；作者报告最初 RED 为旧路由404，exit1。后续 Host14/14、facade4/4、launcher/product5/5、typecheck/diffcheck通过。
- 主控冻结候选后复跑 Host+facade：18 passed，exit0；launcher/product：5 passed，exit0；`npm run harness:v2:build` exit0。原始日志在 `evals/jev-crew/jev01-contract-r1/`。未运行模型。
- 独立 reviewer `/root/jev01_standards_review`，Astra xhigh/fork none，读取 dirty tracked diff 与三个新文件；固定基线仍为503408e8，不使用空三点diff作通过证据。
- Standards 发现2项P2（均本地真实HTTP复现）：非2xx provider body未关闭，5次401后的5条流超过4.2秒且Host close后仍打开；慢chunked请求体keep-alive在约4秒收到408后socket仍存活，Host close仍等待。现有14项测试均通过但未覆盖此资源清理问题。
- 已派原 Luna Host writer按RED→GREEN修复两项；同时补回主控发现的R02同(role,kind)必须弃权收窄，保留raw选择/真实usage，不由eval制造政策结果。修复后仅补跑相关检查和审查delta。
- 未完成独立 Spec 轴：主控和 Standards reviewer分别尝试创建独立Astra Spec子Agent，工具均报 `agent thread limit reached`；完成/interrupt旧writer未释放槽位。没有降低模型或把主控检查冒充独立Spec通过。
- 处理方式：后继 JEV-02 Supervisor 的只读接管握手承担独立 Spec 核验；它在此阶段不拥有派实现任务或写产品文件的权限。当前 owner 完成修复/live/证据冻结，收到独立 Spec 结果并完成 JEV-01 验收后，才转移 owner 并授权 JEV-02。提前只读握手不代表提前接受本票。
- 后继 Session 应保留两个独立 Astra 审查槽：优先复用一名 Luna 顺序实现代码/fixture/工具。当前环境的已完成子任务仍占线程槽；不要假定完成或 interrupt 能回收。

## 评测工具预审

独立 Luna Eval writer继续CLI实现；主控要求修正真实OMP启动定位、dirty源码/编译件hash锁定、现有预算账不归零及原子持久化、未知/未结请求停止、Host HTTP与进程有界退出、按decision_id拼接脱敏inference日志；移除无需要的外部Host URL选项。全部live仍未授权，原始Key未读取。

## 后续复核与修复（进行中）

- Host r2：主控实际20/20 Host+facade、5/5 launcher、typecheck/build全部exit0，日志在 `evals/jev-crew/jev01-contract-r2/`。独立 reviewer确认非2xx流与deadline路径已修复，但发现Host主动关闭和提前413仍未清理未完成body。
- Host r3：Luna报告23/23、typecheck及launcher5/5通过。Reviewer独立验证deadline408、Hostclose503、Content-Length413、缺/错auth401、busy429均正确关闭；无Content-Length的chunked >32KiB半包仍返回400/keep-alive，socket与Host close在5.5秒后仍未收束。该剩余P2已派r4修复。
- 主控另在r4要求按既定SPEC修正16KiB provider state上限的input_too_large分类，以及合法Choice缺失概率metadata时记null而非伪造0或错误拒绝；没有改变闭集/概率值合法性校验或增加阈值。
- Eval r1：主控实际9/9、node--check、dry-run exit0；dry-run requests_sent=0、heldout_requests=0。独立 reviewer复现3项P2：main_model.unknown_usage未阻止新请求；同round并发可重复case并损坏resume；SIGTERM CLI遗留owned Host子进程。均已交原Luna Eval writer按RED→GREEN修复。
- 首个live计划使用隔离空主模型配置与用户受保护Jev Key引用，证明真实Host不依赖主模型配置。CLI应区分fixture/live输出、保护未结预算、保留所有失败与not_run槽位。
- 当前Jev/主模型provider请求仍为0；不能把上述确定性测试通过记为真实模型效果。

## 首次真实调用（r1，仅一例）

2026-09-21 16:49 Asia/Shanghai，主控在候选冻结/相关检查与真实Host build完成后执行：

```text
env -u ANNA_HARNESS_HOST_CONFIG_PATH -u ANNA_RUNTIME_CONFIG_PATH ANNA_JEV_API_KEY_FILE=<LAUNCH中的受保护Key文件> node scripts/jev-crew-eval.mjs --live --round jev01-development-20260921-r1 --limit 1
```

- 命令exit0；只消费dev-01，真实provider请求1，主模型0。Host由真实built main启动，使用隔离空主模型host.json；只有Host读取Jev Key，未在工具输出中读取秘密内容。
- 建议 `dev01-member-a`，符合冻结标签；实际返回 `jev-1.13.0`，input_tokens=506、output_tokens=44，Host判断675ms、HTTP约694.443ms。
- input价$0.042/M、output免费；估算累计 `$0.000021252`，预算ledger在LAUNCH隔离state目录，reserved=0、unknown=false。该估算不等于确认provider账单。
- 原始JSONL/summary/round位于 `evals/jev-crew/runs/jev01-development-20260921-r1/`，保留剩余7个not_run槽位。未运行heldout。
- 发现该版本JSONL顶层error_code错误回落为正常reason_code（Host内部meta.error_code实际null）；原始记录不改写。与此同时独立Standards发现round未锁定fixture/live模式，已派CLI定向修正。修正后另开完整开发smoke r2，不能在不同指纹上resume r1或拼最优结果。
- 新Supervisor `01a0c326-a317-7182-afa6-f2f50159160f` 正独立Spec核验；owner未转移。一次真实成功只证明连通与该例，不等同整票/产品通过。

## 两轴最后补验

- 独立Spec r4发现P1清理等待（late Response未cancel、超限reader.cancel无界）、P2错误分支丢已知request ID、P2 Host startup失败缺summary。已分别由两个Luna writer修复；CLI最终hash `e84449c7e6863ad22d8d0ca0028c110227c6bbcb57a944b35dbe251bdec70011`，test hash `255decd0487726c2716530c99e2f808a090ace00a18d2d5e6e11dd69652487ab`。
- r5主控实际Host+facade30/30、launcher5/5、eval15/15、harness typecheck/build均exit0，日志和八文件hash在 `evals/jev-crew/jev01-contract-r5/`。
- 独立Standards：最终Eval模式隔离/启动失败summary/并发/预算/实际CLI信号退出全部复验通过，0剩余；Host r5迟到Response与不可完成cancel及错误ID增量独立HTTP探针通过，0剩余。
- 独立Spec r5：原三个blocker已关闭，新增/残留一个P2窗口：Response已经交回但首次reader.read前signal已abort，readWithSignal直接throw、外层仅releaseLock，body cancelCount仍0。仅本地fixture证明，没有声称真实供应商发生泄漏。已交Luna统一reader所有权最终收尾，补同一微任务竞态测试；完成后两轴核对新指纹。
- 上述改动期间没有继续调用模型；累计仍是r1的一次Jev调用，保留集0、主模型0。

## 验收完成

- r6完成最后reader清理窗口：统一finally中的有界best-effort取消后释放锁，正常EOF不多余cancel。主控最终Host/facade31、launcher5、eval15全部通过，harness typecheck/build及八源文件/构建hash核对exit0；日志在`jev01-contract-r6/`。
- 独立Standards r6清理增量0剩余findings；独立Spec核验原所有blocker关闭，代码/fixture/tool无剩余blocker。
- 主控执行新r2完整开发轮，exit0，8个槽均有结果：7实际Jev调用（4正确推荐、3模型原始弃权）、1零候选预检，所有固定标签通过。无retry、无主模型/heldout调用。
- 新Supervisor独立逐条复核r2原始记录、账本、代码/构建/fixture指纹及最终检查日志，确认JEV-01的AC05/AC17开发smoke部分验收通过；所有代码变更均由Luna high完成，当前进入local commit与唯一owner交接。
- 最终r2报告与边界见`evals/jev-crew/runs/jev01-development-20260921-r2/REPORT.md`。累计费用与剩余预算以`handoff/JEV-01.md`和受控ledger为准，不以本日志历史时点的0或1请求数字为当前余额。
