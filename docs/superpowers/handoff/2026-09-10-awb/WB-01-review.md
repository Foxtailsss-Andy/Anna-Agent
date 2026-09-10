# WB-01 两轴审查

状态：两轴及最终夹具增量审查通过；实际运行验收见 WB-01 胶囊。固定点与本票 pre-change 为 `cfe0731700268fd466b588a65641c1d162487443`。

本轮 HEAD 与固定点相同、commit list 为空；实际审查使用 working-tree + untracked 的非空补丁，不因 HEAD 三点 diff 为空跳过。29 个冻结文件，6 tracked + 23 untracked；patch 213,151 bytes，SHA256 `29067e40420c313695eb3db5c4da8975302a5479e63a5840aa0c4a9071f150f8`。两位 fresh Astra xhigh reviewer 入场与结束均核对 29/29 hash 一致，互不读取另一轴结论。

## Standards

首轮结论：2 项 P2；可能 smell 0。

1. `workbench-session-migration.test.ts:395` 将冷重启水位固定为 `seq === 11`，把稳定性验收绑定到当前 OMP 事件数量。违反本机 TDD Skill 的“Tests verify behavior through public interfaces, not implementation details”规则。应比较重启前公开 API 的逐 Run `{event_id, seq}` 与重启后实际水位。
2. 同测试 `:406` 覆盖 `:379` 创建且未关闭的 Host，finally 只能关闭后一个，旧监听器失去句柄。与 SUPERVISOR 的资源 drain 要求不一致。重建前必须关闭旧 Host。

本轴只读规范/代码与轻量完整性核查，未重跑整套测试。早期先实现后补测试已由主控记录，不能追补成严格 test-first 历史；本轮只列当前可修复问题。

## Spec

首轮结论：3 项 P2；独立越界项 0。

1. `product-facade.ts:692` 先解析 Project scope 再验证 Session owner。合法跨 workspace 用户 GET 真实 Project Session / POST 其 runs 得 `scope_not_found`，随机 Session 得 `session_not_found`，泄漏对象存在性。违反 R-15 / AC-15 的错误与存在性范围保护。
2. `workbench-migration.ts:35–39,134–137` 在 Project 授权前生成当前 actor/workspace 摘要，且返回被跳过 Project 记录数。不可访问记录仍改变 hash、bytes、skipped count。公开摘要和统计应只基于最终获准集合；诊断完整性另存。
3. `workbench-session.ts:216–219` 永久缓存首次加载失败的 rejected Promise。修复坏目标后，同 Host 迁移、列表和创建仍无法重试。违反 R-17 “迁移失败要能重试且无重复 Session/Run/effect”。失败应允许再次读取，保持现有原子提交。

Spec reviewer 通过真实公开 HTTP、Python 认证/业务、临时持久 EventStore 复现三项；未启动 OMP worker或重复重测试。复现代码与结果保存在本地 `.tmp-tests/wb01/spec-review/`；该 probe 断言缺陷存在，其退出 0 不是产品通过。

## 修复与复核

已创建 fresh Luna xhigh `wb01_review_fix`，初始阶段只读等待。主控完成首轮冻结版本 JavaScript 全套后发出 GO，开始有界修复，避免混合版本测试。预定修复范围为上述三个产品模块、迁移测试及公开回归，不改 Python、OMP worker 或无关模块。

主控现有检查：Host/Web build 退出 0；Python 全套 1,080 passed；release boundary 与 product smoke 退出 0。首轮冻结代码 JavaScript 全套退出 0，1,179 passed / 7 skipped；这是修复前结果，修复后另行验证。当前最终证据轮另记；L/M blocked、P not_run。首轮两轴尚有 2 / 3 项，不能验收 WB-01。

## 第一次修复复核

修复后冻结 31 文件，patch SHA256 `81706e19960352fb0ac2da697d45400376e9848add4167713786c75c4a388482`；两轴均核对 31/31 前后无漂移。

Standards：初始 2 → 剩余 0；水位改为逐 Run 比较重启前后公开观察，Host 重建前明确 close。新增标准硬问题 0。

Spec：初始 3 → 剩余 1。最终获准集合摘要与 rejected loadPromise 重试已关闭；错误一致性只修复跨 actor/workspace 分支。同 owner 的 Project 迁出 workspace 后，访问已存在 Session 仍传播 scope_not_found，与不存在的 session_not_found 不同。Reviewer 通过真实公开 API、SQLiteCrewStore 的合成 Project 权限变更及持久 EventStore 复现，独立正确目标 probe 退出 1。

第二轮全仓 JS 已在原修复版启动；发现剩余分支后由主控中止（退出 130），保留 `javascript-full-final.log`，不计通过。后续由同一 review-fix Coding 在明确两个文件内补齐原 Spec1，再重新冻结和验证。首轮 1,179 passed / 7 skipped 的结果仍仅对应原始冻结版，不被覆盖。

## 最终两轴复核

第二次有界修复只改 Session 授权归一化及长期回归，真实 Project 权限变化场景先 RED 后 GREEN；原日志保存在 `.tmp-tests/wb01/review-fix/round2-*.log`。

最终复核固定 31 文件，patch 231,350 bytes；SHA256 `1cea1aed43687e9ae2b10bb22bcbd0b287b3ac4011b68cfcbddf2b77bfbce84d`。两轴均核对入场/结束 31/31 hash 无漂移。

- Standards：初始 2 → 剩余 0；新增硬问题 0，可能 smell 0。原水位与 Host drain 修复保持；新增权限变化测试使用真实业务存储安排条件，再由公开 HTTP 验证。
- Spec：初始 3 → 前轮剩余 1 → 当前剩余 0。跨 workspace 与同 owner 权限变化的 GET/POST 均与不存在 Session 完全一致；摘要只计最终获准集合；坏目标修复后同 Host 可重试。独立最终真实 HTTP probe 1 passed、退出 0；未运行 OMP worker。

最终复核各自独立判定，combined review 文档在本轮只作 hash 核对。首次修复 Spec 复核曾在补丁输出中偶然看到 Standards 片段，reviewer 明确未据该片段提出/关闭 Spec 项；其判断均由上位 Spec 与独立 HTTP 探针支持。

两轴审查通过不替代最终运行检查。最终候选 JS 全套、AC-18b 新轮与集成提交见 WB-01 胶囊；L/M blocked、P not_run 保持。

## 完整回归失败与最终夹具复核

产品问题清零后，主控完整 JS 回归得到 1,181 passed / 1 failed / 7 skipped、退出 1；日志 `javascript-final-candidate.log` 保留。失败为迁移历史 `legacy-history-04` 未在旧约 5 秒观察窗内完成，与 WB-00 的旧恢复预算用例不同；原失败具体慢在哪层尚未证明。

fresh Luna `wb01_fixture_wait` 仅修改迁移测试。两份带外部 transport 延迟的 RED 分别失败于 `legacy-project-b`（`red-6s-transport-before-fix.log`）和 `legacy-run-chat`（`red-maintenance-delay-before-fix.log`）；不能由这些日志推定原自然失败的直接因果。最终 fixture 固定首次 transport 响应延迟 6 秒，观察窗改为 30 秒，逐事件使用公共 `read(afterSeq)`，只有 completed 成功，其余失败或需人工状态立即报错；超时保留安全的最后事件/状态诊断。总测试上限 450 秒覆盖 13 个串行旧 Run 与后续操作。产品 Run 的 180 秒预算、OMP readiness 上限及产品源码未改。

聚焦 GREEN：`npm run test --workspace=@anna/harness-service -- test/workbench-session-migration.test.ts --reporter=verbose`，1 passed、退出 0；测试本体 57.22 秒，suite 总 58.04 秒。全仓 typecheck 退出 0。真实日志位于 `.tmp-tests/wb01/fixture-wait/`。该结果仍不代替全仓最终运行。

最终夹具冻结仍为 31 文件，234,582 bytes，patch SHA256 `ac0eec5d8a06583a2c8be704587cdb01ba2a82f9cfd7883f7a2f89aa00737946`；测试 SHA256 `c60f9a0c0a7b7037ed01e9a7651d7754ec831825da0622a971e027c4852af7da`。本次 patch 按文件清单顺序重组，块排序与前轮不同，逐块内容一致。两个独立 reviewer 初末均核对 31/31 hash，combined 文档只查 hash；未重跑重测试。

- Standards：原 2 → 0 维持，新增 0。公共排他游标、观察界限、终态判断和资源关闭符合标准。
- Spec：原 3 → 0 维持，新增 0。AC-17a 的 13 Run→5 Session、来源保留、dry-run/apply 幂等、隔离、冷重启水位、坏源/冲突/重试断言完整。

此后仅主控验收文档与新证据产物更新；产品及测试 bytes 必须与该冻结快照保持一致。最终完整回归与新 AC-18b 轮次见胶囊。

## 第二处观察窗口失败

迁移夹具修复后的完整轮 `javascript-acceptance-fixture-fixed.log` 退出 1：总计 1,181 passed / 1 failed / 7 skipped。迁移测试通过；唯一失败为 `Workbench retry prefers a canonical Run when admission status persistence fails`，其旧 200×25ms helper 在 `workbench-admission-failure.test.ts:191` 未观察到终态。日志没有最后事件，因此不推定产品终态失败或具体慢层。失败记录保留，不能用之前聚焦通过替代。

主控重新给予 Luna 单文件 admission 测试写入权；其余两个 Session 公共查询 helper 为约 10 秒，未在此轮失败，本次不扩改。下一冻结与验收另记。

## 最终 admission 增量复核

单文件修复后固定 31 文件，238,541 bytes，patch SHA256 `88e6143a124eca9deffbd740b249adc64cae4162d2f04ff16e3ca719365e2e57`；admission 测试 SHA256 `4acb38d2b971f626fe2a9e1f54ab7e85642b324e58997537151438d90cfc362f`。两个 reviewer 初末核对 31/31 hash，按冻结顺序重组 patch 一致；产品源码、Run 预算和测试整体 120 秒上限未变。

6 秒外部 transport RED：focused 1 passed / 1 failed、退出 1，失败于该唯一执行 Run 的旧观察器。GREEN：focused 2 passed、退出 0，测试本体 20.32 秒、suite 21.10 秒；全仓 typecheck 退出 0。此处仅证明指定 fixture 在修复后的观察规则下通过，不归因原自然失败的慢层。证据保存在 `.tmp-tests/wb01/admission-wait/`。

Standards：原 2 → 0 维持，新增 0；Spec：原 3 → 0 维持，新增 0。公共游标符合严格大于 afterSeq 的读取契约；30 秒观察窗口只接受 completed，失败/等待状态立即失败；无模型首次/重复/并发提交、失败公开状态、损坏 sidecar 拒绝、Canonical 已完成但 admission 标记滞后的重复提交与单模型调用断言全部保留。无伪造 Canonical events。两轴只读，未重复重测试。

最终实施/测试字节以本冻结与新 AC-18b sourceHashes 为准。主控随后仅补齐验收文档和证据；原始失败与所有冻结日志不覆盖。

主控最终验证：完整 JS 1,182 passed / 0 failed / 7 skipped、退出 0；Python 全套 1,080 passed，最终 typecheck/Host build/Web build/release boundary 均退出 0。独立 `wb01-acceptance-20260910-r1` 为 9 TS + 1 Python passed，source/owned hash 无漂移，manifest 独立核验通过。代码提交 `020112091849f0d3a2c08349ff38c4b13d44fff0` 的 source blobs 与证据逐项一致；详见 WB-01 胶囊。
