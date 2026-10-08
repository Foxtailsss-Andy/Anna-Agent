# OMP 更新评估（2026-10-07）

**结论：本轮 NO-GO，保留 18.0.11。** 新版确有更新，但当前 Anna 接入路径没有已确认、足以覆盖适配与验收成本的直接收益。本轮只做 Astra / xhigh 必要性与架构评估，未修改产品代码、依赖或既有 dirty 文件。

## 版本基线

- Anna：`f8f5f825eccd83cbcfa28d362c16192b0fec48ad`。
- 当前 OMP：`18.0.11`，生产 descriptor 的上游 commit 为 `b8ce33a58911c26bed1d84f0db9a5e2e727c49a2`；Bun `1.3.14`。
- [最新正式版 v18.8.0](https://github.com/can1357/oh-my-pi/releases/tag/v18.8.0)：发布时间 `2026-10-07T07:15:26Z`，tag commit `4ef97c8826ee012829a3e756b693a2a16a414f47`。以上为评估时状态。

## 收益能否到达 Anna

Anna 的 [`worker.ts`](../../packages/omp-loop-kernel/runtime/worker.ts) 使用 in-memory session 和自定义 Host transport，禁止 worker 网络，关闭 OMP memory/compaction/retry/advisor/async；Host 持有历史、工具授权与终态。除 native Todo 外，工具经 Host 代理并串行执行。

| 更新 | 当前链路判断 |
| --- | --- |
| 18.7 中断时补齐 assistant 边界 | worker 在 abort 后停止发送 observation；`toNeutralMessage` 也过滤 aborted/error 消息。新增边界不会自动进入 Anna 持久化记录。 |
| 18.5.1 重复/空 tool-call ID 修复 | Host 在回送 OMP 前拒绝空字符串及重复 ID；内部重写 ID 仍须通过 Host 历史与参数一致性校验。空白字符串未等同空字符串处理，不声称穷尽无效 ID。 |
| 18.5.1 `end(result)` 异常工具回合恢复 | Host 完整聚合 SSE 后交给 worker；`pumpModel` 显式发送 done/error，未采用该修复对应的终止路径。 |
| 18.6 DeepSeek DSML 清理与纠正 | 新版 registry 按模型 ID 推断 identity，`anna-host/deepseek-v4-pro` 仍可触发 core 清理；清理后回复与 Host 原始 checkpoint 不一致，按现有校验将被拒绝。这是源码推断，未在 18.8 运行复现。 |
| 18.8 thinking-loop 误判、原生 Provider 性能修复 | Anna 自行实现 HTTP/SSE transport，绕过 OMP 原生 Provider。CLI/TUI、磁盘 session 等更新也未进入当前产品路径。core 优化的潜在收益尚无实测。 |

本地依据：[`omp-model-transport.ts`](../../apps/harness-service/src/omp-model-transport.ts) 的 SSE 聚合；[`omp-loop-kernel.ts`](../../packages/omp-loop-kernel/src/omp-loop-kernel.ts) 的模型 checkpoint/工具授权；[`worker-client.ts`](../../packages/omp-loop-kernel/src/worker-client.ts) 的消息、ID、参数一致性校验。上游依据固定在 v18.8.0 的 [agent.ts](https://github.com/can1357/oh-my-pi/blob/v18.8.0/packages/agent/src/agent.ts)、[agent-loop.ts](https://github.com/can1357/oh-my-pi/blob/v18.8.0/packages/agent/src/agent-loop.ts)、[DSML gate](https://github.com/can1357/oh-my-pi/blob/v18.8.0/packages/ai/src/utils/dsml-leak.ts) 和 [DeepSeek taxonomy](https://github.com/can1357/oh-my-pi/blob/v18.8.0/packages/catalog/src/compat/rules/taxonomy/deepseek.kdl)。

## 成本、验证与重新评估条件

升级须同步包/lock、npm integrity、native hash、worker/canary/client 版本校验和生产 descriptor，再生成 manifest 并验证打包 runtime；worker 还直接导入上游 src 路径。仅回移中断补丁也无法越过现有 Host 协议边界，本轮均不采用。

保留版本的实际 worker + synthetic model baseline 已运行：

```text
npm run test --workspace=@anna/omp-loop-kernel -- --run test/worker-restore.test.ts test/worker-steer.test.ts --testNamePattern='actual worker restores a consumed transcript|actual worker preserves a fully paired unknown tool result|managed worker steers the live OMP session'
```

结果：退出码 0，2 个测试文件通过，3 passed，7 因名称筛选未选中，32.12 秒。覆盖已完成 transcript 恢复不重放、已配对 unknown 工具结果不重放，以及运行中 steer 消费入历史。**这不是 18.8 兼容性验证，也不包含真实 Provider 或性能实测。**

重新评估的触发条件：Anna 当前路径出现可复现缺陷且新版能修复；产品明确需要中断内容持久化或 DSML 恢复；固定工作负载证实有实际性能收益。届时先确定 Host checkpoint/预算契约，再由 GPT-5.6 Luna / high 实现，独立审核实际 worker 的取消、恢复、steer、工具授权及打包结果；广泛交付仍执行 AGENTS.md 完整检查。
