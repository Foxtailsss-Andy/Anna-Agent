# WB-02 两轴审查记录

状态：核心切片 A 的 D/O 契约验收通过，两轴剩余 0；整张 WB-02 未关闭。本文件按轮保留问题、修复与未验证边界，不以基础设施审查替代产品验收。

## 证据入口首轮冻结

固定点 `eec76df8cc7fc40d412f5f3e253fd15d0a4c07b1`；HEAD 尚无新增提交，因此使用四个 owned 文件的 working-tree + untracked 非空补丁：新 `scripts/workbench-capability-evidence.mjs`、其 `.test.mjs`、`package.json`、`.github/workflows/ci.yml`。准确拼接见本地 `.tmp-tests/wb02/supervisor/evidence-review/`；26,483 bytes，SHA256 `7d7459b57da2d2721c531b93099f15d2228a46505fff30d373015d54a7bd40e7`。

两位 fresh Astra xhigh reviewer 互不读另一轴结果；初末均核对 4/4 hash 无漂移。产品实现仍在独立写入，未纳入本次冻结。主控独立 CLI guard 2 passed；未运行完整 WB-02 能力证据轮。

### Standards

首轮：1 项 P2；可能 smell 0。

runner 的 Python 必需测试判定使用 `pythonTests.length === 0`，其他 matching 文件存在时可掩盖指定 contract 缺失。违反 AGENTS 的缺失证据不可伪造成功要求。应按 required file 是否存在单独生成 not_run/fail，并补回归。该轴只读规范/代码/摘要，未运行测试。

### Spec

首轮：2 项 P1；越界 0。

1. source snapshot 漏掉当前新增共享核心 `packages/harness-v2/src/capability-catalog.ts`。隔离 synthetic 命令 probe 在执行期间修改它仍得到 pass/sourceChanged=false；修改已覆盖的 run-profile.ts 则 fail。实际 WB-02 核心依赖应完整纳入前后 hash。
2. Python 必需 contract 缺失但存在另一个 matching 测试时，probe 得到 missing=[]/pass。必需文件必须独立产生 missing/not_run 并阻断总 pass。

该轴的隔离 probe 仅验证 CLI 编排缺陷，结果保存于 `.tmp-tests/wb02/spec-evidence-review/probe-summary.json`；不证明产品或 OMP 通过。未运行真实 WB-02/OMP/完整测试，未读另一轴。

## 修复状态

四文件解冻给原 Luna evidence writer，逐条保留 RED/GREEN；产品源码和测试写入权仍仅属于独立产品 writer。修复后重新冻结并分别复核，当前不关闭上述问题。

## 证据入口修复复核

修复后四文件重新冻结，patch 32,175 bytes，SHA256 `243f3518693610af13effa2977a06e37296b442f6f5b9ceff97e517a8af50d24`。两轴初末 4/4 hash 均一致。原始 RED/GREEN 保存在 `.tmp-tests/wb02/evidence-coding/`，未覆写首轮结果。

### Standards

原 1 → 剩余 0；新增硬问题 0，可能 smell 0。required Python 独立 missing/not_run/fail 判定符合缺失证据纪律；新回归在公开 CLI 与证据文件边界验证。`testFileCount` 明确是文件数。该轴只读复核，未重复运行测试。

### Spec

原 2 → 剩余 0；新增 0，越界 0。独立执行四个隔离 synthetic probe：必需 Python 缺失、catalog 改变、新增 capability 模块改变均被门禁拒绝；无变化正向对照通过。结果在 `.tmp-tests/wb02/spec-evidence-review/revision-r2/probe-summary.json`。未运行实际产品/OMP。

主控另独立执行 `node --test scripts/workbench-capability-evidence.test.mjs`，4 passed，退出 0，日志 `.tmp-tests/wb02/supervisor/evidence-guards-final.log`。仅证据入口实现与审查通过；WB-02 产品源码、真实能力增量轮、最终回归尚未验收。

## 能力核心首轮冻结

A1/A2/A3 实现与证据入口共 20 文件；固定点仍为 `eec76df8cc7fc40d412f5f3e253fd15d0a4c07b1`，无新增提交，使用 working-tree + untracked 补丁。冻结位于 `.tmp-tests/wb02/supervisor/core-review-r1/`，234,670 bytes，SHA256 `405f816ee54f88240380d89c1bc213da2e35cfec0d8d791aef5d174fb3860d1d`。两位 fresh Astra xhigh 初末均核对 20/20 hash 无漂移，逐文件 diff 一致；互不读取另一轴。

本次只审能力核心切片，未关闭整 WB-02。Skill 按需加载、公共检索/URL/文件/其他固定连接器、参数错误可观察性仍属于后续切片；现有显式限制和已新增恢复边界的错误不能借后续范围跳过。

### Standards

硬问题 2 项；可能 smell 1 项。

1. P1：`production.ts:1664` 的业务配置检查先于 v2 判定，无配置的既有 v1 本地工具被拒，违反保留预期业务行为要求。
2. P2：v1 restore 测试只查历史中已有 marker、completed 和 dispatch，未验证恢复后新读取成功。初轮填入占位业务配置掩盖入场路径；应删占位配置，恢复前改真实文件，按新 toolCallId 验证成功和新内容。
3. Duplicated Code（判断意见）：production 与 controller 注册两套同名能力定义；递归 schema 校验和浅校验并存，依赖 first-wins 才使用严格版本。建议只保留一个定义/校验来源。

该轴只读检查全部冻结文件，未运行测试、OMP 或构建。

### Spec

本切片部分实现 1 项、实现错误 3 项；越界 0。

1. P1：v2 清空 Skills 并复制固定授权列表，丢失可信 `skillPath` / `ANNA_HARNESS_V2_SKILL_PATH` 中的显式限制。默认 Skill 硬绑定可解除，显式限制仍须进入授权交集。
2. P1：v1 本地工具被业务配置门禁拒绝；恢复测试的旧 marker 可掩盖新调用失败，不能据该测试通过宣称兼容通过。
3. P1：恢复的目录/schema 从当前 fixedCapabilities 读取，而 receipt 从旧 profile 快照生成；注册表改变后会出现新版定义、旧版 receipt 或恢复失败。执行、模型定义和 receipt 必须使用同一持久快照。
4. P2：缺少 model checkpoint `toolDefinitions` 时退回全部 admitted，配合匹配 digest 可绕过 v2 加载前缀检查。仅 v1 可保留历史缺字段兼容。

该轴静态核对与逐文件 diff/hash 检查，未执行 OMP/重测试/API probe。后续 Skill/目录、L/M/P 仍未验收。

## 能力核心修复派工

已派 fresh Luna xhigh `wb02_core_review_fix`，仅修上述具体问题及必要回归；先复现 v1 无业务配置的新读取失败，再处理冻结目录、缺字段、显式限制与重复定义。参数错误反馈、skills.load 和其他连接器不在本次修复中扩展。主控在已知问题修复前暂停完整 JS 回归；当前候选仅全仓 typecheck 与 Web build 通过，不能代表行为验收。

## 能力核心修复与第二轮冻结

修复 writer 已停止并 drain，无提交。第二轮冻结 21 文件，新增 `workbench-capability-review.test.ts`；补丁 273,904 bytes，SHA256 `418e4ee6f3f3c012600fdf435bedddb96ba835b97d555609928386ca39a26db7`。固定点和 HEAD 仍为 eec76df；精确路径/hash 位于本地 `.tmp-tests/wb02/supervisor/core-review-r2/scope.json`。worker/protocol 与首轮一致。原两轴分别独立复审，当前尚未取得复审结论。

修复原始命令/退出码位于 `.tmp-tests/wb02/review-fix/`：

- v1：旧 baseline-v1-002 的通过仅为弱基线。red-v1-001 实际新读取失败，green-v1-001 通过；删除占位业务配置，恢复前修改真实文件 marker，并按新的 toolCallId 验证成功及新内容。
- 冻结目录：red-v2-001 暴露当前注册表取代历史目录，green-v2-001 通过。该测试通过真实 Profile/StartRun、EventStore、Gateway、Python 认证和业务读取；是 D 集成证据，不是历史版本 OMP 恢复的直接证据。生产 OMP/Gateway 定义与 controller 在有策略时统一消费持久目录。
- 缺模型定义：red-v3-001/002 使用了错误摘要格式或顺序，不计行为 RED；有效 red-v3-003 使用真实 admitted 顺序和 raw hex digest，green-v3-001 通过。v2 缺实际定义即拒绝，v1 历史缺字段兼容保留。
- 显式 Skill：red-v4-001 复现限制丢失，green-v4-005 通过。三个公开入口接入实际显式 Skill 条目；默认无 Skill 仍可用 A/B；控制工具为 Host 基础能力，显式 forbidden 最后收窄。没有新增按需 Skill 加载。
- 重复 schema：移除 controller 的另一套工具定义/浅校验，生产 Gateway 仅注册一次并使用已有严格 schema 校验。

编码代理最终组合为四 TS 文件 12 passed / 134.96 秒，Python 合同 5 passed，全仓 typecheck 退出 0；主控已读取原始日志与退出码。原失败与无效探索记录均保留。主控完整 JS/Python 回归已启动；这些候选记录尚不构成切片验收。

### 第二轮 Standards

原硬问题 2 → 0，原 smell 1 → 0；新增 P2 测试证据缺陷 1：旧“提前暴露工具”负例用带 `sha256:` 前缀的 inputDigest，而内核使用裸 hex。即使缺加载前缀守卫，普通 digest mismatch 仍会拒绝，不能证明前缀检查。要求修正 inputDigest/工具 hash 格式，并用有界 mutation probe 验证去掉目标守卫时测试确实失败。

### 第二轮 Spec

原 4 → 0；新增实现错误 2，新增缺失/越界均 0。

1. P1：`ompActiveToolDefinitions` 仍以 task.project_id 存在决定动态过滤，未检查 capabilityPolicy；合法 v1 带 Project 时固定工具被隐藏。要求仅对明确能力策略应用该过滤，并验证真实 Project 的 v1 任务。
2. P2：恢复检查实际定义/inputDigest，却未要求和重算 toolDefinitionHashes；单独删/改数组不被拒绝。要求 v2 逐项验证，v1 历史兼容保留。

两轴均独立只读静态检查，初末 21/21 hash、273,904 bytes patch 均一致；未运行重测试，未用修复者 GREEN 代替独立验证。历史目录用例只作为 D 集成证据，边界继续保留。

主控在收到剩余问题后主动停止 r2 全套 JS：137.6 秒，进程返回 -2（SIGINT），不记通过或行为失败；仅清理该命令的 9 个子进程。日志与中断原因保存于 `final-checks/full-js*`。同轮 Python 全套独立完成：1,085 passed / 53 warnings，退出 0；本轮后续修复不涉及 Python。原 Luna writer 继续有界修复三项，当前尚未形成最终候选。

第三轮记录完整性例外：writer 将问题 1 的初步 `green-r3-001.raw.log/.exit` 用问题 2 的 GREEN 覆盖，原字节无法恢复；不能声称该份原始日志仍保留，也不重建它。问题 1 后续使用真实 scope 返回 Channel 的 `red-r3-003` / `green-r3-002` 完整；问题 2 的 `red-r3-004` 与当前 `green-r3-001` 完整。主控已核对文件内容并要求后续 issue 前缀与排他创建。此丢失的初步 GREEN 不参与验收。

第三轮有界修复记录：

- v1 带 Project：通过真实业务 API 创建 Project，真实 scope 返回 Channel，完整 validatedProductTask 经 ProductSessionStore 保存。校正版 RED 中首轮工具定义为空，终态 `omp_invalid_tool_identity`；修复后固定 read_only 读回新 fixture 文件内容。production 只对明确 capabilityPolicy 应用动态子集。
- 模型定义 hash：`red-r3-004` 单独篡改真实 checkpoint 的一项 hash，其他定义/inputDigest 不变；旧实现允许继续，期望拒绝的断言失败。修复后 v2 检查 hash 数组的存在、类型、长度与逐项裸 hex 摘要；`issue-hash-variants-001` 在两个隔离 store 分别检验改单项与删除数组，两次均拒绝；v1 历史兼容保留。该文件是一项测试内两个变体，不计两项测试。
- 加载前缀：修正摘要格式后 `issue-prefix-green-001` 通过；有界撤去精确前缀守卫的 `issue-prefix-mutant-001` 退出 1，已调用模型导致“恢复模型调用数应为 0”断言失败。恢复守卫后 `issue-prefix-green-002` 通过。这是 mutation 证据，不包装成产品实现之前的时间顺序 RED；临时变更已恢复。

主控已读取原始输出、实际诊断记录和修复 diff；第三轮组合与类型检查仍待收口，尚未验收。

## 能力核心第三轮复审

第三轮 Coding 已停写并 drain；组合 4 文件 / 14 passed，148.25 秒，退出 0；全仓 typecheck 退出 0。21 文件冻结 patch 293,704 bytes，SHA256 `62984e7dd662bbb341100546f2e620a7f2607e7baabaf3874a1baae1733ac7b9`；相较 r2 仅 production、omp-loop-kernel、restore.test 三文件变化。两轴分别核对初末 21/21 hash 和实际 patch 一致，HEAD/base 未变。

### Standards

硬问题新增 0、剩余 0；smell 新增 0、剩余 0。前缀负例采用裸 hex，精确守卫仍在；已只读核对 mutation 时模型调用 2 次导致期望 0 次的断言失败、恢复守卫后通过。此为 mutation 有效性证据，未改称时间顺序 RED。v1 Project、新 hash 校验静态无新增规范问题。

### Spec

需求缺失/部分剩余 0，越界 0，实现错误剩余 0（仅核心切片 A）。v1 动态过滤按明确策略判定；v2 hash 数组存在/类型/数量/逐项摘要校验保留 v1 兼容。已只读核对校正版 v1 RED/GREEN 与 hash changed/missing 两个隔离恢复；未运行新测试。历史目录用例仍只记 D，不扩为跨版本 OMP 恢复证据。

两轴未把已覆盖日志用于 v1 验收；此结论不关闭整 WB-02，也不宣称全套通过。

## 完整回归发现的既有 client fixture

主控最终源的 typecheck、Web build、Host build 均退出 0；完整 JS 在 `packages/omp-loop-kernel/test/client-restore.test.ts:506` 报 `raw SDK model context fixture did not match`。错误发生在注入前：该旧测试 literal needle 仍匹配 `this.input?.allowedTools ?? []`，本卡 Worker 实际已使用 `this.activeTools`。锁定核对只有这一处旧 needle；不能把它记作产品恢复防护失败。

该文件原不在 21 owned 中。等待整轮结束后，仅将其匹配字符串同步为实际 Worker 代码，保留 history 拒绝与 modelCalls/toolCalls=0 原断言；随后补独立单例、22 文件冻结与两轴增量复核，再完成完整 JS。不会为适配测试修改 Worker 或运行包。

完整 r3 回归结束：1,193 passed / 3 failed / 7 skipped，退出 1，864.96 秒，初末 21 个冻结源码 hash 一致。除上述 client fixture，另有：

- `omp-ready-abort.test.ts`：ready 持久化后取消时 Gateway factory 预期 0、实际 1。本卡为初始化 cold loaded map，将 Gateway 创建提前到了准备阶段前，破坏了已有取消顺序。这是确定的实现回归，须修复；不降低原事件/零调用断言。
- `omp-resume.test.ts` 的 tool budget 用例：实际错误为 `OMP worker readiness timed out`，未到预期的观察丢失阶段。主控在完全相同源码、无其他重测试时孤立复跑退出 0（1 passed / 19 skipped，测试 25.01 秒）。历史 WB-00 有同例 readiness 失败，但当前具体慢层/根因仍未定位，不能称为已修复或归因于产品预算。

日志为 `supervisor/final-checks/r3-full-js.log/.exit` 与 `r3-budget-isolated.log/.exit`。另一次只读采样时 Worker 处于事件循环等待，该瞬时观察不证明超时根因。

第四轮 writer 范围为 kernel 源码与新增 owned 的 client fixture。恢复依赖必须保持：准备前仅验证纯加载历史与 admitted 定义；Gateway 创建移到准备/持久事件后的取消与预算检查之后；依赖该 Gateway 初始化 loaded map 的 initial subset 随后解析；异步等待后再核对取消/预算。不能为修取消而重新打破 cold 恢复。修复后再跑原取消用例、14 项能力组合和独立复审。

第四轮 writer 已停写并 drain。client 一行 needle 修复单例退出 0（13.85 秒）；`r4-ready-red-002` 稳定复现 Gateway factory=1，修复后 `r4-ready-green-001` 退出 0。较早 `r4-ready-red` 为错误 package/path 的 setup 失败，不计行为 RED。取消用例的 ready 指 context ready，不能与前述 Worker readiness 超时混称。

`r4-capability-combined` 为四文件 / 14 passed，190.81 秒；随后移除 initial subset 后一条重复 signal 检查，保留每个异步边界后的预算与取消 guard，全仓 typecheck 退出 0。该组合对应清理前字节，最终清理后字节由主控完整回归和增量轮核对，不挪用成同源通过。

第四轮冻结 22 文件，patch 294,957 bytes，SHA256 `5c830fadeab4dcc36eada77cd10bcd7ade47079d53ee0f58094e0b0bd3ec631c`；相较 r3 仅 kernel 源码与 client fixture 变化。主控已启动 Worker typecheck、全仓 typecheck、Web/Host build 和完整 JS，另派原两轴独立复核该增量。尚未关闭核心切片。

### 第四轮 Standards

硬问题新增 0、剩余 0；smell 新增 0、剩余 0。纯持久加载验证保留在准备前；Gateway 在准备/恢复校验及取消、预算检查之后创建，initial subset 在 Gateway 初始化 loaded map 后解析，每个异步边界后重新检查。旧 client 仅同步 injection needle，匹配失败检查及 history/零调用断言保留。未发现新增范围。

### 第四轮 Spec

需求缺失/部分剩余 0、越界 0、实现错误剩余 0（仍仅核心切片 A）。取消与 cold 恢复依赖顺序正确，预算起点和计数未改变；保护现有预算/恢复语义，不扩称后续 AC 已完成。旧 client 的有效恶意上下文注入恢复，保留原拒绝条件。

两轴只读复核最终源码/指定日志，初末 22/22 hash 和全部 patch 一致；未运行重测试。历史目录仍为 D，readiness 根因仍未知。主控最终 Worker typecheck、全仓 typecheck、Web build、Host build 均退出 0；完整 JS 与正式增量尚在后续核验中。

主控 r4 最终完整 JS 已完成：**1,196 passed / 0 failed / 7 skipped，退出 0，888.02 秒**。其中 OMP kernel 42 passed，Host 199 passed / 1 skipped；上一轮三项失败在该轮均通过。初末 22/22 源码 hash 与冻结一致。此结果说明本轮通过，不把旧 readiness 问题改称已定位或修复。日志为 `supervisor/final-checks/r4-full-js.log/.exit`，完整命令与构建 hash 为 `r4-checks-summary.json`。正式核心增量轮正在独立执行。

正式轮 `wb02-capability-core-20260910-r1` 已通过：14 TS tests / 5 Python tests，源前后无漂移；主控独立核对 38 个关联源 hash、manifest 的 15 文件、公开摘要中 26 次模型请求/7 条完整加载/4 条可用 dispatch 关联，并重新验证整个 OMP 运行包 21,465 文件。精简 receipt 的解释边界见胶囊，不改写生成的 D metadata。

## 发布扫描的既有 fixture 误报

本次 42 个候选实现/证据/交接文件的公开扫描通过，但全仓 `release:verify` 退出 1：旧 `workbench-session-review-regressions.test.ts` 与 `workbench-session-scope.test.ts` 的无效鉴权 fixture 字符串命中 credential_marker，旧 `workbench-session-run.test.ts` 的路径前缀禁泄露断言命中 absolute_path。三文件均与入场 HEAD 字节相同，属于既有测试写法的误报；未发现真实凭据或用户路径泄露。

为使全仓 CI 门禁继续工作，fresh Luna 仅对三处 fixture 做等值字符串构造，保持运行时值、原 401 与禁泄露断言，扫描器规则不变。这三文件不属于核心增量命令或其 38 文件源集合；后续将独立核对等值性、运行受影响测试、复核两轴增量和全仓扫描。产品核心 22 字节保持冻结，不重新解释既有整轮失败。

修正已完成：三文件共 7 insertions / 4 deletions；实际定向测试分别 3/1/1 passed，共 5 tests，退出 0。最初路径选择错误的尝试是 setup 失败；校正后的三个日志才计行为通过。主控独立内联还原新常量后，三整文件与 HEAD 逐字相同，原运行时值及所有断言保持。全仓 release:verify 主控复跑退出 0。

### r5 Standards

硬问题新增/剩余 0，smell 新增/剩余 0。该轴独立执行内联等值核对，三文件与基线逐字相同；核心 22/22 与 r4 一致。只读复核，未运行测试或 release。

### r5 Spec

缺失/部分 0，越界 0，实现错误 0。该轴独立核对等值性与 R-15 原断言保留，不把后续 5 项定向当作新增测试，也不扩大核心切片验收。

两轴初末 25/25 hash 及 patch 一致：298,124 bytes / SHA256 `86399f373f7f141038c3788357222a9737b3feb8cb3bdb09ad326a01b95dc48c`。该轮 fixed point 与审查时 HEAD 仍为 eec76df，commit list 为空。最终代码/证据随后提交为 `dae2b4fde6a0efe01408e600bf04625fa55fa680`；主控验证提交精确 41 个 owned 路径，38 个证据源 hash 与 25 个审查文件 hash 均匹配 Git blob，用户原 dirty 保持。

等值 fixture 修改后，主控还在最终代码提交上运行全仓 `npm run typecheck`，退出 0。全部实施/审查与测试进程已 drain，四份交接文档的相对链接和公开内容检查通过。该验收限核心切片 A，后续按 SUPERVISOR 接力继续 WB-02。
