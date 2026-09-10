# WB-02 Skill 切片审查与证据记录

状态：r2独立两轴清零，Skill切片D/O契约与正式AC-18b验证通过；整WB-02未关闭。详细提交/交接见胶囊与STATUS。

固定点：`857bba3bbf593c7b6bb268c56d3bb894a39d93f7`。行为契约见 [Skill 契约](WB-02-skill-contract.md)。只审本切片 owned diff；用户原 AGENTS、CONTEXT、docs/agents、AWB 规划不计本切片实现。

## 主控入场与首个 tracer

主控独立核对核心 A 的 25 个审查文件、38 个证据关联源和 21,465 个 OMP 运行包文件，worker/protocol/runtime lock 均一致。原 12 个保护输入（除 STATUS）及 tracked dirty digest 保持。第一次核对脚本将 sourceHashesAfter 误当字典，尚未写证据即退出 1；校正列表读取后的第二次核对通过，保留该 setup 说明。

WB-00 baseline verifier 独立退出 0：36 槽仍为 21 blocked / 15 not_run。没有跨轮填充或累计。

首 writer 的有效 RED 为 issue-skill-tracer-red-003：第二次实际 OMP 请求的 search 结果缺少 Skill 目录。此前 red-001/002 只显示 runtime_bridge_failed，不单独用于定位。首 GREEN 为 1 test passed、typecheck 退出 0。主控收回写入权，冻结 7 文件，再独立执行同一公开入口用例：1 passed，源码 7/7 无漂移。此为 tracer 候选验证，不是完整切片验收。

## 后续实施中的证据边界

- policy definition 首 RED/GREEN 直接断言内部 description/schema helper，并以不完整 ToolRequest 调 controller。这一组只记诊断证据，不能算已同意的 Host/Gateway 契约用例。最终测试需替换到生产执行边界；若后续使用临时撤去守卫的证明，明确记 mutation，不改称时间顺序 RED。
- 主控将修复范围收窄为删除 skills.load 的硬编码 definition 分支，让它沿已存在的持久目录查询；原 capabilities.search/load 的 Host 控制定义优先级保持。
- explicit forbidden 的早期 bridge 失败诊断不足；red-003 明确显示禁用 skills.load 后仍返回两项 Skill，green-001 返回空目录并正常完成。该组合总数包含上述 helper 诊断项，不能将总数全部称为合格合同。
- 恶意正文首次直接调用 secret.tool 得到 omp_invalid_tool_identity，属于 OMP 定义层拒绝；随后改为调用获准 capabilities.load 请求 secret.tool。中间一次 failed result 解析错误是夹具失败；校正后观察到 failed/capability_not_available，再正常完成。该组没有证明真实模型的提示注入判断质量。
- 原失败、setup 与 GREEN 均保留于本地 .tmp-tests/wb02-skill/。公开交接只保存摘要和合成证据，不复制正文/配置或私密地址。

## Standards

待最终源码冻结后由独立 fresh Astra xhigh 只读审查。

## Spec

待最终源码冻结后由另一位独立 fresh Astra xhigh 只读审查。

## 未完成

生产边界的历史 definition 验证、参数/未知 ID、已有显式 Crew 限制、跨入口、真实 OMP 冷恢复与新版本登记、正式 AC-18b、完整四项回归、公开扫描和最终运行包一致性尚未收口。L/M blocked、P not_run、usage unavailable。

## 参数错误用例的验收纠偏

invalid-argument-red-001 原断言认为错误参数不产生 OMP dispatch，实际存在 dispatch；green-002 改为期待 run.failed/runtime_bridge_failed 而通过。这不满足本切片“错误反馈给模型并可继续”的契约，主控明确拒绝把它计为通过，也未接受“SDK 校验前终止”的归因。

主控检查当时 transport：第 3 次及以后的每次请求均重复相同工具调用 ID 和错误参数，没有读取错误观察或修正参数的分支。当前先仅改测试反馈链：错误参数 → 观察错误 → 新调用 ID 的合法参数 → 正常完成，并捕获每次安全状态/错误信息。产品源码暂不修改；若仍失败，再通过实际事件定位需变更的执行边界。旧诊断与弱化期望的日志全部保留。


参数反馈环校正结果：`issue-skill-invalid-feedback-red-001-1789044404233300000-96458.raw.log` 虽名为 red，实际 1 passed / exit 0。第 4 次真实 OMP 请求收到 failed/invalid_tool_input，使用新调用 ID 提交合法参数，第 5 次收到成功正文，Run 正常完成。主控独立读取该日志与测试代码；生产、Worker、kernel 未为此更改。原“SDK 校验前终止”的结论撤回；本次修的是测试反馈环，未证实需要修复的产品参数错误故障。


## 最终候选第一轮独立审查

固定点仍为 857bba3b；10 文件 owned patch 113131 bytes，SHA256 `919c91d7c165e0eeac07f50ddd9f3faafaa56c5c4a57666e96fa03378bcf2c0c`。两位 fresh Astra xhigh 分别核对开始/结束 10/10 hash 和实际 patch，无漂移；均只读，未跑测试。

### Standards r1

硬违规 0；P3 判断意见 1：workbench-capabilities.ts 的 search 与 skills.load 重复映射同一组 Skill 元数据和 missing_dependencies，可能随口径变化漂移。主控采纳，抽为一个局部投影，读取再附 content。

### Spec r1

需求遗漏/部分 1 项 P2；越界 0，其他行为错误 0。query=general 命中 Skill 时，能力 results 为空，方法 metadata 未提供 skills.load 的 canonical ID，初始模型输入也未交代该入口；tracer 硬编码隐藏了发现到加载的缺口。修正为 metadata 明确提供 loader_capability_id，测试从实际结果取得 ID 并继续加载。

两项由 fresh Luna 在两个 owned 文件内有界处理，再分别复审。不得为此改变原两个 Host 控制工具 description/schema，以免影响旧快照恢复。

## Receipt 日志完整性例外

fresh receipt writer 早期 red-002/green-001/final-002 未将原始 stdout/stderr 落盘，仅保留工具记录和本地结果摘要；不称这些摘要为 raw。后续新 mutation-red-002、恢复后的 mutation-green-002、typecheck-001 保存了 command/source hashes/exit code/stdout/stderr。该 mutation 是新发生的验证，不补造早期 RED。

主控独立核对修正后的 12 份精简 Run receipt：40 个实际 omp.tool.response，40 个唯一事件 ID，4 failed 均保留；只含公开 event_id/seq/tool_status，不杜撰工具调用 ID或正文关联。详细定义/恢复 receipt 另列。此后第 r1 源已冻结，原其他 9 文件和12保护输入保持。


## r2 独立复核

writer 已停写并 drain。固定点不变，10 文件 patch 113458 bytes / SHA256 `3c4d9fffaea7fc75587f93fb723a7daaeac6ba42908feb06cd60245c6fd6eb3a`，相较 r1 只有能力 controller 与 Skill 测试两文件变化。两轴开始/结束均独立验证全部 hash、完整 patch 和空提交列表。

### Standards r2

原判断意见剩余 0，新增硬问题 0，新增 smell 0。局部 metadata 投影统一搜索和读取；读取仅追加正文，没有多余抽象。实际 loader/Skill ID 来自 search 结果，未新增内部权限或 Store/Gateway mock。

### Spec r2

原遗漏剩余 0，新增遗漏/越界/实现错误均 0。loader_capability_id 使方法命中后有明确加载入口，tracer 使用实际返回 ID；显式限制与原能力定义保持。历史 schema 完整 OMP 恢复未验证的边界继续保留。

r2 的有效 RED 为 review-fix/issue-skill-tracer-red-008；green-010 实际因测试局部变量漏声明失败，不计通过。green-013、两文件 targeted-014（8 项）、typecheck-016 退出 0。主控已读取实际日志；所有原始输出/源码 hash/退出码保留。

两轴只读，没有自行运行测试；独立审查通过不等于完整 M1 验收。随后主控开始当前冻结源的完整回归与正式增量。


## 主控最终验证

r2冻结字节的四项：typecheck退出0；JavaScript 1204 passed /7 skipped、退出0、747.73秒；Python1085 passed /53 warnings、退出0；Web/Host build退出0。正式轮 wb02-skill-20260910-r1 为22TS+5Python通过，49关联源无漂移、29个manifest文件通过独立校验。12新Run精简receipt的40响应/4失败均有效；详细定义和恢复hash独立复算一致。OMP21465文件在增量后再次核对。

主控独立完整性脚本首尝试把evidence manifest的size误作runtime manifest的bytes字段，KeyError中止；修正读取实际schema后通过，未修改证据。此为验证脚本setup，不记产品失败。

本轮全部通过不更改核心A历史readiness问题的未定位状态；L/M/P仍未验收，WB-00的36槽原样保留。


主控独立CLI guard完整5项通过，43候选文件公开扫描、8处相对链接与git diff检查通过。代码/公开证据已精确提交为 `c0c78e706b7c67a07beca1c8c59e17741ec178c2`：40个owned路径，49个证据关联源及10个审查文件hash均与Git blob相符；用户原tracked dirty digest仍5a5a75da...611b。此结论仅关闭Skill切片，不关闭整WB-02。
