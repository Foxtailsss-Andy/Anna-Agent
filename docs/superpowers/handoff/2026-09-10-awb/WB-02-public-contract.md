# WB-02 公共检索与 URL 读取切片契约

状态：公共搜索/URL读取切片D/O契约、独立两轴与AC-18b增量已验收。整WB-02保持in_progress，文件与固定业务能力仍待后续切片。

- owner_task_id：`01a08bb4-50a8-7ad0-9e6e-0af0ce5e3938`；唯一 owner 以 STATUS 为准。
- baseSHA：`e3e95621abbb15b66767e7b4bd9a6b2b3db7a9d4`；分支 codex/workbench-plan-20260907；唯一工作树 Anna-Workbench-Plan-20260907。
- Spec 1.2，R-01/04/05/15；AC-01/04/05/15 对应公共读取部分，AC-18b 独立增量。核心 A 与 Skill 既有证据保持。

## 派卡前判断

1. 用户结果：同授权用户从 chat/create/crew 普通输入研究问题，模型能发现搜索和正文读取，按实际结果决定是否继续取证。返回真实 URL、标题、获取时间，来源未提供发布时间时不生成发布时间；错误和截断可观察。
2. 认证身份、Channel/Project、显式 Skill 限制及公开网络边界是授权事实。入口固定工具表、默认 Skill 和是否绑定 Project 不能成为公共检索上限。
3. 公开 seam：Workbench Session/Run API → 真实 Python 身份及 scope → Host/Gateway/EventStore → 实际 OMP → 登记的外部搜索/HTTP transport。固定模型和外部网络响应允许 fixture；内部权限、状态和执行层保持真实。
4. 当前 production.ts 已有 createWebSearchProvider、生产 Gateway 已有 web_search；v2 目录与 profile 仅覆盖 Skill/Crew，因此优先接入现成搜索。当前范围搜索未发现 URL 正文读取执行器，需要新增小型网络适配。受管 Worker 不直接放开网络，不新增插件框架或第二个执行所有者。
5. 第一个可失败行为：无 Project 的公开 Create 会话搜索目录，取得实际 canonical ID 并加载，搜索返回合成来源事实，下一次实际 OMP 请求读到来源与获取时间，文本完成。初始定义只含现有控制工具。之后逐条覆盖观察分支、正文分页与权限/失败。

## 公共行为与边界

- 复用 canonical web_search；新 URL 工具的名称/输入由最小网络适配确定并记录。定义使用持久能力目录，load/实际模型定义/dispatch 保持同一 ID。显式禁止仍拒绝。
- 搜索未配置时可报告明确 not_configured；不得将其记为真实搜索成功或隐藏失败。配置来自可信 Host；renderer 不能提交 endpoint、密钥、网络策略或授权目录。
- 公共 URL 读取只访问允许的公共 HTTP(S) 目的地址；逐跳重验重定向，阻止 loopback、私网、链路本地、凭据端点及其他非公共目标。DNS 解析与实际连接必须绑定，不能只校验 URL 字符串。连接器凭据不传给公共页面。外部内容始终作为工具数据返回。
- 正文支持有界分段读取，返回 URL、标题或明确缺失、fetched_at、范围及 truncated/后续读取信息。published_at 只来自明确的来源字段，不从抓取时间猜测。响应在读取过程中受字节/时间/重定向上限约束。
- 网络失败、无配置、错误参数、无正文/不支持类型、截断与未授权可辨识；错误反馈后模型能修正参数或继续正常工作。
- 一个合成网页宣称新权限时，尝试加载被禁止能力仍被现有 Gateway 拒绝，后续正常读取可继续。此为 D/O 权限契约，不声称真实模型注入抵抗质量。
- 新 Run 使用当前登记定义；旧 Run 保持持久快照。若改变初始化，必须覆盖 cold 和 omp-ready-abort，保留 context ready 后取消/预算检查 → Gateway → loaded map → initial subset 顺序。

## 第一个 Coding tracer

唯一 fresh Luna xhigh writer；首轮仅接搜索，修改 production.ts、workbench-capabilities.ts 及新增 workbench-capability-public.test.ts，必要时 production-tools.ts。使用本地合成搜索 HTTP 服务穿过既有 Provider，不注入假的 ToolResult，不 mock 身份/权限/Gateway/Store。先取得有效 RED，再做最少接线与来源元数据；GREEN 后停写，由主控核定下一条用例。首 tracer 不代表本切片验收。

每条测试先创建带 issue 的唯一目录，排他写入完整 command、source hashes、真实 stdout/stderr 和 exit code；保留失败，不事后补造 raw。外部 fixture 与实际 OMP 分别记账。源码冻结后两位 fresh Astra xhigh 独立 Standards/Spec 只读审查；主控独立验证。

新模块/测试/固定资源加入现有 evidence CLI 前后 hash 和独立缺失门禁。完整交接前运行四项仓库检查、Host build、实际 OMP 与正式 AC-18b，并独立核对公开 manifest/receipt/源与运行包。WB-00 r5 的36槽保持21 blocked/15 not_run；L/M blocked、P not_run、usage unavailable。

## 后续范围

可信 resource_refs/工作目录解析、目录/路径或内容搜索/分段文件读取，以及 Hiker/报销/剩余 Crew 固定读取仍由 WB-02 后续切片完成；本切片不能关闭整卡。WB-03 原 UI、WB-04 控制依授权接续。WB-05～09、自动 Memory、Sandbox、push/PR/发布不在范围。AGENTS/CONTEXT/docs/agents/AWB规划原字节保护，仅 STATUS 可必要更新。

## URL 后续实施决定（待 tracer 核定后派工）

已核对本树 OMP 18.0.11 的 tools/fetch.ts 与 web/scrapers/types.ts：其主读取链依赖 Bun/原生转换、约80种站点 handler 和可选转换工具；loadPage 使用自动跟随重定向。当前受管 Worker 禁网络且没有 Anna 公共目的地址校验，因此不整套启用。此判断只说明接入范围，不评定上游自身的通用安全性。

URL 适配采用 Host 的小型 `web_read` 能力。输入只含 url、offset/limit（正文字符范围）；正文只读，不接收自定义 headers、凭据、代理或网络策略。每次读取返回实际 final URL、fetched_at、正文 content_sha256、范围、truncated 与 next_offset（有保留正文剩余时）；如上游超过抓取上限，另标 source_truncated，不谎称尾部已完整。

HTML 用 parse5 解析，避免自己实现 HTML tokenizer/entity 解码。2026-09-10 npm registry 已核对 parse5@8.0.1，integrity `sha512-z1e/HMG90obSGeidlli3hj7cbocou0/wa5HacvI3ASx34PecNjNQeaHNo5WIZpWofN9kgkqV1q5YvXe3F0FoPw==`，依赖 entities ^8.0.0。允许下一 writer 只为该解析用途把 exact parse5 版本加到 Host package 和根 lock；不改 OMP runtime lock。正文提取去掉 script/style/template，保留可读文本；只从真实 title 和明确 article:published_time 等来源字段提取元数据，不把 Last-Modified 当发布时间。无标题/无正文/类型不支持明确报告。

网络使用 Node HTTP(S) 原生请求，由系统 DNS 解析后拒绝非公共地址并把获准地址绑定到实际 socket；每跳重新执行同一检查，禁用连接复用和自动重定向。URL只允许HTTP(S)标准端口、无userinfo；不传Host/业务密钥。流读取有固定上限、超时与取消；重定向有固定上限。IPv4私网/loopback/link-local/reserved及IPv6非全球单播/映射/隧道保留范围必须在I/O前拒绝，混合DNS结果也拒绝。拒绝响应不回显内部地址或解析结果。

测试允许在 DNS 与 HTTP transport 这两个外部边界提供固定结果；必须穿过生产URL校验、地址判定、分段/解析、Gateway与实际OMP。不得注入可直接返回成功 ToolResult 的URL executor，或用mock的权限检查声称安全。默认原生网络路径另外验证本机目标零连接；固定public地址transport用于合成HTML正向、重定向、截断与失败。真实公共网络成功和真实模型质量仍另记。

依据：[Node HTTP 原生请求](https://nodejs.org/api/http.html)、[parse5 parse API](https://parse5.js.org/functions/parse5.parse.html)；实现时以本树 Node24.12.0 的类型及实际执行核对。


公网地址判定参考已核对的 [IANA IPv4 special registry](https://www.iana.org/assignments/iana-ipv4-special-registry) 与 [IANA IPv6 special registry](https://www.iana.org/assignments/iana-ipv6-special-registry)，2026-09-10读取，登记页更新时间2025-10-09。首版采用保守公开网页网络面：IPv4拒绝私网/loopback/link-local/shared/documentation/benchmark/multicast/reserved段；IPv6只接纳2000::/3中的普通全球单播，排除2001::/23特殊用途、2001:db8::/32、2002::/16及3fff::/20。该固定策略不声称覆盖所有公网特殊协议服务，也不对每次读取动态获取IANA列表。

原生网络还应独立尝试一次无凭据公共静态页（如example.com），保存默认DNS/socket/HTML提取实读结果；若外部网络不通，保留具体失败与未验证范围，不借fixture替代。它只证明该次公共URL实读，不解除真实模型L或业务M阻塞。


## 搜索 tracer 核定与下一序列

首 writer 已停写/drain。有效 RED：coding-tracer/20260910T-red-public-capability-workspace；目录缺搜索。No test files found的尝试仅为setup失败；后续未通过的GREEN名称按退出1保留。v2不能沿用已被默认Skill求交的旧profile.allowedTools作为搜索授权来源；现已直接登记公共搜索，显式限制最后收窄。最终首tracer通过，相关3文件25项通过、typecheck退出0。主控独立同一公开测试1项通过、9.60秒、源前后无漂移；本地 issue-tracer-freeze-001.json 冻结5文件。仍未验收本切片。

后续逐条垂直实施：先公共OMP的搜索观察不足→发现并读取HTML URL→正文截断→继续后段→文本完成；另一观察充分时直接结束。再补网络拒绝/错误反馈、缺配置/缺来源/发布时间、跨入口与显式禁止、Gateway持久schema一致性。每条先行为RED或明确mutation，不一次写完所有测试。

公共连接器 seam 明确包括 createPublicWebReader 的请求/结果：可在外部DNS及HTTP transport提供合成事实；URL/地址策略、分段解析不得mock。工作台代表用例必须穿过真实身份/持久状态/Gateway/OMP。web_search 的Gateway定义当前仍需从v2持久目录消费，v1静态定义兼容保持；不能用一份静态schema与一份持久schema靠first-wins掩盖差异。


## r1 审查后的明确边界

搜索Provider只访问可信Host登记endpoint，HTTP redirect不跟随；非成功响应取消未消费body。搜索JSON在流读取中限制1MiB（1,048,576 bytes），超出即取消并返回明确失败。此数值是本轮针对无界响应的最小实施决定，不声称原Spec已规定。最多返回5条时显式truncated；空title和缺失/无效URL不能冒充完整来源。

web_read的来源字节上限为1,000,000，正文每段最多20,000字符。offset为非负safe integer，limit为1～20,000的integer；持久catalog、实际OMP定义、Gateway验证和reader一致。来源在合法UTF8字符中间达到字节上限时，仅解码此前完整字符并标source_truncated；内部非法UTF8仍失败。空title为null并标source_missing，空发布时间不生成字段。默认请求声明Accept-Encoding: identity，不接入解压/其他charset框架。

原生网络测试的注入点是DNS与原生HTTP请求边界；必须消费生产lookup回调并观察真实IncomingMessage。上游保持打开，测试在主动清理前验证限流或取消触发peer close，不能通过自动end证明有界读取。公开模型schema断言必须走真实OMP和持久catalog；直接helper测试仅作诊断。
