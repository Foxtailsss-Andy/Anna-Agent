# JEV-03 工作记录

## 接管与边界

- Owner：`01a0c3dd-cf77-71e0-a7a4-f9328035f42a`，Astra xhigh；旧 owner 正式授权已收到。
- 唯一工作树：`$ANNA_REPO_ROOT`；branch `codex/jev-crew-preview-20260921`。
- Pre-change：`ba4b80d091703fffbe93fa7fe109bc885fdcd20f`，接管时 clean。JEV-02 accepted code `3e148390c119cf53c131953aaafebae192bbda49`。
- 握手检查：JEV-02 r7 20/20 工作区/HEAD/accepted blob 匹配；JEV-01 r6 8/8 匹配；build 5/5、UI artifacts 19/19、SPEC/AC 与 8+24 fixture hash 匹配。旧 owner 三个进程均不存在。
- 累计预算起点：Jev9、main0、估算 $0.000201558、reserved0、unknown=false；外部共享账与 JEV-02 budget-after 相同。现存评测记录仅开发集，24 heldout 尚未调用。
- 本票为 AC15—18：固定 A/B/C/D、ready Worker、整仓检查、两轴审查、中英文首页及发布候选。没有远程发布授权，不扩展旧 backlog/OMP/自动派工/权限策略。

## 实施与验证计划

1. Luna 通过已有 CLI、生产 Host/OMP transport 与实际 matcher 公共接口，逐切片完成对照工具、逐 provider 预算与脱敏记录；先确定性 RED/GREEN，再独立审查。
2. 冻结工具/输入/问题/价格指纹；先开发集验证主模型连通与预算观测，最终固定轮才用 heldout。保留所有 case/group 槽位、失败及成本；候选反转诊断只用开发集。
3. 通过真实隔离业务与 Host 验证 ready Worker 的 run_ref 与终态；明确区分指派、启动、产物、完成。
4. 最终候选全仓检查与独立 Standards/Spec 审查；准确更新本地首页、release 草稿及证据索引。

## 当前文件权与公共 seam

- `/root/jev03_coding`：Luna high，fork none。仅授权 `scripts/jev-crew-eval.mjs`、`scripts/jev-crew-eval.test.mjs`、必要的 `scripts/jev-crew-*.mjs/.py/.test.mjs`、新 `tests/crew/test_jev_evaluation.py`、`evals/jev-crew/jev03-tool-development/` 日志。产品代码/fixtures/labels/计划不在写权内；暂不授权任何 live 请求。
- TDD seam 已由 SPEC/AC 审定：CLI 真实输入/输出与预算阻断；真实 `deterministic_proposals`/`CrewMatchingService` 经 Host；生产 Jev HTTP adapter；模型 transport 只在外部边界替身。Supervisor 不实现评测工具。
- B 源码只消费项目目标、任务 title/role、roster ID/display_name/role/kind；公平核心统一至该语义字段集，description/acceptance 为空，display_name 使用局部 ID，无标签泄漏。B 的真实 fallback 保留并以调用证据解释。
- 旧 expanded asyncio-debug shutdown hang 保留为 pre-change 可复现局限；不改运行时或弱化断言。

## 首次整仓检查与窄修复

- `npm test -- --reporter=dot`：2026-09-21 12:15:40 UTC 启动，exit1；root Vitest 652 passed / 1 failed（57 files）。由于 `&&`，后续 Harness workspace tests 尚未运行。日志 `evals/jev-crew/jev03-repository-checks/npm-test.log`，相关输入 hash 在同目录 `npm-source.sha256`。
- 失败为既有中文标点检查，定位 JEV-02 新增 `MemberPicker.tsx` 两处「正在生成建议…」「正在采纳…」。已授权同一 Luna 仅将省略号改成六点形式并复跑标点与真实 render；不改测试政策/断言。这是本票 AC18 的有证据阻断修复。
- `npm run release:verify`：exit1，日志 `evals/jev-crew/jev03-repository-checks/public-boundary-initial.log`。扫描命中本计划/历史测试日志中的本机绝对路径与三份已入库 JSONL 证据扩展，无 `credential_marker` 命中；这是当前 Git 树的公开打包阻断。冻结 SPEC/fixture 与原始日志字节不因扫描而改写。当前交付仍为本地可审阅候选，远程发布需先形成符合公开边界的树及对应 CI。
- `npm run typecheck`：exit0，root frontend 与全部 Harness workspace 类型检查通过；日志同目录 `typecheck.log`。标点两处变更后启动第二次完整 `npm test -- --reporter=dot`，日志 `npm-test-r2.log`，运行前 npm 相关输入冻结于 `npm-source-r2.sha256`；尚未记录该运行通过。

## 开发中方向核验（未验收）

- 初稿不能用 JS 重写规则冒充 A 基线；A 必须调用真正的 Python `deterministic_proposals`。
- B 的保护必须下沉至每次真实 provider fetch，不能只预留一次再事后累计整段 Run；C、反转诊断和 Worker 共享同账。
- `split=all` 同样包含 heldout，必须受 final freeze 保护；未实现 adapter 不能标作真实 provider blocked。
- 传入 provider/request seam 的对象只含输入和必要 case 元信息，不包含 expected 标签；D 的严格 schema 不得被 display_name 等对照字段污染。
- 以上为 Supervisor 对进行中切片的反馈，未改变冻结 SPEC/AC、样本或标签；尚无 JEV-03 live 请求。
- Luna 交回标点文件，报告现有标点测试 1/1、eval 脚本 20/20、语法检查通过；暂未有独立持久日志，因此保留报告证据层级。A 已接 Python 真实规则，D 已接生产 HTTP；B/C 仍为未实现 adapter，Worker 只是记录接口，不能记验收或真实 provider blocked。
- Supervisor 曾中断扩展以收口设计，现恢复唯一 Luna 的评测工具写权，下一切片仅实现真实 B 的 `CrewMatchingService → HostHarnessRuntime → ProductTask → verified OMP`、外部 fetch fixture 与逐请求预算；暂不扩 C/Worker。产品 MemberPicker 写权已收回。
- 下一切片还需修 D 真实 `meta.provider_calls` 归一化、异常计数/全局停止、强制输入输出上限和官方 endpoint 价格校验；不得由返回聚合次数冒充逐调用预留。未开始新 live。
- root 独立 `node --test --test-timeout=15000 tests/frontend/jev_member_picker.test.mjs`：11 passed、exit0，日志 `jev03-repository-checks/member-picker.log`；覆盖窄标点修复后的实际渲染。
- root 完整 `./.venv/bin/python -m pytest -q`：1112 passed / 1 failed、exit1、49.66s。唯一失败 `test_gate_egress_no_hardcoded_remote_endpoint_in_services`：脚本内两处 TypeSafe 官方价格文档链接被识别为硬编码远程 endpoint。已授权 Luna 将静态价格/来源移至独立数据 JSON，测试配置同理与可执行源码分开；不得拼接 URL 规避扫描或修改断言。原始日志 `jev03-repository-checks/pytest.log` 保留。
- Luna 后续报告 eval21/21、egress gate8/8；仍未完成真实 Host 内逐 fetch 注入，故这次交回不构成 B 验收。Supervisor 继续授权同一 writer 通过已有生产公开工厂组合 eval-only Host，以真实 OMP+外部 fetch fixture 验证连续两次调用及第二次预算拒绝；未允许任何 live 请求。
- 环境独立核对：macOS 26.6.2 (25G83) arm64、Node v24.12.0、Python 3.12.13。合同及两组fixture hash再次匹配冻结记录。
- 第二轮整仓 `npm test -- --reporter=dot`：exit0，**1268 passed / 7 skipped / 0 failed**；日志从 20:22:09 到最后一组 20:39:18（Asia/Shanghai），Harness service 270 passed/1 skipped，真实 OMP kernel42 passed。root 对 `npm-source-r2.sha256` 运行后逐项校验exit0（`npm-source-r2-check.log`），证明运行期间相关 npm 源文件未变。评测工具的新增脚本测试另行验收，不混入这1268个。
- `npm run build`：2026-09-21 12:40:12.353—12:40:20.233 UTC，exit0，7.881s；日志 `jev03-repository-checks/build.log`、精确命令元数据 `build-command.json`。仅既有 large-chunk warning。本轮 served build 的5个文件 hash 在 `build.sha256`，历史r7 build manifest不改写。

## B 组工具装配诊断（未完成）

- Luna 报告真实 B probe 已通过 Host/OMP identity，但在 `run.eval.contract` 记录 `required_terminal_event`，终态 `runtime_bridge_failed`，fake HTTPS 计数0。尚未保存精确命令/日志前，仅记为 writer 报告，不能当独立验收。
- `runtime_bridge_failed` 为 runtime.ts 的通用异常映射，不能据此直接归因 OMP bridge 路径。Supervisor 静态核对发现 eval Host 传入 `root/workdir`，只创建 root；现有 managed launcher 要求 workspace 目录已存在。此项仅为待验证假设。
- 已要求同一 Luna 将现有 probe 变成可重复公共 seam 测试，保存真实RED，再单变量验证：创建workdir；预算回调提前异常；临时bundle路径。仅使用合成配置和外部HTTPS替身，不读取真实秘密。
- 临时打包不得制造另一套 Pi/OMP identity 或软化验证；应复用正式 Vite source identity/sidecar。已要求移除本切片自身的伪package symlink/重复descriptor算法，清理自身临时产物；不修改产品Runtime。
- 仍没有任何 JEV-03 live 请求，fixture/heldout/预算不变。C/Worker暂未接通，不能记provider blocked或完成。

## 价格核实

- 2026-09-21 官方 https://docs.typesafe.ai/models：Jev 输入 $0.042 / million tokens，输出免费，继续原预算口径。
- 同日官方 https://api-docs.deepseek.com/quick_start/pricing/：`deepseek-v4-pro` 当前版本 DeepSeek-V4-Pro-0813；peak input cache miss $1.32/M、cache hit $0.044/M、output $3.96/M，off-peak 减半。先按 peak/cache-miss 保守估算并标记为上界参考，绝不声称为确认账单。
- 只有实际 Host 配置对应该官方 provider/model 才可用此价格；其他 endpoint/model 先阻断核实。逐 provider 调用预留须覆盖受限输入与最大输出，未知 usage 停止新增批量。
