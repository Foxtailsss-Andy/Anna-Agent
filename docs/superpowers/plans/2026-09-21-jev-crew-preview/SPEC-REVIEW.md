# SPEC 独立审定记录

日期：2026-09-21。版本：JEV-PREVIEW-1.0。

**结论：无剩余 SPEC blocker，可进入 JEV-01；功能未验收。**

## 角色和固定候选

- 设计作者：`jev_spec_architecture`，`gpt-6-astra/xhigh`；仅写 SPEC/ACCEPTANCE。
- 独立审查：`jev_spec_review`，`gpt-6-astra/xhigh`；只读源码与文档，无实现写入。
- SPEC SHA256：`abf20417288899f17358800e39d61e30a95d8b56396013cbf5549eeae8f9f91d`。
- ACCEPTANCE SHA256：`3802f461e3a909f4b6eb3bebd2b64d9014d304ba696363299d646e8af078c7f6`。
- Code base：`e2e603cbc70de5fddaeb4036e001cbaba4e4da0c`。

## 已收口的问题

| 问题 | 定案 |
| --- | --- |
| Host 有时限但缺并发/大小上限 | 4 个 in-flight、无队列；严格请求/响应大小和 ID 边界；超额零 provider 请求 |
| 同质候选标签可能将任意选人记为正确 | 相同语义资料必须弃权；raw 与最终策略分开汇总 |
| UI 耗时口径未进入合同 | 显示真实 Host 判断耗时；规则标未调用模型，缺失不填 0 |
| 原子采纳与通知/派工混为一体 | 事务内写任务与 receipt；commit 后 best-effort 副作用，不承诺跨崩溃 exactly-once |
| 评测分母与独立验证不明确 | 8 开发 + 24 保留；分别汇总；先小轮可见 preview，再完整对照 |
| 多 Session 角色与预算漂移 | Astra xhigh / Luna high；唯一 owner、三票接力、跨 Session 统一预算 |

独立审查确认权限/成员复核、过期拒绝、重复采纳、取消、旧自动推进隔离和真实证据口径均有可验证合同。EXECUTION 的目录与 R/AC 映射一致。

## 本轮验证边界

本轮没有调用 Jev 或其他产品 Provider，没有修改产品代码或运行新功能测试。上述通过只表示可以开始实现。开发后的代码仍需独立 Standards/Spec 两轴审查、相应测试和真实测量。
