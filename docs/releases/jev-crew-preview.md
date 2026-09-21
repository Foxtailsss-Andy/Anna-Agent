# Jev Crew · Experimental Source Preview

> **Experimental source preview · remote CI in progress.** [Current main CI](https://github.com/Foxtailsss-Andy/Anna-Agent/actions/workflows/ci.yml?query=branch%3Amain) · [reviewed-candidate CI](https://github.com/Foxtailsss-Andy/Anna-Agent/actions/runs/35640135163). Local checks and independent review passed; remote CI is not yet claimed as passed.
>
> Measured scope: 24 synthetic heldout cases, 22 model inputs and 2 hard prechecks. C is one `deepseek-v4-pro` judgment with thinking enabled/high; D is `jev-1.13.0`. Both match 22/22 labels (12 recommendations + 10 abstentions). Jev p50 is 85.23% lower; at this run's off-peak/cache-miss prices estimated cost is 94.71% lower (peak reference 97.35%; not invoices). Reported total tokens are 57.98% higher. This does not establish production accuracy, Worker completion or whole-workflow acceleration.

> **实验性源码预览 · 远程 CI 进行中。** [当前 main CI](https://github.com/Foxtailsss-Andy/Anna-Agent/actions/workflows/ci.yml?query=branch%3Amain) · [已审候选 CI](https://github.com/Foxtailsss-Andy/Anna-Agent/actions/runs/35640135163)。本地检查与独立审查已通过，尚未宣称远程 CI 通过。
>
> 实测范围：24 个合成 heldout，22 个模型输入、2 个硬预检。C 为 `deepseek-v4-pro` thinking enabled/high 单次判断，D 为 `jev-1.13.0`；两者均 22/22 符合标签（12 次推荐＋10 次弃权），质量持平。Jev p50 低 85.23%，按本轮非高峰、缓存未命中价估算费用低 94.71%（高峰参考低 97.35%，非账单），总 tokens 增加 57.98%。结果不证明生产正确率、Worker 完成或整工作流加速。

Crew adds optional assignee suggestions to the existing member picker for one unassigned task. A unique exact-role match uses the role rule; other eligible requests ask Jev for a candidate or abstention. Users explicitly adopt a suggestion or choose manually. Current task and roster facts are rechecked before an atomic assignment receipt is committed.

Crew 在现有选人浮层中提供可选的单任务建议：唯一精确角色匹配走规则，其余符合条件的请求由 Jev 选择或弃权。用户明确采纳或手动选择；服务端复核当前任务、成员与有效期，再原子写入指派及 receipt。

## Measured result / 实测结果

Frozen round `jev03-final-20260922-r1`: 8 development cases and 24 synthetic heldout cases. All 96 A/C/D slots are preserved; C/D each made29 real requests. The heldout comparison uses22 eligible inputs; two hard-precheck cases made no C/D call and are not counted as model successes.

| Heldout measure / 保留集指标 | C: DeepSeek single judgment | D: Jev production adapter |
| --- | ---: | ---: |
| Requested → returned model | deepseek-v4-pro → deepseek-v4-pro | jev-1.13.0 → jev-1.13.0 |
| Inference setting / 设置 | Thinking enabled, high, max4096, JSON-only | Typed Choice, crew-assignee-v1 |
| Label agreement / 标签符合（含正确弃权） | 22/22 | 22/22 |
| Correct recommendations / correct abstentions | 12 / 10 | 12 / 10 |
| Wrong labels / API or format errors | 0 / 0 | 0 / 0 |
| p50 / p95, n22 | 2007.078 / 2692.501ms | 296.349 / 421.889ms |
| Input / output tokens | 4,887 / 2,873 | 11,233 / 1,026 |
| Peak/cache-miss reference estimated USD | 0.017827920 | 0.000471786 |

Jev p50/p95 were **85.23% / 84.33% lower**, and reference estimated cost **97.35% lower**. Label agreement was **equal**, including both raw Jev choices and its final policy result. Existing role rules matched12/22 on that same eligible subset. Jev reported **57.98% more total tokens**; tokenizer differences also prevent treating token counts as equivalent compute.

Jev 的 p50/p95 分别低 **85.23% / 84.33%**，参考估算费用低 **97.35%**；标签符合率与 DeepSeek **持平**，未宣称准确率提升。原角色规则在相同有效子集为12/22。Jev 总 tokens **增加57.98%**，不能宣传 tokens 下降。

The ledger uses dated official peak/cache-miss DeepSeek prices for a conservative reference, not a verified invoice. At this run's off-peak rates with the same cache-miss assumption, C is estimated at $0.008913960 and D is **94.71% lower**; cache hits may lower C further. Timing is the outer elapsed time per group request, with Host startup excluded and nearest-rank percentiles. This is neither browser E2E latency nor measured acceleration of the previous full Crew matcher/Host/OMP path B. See [full public results, development split, costs and method](../../evals/jev-crew/jev03-final-20260922-r1/REPORT.md).

预算账使用官方高峰、缓存未命中价作参考估算，未经账单核实。按本轮非高峰时段、仍假定缓存未命中计算，Jev 估算费用低 **94.71%**；缓存命中可能进一步降低 DeepSeek 费用。C 是单次模型判断，不能冒充旧完整产品链路 B 的实测。8个开发案例单列，不并入保留集质量结论。

## Visible functionality / 可见功能

- Explicit request: opening the picker does not call a model; generating a suggestion does not assign, notify or run a task.
- Actual source, rule/no-model status and Host decision duration are visible. Missing configuration, abstention or provider failure leaves manual selection available, with no automatic model fallback.
- Adoption revalidates scope, member facts, task facts and expiry. The durable receipt handles duplicates. Cancellation and late-result isolation are covered by public API and rendered-UI tests.
- Human assignments do not start Workers; blocked Workers wait for dependencies; ready Workers retain the existing policy. Assignment and execution remain separate facts.

用户可明确生成、取消与采纳建议，查看真实来源和判断耗时。采纳前复核当前事实并处理重复提交；模型失败保留手动操作，不自动调用另一个模型。Human 不运行，blocked Worker 等待依赖，现有执行与权限规则保持。

The accepted [real UI round](../../evals/jev-crew/jev02-ui-r1/REPORT.md) traces one actual `jev-1.13.0` suggestion through explicit UI adoption and SQLite readback:667ms Host inference,648/68 tokens, one provider request. A Human assignment had no Run; a second rule-based blocked Worker assignment made no extra Jev call or Run. Actions were exercised by the supervising agent in the UI. That evidence establishes suggestion/adoption, not a new Worker completion claim.

## Validation and publication / 验证与发布

- Local full JavaScript:1268 passed,7 skipped, exit0; relevant source hashes were unchanged before/after. Typecheck and Web build passed. MemberPicker real-render regression:11 passed.
- Full local Python initially had1112 passes and one egress metadata failure. Pricing citations moved to static JSON; the affected egress gate passed8 tests. Evaluation CLI tests passed24 tests. No assertion or publication gate was weakened.
- Independent Astra Standards and Spec reviewers checked the fixed source, fixtures, all96 result slots, raw/final outcomes, usage and percentage calculations; final reports are recorded in [review evidence](../../evals/jev-crew/jev03-final-20260922-r1/REVIEW.md).
- The [GitHub Release](https://github.com/Foxtailsss-Andy/Anna-Agent/releases/tag/jev-crew-preview) records the exact published main commit, PR and actual CI for that commit. The original [RC2](rc2-developer-preview.md) remains a separate release record.

Public evidence uses portable paths and sanitized JSON. Original logs, local launch capsules and private Git history are retained outside the public tree; [publication provenance](../../evals/jev-crew/publication-provenance.json) records the exports. The public boundary check passed without changing its rules.

## Limits and setup / 限制与配置

This is a small synthetic comparison and an experimental source preview on macOS arm64. It does not establish production accuracy, stable population p95, signed distribution or Windows/Linux acceptance. B full-workflow timing and a new ready-Worker terminal demo remain unmeasured in this release. Post-commit effects do not have a crash-recovery exactly-once guarantee, and separate databases do not provide distributed atomic revocation.

本预览限于小型合成样本与已验建议/指派行为，不代表生产准确率、完整工作流提速或跨平台发布验收。完整 B 路径和本轮新 Worker 终态演示未完成。

See [DEVELOPMENT](../../DEVELOPMENT.md#optional-jev-crew-suggestions) for opt-in configuration and the data-sending boundary. Credentials and state stay outside the checkout and Agent-readable workspace. No bulk assignment, new permission policy, OMP upgrade or automatic fallback was added.
