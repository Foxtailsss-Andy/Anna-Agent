# Anna Jev Crew Preview · ACCEPTANCE

版本：JEV-PREVIEW-1.0 · 2026-09-21 · 配套 [SPEC.md](SPEC.md)。状态：验收设计已冻结，以下检查尚未执行。

验收固定候选 SHA、Spec/问题/adapter 版本、fixture hash、运行环境、主模型实际模型、Jev 请求及返回模型、`eval_round_id`。每次模型尝试保留 pass/fail/blocked/not_run；失败不删除，修复开新轮，不能把不同轮的最好结果拼成通过。本文件不继承旧 RC2 的测试数为本次结果。

## 1. 公共 seam 验收矩阵

| ID | 触发 / 核验 seam | 必须观察到的结果 | 主要票 |
| --- | --- | --- | --- |
| JEV-AC01 | 真实startProductHost HTTP，缺失/错误service token、额外endpoint/key/tool字段、非法ID/hash、body/响应超限、并发第5请求 | 鉴权/结构拒绝时provider调用为0；请求32KiB/provider响应64KiB/归一化输出16KiB上限；4在途无队列，第5返回jev_busy；异常释放slot；错误正文不含输入/Key。 | 01 |
| JEV-AC02 | Host 正常一次 Choice、abstain、未知选项、缺失/重复答案、非法概率 | 闭集映射正确；未知/畸形不选首人；abstain 与错误分开；不制造 tool call/OMP transcript/Run。 | 01 |
| JEV-AC03 | Host 401/403/429/5xx/网络/超时/取消/关闭 | 稳定错误码；4 秒总预算；零自动 retry/LLM fallback；signal 到达 transport；迟到响应不变为建议。 | 01 |
| JEV-AC04 | 未配置/关闭 Jev；仅配 Jev 未配主模型；launcher env 与文件保护 | 未配零请求且手动可用；Jev 不依赖生成模型 preflight；Python env 无 Jev 配置/文件引用；Key 文件不能经受控文件工具读取。 | 01 |
| JEV-AC05 | 同一生产 adapter/Host seam 的真实 Jev smoke 与 metadata | 真正收到 provider 响应，留实际来源/耗时/usage或null；不将 fake transport 计为 live；无原始 Key/输入正文泄露。 | 01 |
| JEV-AC06 | Crew 新建议 HTTP：无登录、异工作区、不存在、gate、已指派、非法状态 | 401/404/409；读取/返回 scope 正确；不读越权 roster；provider 调用数为 0。原权限未凭空变成 owner-only。 | 02 |
| JEV-AC07 | 0 候选、唯一角色、同资料并列、多角色、超过20人/16KiB | 规则来源/待定/限制明确；role 不是权限；无静默裁剪或按名字猜人；任务始终未指派。 | 02 |
| JEV-AC08 | pending/ready 取消；cancel 先于 POST；重复 request_id；同 id 不同 scope；重启后未采纳 | 一次在途模型请求；取消不复活；跨scope不泄漏；过期/重启不能采纳旧缓存。 | 02 |
| JEV-AC09 | 真实render的MemberPicker，按钮→延迟响应→建议；手动选择并行可用 | 只有明确点击调用；生成不触发assign；只映射当前task/id；来源来自结果；显示真实Host「判断耗时」，规则为「未调用模型」，缺失不补0，不称E2E或成功率。 | 02 |
| JEV-AC10 | UI Esc/外部点击/任务与项目切换/unmount/新请求晚到 | abort + cancel；旧结果不覆盖新界面、不自动采纳；不得仅测试一个脱离组件的 reducer。 | 02 |
| JEV-AC11 | `assign` 带 decision_id：任务/依赖/目标/role/候选资料改变、候选删除、已手动指派 | 当前事实重验；409 stale；零任务变更、零频道/通知、零 Worker dispatch。普通频道新消息不触发 false stale。 | 02 |
| JEV-AC12 | 新采纳service/HTTP，两个并发重复、顺序重复、重启后重复、换member重复 | 一次持久receipt；正常无故障路径一次频道/通知触发与至多一次dispatch；receipt readback不重派/重发，换member冲突。 | 02 |
| JEV-AC13 | 事务任一点注入失败；cancel/adopt交叉；commit后通知/dispatch失败 | 事务回滚时零通知/派工；取消先赢则拒绝；任务+receipt原子；commit后effects可失败，仅报告指派成功，不伪称执行完成或崩溃恢复exactly-once。 | 02 |
| JEV-AC14 | Human、blocked Worker、ready Worker；门/依赖与原自动推进 | Human不运行；blocked等待；ready按既有策略；显式建议不调用 `_auto_advance`，完成/解锁仍走旧 matcher，Jev transport额外调用数为0。 | 02 |
| JEV-AC15 | 实际浏览器→公共Crew API→生产Host→真实Jev→公共assign→SQLite回读 | 完成真实单任务可见闭环，保存decision_id与指派receipt；不得把预设mock答案当演示。 | 02/03 |
| JEV-AC16 | 当前真实生成模型可用时，ready Worker 从指派到 Host Run，再看实际终态 | 关联真实run_ref，区分指派/启动/产物/完成；遇到依赖或provider阻塞如实记录，不用旧视频拼接。 | 03 |
| JEV-AC17 | 冻结32例四组对照与统一数据汇总 | 保留所有槽位、输入/版本/来源/时延/成本口径；规则零调用不计Jev能力；不存在同字段省略/合成技能造成的不公平输入。 | 01/03 |
| JEV-AC18 | 对当前候选HEAD的相关测试与整仓交接检查、独立审查、公开草稿 | 检查命令/退出码/环境留证；未通过与未运行明确；只写已验范围，不把本地preview写成正式生产或全平台发布。 | 03 |

测试优先跨生产公开接口：Host HTTP + 同一 adapter；FastAPI 新建议/assign HTTP；`CrewService.assign_from_suggestion` + 临时真实 SQLite；渲染的 MemberPicker + 相同 API wiring。fixture transport 用于确定性边界，真实模型用于质量/延时，不写只复述实现的私有函数测试。

可复用回归入口：`apps/harness-service/test/product-facade.test.ts`、`tests/business/test_host_runtime.py`、`tests/api/test_crew_api.py`、`tests/crew/test_auto_trigger.py`、`tests/crew/test_crew_store.py`、`tests/crew/test_channel_and_notify.py`；新测试与旧测试均应从实际入口触发相关行为，不通过修改旧断言隐藏回归。

## 2. 真实评测最小方案

### 2.1 冻结样本

采用 **32个合成中文单任务案例：8个开发smoke+24个独立heldout**，使用Anna现有任务/Account字段；明确标注合成数据，不声称客户样本。fixture内事先写case_id、输入、允许答案集合或必须弃权、简短标签依据、类别、split，分别保存hash。标签不在模型输入里。总体分布如下：

- 16 例有可区分资料，包含现有角色措辞/中文同义表达、不同角色与Human/Worker组合。
- 8例信息不足或同 `(role, kind)` 的多人，按SPEC必须标 `must_abstain`，不能把任意其中一人标为允许正确答案。仅当已有资料确实可区分且多个候选均有效时，其他类别才可用允许答案集合。
- 8 例无合适人选/角色不匹配/无候选/不支持规模与对象。区分业务预检例与实际模型判断例；业务拒绝不计入provider质量分母。

至少24例适合进行实际Jev判断；若上述样本中大量是规则/预检，补充实际语义案例到32例内并在第一次live调用前冻结分布。heldout至少18例为有效模型输入，且包含可区分、must_abstain、跨角色/措辞变化；开发smoke至少6例有效模型输入。字段、标签和split由Astra预审，编码者不能看了模型输出再改标签。本轮不建立300例标注前置。

24例heldout由Astra独立审定，不用于smoke、调提示词或阈值，最后固定版本才调用。开发8例与heldout24例分别报告，32例合并仅作描述性统计，不能称32个未知样本。如果根据heldout改实现或政策，该集转为已使用测试集，下一次泛化结论必须另换留出集。

### 2.2 对照组和必需性

| 组 | 调用方式 | 必需性及证据解释 |
| --- | --- | --- |
| A 现有角色规则 | 真实 `deterministic_proposals`，单任务输入 | 必需、无付费；保留原 Human优先/首人策略的真实错误，不改基线取胜。 |
| B 当前 Crew matcher | 同一个任务/候选语义字段经真实 `CrewMatchingService`→`HostHarnessRuntime`→既有 ProductTask | 当前主模型可用则必需；不看旧API source猜调用成功，使用Host事件/实际响应确认生成模型是否调用及是否落回规则。配置/网络失败留blocked或真实fallback。 |
| C 精简生成模型 | 在离线eval代码中使用Host读取的同一生成模型配置，一次受约束结构化选人/弃权，无工具循环 | 判别「Jev收益还是减少Host/loop开销」的对照；当前配置可用时必需完成后才能作模型优劣比较。仅存在eval，不能接入产品自动fallback。 |
| D Jev | 同一生产 typed adapter + 受保护 Host seam，eval入口明确 force Jev | 必需；绕过规则直达仅用于测量，状态/长度/合法候选硬检查仍保留。真实Jev调用分母单列，生产混合规则政策另报。 |

主控已确认现有生成模型 `deepseek-v4-pro` 配置存在，尚未调用API验证；评测用隔离host.json，引用见同目录LAUNCH。若实际调用失败，B/C如实blocked，不阻塞Jev/规则与首个可见preview；但缺B/C时不得声称优于当前模型或完整旧调用链。评测工具不能打印/复制配置秘密进输出文件。

若旧matcher本身只读取title/role，公平核心对照为所有组使用这个共同字段子集；扩展description/acceptance输入的组单列为扩展实验，不能把它与较少输入的B混成唯一性能/质量结论。相同case保留候选顺序并记录；另选4个开发集语义case做一次候选顺序反转敏感性检查，作为诊断不混入主32例分母，也不提前使用heldout。

### 2.3 分阶段调用与预算

1. **JEV-01 smoke：** 冻结8例开发集后调用D各1次（硬预检拒绝的记录不计provider调用），包含可选人/应弃权。此阶段允许交付早期Host证据，不宣布32例质量通过。先验证实际endpoint、模型、取消、usage口径。
2. **JEV-02 可见闭环：** 在明确标注的合成项目执行一次实际Jev建议与人工采纳；另验证规则、不可用、blocked Worker等公共路径。使用force Jev的工具证据不能冒充默认UI必然调用Jev。
3. **JEV-03完整轮：** 固定HEAD/问题版本上A/B/C/D按相同split每case各1次；不适用/配置失败保留槽位，预算到限的槽位标not_run。24例heldout最终只运行一次并独立汇总，开发8例另报。32例仍只为小型方向性评测；若需要稳定p95或小幅质量差异，另开扩展轮，而非在小样本上做强结论。

本期所有票/Session共享同一累计账：**Jev最多2美元或500次provider请求，生成模型最多100次provider请求，全部模型合计最多10美元，任一对应上限先到即停。** B的一个Host Run可能包含多次模型调用，必须逐provider调用计数；一次逻辑case不等于一次请求。主控统一预算账，跨Session/换轮不归零。工具限制请求数/单次timeout/零自动retry，并记录累计实际usage与带日期价格的估算；接近预算时为下一请求预留保守余量，不能先调用再发现超额。无法获取provider账单时不得把估算写成已确认账单；usage缺失时不能按0扣预算，应暂停新增批量请求，先由主控核实剩余额度。已有8例smoke不从证据删除，若实现变更则新轮重新固定。

## 3. 指标、门槛与结论等级

每条记录：case_id/round_id、输入hash/标签版本、source、provider_called、请求及返回模型、预检/规则结果、建议或弃权、标签判定、provider耗时、Host总耗时、公共API耗时（若经过）、实际usage/null、估算成本与价格日期、错误码、retry_count、是否人工采纳、receipt/run_ref。用户人工思考时间单列，不能混入模型延时。

质量至少报告：正确建议数/可判断case数、错误建议数、应弃权case上的错误推荐数、弃权率、有效建议覆盖率、完整产品政策结果。provider错误与格式错误分别列，不能从质量分母删除。模型原始选择与规则/校验收窄后的最终选择分开报告。

耗时报告每组样本数、中位数与观测p95；32例p95只是该轮观测值，需同时给原始数据。若两组有超时/blocked，完整路径延迟必须保留超时上限，不能只对成功快速项算提速。成本给每次逻辑判断/完整路径总成本；B的Host多次调用全计，规则为零provider调用但不得称Jev零成本推理。

**进入用户可见受限preview的门槛：**

- JEV-AC01—14相关确定性检查通过，无已知越权、错误成员映射、陈旧采纳、重复副作用、凭据泄露或自动推进串线；发现任何一项即修复后新轮验收。
- 8例开发smoke都有可追溯结果，其中至少6例真实Jev调用、至少一个符合标签的非弃权推荐和一个真实弃权；若没有有效推荐，只能交付连接/实验结果，不能宣布建议功能达到目标。
- 至少一次JEV-AC15的真实UI建议→采纳→SQLite/任务读回。Host单独调用成功不满足此项。
- 不要求32例或B/C对照先全部完成才看到preview；未完成项在STATUS和用户说明中逐一列出。

**写「本轮样本效果达标」的门槛：**

- 完整冻结32例所有必需槽位有结果；D至少24例真实语义请求，其中heldout至少18例；开发8/heldout24分开。provider格式/闭集映射错误为0；任何业务硬规则越界为0。
- 在24例heldout的可判断子集，正确率至少80%，有至少50%的可判断case给出有效建议；应弃权子集错误推荐最多1例，结果需同时给分子分母。开发集不并入这个门槛。该数值是preview筛选门槛，不能推导生产正确率。
- 不满足时保持功能显式可选且如实标实验受限，定位错误；不能靠删失败或把大量弃权称100%正确通过质量验收。

上述80%/50%及弃权错误数是首轮preview筛选政策，尚未经过充分校准；即使通过也保持「实验性、人工采纳」措辞。heldout出现新的系统性错误时不能据主集通过宣布质量稳定，需记录并定向修复或收窄适用范围。

**写「比旧方式更快/更好」的附加门槛：** B/C真实对照可用，同输入、同版本、全部调用成本与超时都计入；质量不得劣于所比较基线，语义有效覆盖不得靠大量弃权人为降低。只报告本轮实测差值；与B有差异而与C无差异时，应说明收益可能来自简化调用链，不能归因Jev模型。无稳定优势也可发布事实准确的集成preview。

Worker完成与发布等级独立：JEV-AC16不通过/blocked时只能声明「建议与指派闭环」，不能声明本次Worker交付闭环。GitHub发布需远程提交/实际CI证据；本地build、文档或fixture通过不能替代。

## 4. 必要检查、证据及未验边界

每票先跑与修改相关的Host/API/SQLite/UI tests；首次失败修复后重跑对应检查。广泛交接/发布前按AGENTS执行：

```text
npm run typecheck
npm test -- --reporter=dot
./.venv/bin/python -m pytest -q
npm run build
```

记录实际命令、退出码、候选HEAD、开始/结束与日志路径。已有环境阻塞不改弱断言；由主控修环境或标blocked。全部通过后没有新变更/新风险不无意义重跑。

交付最小证据：8例开发/24例heldout及各自hash、原始JSONL与分别汇总、脱敏真实Host inference记录、UI截图/短录屏及decision_id、原子采纳receipt与真实任务读回、相关测试与整仓检查日志、独立Astra审定、准确的release草稿。原始secret、完整私人任务或配置文件不进入证据包。

当前未验：真实Jev网络/API、这轮功能实现、中文质量/延时、UI闭环、Worker终态、安装包/Windows/Linux、跨库同步撤权、commit后dispatch崩溃恢复。最后两项是已说明的preview边界，不得被改写成已提供的exactly-once或分布式事务保证。
