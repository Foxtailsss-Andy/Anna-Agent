# WB-02 公共读取切片审查记录

状态：本公共读取切片两轴与主控完整验证、D/O及AC-18b增量已验收，整WB-02保持in_progress。下文按阶段保留当时状态，最终结论见末尾；历史失败不被后续通过覆盖。

固定点：e3e95621abbb15b66767e7b4bd9a6b2b3db7a9d4。用户原AGENTS/CONTEXT/docs/agents/AWB规划不属于本slice owned diff；STATUS是授权活跃记录。

## 主控入场

STATUS完成单次owner转移后开始接管。独立核对49源hash与代码提交c0c78e7的Git blob、10审查hash、12保护输入、tracked dirty digest与全部21465运行包文件（含大小/内容/文件全集/无符号链接），worker/protocol/runtime lock一致。脚本、command、真实stdout/stderr、exit保存于本地 supervisor/issue-intake-001，退出0。一次读取压缩为单行的runtime manifest使用head导致工具输出过大；未改文件，也不把该输出当完整性验证。

## 搜索 tracer

首writer已停写并drain。有效RED为 coding-tracer/20260910T-red-public-capability-workspace，退出1，实际OMP transport断言目录results为空、缺web_search。20260910T-red-public-capability-valid实际为错误Vitest项目选择、No test files found，属于setup，不按目录行为失败计。GREEN名称的失败尝试按真实退出1保留。

中间将旧profile.allowedTools作为v2公共能力依据仍受默认Skill交集影响；主控要求公共能力直接登记、显式Skill限制随后收窄。最终公开tracer通过，模型使用search实际返回的canonical ID并经load调用真实搜索Provider/合成HTTP服务；固定模型transport、真实Python身份/业务、Host/Gateway/EventStore和实际OMP。下一次模型请求读到URL/title/snippet/fetched_at，来源无发布时间时无published_at，普通文本完成。

相关3文件25项和typecheck退出0；两个已有严格结果断言仅为新增fetched_at调整。主控独立同一公开测试1项通过，9.60秒、源码前后无漂移。5文件候选冻结在 supervisor/issue-tracer-freeze-001.json。该结果仅核定首tracer，不关闭切片或AC-05。

## 后续编码与证据边界

fresh URL产品writer与fresh CLI evidence writer文件独立。前者仅产品适配/新连接器/用例/parse5依赖，后者仅两个已有CLI脚本；CLI只运行隔离synthetic命令，不与实际OMP测试争用。最终统一冻结、两轴和主控集成检查。

parse5@8.0.1安装退出0，根lock发生预期依赖变化；npm附加的无关根license字段应移除。首网络RED误把中文“新”当文件名new前缀，导入newworkbench-public-web失败；主控纠正准确路径为workbench-public-web，该次只记setup，不证明公共URL行为。

当前静态待核对：web_search的v2 Gateway schema必须消费持久目录，不能继续静态定义first-wins；无配置可见状态与实际失败一致；URL的真实DNS/socket绑定、逐跳权限、流上限、超时/取消与分段补证分别有公开seam用例。不得用外部transport fixture证明默认socket已经实读，后者单列实测。

## Standards

待冻结后fresh Astra xhigh独立只读审查。

## Spec

待冻结后另一fresh Astra xhigh独立只读审查。

## 尚未验收

URL公开tracer与完整网络边界、跨入口与失败反馈、CLI新guard、公开receipt、正式AC-18b、四项仓库回归及最终运行包/源核对均待完成。历史Worker readiness未知根因、旧日志完整性例外与历史schema恢复边界继续保留，不以本轮通过改写旧记录。L/M blocked、P not_run、usage unavailable；WB00 r5 36槽不变。


## CLI 子卡日志完整性例外与收回写入权

主控发现CLI writer只保存部分内部CLI子进程日志，没有持久外层node --test的完整raw，遂中断编码并要求只读checkpoint。writer确认六次外层命令缺完整stdout/stderr/command/source hash：初始5/5退出0；新增测试后5pass/4fail退出1；两次8/9退出1；一次9/9退出0；最后组合syntax/test命令被中断、退出未知。这里的计数仅为writer报告，不能当作主控已核对的原始RED/GREEN。

本地evidence-coding/runner-*是部分内部CLI子进程日志，不等于外层测试日志。其余synthetic内部日志可能随临时fixture清理，不能据此声称完整保留所有执行。主控不补造旧raw；后续新执行和明确mutation独立记账。

当前writer已停写/drain，仅两脚本有改动。它最后的command/exit生命周期修改、恢复简单test helper和新增public-web mutation guard之后，没有完整GREEN。主控从该现场开始用既有排他日志wrapper独立执行当前CLI guard，再由fresh writer按实际缺陷完成必要修正和新mutation证据。任何后续通过不补回上述旧日志字节。


## URL 首候选复核与范围收窄

URL writer已结束本轮，logger目录没有尚缺exit的进程记录。主控冻结10文件于issue-url-checkpoint-001.json。实际OMP URL GREEN只证明Create无Project的search/load/search/load/read/文本完成；固定接着读网页，没有两种观察分支或分页补证，web_read ID与URL仍硬编码。因此不计完整AC04/AC05行为通过。

reader层已经有HTML提取、缺标题的真实正文、地址/mixed DNS、IP literal与超时的D用例；其中fixture transport不证明默认socket实读或流限制。原始模块路径错误仍只算setup。后续默认lookup options.all、编码类型/charset、真实流截断/每跳重定向、配置与跨入口仍待补。

主控拒绝新增production-tools持久schema用例的验收口径：该测试手写另一份dynamic schema、注入总返回成功的webSearch，并期待providerRequests=[undefined]。这只证明自定义schema优先级，不证明生产持久schema被正确消费或真实搜索可执行。生产ompToolDefinitions仍先用builtin定义，web_search可绕过持久definition。后续须删除这条维护用例，换成实际OMP请求定义与真实EventStore持久目录核对，并以明确mutation证伪；不能保留假成功断言。

原controller直接not_configured用例已因不在批准seam被删除，仅为诊断，不计验收。缺配置公开反馈环、错误参数后继续、跨入口、显式限制仍由fresh writer完成。

CLI当前现场由主控wrapper独立跑9/9退出0、21.65秒，完整raw保存；前后两脚本hash一致。全局sourceChanged=true仅因为独立URL writer当时修改reader和network test，不能作为整树同源验收。后续CLI收口另由fresh writer补命令运行中可读取raw的可失败guard与新的mutation证据，旧缺raw限制不变。


## CLI r1 独立双轴

两脚本冻结补丁34161 bytes / SHA256 0f661d74f14440a52c8233ff3319bc416e645580fec353dbe6dbe8a67b145bb8；固定点与HEAD仍e3e95621，提交列表空，审查实际working-tree补丁。两位fresh Astra xhigh分别只读核对初末2/2 hash、完整patch及真实raw；未运行测试。

Standards：硬规范问题0；P3 Possible Duplicated Code判断意见1。测试四处展开同一必需TS列表，已有requiredCapabilityTests可复用。主控采纳此最小review refactor，仅改测试四处引用后复跑11项；不修改CLI实现。

Spec：遗漏/部分0、越界0、实现错误0。必需public测试/源缺失门禁、前后hash、排他private round、启动前command/before、fd直接双流、结束exit/after和D/O/L/M/P口径符合当前子卡。11项当前raw与三组current0/mutant1均独立核对。

finish writer另外报告一次未包裹node --test用于诊断NODE_TEST_CONTEXT递归，未持久完整raw；此限制与前六次分开保留，不将后续新mutation当作旧日志恢复。当前后续新正式检查均使用主控wrapper。


## CLI r3 两轴清零

在synthetic npm输出前加入2.5秒受控启动延迟，旧2秒窗口的issue-cli-stream-live-delay-red-001退出1（2.66秒）；随后使用10秒实际deadline并对提前退出明确失败，保留barrier前alive、双流、command/before、无exit及释放后exit/after全部断言。GREEN退出0，full-005完整11/11退出0、源无漂移。

r3两脚本补丁34880 bytes / SHAd3360ff35ef958adcc66146c40cf1a575f0b2470292e13a3bb2c00e2ffaa9fe7；CLI保持d6aa132c...，test为1e6878adc52a56263d45d7dffce7eeac35a3be44986f2607500c9b27d67a7f62。Standards原P2/P3清零、新增0；Spec遗漏/越界/错误均0。两位Astra初末hash/真实patch一致，并独立还原窗口差异核对RED哈希；均只读未重跑。

修的是观察窗口约束。原full-003具体变慢原因仍未知；它及早期缺raw记录全部保留。

## 默认公网实读的环境边界

主控将当前reader及23个实际编译输入单独构建成私有probe；源码/依赖输入和bundle哈希保存在issue-native-public-input-hashes-001.json，bundle SHA7b199d4bcafc1b7156eabc5ca01375fd68c3394439a10b7a11a2f6ba4f8437f4。issue-native-public-build-001退出0；默认DNS/native HTTP路径读取https://example.com的issue-native-public-read-001退出1，真实结果web_read_destination_not_public，无正文。

issue-native-public-dns-001独立系统DNS查询退出0：1个IPv4答案，属于198.18.0.0/15 benchmark地址段。日志只保存类别/数量，没有复制具体地址。该次在socket前按公共网络策略被拒绝；不能据此断言默认socket已经联网成功，也未到lookup(all)协议。保留公网实读成功blocked的环境边界，不改DNS/代理或放宽非公网地址策略，不解除L/M。最终源码变更后应单列重验，不将此候选probe冒充最终字节。


## 产品 r1 独立双轴

12文件固定点e3e95621、commit list=[]；actual patch129511 bytes / SHAfd3b32ad050fcdfca0ca859dd0fb951ddca8369a289fc62094d0da4f0dc572d8。两位fresh Astra xhigh初末12/12 hash、actual/saved patch与HEAD一致，只读未运行。主控同源全仓typecheck退出0、14.79秒；还未运行完整JS/Python/build。

Standards：P1×1、P2×4，smell0。公共搜索fetch默认跟随redirect扩出登记endpoint；搜索静默slice5且空来源成功；HTML空title/published误记；native stream用例上游1秒自动end使完整缓冲后截断也能过；lookup断言在被改成IP hostname的请求中根本不执行（Node原生源码确认）。

Spec：遗漏/部分3、越界1、实现错误4。除上述公共网络/来源和两处native证据问题，还缺恶意网页真实输入（只有D_PUBLIC_BODY，禁止调用由fixture固定发出）、跨入口搜索实际成功覆盖；root lock多余license行未去掉；合法UTF8字符在字节cap处截断被fatal decoder当parse_failed；目录offset/limit允许number与任意大值，reader只接受safe integer且limit<=20000。response.json无独立字节上限作为搜索网络边界补充处理，不伪称原Spec给出了搜索专用字节数。

主控不接受作者把C普通实现修改称为mutation：c-production-tools-regression-001只是正常两文件回归exit0，没有撤去guard→失败→恢复的记录。真实模型定义/持久catalog核对可以保留；下一修复必须新增明确mutation，不改称补回旧RED。

A早期空目录最终查明是fixture把目录query误改sufficient/insufficient，改回public后正常；另一次body局部变量错误也是setup。B首次minimum验证缺失是实际schema问题；后续HTTP201/200误判、run body误传project_id、surfaces修改落错测试等都是fixture。D失败响应误parse及重复toolCallId是transport夹具问题，不是SDK根因。

E9项仅是reader D。只有实际Workbench/真实OMP的A/B/D场景可核定D+O；但r1上述缺口未关闭，不能按作者“A-E均完成”验收。

修复按独立文件边界派fresh Luna：搜索/会话writer只写production.ts、public/web-search/production-tools测试及移除root lock无关行；reader writer只写reader、capabilities、production-tools源码和network测试。无同文件并发，CLI保持r3冻结。修后统一新冻结、独立两轴复核。


## r1 修复进度（尚待整体冻结复审）

Reader writer已停写，修复UTF8 cap、空来源、integer/20k schema、实际lookup(all)调用、保持打开的stream peer-close与I/O开始后取消。wrapper issue-reader-fix-network-final为13/13、issue-reader-fix-typecheck-final2退出0，均sourceChanged=false。直接capabilityToolParameters schema测试已按主控要求删除；其mutation-schema raw仅为诊断，不计公共seam验收。其他真实变异保留原exit与源码记录；名为network-red但退出0的记录不冒充RED。

CLI另加入web-search.test.ts必需执行与发现门禁。缺失RED、独立mutation current0/mutant1、argv检查和issue-cli-search-required-full-001的12/12均有wrapper raw。该full的全局sourceChanged来自并行产品测试修改，两个CLI owned hash稳定；必须以整体冻结后复审和新执行验收。此时CLI SHA e21dedff5a71c21435b8c3d8b4d72188ea5f0ee155f5c7d7fc545ca71c107935，test SHA2179031d5691825dcce63d1ac825acc795d6b0d3b8fe01a1b1296cd01fe92199。

搜索/会话writer仍负责真实跨入口搜索、恶意权限正文、实际OMP与持久schema、真实C mutation及精简per-Run receipt。receipt只声明实际Host/Gateway/OMP事件且模型/HTTP为fixture；不能将fixture归为L。当前无完整四项、正式增量或最终验收。


## r2 冻结与主控检查（两轴结果待回）

全部writer已停写/drain。scope为supervisor/product-review-r2/scope.json，12文件patch159695 bytes，SHA117634b27f90e6b1b2d550cdf524025d78e7f2da7b3e325518db86acaf80af30；固定点/HEAD仍e3e95621。12保护输入与原dirty digest保持。fresh Astra Standards/Spec独立只读复审中。

主控wrapper：issue-public-r2-focused-001四文件48项、typecheck-001、cli-guards-001十二项、python-001的1085项、web-build-001、host-build-001、release-scan-001均退出0且sourceChanged=false。全套JS和正式增量待运行，不能提前接受本slice。

搜索writer的issue-search-definition-mutation-002实际恢复旧静态优先时，真实OMP观察到的web_search描述与持久catalog不一致，退出1；恢复实现后的green-002退出0。该组源码前后稳定；更早mutation-001的全局漂移保留，不能代替这组证据。最终公开测试移除不可达web_read重复分支，实际目录offset safe integer/limit20k与模型定义完整一致。

receipt审计final-001因相对路径解析错误读取空目录，输出count0，主控拒绝将其记为通过。测试实际生成在apps/harness-service/.tmp-tests/wb02-public/supervisor/issue-search-receipts-final-001，final-002正确读到12Run、45dispatch/response、5失败（chat2、failure-feedback2、Skill权限1）。不移动/覆盖旧raw；正式CLI使用自身绝对receipt路径并由主控独立复核。

最终reader单独probe使用23个编译输入，前后hash一致；bundle SHAebdabccc31d7c47d5ae9a3877381f1fb2a910c3ecc54042bc2c9f901d2ddd8e8。issue-native-public-final-build-001退出0，final-read-001退出1：web_read_destination_not_public、无正文。final-dns-001再次确认example.com的1个IPv4答案位于benchmark保留段；未改变网络策略。早期probe及原失败完整保留。


### r2 Standards 独立结论

Standards：0。r1五项已清零；新增硬规范0、smell判断0。fresh Astra核对初末12/12hash、HEAD/base、空commit list、实际重建159695bytes补丁SHA117634b...与冻结一致。指定raw及真实变异1/恢复0、CLI门禁与正确12receipt均只读核对；未改文件、未运行测试。结论不替代四项或正式AC18b，fixture及L/M/P边界不变。


### r2 Spec 独立结论

遗漏/部分0，未授权越界0，实现错误0。r1原8项清零，新增0/0/0。fresh Astra初末12/12hash、HEAD/base、159695bytes实际/saved补丁SHA117634b...一致；只读未测试。核对12Run/45dispatch/45response/5预期失败，以及mutation1/恢复0。mutation/恢复时public test字节早于最终receipt简化，最终surfaces-green-006/typecheck-003为全部12文件冻结字节；主控另完成同源48/12/1085与typecheck/build/scan。全部旧失败和缺raw保留。完整JS正在执行，正式AC18b尚未执行，整WB02不关闭。


## 主控完整回归

issue-public-r2-full-js-001退出0，781.01秒；九组包汇总1229passed/0failed/7skipped，其中Host232passed/1skipped，OMP内核42passed。类型检查、Python1085、Web/Host build及CLI12此前均通过。issue-public-r2-check-ledger-001独立核对七组完整argv/cwd、原始日志hash、exit0与12文件before/after/current等于r2冻结；全部sourceChanged=false。此轮没有重跑挑选成功，旧轮失败仍保留。

正式新轮wb02-public-20260911-r1已启动；未复用或覆盖已有轮。正式证据验证前不提交或转交。


## 最终验收与提交

正式轮 `wb02-public-20260911-r1` 退出0，177.02秒；9个TS文件51项、Python5项通过。issue-public-round-verify-001独立核对全部41个manifest条目的路径全集/大小/hash、54个源before/after/current、12审查hash；12公共Run/45dispatch/45response/5预期失败；私有TS/Python实际argv/cwd/exit与公开receipt一致，raw双流hash已记录。sourceChanged/ownedChanged均false。CLI的O字段保持metadata_only，主控依据实际OMP进程、运行包核对及公开产品测试核定本slice的O范围，未改成L。

issue-runtime-inputs-final-001再次核对21465运行文件、manifest、worker/protocol/runtime lock及12保护输入。issue-public-drain-001检查本任务wrapper记录的进程组无活动残留，所有Coding/Reviewer已结束。issue-public-candidate-scan-001将12实现文件、42公开JSON和3份新文档全部显式送入公开扫描，退出0；此前release扫描仅覆盖tracked树，不用它代替新文件扫描。

代码/公开证据精确提交 `10cc1e799b9b88b4e9c4e9d1878aa78918ace20e`，54路径（12代码/测试/依赖/脚本+42JSON）。issue-public-round-git-verify-001逐个核对54源hash和12审查hash与该提交Git blob一致。正式轮保留当时base SHA和dirty候选事实，不回写其sourceSha来伪装提交后执行。原user tracked dirty digest仍5a5a75da...，AGENTS/CONTEXT/docs/agents/规划未纳入提交。

主控接受公共搜索/URL读取的D/O契约和本次AC18b增量：Standards0；Spec遗漏/越界/错误0/0/0；完整JS1229pass/7skip、Python1085、typecheck、Web/Hostbuild、CLI12全部通过。L/M blocked、P not_run、usage unavailable；默认公网成功仍因benchmark DNS未验证，WB00的36槽及整WB02未关闭。三份交接文档单独提交后按SUPERVISOR转交，最终HEAD/owner见STATUS。
