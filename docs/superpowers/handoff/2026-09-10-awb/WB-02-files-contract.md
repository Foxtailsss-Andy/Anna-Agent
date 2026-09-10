# WB-02 可信目录与文件读取切片契约

状态：本次读取/身份子切片D/O、双轴、主控回归与AC18b已验；目录/搜索与固定业务仍待后续，提交/交接结果见胶囊。Spec 1.2；R-03/04/05/15、AC-04/05/15 文件部分与 AC-18b。当前 owner 为 `01a08c3f-d9f0-7513-b4eb-99daa61a0ca7`，唯一工作树 Anna-Workbench-Plan-20260907，固定点 `63d3ef27a6cfb9e6e8c046ed38bc1fa02435e869`。整 WB-02 保持进行中；固定 Hiker/报销/剩余 Crew 由后续独立切片接续。

## 本次独立验收边界

本轮收口 **可信目录登记/身份、UTF-8分段文件读取、必要旧Chat/Create衔接**。它们构成可独立验证的R05读取及R03/15权限子切片；不关闭整AC05或WB02。下文五问和行为序列描述R05文件能力总目标，其中列目录、按路径/内容搜索尚未实施，明确留给下一fresh Supervisor；固定Hiker/报销/剩余Crew亦继续待办。原始SPEC/任务卡不变，本轮不将这些剩余项改写为完成。

收口需当前字节的真实Workbench/旧入口代表用例、至少两个v2 Surface的同授权文件可达、分段补证与错误反馈、目录归属/撤销/受保护根及参数边界；沿已有按需目录、Skill限制和Gateway授权契约。整体冻结后双轴/完整回归/正式AC18b及精确提交，再单次交接继续剩余R05。

## Supervisor 五问

1. 用户结果：在任一获准 Surface 的普通 Session，引用用户已登记的目录，模型发现/加载目录、搜索与分页文件读取，按观察继续补证并给出有相对路径、范围和截断信息的回答。
2. 必须保留身份、目录登记归属、授权撤销、Host 保护路径和显式 Skill 限制。v2 直接拒绝 resource_refs、旧工具表与 64KiB 全文件上限属于实现选择。现有 workdir 注册表是全局旧格式，不能把其存在当成所有账号都有读取权。
3. 公共断点：product-facade.ts 的 v2 Run 提交直接返回 resource_refs_not_supported；production.ts 的 v2 能力列表不含文件工具；production-tools.ts 已有受根限制的旧文件执行器。测试 seam 为真实 Workbench Session/Run API、真实 Python 身份/目录登记、Host/Gateway/EventStore、实际 OMP 和真实临时文件。
4. 复用现有 workdirs 用户选择入口、JSON 登记事实、Host 保护路径检查、Gateway 和 OMP 动态加载。最少补当前身份可使用的目录解析、v2 绑定及有界文件读能力；不放开 OMP 原生直接文件工具，不引入 Sandbox/命令执行/插件框架。
5. 首个可失败用例：在真实产品 workdir API 登记临时目录，公开 Create Session 提交其 resource_refs，OMP 从能力搜索返回值取得 canonical ID，加载并读取合成 Markdown 的首段，下一模型请求观察到实际文件正文/相对路径/范围。当前在非空 resource_refs 处失败；之后逐个追加分页、搜索及权限用例。

## 可信资源边界

本切片 resource_refs 使用一个 `workdir:<已有目录ID>`；最多一个工作目录，其他资源类型明确不支持。不得接受 renderer 的绝对路径、workdir_path、context、schema 或授权策略。模型工具只能接受此绑定根内的相对路径；没有目录引用时不授予文件能力。新的 Run 自己显式带目录引用，不从其他 Session 或模型文本隐式继承。

现有显式目录登记接口保持产品用途。在 product mode，登记/列出/删除/解析应使用真实 Bearer 或可信本地身份，归属由服务端写入，客户端不能伪造。新归属数据不改写/清理用户原登记；旧无归属登记仅给可信本地身份使用，其他身份不能凭 ID 获取。非 product 历史接口兼容保持。Host 内部解析和每次文件调用都重新校验当前 scope 与登记；删除或变更绑定后拒绝读取，错误不暴露别人的路径或存在性。

Host 持久化资源 ID 与经保护路径检查的 canonical root；产品投影只公开 ID 和相对文件路径。原 Run 的授权快照不静默扩张，显式 Skill restriction 继续收窄。Host 配置、事件库、会话存储及现有受保护路径不得变成可读目录。本轮为受控只读文件适配，不宣称 WB-06 的进程级强隔离。

## 行为与验证顺序

逐条 RED→GREEN，先公开 tracer，再分页、列目录、路径/内容搜索、失败与权限。文本/Markdown/HTML/CSV/JSON 的 UTF-8 内容作为数据；文件内的权限宣称不改变 Gateway。公开输出含资源 ID、相对路径、读取范围、明确截断/后续位置；不编造文件时间或内容。所有读取/遍历/搜索有明确字节、条目及输出上限，遇到不支持、缺失、非法参数、越界、链接跳出、取消等均真实反馈，不以空成功吞掉错误。具体上限在实现后审定并记录。

必须覆盖：至少两个入口同授权可用；未绑定目录不可见/不可读；外部绝对路径与 traversal、链接跳出、跨身份 ID、保护路径被拒；撤销发生在文件 I/O 前；错误后正常读取可继续；观察充分结束、缺证据时搜索/分页继续；初始工具集紧凑，load/实际 OMP 定义/Gateway/持久目录保持 canonical ID 与 schema 一致。真实文件/身份/业务状态/Gateway/EventStore 不得 mock，模型 transport 为明确 fixture，D/O 不替代 L/M。

## 工程与证据

fresh Luna xhigh 为唯一产品 writer；先最小 tracer，完成后停写交主控核定。仅授权文件可写，扩大边界先向主控报告。所有测试在运行前用 `.tmp-tests/wb02-files/supervisor/run-check.py` 创建唯一 issue 目录，保存完整 argv/cwd、源 before、实时原始 stdout/stderr、exit、after；不覆盖失败或补造旧 raw。新源/资源/必需测试纳入现有 evidence CLI hash 与独立缺失门禁。

冻结实际 owned diff 后 fresh Astra Standards 与 Spec 分别只读审查；主控再做相关公共测试、CLI门禁、四项完整回归、Host build、正式新轮 AC-18b、manifest/receipt/源码/运行包独立核对和公开候选扫描。只精确提交本切片文件，不暂存用户原 AGENTS/CONTEXT/docs/agents/规划。12保护输入和原 dirty digest 保持；只按授权更新 STATUS。

L/M blocked、P not_run、usage unavailable，WB00 r5 的 36 槽保持 21 blocked/15 not_run。旧公网 benchmark DNS 拒绝、readiness 根因未知及日志例外保留；不借本切片改写历史。独立切片验收后 drain 并按 SUPERVISOR 跨 Session 接力，整 WB-02 完成前不进入 WB-03。

## v2 分页实施决定

首条读取tracer已通过，但不据此验收有界分页。新v2文件接口的 offset/end_offset/next_offset 使用 UTF-8 字节位置，输出明确 offset_unit；limit 是最多16,384个Unicode字符。单次源读取限制约64KiB，分页从实际已输出的字节数继续，因此超过64KiB的文件仍能读后段，不把固定前缀重复读取称为完整分页。原v1文件工具行为保持。

每次打开已绑定根内的regular file，按有限buffer读取，合法UTF8在chunk末尾的未完成字符留到下一页；offset落在编码中间或文件存在非法UTF8、offset超过EOF等明确失败。字符截取不得拆开代理对。根重新解析必须与入场持久canonical root一致；不为计算全文hash无界读文件。该数值/单位是本切片实施决定，不伪称原Spec规定。

## 旧产品入口的必要衔接（Spec 预审核定）

新增目录owner契约不能让已有登录用户的选目录操作失效，也不能被旧产品入口绕过。独立Astra只读核对确认：原apiFetch只带X身份头，未带已有登录token；product Create的Host目录lookup原走公共API；product Chat在Host前通过build_host_inputs读取目录树，而既有workdir_path可跳过Host归属解析。CreateOrchestrator._resolve_run_workdir是nonproduct路径，不能错当默认product caller。

因此本切片必要补齐：apiFetch携带已有Bearer（无token保持可信本地用法）；product Chat/Create router在现有header/body/对象检查之前用真实Bearer/local身份校验，覆盖运行读取、Trace、stream与现有控制；Python product Chat在生成目录上下文前核对目录owner/local；Host对有workdir_id的v1任务始终内部重解析并匹配root，文件调用复查撤销。保留nonproduct兼容、v1输出格式、原页面与Create业务流程，不新增registry或第二执行authority。

这些是本次目录权限和原产品保真所需的R03/05/15修补，不代表WB03的通用对话UI已实现。新增源码、客户端依赖与必需公开测试同样纳入CLI源hash/缺失门禁。分工采用Python/客户端与Host两个独立writer，实际文件清单由主控派卡；他们不共享写入文件，整体冻结后再统一验收。
