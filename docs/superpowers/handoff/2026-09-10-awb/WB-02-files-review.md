# WB-02 可信目录与文件读取审查记录

状态：读取/身份子切片的D/O契约、双轴与主控完整回归、AC18b已验；公开扫描/drain通过，67个代码/公开证据路径已精确提交。固定点 `63d3ef27a6cfb9e6e8c046ed38bc1fa02435e869`。契约见 [文件切片契约](WB-02-files-contract.md)。用户原 AGENTS/CONTEXT/docs/agents/AWB 规划不属于 owned diff。

## 入场

旧主控完成唯一 owner 转交后开始写入/派工。主控通过排他日志 wrapper 的 issue-intake-001，独立核对 HEAD/branch、54源与12审查hash对代码提交Git blob、41manifest条目、12公共Run/45响应/5预期失败、三份交接文档、12保护输入、原tracked dirty digest及全部21465运行文件。退出0，sourceChanged=false；原始command/双流/exit/before/after在 `.tmp-tests/wb02-files/supervisor/checks/`。

## 已确认断点与取舍

v2 Run API直接拒绝非空resource_refs；v2 profile未登记文件能力。已有 workdirs 是无归属的全局登记，不能据此给所有认证用户读取权。复用登记入口、Host根保护、Gateway与OMP动态加载；product mode补真实身份与归属过滤，旧无归属仅可信本地身份使用，非product历史行为保持。v2仅绑定一个workdir ID；模型不获绝对root，文件文本不提升权限。

旧保护路径逻辑仅看sessionStorePath，默认main实际传Store对象；实施需涵盖实际task snapshot与Workbench sidecar。已向产品writer指出，最终按公开失败用例核对。文件工具为只读适配，不宣称WB06强隔离。

## 产品 tracer

fresh Luna唯一产品writer。issue-files-tracer-001实际公开Create Run返回422而预期202，为非空resource_refs行为RED；此前登记真实临时目录成功，身份/业务状态/OMP/Gateway不替换为stub。实现与GREEN尚待核对。

## CLI 增量

另一fresh Luna只拥有现有两个evidence CLI脚本，执行synthetic命令，不与产品writer写同文件。issue-files-cli-red-001退出1，sourceChanged=false：Python发现只包含原test_workbench_capabilities.py，缺新增test_workbench_files.py。它是执行发现的有效RED，不能用source hash覆盖代替真正执行。后续独立缺失门禁/变异与整体冻结仍待完成。

## 独立审查和主控验收

Standards：未运行。Spec：未运行。完整回归、正式AC18b、源/manifest/receipt与运行包最终核对、提交和drain均未完成。

L/M blocked、P not_run、usage unavailable；WB00 r5的36槽保持21blocked/15not_run。公共读取已验范围不变；默认公网benchmark DNS拒绝、历史readiness根因未知、旧raw缺失与误标mutation例外见上一公共读取胶囊/审查，不由本轮覆盖。整WB02/M1未关闭。

## 中间候选复核（未验收）

主控拒绝公共workdirs依据Host附加service token直接信任客户端身份头：product-facade代理会加内部令牌，形成伪造header被代理放行的路径。要求公共接口独立认证，内部解析走已有受令牌保护且核对真实identity的workbench/scope。此为中间设计纠正，最终仍需公开用例证伪。

tracer-002能提交并启动实际OMP，但无Project目录过滤遗漏workdir；后续003/004为admission 503，005/006的临时scopeProbe为404。006日志确认登记owner正确；旧resolve_workdir只投影id/name/path，丢掉新增owner，是重点核对根因。临时probe不作最终公共seam验收，须回原Run→OMP→真实文件链。全部失败各有raw；002全局sourceChanged=true发生在并行编写期，不作为同源验收。

主控另标记待关闭项：重新解析root必须与原持久绑定比较；不能无界readFile；保护路径复用且涵盖实际Store路径；资源admission异常必须持久failed，不能留下永远pending。以上在产品首tracer后逐条验证，不因首条转绿自动关闭。

CLI discovery GREEN退出0；regression-001的11pass/2fail反映旧Python预期与synthetic夹具缺新增测试。mutation-file-004的current guard先失败，不算成功mutation证明。后续新修复/变异保留独立记录。

产品writer在连续失败后被收回写入权并要求只读checkpoint。其最后一个已发出命令tracer-012随后正常退出0，公开Create首条读取1项通过；主控核对10个产品owned before/after/current一致，tracer-checkpoint-001无漂移。012全局sourceChanged仅为并行CLI测试文件变化；不能记成整树同源验收。issue-tracer-drain-001核对12个已登记进程组无残留。旧writer确认001～012均包裹日志，无额外测试。

010/011明确暴露production-tools内置旧workdir分支抢先，返回旧path/content而缺分页字段；012的最小dynamic路由修正将v2送入新reader，v1保持旧分支。首tracer只核定该公共读取链，不关闭文件切片。fresh Luna继续root快照绑定、有界UTF8读取、输入与分页；目录/搜索与完整权限/独立双轴仍待后续。原owner字段丢失、404/503、临时probe和全部旧失败保留。

## CLI 完成候选

files_evidence writer已停写。full-013退出0，17/17；15个独立mutation为current0/mutant1。主控issue-cli-ledger-001核对完整argv/cwd/exit、双流hash、17/0计数及15唯一标签，CLI两文件before/after/current均匹配作者终稿hash（mjs847b3dcd...，test61a7a6f1...）。full-013的全局sourceChanged来自并行产品文件变化；本子检查只核定两脚本，整体冻结及双轴尚待完成。Python发现已收窄为原capability规则加本次明确required文件，未扩展到全部workbench测试。

## 读取后续证据口径

fresh reader的baseline-013重跑首公开例通过。bound-root-red-014直接替代内部scope响应，只作诊断，主控拒绝其为授权验收；该helper测试已移除。后续bound-public-red-016/green-017经过真实Python登记/OMP，受控更改专用JSON登记路径，撤guard失败/恢复通过；它是测试中的真实状态变更，不冒充真实用户授权操作。

分页connector用例使用真实Python身份、登记与真实临时文件，主控确认属于真实连接器seam的D；不能替代实际OMP观察truncated后继续下一段。pagination-red-018/green-021和输入red-022/green-023按当前raw保留，代表性OMP分页与进一步边界仍在实施。

symlink-red-024在移除guard后得到workdir_file_unavailable，主控只接受其为错误路径变化，不能据此声称新目标正文已被读取。要求新fixture在offset0实际成功读到新目标marker、恢复guard再拒绝，后续独立轮补证，024不改写。

## 身份兼容子切片

TS reader已明确交还5个Python文件；fresh files_identity独占main/workdirs/business/workdir_store及新test_workbench_files.py。identity-red-001只是测试文件缺失/exit4/未运行，主控纠正为setup，不计业务RED。有效identity-red-002退出1：nonproduct真实API登记旧无owner记录，product本地列表可见，但同一真实local身份的内部scope404。修复与后续双owner/身份伪造/撤销仍待核对。

## 旧入口 Spec 预审

fresh Astra只读追踪默认caller，未运行测试。确认apiFetch未带Bearer，会使严格workdirs API拒绝登录UI的列表/登记；product Create携context.workdir_id，Host lookup应改内部scope。product Chat在Host前build_host_inputs读取目录树，已有workdir_path还可绕过admission owner检查。原legacy仅header/body自洽的身份不足是既有问题，新增owner契约需在实际目录消费入口补齐；只修Host不足以保护衍生上下文/旧Run控制。

主控采纳有界修补：客户端token；product Chat/Create可信身份；product Chat上下文前owner；v1 Host目录admission/每次读取撤销。CreateOrchestrator的workdir解析仅为nonproduct路径，保留，不扩改。此判断改变本文件切片的必要实现触点，未提前进入WB03，也不作能力验收。

Python身份作者最后一次py_compile未通过wrapper，退出0仅为作者报告，没有完整raw；不能列为主控已验证的独立检查，也不补造旧日志。现有22项合同/9项业务raw保持，后续完整回归按当前字节重新执行。

## 读取候选出口与原入口中期

读取writer已停写；final-tests-037与final-typecheck-040退出0，当前3个测试包含2个实际OMP Run；legacy-regression-039通过。源码类型错误曾在typecheck-034暴露，修正JsonValue输出后035通过；旧失败保留。033 receipt位于私有临时目录，只含真实事件元数据，正式轮将重新生成。它是读取子候选，未关闭完整文件能力。

Python/client writer按预审补真实product Chat/Create身份、上下文前目录owner及客户端Bearer。33项相关/7项product regression/37项nonproduct API候选通过；最新全Python1093通过，owned Python/client前后稳定，全局sourceChanged仅并行Host测试/CLI测试变化。当前不是主控整体冻结回归。

Host client-red-001证明真实登录apiFetch经Host proxy登记目录403；其初稿runtime占位未被调用，只作client/proxy/Python这个窄D断点，不能作Host执行证据。主控要求换真实createLiveHarnessV2Runtime/Sqlite/SessionStore后，client-green-003通过；无Run时不声称OMP已执行。002过程存在并行main修改与fixture启动失败，保留。

legacy-admission-red-004在同时提交真实workdir ID与冲突root时错误202，green-005通过canonical root与内部scope比对后正确拒绝。legacy-revoke-red-010实际OMP的v1 read_only在真实删除登记后仍读成功，暴露v1直接allow；修复尚待核对。直接v1 Host任务不替代原Chat/Create产品caller正向，主控要求补真实Chat API→Python context→OMP文件读取。

## r1 冻结与双轴

19个owned文件固定在63d3ef27，commit list=[]；实际working补丁176431bytes，SHA256 `55de45005f88193622952110d3a1c45644a160ccf71f4c90988e9450fb02353a`。两个fresh Astra均初末核对19hash、HEAD/branch及逐路径重建patch=saved，未写/未测。主控issue-files-r1-focused-001的两文件7项退出0、23.91秒、sourceChanged=false；它未覆盖下述BOM问题，不能据此接受整个slice。

### Standards r1

硬规范违反0；P3 Possible Duplicated Code判断意见1（不阻断）：workdirs.request_owner的product Bearer/local分支重复同批security._resolve_product_identity。主控采纳最小复用，保留nonproduct原语义；不做无关重构。

### Spec r1

范围内遗漏0、未授权越界0、实现错误P2一项：TextDecoder默认消费UTF8 BOM，而读取游标只累计返回content的UTF8字节数。BOM开头/分页边界会漏3字节；BOM-only会空成功、next_offset=0且truncated=true。违反本切片实际字节位置/分段前进契约，需保留BOM或计算消费字节并补回归。

主控选择保留U+FEFF原字符（ignoreBOM:true），使返回文本和字节游标一致。fresh Luna只拥有workbench-files.ts/files.test.ts/workdirs.py修这两项，先真实Python/文件connector的BOM RED再GREEN，并复用认证helper。四项完整回归及正式新轮在修复、重新冻结和双轴复核后执行；r1不验收。


## r2 冻结与双轴

BOM有效RED为issue-files-r1-fix-bom-red-002的2 fail；GREEN-003为2 pass，完整TS-004为5 pass，Python-005为21 pass，typecheck-006退出0。workdirs product分支已复用security公共身份校验，nonproduct早返回保留。所有作者进程已drain。

r2冻结19文件180264bytes，SHA256 `c3967a0cff949c740ab6cd1ad625618da02df8ccc47f43114b83fe343b70499c`，固定点/HEAD仍63d3ef27、commit list=[]。两位fresh Astra初末核对19hash和逐路径重建patch一致，纯只读未测试。Standards硬规范0、新增/遗留smell0，原P3关闭。Spec遗漏0/越界0，原BOM P2关闭；新增P2一项：reader以startsWith("..")误拒根内合法..notes.md与..data/note.md，需只识别完整父目录段。同模块保护路径containsPath的同形判断也应修正；Host既有containsPath已按sep正确判断，无需修改。

主控r2全仓typecheck和Python1093项分别退出0、15.63秒与39.57秒、sourceChanged=false。这两组只证明r2字节，不冒充后续修正版验收。fresh Luna仅获reader与对应TS测试写权，先真实Python/FS connector RED，再最小GREEN与安全边界回归；所有失败raw保留，r2不验收。


## r3 路径边界修复与主控检查

fresh Luna只改reader和对应TS测试：requested/resolved relative与containsPath以完整父目录段及绝对路径判断，合法..notes.md与..data/note.md可读，真正../跳出、外部symlink及..protected目录保护不放宽。r2-path-red-001调用root Vitest配置而No test files found，仅setup失败；red-002在harness workspace实际1 fail为有效RED；green-003通过；ts-004为6 pass，r2-typecheck-005退出0。均sourceChanged=false，final-drain-009无活动进程，已收回写权。

r3冻结19文件184046bytes，SHA256 `1bf475ad007cf6843ad58268f643472c8d58fc8ae05ee1d58a6b1653b42c4dc9`；HEAD/固定点仍63d3ef27，commit list=[]。freeze-r3检查12保护输入与用户dirty均保持。两位新Astra分别只读复审，结果待回收。

主控final-*-002在r3字节上执行：typecheck退出0，Python1093 pass，Web/Host build与release scan退出0，均sourceChanged=false。runtime-inputs-001再次逐项核对21465运行文件、worker/protocol/runtime lock、12保护输入和原tracked dirty digest通过。完整JS/CLI、focused与正式AC18b、最终独立manifest/receipt/源校验尚待完成，不以当前检查关闭slice。


### Standards r3 最终

硬规范违反0；P3 Possible Duplicated Code一项（非阻断）：evidence.test.mjs的removeRequiredEntry与removeRequiredSourceEntry各约10行，重复列表块定位/断言/删除，仅表名与错误文案不同。Reviewer建议可抽小helper；主控决定本轮保留，当前两处独立guard测试的参数化收益有限，不为非阻断整理改动冻结字节。原身份重复P3已关闭。此处保留审查判断与主控处置，不将Standards写成全零。

Reviewer全程只读，起末HEAD/branch、19hash与逐路径重建184046bytes补丁均与r3冻结一致，已结束。主控CLI final-cli-002为51 pass/0 fail，sourceChanged=false；完整mutation与日志hash在最终ledger一并核验。owned-public-scan-001明确扫描19实现/测试/脚本及3文档，退出0；它不替代生成后整个新公开证据目录的扫描。


### Spec r3 最终

范围内遗漏/部分0、越界0、实现错误0。原r2合法点号名称P2已关闭，真实parent traversal/外部链接/..protected保护仍拒绝；r1 BOM修复保持。目录/搜索与固定业务继续待办，不关闭整个R05/WB02/M1。Reviewer初末独立核对19hash、HEAD/branch和184046bytes实际补丁与r3逐字节一致；纯只读无测试/构建/提交，已结束。最终完整回归及正式AC18b仍由主控验收，L/M/P不由此推导。


## 主控完整回归与额外定向检查

r3 full-js-002最终退出0，1239 pass/7 skip/0 fail，836.50秒，sourceChanged=false。其后默认并行focused-002有9 pass/1 fail：新legacy客户端登记例超过Vitest默认5000ms；不是HTTP状态或内容断言失败。原失败command/双流/exit/前后源码均保留，不改写为通过，也不冒充已定位产品故障。

主控在同一r3字节上缩小运行边界：client-timeout-isolated-001只执行该例，2929ms通过；focused-003仍执行两个完整文件，唯一执行条件变化为--no-file-parallelism，verbose仅增加报告，10项通过，其中登记例2924ms。未改测试超时、产品/测试源码、运行包或授权断言。这支持启动资源竞争的可能性，但仍不足以唯一归因；本切片保留默认5秒预算下间歇超时限制，不声称已修复时序根因。最终ledger明确同时列成功串行检查和原并行失败。正式AC18b仍使用CLI默认测试配置，结果另行记录。


## 正式 AC-18b 与独立核验

issue-files-increment-r1执行唯一新轮`wb02-files-20260911-r1`，200.18秒，退出0、sourceChanged=false；沿CLI默认配置11个TS文件61 pass与2个Python文件13 pass。原定向5秒超时仍保留，不因本轮通过改写。

issue-files-round-verify-001独立核对47条manifest的完整路径集合/大小/内容hash（连manifest为48个JSON）、68个源before=after=current、19个r3审查hash、测试真实argv/cwd/exit及双流hash、required发现与基线状态。新增实际OMP Run共5个：3个v2读取/分页/未绑定Run及旧v1撤销/Chat各1个；v1 admission拒绝在runtime前，单列且不计OMP。v2回执10个response含2个预期失败，dispatch/response序号与事件ID核对；原12公共Run/45响应/5预期失败保留。receipt是元数据摘要，不补造完整Trace。

CLI仍声明O=metadata_only，由主控基于真实OMP/真实Python和文件seam及receipt核定本切片O；模型transport为fixture，不推导L/M。WB00 r5/dataset v1.1的36槽21blocked/15not_run、L/M blocked、P not_run、usage unavailable保持。目录/搜索与固定业务未验，整WB02/M1不关闭。


## 精确提交与 Git blob 对应

代码/公开证据提交`e93647ed2cb427885d6a1e6a728906c986b833a2`：仅19实现/测试/CLI路径与48公开JSON，共67个路径。commit-code-001逐个核对提交路径集合及Git blob=当前文件，原用户dirty摘要保持。public-candidate-001显式覆盖全部67路径与3文档、退出0；precommit-drain-001核对172进程组无活动。git-round-verify-001将完整manifest/receipt、68源hash和19审查hash再与代码提交Git blob核对通过。正式轮sourceSha保持当时base/dirty候选，不补改SHA；文档另单独提交。
