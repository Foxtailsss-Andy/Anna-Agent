---
status: accepted
---

# Crew 采用耐久命令/事件执行内核

Crew 以频道中的结构化 Mention 和耐久事件作为协作事实源；Anna 仍是唯一协调 Agent，具名 Worker Profile 是可加入频道、发言和被 Mention 的 Actor，但不拥有绕过 Anna 治理的独立全局身份、记忆或凭据。执行控制收敛到一个深 `AgentExecution` module，外部只暴露 `dispatch / get / read_events`，内部统一命令幂等、排队、lease/fencing、checkpoint、预算、重试、DLQ、Tool 副作用账本与 Trace；CrewTask 和频道 UI 是其事实事件的投影，不再与 Runtime 平行维护运行真相。

我们吸收 Buzz 的结构化 Mention、频道成员、per-key ordering、可见失败和队列纪律，但不移植 Nostr、Rust relay 或其内存 ACP Harness。现有 Python Loop 与未来 Pi Agent Loop 位于同一个内部 seam 下，分别作为 `LoopAdapter` 参加 conformance/canary 评测；在证据证明 Pi 更优前不整体替换 Python Runtime。SQLite Adapter 只承诺 Windows 单机的崩溃恢复与 fencing，多实例能力等第二个真实部署需求出现后再增加 Postgres/queue Adapter。

采用 replace-don't-layer：新内核达到行为 parity 后删除 `CrewBackgroundRunManager`，不保留双重调度。外部写无法承诺 exactly-once；只有带稳定 idempotency key 且结果确定的动作可自动重试，结果不确定时必须转人工处理，不能用重复副作用换取表面成功。
