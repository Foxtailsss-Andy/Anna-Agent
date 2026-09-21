# 开发票与文件归属

版本：JEV-PREVIEW-1.0。合同与验收以 SPEC / ACCEPTANCE 为准。三张票串行推进，不恢复旧 WB backlog。

## 总体规则

每票开始由 Astra 记录 pre-change SHA 和明确的 R/AC。下列文件集合是最大允许范围；实际派给 Luna 时要选更小的集合。需要新增文件时只在指定模块目录内创建；跨越范围由 Astra 给出必要性与对应需求后更新本卡，不能自行扩为框架改造。

实现人固定 `gpt-5.6-luna/high`，审查/验收固定 `gpt-6-astra/xhigh`。一票至少形成一个真实可观察垂直结果。无真实 Provider 时，可先完成代码和确定性证据，但 live 不能记为通过。

## JEV-01：Host 窄决策与首轮实测

合同：JEV-R01、JEV-R02、JEV-R06；验收：JEV-AC01—05，以及 JEV-AC17 的 fixture/smoke 部分。

目标：通过受保护的 Host 公共 HTTP 边界，对一项合成 Crew 任务得到真实 Jev 建议、弃权或明确失败，记录实际返回模型、usage 和延迟；同时证明没有触发 Agent Run、工具调用或业务状态变化。

依赖：SPEC 已独立审定；LAUNCH 中凭据文件存在；工作树和预算核实。

最大文件范围：

- `apps/harness-service/src/`：仅 SPEC 指定的 Jev 决策模块及其 main/product-facade 装配。
- `apps/harness-service/test/`：本功能公共 HTTP/transport 行为测试。
- `apps/desktop/electron/runtime-service.mjs` 及对应启动环境测试：Host-only 环境与 protected paths。
- `scripts/jev-crew-eval.mjs`、`scripts/jev-crew-eval.test.mjs`（R06/AC17：通过 CLI 公共边界验证限额、未知 usage 停止、标签不进入请求与 frozen fixture hash）；`evals/jev-crew/` 下合成输入、已审标签及脱敏结果。
- 根 `package.json` 仅在确需增加本功能命令时修改；不增加不必要的 SDK/依赖。

明确禁止：Python 模型调用、Crew 自动推进、任务 mutation、OMP/kernel descriptor 重构、通用 Provider 路由、前端新面板、原业务数据库和旧配置写入。

步骤：

1. 准备本树依赖；记录环境与基线相关检查。任何旧失败单独记录，不顺手修复。
2. Luna 完成一次公开边界 RED→GREEN：缺服务凭证被拒、有效服务凭证得到明确未配置结果。
3. 完成真正的 Jev transport、固定模型/endpoint、容量/超时/并发约束、取消和结果校验。
4. 验证 Host-only 凭据/路径隔离及错误输出脱敏。
5. 冻结合成数据、标签和请求构造，Astra 先审标签；live 工具只发送 state/criteria，不泄漏 expected labels。
6. 先做 1 次真实 smoke，再按 ACCEPTANCE 进行有限测量。脚本的 `force Jev` 仅为测量路径，不能把生产规则直达记为模型决策。
7. 独立两轴审查、相关检查、证据汇总后，提交本票 owned 文件并写交接。

退出条件：受保护 HTTP 路径通过；取消/错误/配置隔离符合 SPEC；首个真实调用证据明确（成功或真实阻塞）；有冻结轮次与完整失败记录。真实 Key 无效可将 live 标 blocked，继续代码验收，但不能把本票描述为模型效果通过。

交付：代码提交、RED/GREEN与审查记录、首轮样本结果、`handoff/JEV-01.md`、预算余额。验收后新建 Astra Session 进入 JEV-02。

## JEV-02：单任务 UI 与原子采纳

合同：JEV-R02—06；验收：JEV-AC06—15。JEV-AC16 的真实 Worker 终态留给最后一票，不混入本票指派成功。

目标：在当前 MemberPicker 可请求一项指派建议，用户明确采纳后准确写入任务；不改变原手动指派和自动推进的策略。

依赖：JEV-01 HTTP 合同已通过。Jev live 服务暂不可用时可用明确 fixture 验证产品，但真实演示保持未通过。

最大文件范围：

- `services/business/harness_client.py`：仅增加 Host 窄决策调用适配，不读取模型凭据。
- `services/api/app/main.py`、`services/api/app/routes/crew.py`：注入与新单任务接口。
- `services/crew/app/`：SPEC 指定的快照/建议/采纳服务及必要 schema；`store.py` 仅在复用现有事务仍不足时作最小补充。
- `tests/business/test_harness_client.py`、`tests/api/test_crew_api.py`、本功能 Crew 公共服务/存储测试。
- `apps/desktop/src/lib/api/crew.ts`、`pages/crew/CrewProjectDetailPage.tsx`、`pages/crew/inspect/` 中 MemberPicker、必要 props/状态与局部样式，以及对应前端行为测试。
- `tests/frontend/jev_member_picker.test.mjs`：AC09/10 的真实渲染公共 seam；沿用仓库已有 esbuild + Playwright + HTTP fixture 方式，直接渲染 MemberPicker/实际 API wiring，不添加 jsdom 或替换现有 Vitest 配置。

明确禁止：改 `matching.py` 后自动接入 `_propose_assignments`、全项目批量接口、通用 Proposal 表、长期队列/恢复器、角色画像系统、其他 Surface 重构。

步骤：

1. 服务端从可信项目/成员构造单任务快照，按 SPEC 权限检查；模型状态不含邮箱和秘密。
2. 新建议采纳在事务中重读、核验快照和成员，写 assignee 与 receipt；成功提交后才通知/派工。
3. 验证并发、重复、过期、blocked 预派、gate、成员失效、用户切换和取消。
4. 在现有浮层增加生成、等待、建议/待定、采纳和错误状态；明确 Human 与 Worker 采纳的不同结果。
5. 一次真实本地 UI→Host→Jev→用户采纳→业务读回演示；不借用另一次历史运行冒充。
6. 独立两轴审查、相关回归、提交和交接。

退出条件：AC 中相关业务与 UI 不变量均通过；结果来源真实；不在网络等待时持有数据库事务；原自动链路隔离通过。提交后外部 dispatch 失败如实记录，不扩展为跨崩溃 exactly-once 交付承诺。

交付：可运行功能、产品流程证据与限制、`handoff/JEV-02.md`、预算余额。新建 Astra Session 进入 JEV-03。

## JEV-03：对照、完整验收与首页候选

合同：SPEC 第 8—9 节及 JEV-R06；验收：JEV-AC15—18，并确认前两票证据对最终候选仍成立。

目标：以实际候选代码得到可审阅的效果结论，准确更新本地中英文首页及发布说明。

依赖：JEV-02 已实现；未通过的真实网络项目仍需保留阻塞事实。

最大文件范围：本功能评测 CLI/合成用例与必要修复，`README.md`、`README.zh-CN.md`、`DEVELOPMENT.md`、`docs/releases/`、本计划 handoff 与公开脱敏评测记录。任何产品修复仍要派 Luna 并标明原 AC，不由 reviewer 顺手改代码。

JEV-03 已复现的 AC18 阻断修复：`MemberPicker.tsx` 两处加载提示使用单个省略号，违反现有 `chinesePunctuation.test.ts`。仅授权 Luna 将「正在生成建议…」「正在采纳…」改为六点形式；真实 render 测试若引用该字面量，只同步对应预期。不得改弱标点检查或扩展其他界面行为。

整仓 Python 检查还定位价格来源 URL 元数据触发现有 egress 源码扫描。授权 Luna 新增 `evals/jev-crew/prices-20260921.json` 保存静态价格/来源，并按需新增 `tests/fixtures/jev-crew/*.json` 承载测试配置。真实请求目标仍取 Host 保护配置，价格元数据不作为调用地址；不通过拆分 URL 字符串规避扫描，不更改 egress 断言，也不改已冻结的32例数据。

步骤：

1. 固定相同输入与候选，对照规则、当前 Host/OMP 匹配、Jev；精简结构化 LLM 对照用于分离流程收益，不做成产品功能。
2. 报告覆盖、正确/弃权、p50/p95、调用数、真实 usage、回退/失败及总体成本；按 ACCEPTANCE 区分必需与补充实验。
3. 执行相关 live 流程与最终全量仓库检查；运行失败保留实际命令、退出码和原因。不会为了绿色修改预算、断言或 unrelated 测试。
4. 最终两轴审查；修复后只补跑受影响检查，避免无意义重复全量。
5. 更新首页：能做什么、配置方式、测量方法和限制。仅填实际数据，不从厂商演示迁移数字。
6. 写 `handoff/JEV-03.md` 及最终证据索引。说明本地候选、真实验证和远程发布分别是否完成。

退出条件：完整材料可由另一位开发者复核；不低于 SPEC 要求；没有把功能存在、模拟通过或小样本结果等同生产就绪。收益不成立时准确保留实验态或关闭，不能用宣传替代验证。

## 变更与阻塞

需要新行为时，Astra 先更新对应 SPEC/R/AC 和本票文件范围，再派 Luna。不得以缩短开发为由跳过成员校验、原子采纳、取消、凭据隔离和真实结果标识。

若现有 Provider/OMP 启动出现与本功能无关阻塞，先判断能否用当前组件的最小公开边界继续验证。记录局限，不自动重做 Runtime、改完整调度器或扩大到其他业务功能。
