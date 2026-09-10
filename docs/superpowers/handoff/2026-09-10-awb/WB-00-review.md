# WB-00 两轴审查

固定点与本卡 pre-change：`d461a1a344d82d7bd95ca5073b0a1e2a700d2162`。首轮 HEAD 与固定点相同，commit list 为空；实际审查包含 package/CI 的 working-tree diff、所有新增脚本/测试/数据集/evidence/职责文档。未因三点 diff 为空跳过审查。原有 AGENTS、CONTEXT 与规划文档为标准来源，不纳入本卡提交。

首轮两个独立 Astra xhigh reviewer 均核对 25/25 文件 hash，与 `.tmp-tests/wb00/supervisor/review-scope.json` 一致。Coding 为新上下文 Luna xhigh，不能自行关闭 AC。

## Standards

结论：1 条 P2 硬违规，修复前不验收。

- 重复指定 evalRoundId 或 OUTPUT_DIR 时，recursive mkdir 接受旧目录，普通 writeFile 随后覆盖结果、receipt、manifest；部分测试失败还可能混入旧 receipt。违反 README 的不可覆盖约定和 ACCEPTANCE 冻结轮保留规则。需要执行前排他创建轮目录并验证拒绝时旧字节不变。
- 非阻断质量建议：Product signal 测试等待 transport 进入时，使用已有有界 timeout，使 worker 进入前失败也可进入 finally。

审查未发现其他阻断级 Standards 问题。CI 已显式绑定当前轮目录。Reviewer 未复跑整套测试，未进行 Spec/AC 自批。

## Spec

结论：3 条 P2，修复前不验收。

1. 同名轮覆盖：对应 ACCEPTANCE 第 4 节保留全部槽位和实际尝试、修复后独立新轮；与 Standards 同一事实，保留独立轴结果。
2. 完整任务集未校验：validator 忽略已记录的 datasetSha256；Reviewer 只读 VM 实验更改 task、expectedEvidence、sourceWindow、scoring 后仍返回 ok。需要每轮完整 dataset 快照和摘要校验，历史轮按自己的快照验证。
3. 合成业务输入不完整：L-04/05/06/12 只有对象 ID，缺少对应项目、延期事实、方案正文、看板数值、Worker 初始数据与依赖。需要静态合成材料、明确预期及装载说明，材料内容计入 hash；无需提前实现 live 执行器。

Reviewer 确认 36 槽计数准确，未要求 WB-01～04 能力在 WB-00 提前通过。

## 修复与复核

修复派给新的 `wb00_integrity_fix` Luna xhigh；旧 Coding 已全部收回写入权。限定证据 runner/validator、静态数据集、必要公共 CLI 回归，以及本卡新增 signal 测试的 timeout；不改产品源码或旧恢复测试。

修复已完成：排他创建轮次目录；每轮完整 dataset 快照/摘要及 slot 字段校验；历史 v1 fallback 同时校验版本与摘要；v1.1 内联四项合成资料；signal 等待已有有界 timeout。新增完整性 CLI 回归已接入 CI。

### Standards 复核

剩余 finding：0。原 P2 解决，非阻断 timeout 建议也已处理。独立 reviewer 核对 43/43 文件 hash、历史 r3/r4 的 16 文件未改，并只读复验 r3/r4/r5 与产品 manifest 均退出 0。

### Spec 复核

剩余 finding：0。原 3 项 P2 全部解决。独立 reviewer 核对冻结清单与历史字节；r3/r4/r5 verifier 通过；只读 VM 分别修改 r5 快照 task、expectedEvidence、sourceWindow、scoring，四项均被拒绝（退出 1）。静态材料与胶囊中的公共接口装载说明满足本卡可复现输入范围。

主控独立运行 `node --test scripts/workbench-baseline-integrity.test.mjs`：5 pass、退出 0；显式 r5 verifier 退出 0。原 P2 的 RED 来源为首轮独立源码/VM 审查；新增 CLI 回归首次运行的两项失败来自修正过程中 scoring 字段映射错误，随后修复为 GREEN，未将其冒称为原产品回归。

r5 生成之后新增了 CI 的 CLI integrity step，因此 r5 的 CI 文件摘要早于最后一个配置增量；其余 r5 执行源码摘要一致。新增步骤对应命令已由主控独立验证，远端 CI 未运行。旧恢复预算用例的全套 readiness 失败及隔离通过仍保留；两轴复核不表示全套测试绿灯或产品 L/M/P 通过。

两轴分别结案：Standards 初始 1 P2 → 剩余 0；Spec 初始 3 P2 → 剩余 0。Astra 主控据此验收 WB-00 基线记录与 AC-18a，未来功能由后续卡验收。
