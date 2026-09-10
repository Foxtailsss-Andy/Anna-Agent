# WB-02 Skill 切片交接胶囊

状态：Skill 发现与读取切片的 D/O 契约、独立两轴与 AC-18b 增量已验收，代码和公开证据已精确提交。整张 WB-02 未关闭，下一主控继续剩余 R-05 能力，不能直接进入 WB-03。

## 范围与现场

- scope：M0 + M1；ticket：WB-02；slice：固定登记 Skill 发现、按需读取、冻结版本及权限保护。
- 实施 owner_task_id：`01a08b29-b7b5-74f0-8dec-848bea043f02`。当前唯一 owner/交接 HEAD 以 STATUS 为准。
- 工作树：`Anna-Workbench-Plan-20260907`；分支：`codex/workbench-plan-20260907`；所有命令显式指定该工作树，外层 Anna 只是保存项目容器。
- 固定点：`857bba3bbf593c7b6bb268c56d3bb894a39d93f7`；代码/公开证据提交：`c0c78e706b7c67a07beca1c8c59e17741ec178c2`。
- Spec 1.2 SHA256：`d3ec39733a170e25e1d34a72e1b4b0d456572001acd414ba191eaace43e159e7`。R-04/15、AC-04/15 的 Skill 部分与 AC-18b；不关闭全部 AC-05。
- 原用户 AGENTS、CONTEXT、docs/agents、AWB 规划保留；12 个保护输入（STATUS 除外）未变。原 tracked dirty SHA256：`5a5a75dad632d126dad8073c8548b44508804e4329dc52d54696697da6c4611b`。

## 实现与边界

复用 Node Skill Loader，固定登记七份现有仓库方法。可信 Host 可选择这些固定文件的注册根；renderer 无此字段。目录在 Host 构造时登记，内容作为新 Run 的版本化可选 skillCatalog 快照纳入 RunProfile hash，不承诺热扫描/自动注册新文件。

模型初始只见能力 search/load。search 返回 Skill 元数据与 loader_capability_id；模型使用实际返回的 loader/Skill ID，先加载定义，再读取方法。搜索与读取共享局部元数据投影，正文通过普通工具结果进入下一次实际 OMP 请求。能力 description/schema 使用持久目录；未改原两个 Host 控制工具定义。

显式 skillPath 的可信 Run 限制保持。方法正文及 allowed/forbidden 声明不增加权限，缺失依赖明确返回；实际读取方法后，未登记或显式禁止的目标仍被拒，其他获准工具可继续。未知 ID 与错误参数能回到模型，修正参数使用新调用 ID 后可正常完成。

chat/create/crew × 有/无 Project 的六个公开 Run 可达同类方法。真实冷恢复继续使用旧 Skill 正文/版本，新 Host 登记新版本后的新 Run 使用新版本。恢复从实际执行捕获 command/events/Host context，在隔离 checkpoint store 重建；不声称进行了 OS crash。

本切片没有新增授权账本或 Skill 执行编排，没有改 Worker/protocol/kernel、解除受管限制或开启 Memory/Sandbox。原 UI 属于 WB-03，问人/控制属于 WB-04；创建/验证/保存后复用完整闭环属于 WB-07。

## 最终验证

10 个实施/测试/脚本文件在 r2 冻结，patch 113458 bytes，SHA256 `3c4d9fffaea7fc75587f93fb723a7daaeac6ba42908feb06cd60245c6fd6eb3a`。固定点与测试时 HEAD 相同，执行的是冻结 working-tree；49个关联源和10个审查文件hash已逐一匹配代码提交 `c0c78e706b7c67a07beca1c8c59e17741ec178c2` 的Git blob，不把证据中的旧HEAD字段冒充新提交。

| 检查 | 已核对结果 |
| --- | --- |
| Standards / Spec | r2 两轴剩余与新增均 0；分别只读核对10/10 hash及完整非空diff |
| 主控全仓 typecheck | 退出 0，16.02 秒；源无漂移 |
| 主控完整 JavaScript | 1204 passed / 0 failed / 7 skipped，退出0，747.73秒；源无漂移 |
| 主控完整 Python | 1085 passed / 53 warnings，退出0，37.25秒命令耗时 |
| Web / Host build | 均退出0；源无漂移 |
| 正式 Skill 增量 | wb02-skill-20260910-r1：6个TS文件22项、Python5项通过，155.82秒；sourceChanged/ownedChanged均false |
| 独立完整性 | 49个关联源hash、10个审查文件、manifest列出的29文件、共30个JSON均核对 |
| 主控CLI guard / 公开扫描 | 5项guard通过；独立缺测试守卫mutation有效；43候选文件扫描、链接与diff检查通过 |
| Runtime | OMP18.0.11 / Bun1.3.14；全21465文件及worker/protocol/lock一致，增量后再次核验 |

正式[结果](../../../../evals/workbench/wb02/runs/wb02-skill-20260910-r1/evidence/increment-result.json)、[源码快照](../../../../evals/workbench/wb02/runs/wb02-skill-20260910-r1/evidence/source-snapshot.json)、[manifest](../../../../evals/workbench/wb02/runs/wb02-skill-20260910-r1/evidence/manifest.json)。模块摘要：`sha256:55457648fc3aa9d3e7b82fcfc9d7d275947c8d8f50a60b2ff0f00c23867ae5f1`；本轮代码 dirty digest：`sha256:50726a4155030ebaeb66a98e7852968e231e736964fca2543a11cc6604cbe5fd`。

CLI 顶层只自动记 D，O 为 metadata_only；主控依据真实 Python 身份/业务、Host/Gateway/EventStore、OMP Worker 和实际断言，将本切片8项核定为 D+O。模型 transport 为固定 fixture，不证明真实模型质量。增量中的 R/AC 是整卡关联，status=pass 不关闭全部 R-05/AC-05。

主控独立核对新12份精简 Run receipt：40条实际响应、40个唯一事件ID、4个failed均保留。它们只保留公开event_id/seq/tool_status，不包含完整调用ID/正文关联。详细定义receipt另核对4次实际模型请求、持久schema与定义hash；恢复receipt按新toolCallId及seq水位核对新读取，并独立复算v1/v2正文和原文hash。详细tracer与对应精简receipt引用同一Run，不能重复计数。

## 运行包与构建身份

- Node24.12.0 / Python3.12.13；平台darwin-arm64。
- OMP规范manifest：`sha256:168da57a60493b094ea6b2525f312c3e05a6585ffc167cba2a7b9c5beb6719ec`；manifest文件字节hash：`3a78ef5da9aa194186fdde8324633928a7d37f2a07ea4f6be64c9cb927fe0def`。
- worker：`1cf42eb0907170cfd1c198b5e0c990ff55cf3b741e02c8db6bbed13c395d91b8`；protocol：`f8130c5d1af12316b0875f1e0368a436a1e125e0c155fc3cb66a4d8d76fa2a56`；runtime lock：`f5a96c28a0187d549959fbe33c78596198491df29be9ea18424bf814fea88ceb`。
- Host main.js：1544984 bytes，SHA256 `87ca059d33f30b58e01bcaa472bb9a194b8158735471ae1cf9ca0f447d1f56af`。
- Web index：392 bytes，SHA256 `19f90c39b7939be84c373862ca6b266b3211e1cea8aa8abe5e9064df34c3dcf6`。

## 失败记录与未验证范围

完整过程见[审查记录](WB-02-skill-review.md)。内部helper policy测试仅作诊断，已替换为实际模型定义/持久目录一致性及精确mutation；恢复的两次404是错误route setup；一次GREEN名称的用例因变量漏声明实际失败。参数错误早期fixture重复调用ID且弱化为Run失败，主控拒绝该口径；正确反馈链无需改产品即通过。

早期精简receipt误计消息、误读payload，旧目录保留且不用于验收。fresh receipt writer前几轮仅有结果摘要和分段工具记录，未保存完整本地raw；不把摘要称原始日志。后续独立新mutation RED/GREEN/typecheck已直接保存stdout/stderr/exit/source hashes；不补造旧RED。

核心A旧Worker readiness超时根因仍未知；本轮完整通过不改称已定位修复。更早被覆盖的初步日志例外仍按[核心胶囊](WB-02.md)保留。历史schema的完整OMP恢复未直接验证；本切片验证的是Skill正文版本恢复。

WB-00 r5 / wb00-dataset-v1.1 保留36槽：21 blocked /15 not_run；不跨轮累计。真实Provider/MCP与包内验收未完成：L/M blocked、P not_run、usage unavailable，不宣称M1整体放行或远端CI通过。

## 下一主控的具体动作

1. 首先只读STATUS，确认唯一owner转交后，再核对本树HEAD/branch、原dirty、49源hash、运行包与本胶囊。不得提前派工/写入或修改owner。
2. 继续WB-02剩余R-05：公共搜索/URL正文/文件读取、已有固定业务连接器及剩余Crew读取；从实际现有执行器与可信资源解析出发，先写用户行为和公共测试边界，再派fresh Luna xhigh最小切片。补来源/获取时间、发布时间存在才记录、截断后补证、缺配置/失败事实；不能用renderer任意path/workdir扩权，也不预做WB-06。
3. 新源/资源/必需测试继续纳入现有CLI前后hash与独立缺失门禁，保留每轮失败。D/O、L/M/P分开。整WB-02完成后再依SUPERVISOR接力WB-03，随后WB-04；大卡可在独立验收切片后再交接。
4. 用户已授权M0+M1内部推进；不逐卡重问。用户暂停立即停止，不靠接力绕过。WB-05～09、push、PR、发布不在范围。

本地原始记录/诊断摘要保留于 .tmp-tests/wb02-skill/，正式增量原始执行输出在 .tmp-tests/wb02/evidence/wb02-skill-20260910-r1/。所有Coding/Reviewer均已停止；提交/转交前再次核对无本卡测试进程。


代码提交精确包含40个owned路径（10实施/测试/脚本+30公开JSON）；原tracked dirty digest保持。三份Skill交接文档单独提交，交接HEAD由STATUS记录。原核心A文档/证据和本地失败目录未清理。后续按SUPERVISOR单次转交唯一owner；旧主控转交后停止派工/仓库写入。
