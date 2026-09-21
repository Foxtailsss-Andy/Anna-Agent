# JEV-01 中文开发 smoke

日期：2026-09-21。轮次：`jev01-development-20260921-r2`。全部输入为预先冻结的合成数据。

## 结果与口径

本轮8个开发案例全部有结果：7次真实Jev请求、1次零候选预检。4次模型推荐和3次模型原始弃权均符合预设标签；没有靠事后规则收窄把模型错误改记为正确。零候选的通过属于Host预检，不计入Jev能力或模型质量分母。

| case | Jev请求 | 模型原始选择 | 最终状态 | Host判断耗时 ms | 输入/输出tokens |
| --- | ---: | --- | --- | ---: | --- |
| dev-01 | 1 | c1，预期成员 | suggested | 658 | 506 / 44 |
| dev-02 | 1 | c2，预期成员 | suggested | 349 | 509 / 44 |
| dev-03 | 1 | c1，预期成员 | suggested | 286 | 507 / 44 |
| dev-04 | 1 | c2，预期成员 | suggested | 348 | 518 / 44 |
| dev-05 | 1 | abstain | abstained | 286 | 553 / 53 |
| dev-06 | 1 | abstain | abstained | 353 | 551 / 53 |
| dev-07 | 1 | abstain | abstained | 281 | 501 / 45 |
| dev-08 | 0 | 无模型调用 | abstained / no_candidates | 1 | null / null |

真实模型请求 n=7，实际返回模型全部为 `jev-1.13.0`。Host判断耗时中位数348ms，范围281–658ms；observed p95采用nearest-rank，n=7时为658ms。这是本轮小样本观测值，不是稳定p95或生产SLA。

Host耗时覆盖内部接口的判断处理。原始JSONL的 `http_elapsed_ms` 是评测客户端包装调用耗时，包含结果/telemetry关联，不能当纯网络时间、供应商内部纯推理时间或用户UI端到端时间。供应商内部纯推理耗时未单独取得。

## 费用与跨轮累计

- 本轮实际usage：3,645输入、327输出tokens；provider请求7，retry 0。
- 按2026-09-21[官方单价](https://docs.typesafe.ai/models)（输入$0.042/M，输出免费），本轮估算 `$0.00015309`。这不是确认的供应商账单。
- 保留旧r1的一次真实探测（506/44 tokens、约$0.000021252），不把它拼入本轮质量结果。
- 本期累计：Jev请求8、输入4,151/输出371 tokens、估算 `$0.000174342`；主模型请求0。预算账无pending reservation或unknown usage。
- 剩余：Jev492次、约$1.999825658；生成模型100次；全模型约$9.999825658。后续UI/Worker/对照调用同样必须记入该累计账，不能因换Session归零。

## 可复核入口

- `round.json`：HEAD、源文件/构建件hash、fixture hash、模式及版本。
- `results.json`：全部8个原始记录，包含实际usage、raw/final结果及脱敏Host inference。
- `summary.json`：8 pass / 0 fail / 0 blocked / 0 not_run，逐槽记录；heldout请求0。
- `../../jev01-contract-r6/`：固定八文件hash、实际Host build、Host/facade31项、launcher5项、eval15项及typecheck日志。

运行入口为真实生产Host的受保护typed接口，采用仅Jev配置、隔离空主模型配置；本轮没有Agent Run、Crew指派或Worker执行。该入口直接测量Jev，默认Crew角色规则和UI行为属于后续JEV-02验证。

## 未验边界

24个heldout案例保持未调用；没有完成32例四组对照，没有当前主模型B/C、UI建议/原子采纳或Worker终态证据。此轮只满足JEV-01的开发smoke范围，不能推导生产正确率、相对旧方式的速度/质量优势、完整Crew替换或正式发布就绪。
