# JEV-01 验收与交接

日期：2026-09-21。状态：**JEV-01 accepted；已授权JEV-02接管**。

## 定位

- Previous owner：`01a0c2dd-b2cc-7223-b712-af209f26df14`；当前 owner：`01a0c326-a317-7182-afa6-f2f50159160f`。
- 唯一 worktree：`$ANNA_REPO_ROOT`；branch：`codex/jev-crew-preview-20260921`。
- 产品基线：`e2e603cbc70de5fddaeb4036e001cbaba4e4da0c`；本票 pre-change：`503408e8f01a6b55b2c85f94cb94cd5b8b462bc3`。
- Accepted code commit：`59579c38a8ac62f211559bbe5366ea39c063cc35`。提交后用git show逐一复算8个实现/测试文件SHA256，全部等于r6实测指纹；工作树干净。随后控制权提交只更新STATUS与此胶囊，最终启动HEAD由明确授权消息给出。
- 合同：JEV-PREVIEW-1.0，R01/R02/R06、AC01—05及AC17的fixture/smoke部分。SPEC/AC hash保持SPEC-REVIEW中的审定值。
- 最终实现八文件指纹：`evals/jev-crew/jev01-contract-r6/candidate.sha256`；构建指纹：同目录`build.sha256`。真实调用完成后再次核验全部一致。

## 已交付

受service token保护的 `POST /_harness/crew/assignee-decision`；固定官方endpoint/jev-1.13.0的一次typed Choice、局部候选ID映射、严格输入/输出、4秒总预算、4在途无队列、取消/错误/流资源收束、真实usage/null和raw/final脱敏记录。零自动retry、零生成模型fallback，不创建Agent Run/tool call，不修改业务任务。

Jev配置仅进入Host，Key路径保护贯穿main、launcher和实际文件能力。真实smoke使用隔离空主模型配置，证明该判断无需主模型配置。

8 development +24 heldout合成中文fixture已在任何live前由Astra独立预审冻结。开发集7个有效模型输入、保留集22个；总分布16可区分/8歧义/8无适合或预检。正确候选位置在可判断集按1/2均衡。24 heldout从未调用，后续不得用于JEV-02 smoke或调参。

## 验证与独立审查

最终r6主控实际命令全部exit0，原始日志在`evals/jev-crew/jev01-contract-r6/`：

| 检查 | 结果 |
| --- | --- |
| `npm run test --workspace=@anna/harness-service -- test/jev-decision.test.ts test/product-facade.test.ts` | 31 passed |
| `node --test tests/frontend/jev_runtime_env.test.mjs tests/frontend/product_runtime.test.mjs` | 5 passed |
| `node --test scripts/jev-crew-eval.test.mjs` | 15 passed |
| `npm run typecheck --workspace=@anna/harness-service` | passed |
| `npm run harness:v2:build` | passed |
| 源文件/构建/fixture指纹与`git diff --check` | passed |

- Standards：独立Astra xhigh `/root/jev01_standards_review`，最终Host r6与Eval增量均0剩余findings。实际HTTP/进程探针确认错误流、所有未完成body出口、各取消窗口、SIGTERM owned-child、预算未知、同轮互斥和fixture/live隔离。
- Spec：全新Astra xhigh任务`01a0c326-a317-7182-afa6-f2f50159160f`只读独立核验；代码/fixture/tool所有blocker关闭，随后独立核验r2原始结果、usage账本和指纹，确认本票AC05/AC17范围通过。
- 两轴各自的初始发现和修复证据保留在`JEV-01-worklog.md`。当前Session已完成子Agent仍占线程槽，故后继任务提前只读握手承担Spec；此过程没有提前转移owner或派JEV-02编码。
- 本票使用相关检查；完整仓库JS/Python/前端build检查留JEV-03最终集成。旧Preview套件的6项既有失败已在worklog单独记录，不通过改旧断言掩盖。提交时仅统一测试日志末尾空行以通过git whitespace检查；测试输出内容和模型原始JSONL未改。

## 真实结果与预算

最终轮：`evals/jev-crew/runs/jev01-development-20260921-r2/`，见`REPORT.md`、`round.json`、`results.json`、`summary.json`。

- 8/8开发槽有结果且符合预设标签：4真实推荐、3真实模型原始弃权、1零候选预检。真实Jev请求7；零调用预检不计Jev能力。
- 请求及实际返回模型均`jev-1.13.0`；usage3,645输入/327输出tokens；本轮估算$0.00015309。
- Host判断耗时n=7：中位348ms、范围281–658ms、观测p95 nearest-rank=658ms。小样本不构成稳定p95或生产SLA；CLI包装耗时不是纯网络/供应商纯推理/UI端到端时间。
- 旧r1的一次真实探测原样保留，不与r2拼质量结果。旧r1顶层error_code曾误用正常reason，Host内部meta.error_code实际为null；该记录问题已在新CLI修复，未改写旧JSONL。
- **跨票累计**：Jev8请求、输入4,151/输出371 tokens、按官方单价估算$0.000174342；主模型0；reserved0、unknown=false。估算不是确认账单。
- 预算账：`$ANNA_STATE_ROOT/budget-ledger.json`，不是凭据。剩余Jev492请求/约$1.999825658、主模型100请求、全模型约$9.999825658。UI/Worker/其他评测真实调用也必须累计，不能仅依赖本CLI的自动记账或换Session归零。
- Key/主模型配置引用仍在LAUNCH；禁止cat/打印内容。主模型配置存在，但实际API连通性仍未验证。

## 下一票与边界

后继收到明确owner转移消息并核对实际HEAD/STATUS后，立即进入JEV-02：Python独立建议collaborator、可信快照/取消、单任务MemberPicker、原子条件采纳+持久receipt，保留旧自动推进及手动指派。用一个Luna high writer顺序处理有依赖的切片，保留两个Astra独立审查槽；不要再假设完成或interrupt会释放线程槽。

本票不证明UI采纳、Worker交付、完整32例四组对照、相对旧模型优势、安装包或生产质量。JEV-02完成后按同一协议由全新Supervisor接力JEV-03；本次用户授权覆盖接力，无需再问是否继续。无新工作树、无自动派工策略替换、无DAG/批量界面/自动LLM回退/OMP升级。

实现writers和reviewers均已交回文件权；本票启动的检查及真实Host进程均已结束。接管前保持只读，只有STATUS授权owner可派实现任务。
