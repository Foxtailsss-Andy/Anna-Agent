# WB-02 可信目录身份与分段读取交接胶囊

状态：可信目录身份/分段读取及必要原入口衔接的D/O契约、双轴、主控完整回归与AC18b已验；代码与公开证据已精确提交。整WB-02保持in_progress，目录/路径与内容搜索、固定Hiker/报销/剩余Crew读取继续待办。

## 范围与现场

- scope：M0 + M1；ticket：WB-02；slice：可信目录登记与归属、UTF8分段文件读取、必要原Chat/Create衔接。
- 实施owner_task_id：`01a08c3f-d9f0-7513-b4eb-99daa61a0ca7`；唯一owner与交接HEAD以STATUS为准。
- 唯一工作树：`Anna-Workbench-Plan-20260907`，branch：`codex/workbench-plan-20260907`；外层Anna只为容器，所有命令必须显式workdir指向工作树。
- 固定点：`63d3ef27a6cfb9e6e8c046ed38bc1fa02435e869`。代码/公开证据提交：`e93647ed2cb427885d6a1e6a728906c986b833a2`；最终交接HEAD以STATUS为准。
- Spec1.2；R-03/04/05/15与AC-04/05/15的文件读取子范围、AC-18b。不关闭整AC05、WB02或M1，不开始WB03。
- 原AGENTS/CONTEXT/docs/agents/AWB规划保护；12保护输入（除STATUS）保持。原tracked dirty SHA256：`5a5a75dad632d126dad8073c8548b44508804e4329dc52d54696697da6c4611b`。
- 决策与实施边界见[契约](WB-02-files-contract.md)，独立审查及历史失败见[审查](WB-02-files-review.md)。先前核心A/Skill/公共读取已验范围与正式轮保留。

## 实现行为

v2接受零或一个`workdir:<注册ID>`，由真实Python身份/scope解析归属并绑定canonical root，Host保护实际Session/Workbench/EventStore与配置路径。新Run不隐式继承上次目录授权；只有显式绑定才可发现/加载文件能力，保留Skill与Gateway限制。模型初始元数据不暴露绝对root。每次读取重新校验注册事实和原绑定，删除注册、root改绑或符号链接替换后拒绝读取。

product目录接口以真实Bearer或可信本地身份写owner并过滤登记。旧无owner记录仅可信本地使用，非product兼容保持；同一路径/ID的不同owner按真实身份解析。客户端apiFetch发送已有Bearer，大小写不敏感地合并Headers；product Chat/Create的读取、trace、stream及控制也核对可信身份。Chat在目录上下文注入前核对owner；v1有workdir_id时始终解析并比对root，每次旧文件工具调用复查撤销。原输出格式和nonproduct Create流程保持。Python product submit通过to_thread释放事件循环，允许Host回调内部scope，消除真实Chat链的互等阻塞。

文件读取使用真实regular FileHandle、O_NONBLOCK/O_NOFOLLOW与有限buffer；单次源窗口65536字节，最多16384 Unicode码点。offset/end_offset/next_offset为UTF8字节，返回资源引用、相对路径、range、截断和下一位置。超过64KiB可继续下一段，BOM作为U+FEFF保留并计入字节；拒绝非法UTF8、字符中间offset、超过EOF、额外参数、绝对路径和越界链接。该适配不等于WB06强隔离。

## Owned 文件

19个产品/测试/CLI文件，完整源hash以最终source-snapshot与审查scope为准；其余用户dirty不纳入提交。

- Desktop：`apps/desktop/src/lib/api/client.ts`。
- Host：`apps/harness-service/src/product-facade.ts`、`production.ts`、`production-tools.ts`、`workbench-capabilities.ts`、`workbench-files.ts`。
- Host测试：`apps/harness-service/test/workbench-capability-files.test.ts`、`workbench-capability-files-legacy.test.ts`。
- CLI：`scripts/workbench-capability-evidence.mjs`、`scripts/workbench-capability-evidence.test.mjs`。
- Python API：`services/api/app/main.py`、`security.py`、`routes/business.py`、`routes/chat.py`、`routes/create.py`、`routes/workdirs.py`。
- Python消费与登记：`services/chat/app/orchestrator.py`、`services/runtime/app/workdir_store.py`。
- Python测试：`tests/contracts/test_workbench_files.py`。

## 证据边界

新测试的Python身份、注册表、scope与临时文件为真实实现；模型transport是明确fixture。真实Workbench Create/Crew与旧Chat经Host/Gateway/EventStore、当前OMP子进程读取；分页下一模型请求观察实际截断/正文后继续，未绑定新Run不能加载文件能力。旧admission拒绝发生在runtime之前，不能计作OMP Run。公开receipt为事件元数据摘要，非完整Trace；原始输出和断言受源hash约束。

CLI保留原发现规则并显式增加本切片必要文件、客户端依赖、Python测试和legacy测试；每个缺失门禁独立验证，不能以源码hash包含替代执行。主控检查与正式轮已完成，manifest/receipt及当前源独立核验通过；68源hash与19审查hash已通过issue-files-git-round-verify-001匹配代码提交Git blob。

## 冻结与主控检查

r3审查scope在本地`.tmp-tests/wb02-files/supervisor/review-r3/scope.json`；19文件实际未提交补丁184046bytes，SHA256 `1bf475ad007cf6843ad58268f643472c8d58fc8ae05ee1d58a6b1653b42c4dc9`。两位fresh Astra初末核对HEAD/branch、19hash与逐路径重建patch一致。Standards硬规范0，非阻断P3 Possible Duplicated Code一项（两个约10行的测试guard mutator），主控决定保留；Spec遗漏/越界/实现错误0/0/0，BOM及合法点号名称两个P2均关闭。

全部主控检查使用排他wrapper保存真实command/cwd、stdout/stderr、before/after和exit，位于`.tmp-tests/wb02-files/supervisor/checks/`。

| 主控检查 | 结果 |
| --- | --- |
| final-typecheck-002 | 全仓类型检查退出0 |
| final-python-002 | 1093 pass，退出0 |
| final-web-build-002 / final-host-build-002 | Web/Host构建退出0 |
| final-full-js-002 | 1239 pass / 7 skip / 0 fail；836.50秒 |
| final-cli-002 | 51 pass；24个独立mutation全部current0/mutant1 |
| final-release-scan-002 | tracked公开扫描通过 |
| owned-public-scan-001 | 19产品/测试/CLI文件与3文档显式扫描通过 |
| final-focused-002 | 默认并行9 pass/1 fail，客户端登记例超过默认5000ms |
| client-timeout-isolated-001 | 同字节单例2929ms通过 |
| final-focused-003 | 同字节串行两个文件10 pass，登记例2924ms；保持5秒限制 |
| final-ledger-001 | 成功检查与已保留失败的argv/cwd/exit/日志hash及19个before/after/current hash独立核对通过 |
| runtime-inputs-001 | 21465运行文件、worker/protocol/lock及12保护输入核验通过 |

以上sourceChanged=false。并行定向超时是保留的间歇限制，启动资源竞争为推测，具体时序根因未唯一定位；串行通过不改写原失败，也不声称已修复。正式AC18b仍使用CLI默认配置；其结果为61 TS与13 Python通过；原间歇超时记录仍保留。

## 正式轮与源码对应

唯一新轮为[wb02-files-20260911-r1](../../../../evals/workbench/wb02/runs/wb02-files-20260911-r1/evidence/increment-result.json)，主控issue-files-increment-r1退出0、200.18秒、sourceChanged=false。默认测试配置11个TS文件61 pass、2个Python文件13 pass，required发现无缺失。issue-files-round-verify-001核对完整47条manifest（含manifest共48JSON）、68源before/after/current hash、19审查hash与真实私有命令/输出hash。

新公开receipt含3个v2 Run（10响应/2预期失败）、旧v1撤销与旧Chat各1个Run，共5个实际OMP Run。v1 admission为runtime前拒绝，单列且不计OMP；原12公共读取Run/45响应/5预期失败继续存在。CLI只记录O元数据，主控依据真实运行与seam/receipt核定本切片O；不推导真实Provider/MCP或分发结果。正式轮记录的sourceSha是运行当时base加dirty候选；68源hash和19审查hash经issue-files-git-round-verify-001与代码提交Git blob逐项一致，不改写旧轮SHA。

## 运行包与限制

Node24.12.0、Python3.12.13；当前工作树已完成npm ci/uv sync。OMP18.0.11/Bun1.3.14，21465个运行文件；canonical manifest `sha256:168da57a60493b094ea6b2525f312c3e05a6585ffc167cba2a7b9c5beb6719ec`，manifest文件SHA `3a78ef5da9aa194186fdde8324633928a7d37f2a07ea4f6be64c9cb927fe0def`。本切片未改worker/protocol/runtime lock，没有重materialize；转交前仍须逐项核验。

L/M blocked、P not_run、usage unavailable。WB00 r5/dataset v1.1的36槽保持21blocked/15not_run。上一公共读取默认example.com因本机benchmark DNS被策略拒绝，成功公网读取未验证；不修改DNS、代理或allowlist。历史readiness根因未知、旧raw缺失以及本切片setup/fixture/中间安全设计失败全部保留；后续通过不恢复旧日志。

## 下一主控动作

1. 先只读STATUS等待唯一owner转交；接管后核对同树HEAD/branch、最终源/审查hash与代码Git blob、完整manifest/receipt、原12保护输入和运行包。不得自改owner或提前派工。
2. 继续WB02剩余R05列目录、路径/内容搜索，以及固定Hiker/报销/剩余Crew。先查现成执行器与可信入口；沿真实Python scope/资源绑定/Gateway开展有界公共seam RED→GREEN，不重做已验读取或绕过目录owner。
3. fresh Luna xhigh编码、fresh Astra xhigh Standards/Spec各自只读；新源/资源/必需测试纳入CLI前后hash和独立门禁，D/O与L/M/P分开。独立切片验收、精确提交和drain后按SUPERVISOR继续跨Session。
4. 整WB02完成后才进入WB03，再与WB04集成；用户已授权M0+M1内部推进。WB05～09、Memory/Sandbox扩展、push/PR/发布不在范围。收到暂停即停止，不以接力绕过。

19实现/测试/CLI文件加48公开JSON，共67路径精确提交于`e93647ed2cb427885d6a1e6a728906c986b833a2`，每个提交文件均与工作树Git blob一致。issue-files-public-candidate-001覆盖这67路径及3文档，公开扫描通过；precommit-drain-001核对172个已登记进程组无活动进程。全部Coding/Reviewer已结束。三份交接文档单独提交，最终HEAD/现场复核与唯一owner单次转交以STATUS为准；旧主控转交后停止派工和仓库写入。
