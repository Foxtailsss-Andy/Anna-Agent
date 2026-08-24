# Pi 水平修复轮 · 00-plan（评测 v0 首跑四根因）

> **目标一句话**：让 Anna 的 loop 达到 Pi 的底线纪律——工具错误永不杀 run、模型知道今天几号、
> 空数据说空数据、问二必答二（或诚实说答不了）。验收 = 评测集 v0 重跑，G1/G2/H1/S1/R1 翻绿。
> 证据基线：`evals/v0-smoke/runs/2026-08-06/`（3/8 pass，失败全确定性）。
> 参考序：forge-harness `02-agent-loop.md`/`04-tools.md`（实现前先读错误处理相关节）＞ waku registry.py:47-58
>（surface-don't-crash）＞ Pi `blocked → tool result` 纪律（docs/pi-agent.md:106-124 的教学点）。

## Global Constraints

- 不动 `agent_loop.py` 内核（错误回喂发生在 CapabilityHandler 层，loop 契约不变）。
- ADR-002：一切用户可读标签/事实注入均代码生成。
- 诚实规则：错误观察必须如实（error_code + message 原文），不得美化；日期注入用真实本机时间。
- 每修一处：RED→GREEN、独立 commit（只 stage 本修文件）、四门不回退（基线 pytest 925 / vitest 632）。
- **评测回填纪律**：每个根因至少一条能拦住它的确定性 pytest（eval 只做真机复核，不当唯一防线）。

## F1 · 工具错误回喂（S1 根因，最高优先）

**现场**：`services/chat/app/capability.py:233-234` —— `except ErpMcpError as exc: raise CapabilityError(...)`。
一个 `invalid_arguments` 杀掉了含 5 次成功调用的整个 run（S1 证据）。

**改法**：
- `ErpMcpError` → 不再 raise，改为返回**错误观察**：`tool_observation_message(tool_call, {"error": exc.error_code, "message": exc.message, "hint": "修正参数后可重试"})`（结构照 mcp_dispatcher 的观察折叠形状；hint 文案代码生成）。模型下一轮读到原因自行纠正，`max_turns` 天然兜底防错误死循环。
- `_emit_artifact` 的 `artifact_invalid`（title/content 为空）同族处理——模型可自愈的输入错误一律观察化。
- **保持致死**的只剩治理面：`assert_allowed` 的 `PermissionError → CapabilityError`（fail-closed 不动）。
- **F1b 顺手补 trace 诚实**：失败的工具调用目前在瀑布里会显示成 ok（loop 照常发 tool_done）。`trace_assembler.py` 已经收到 `mcp.tool.called` audit 事件（payload 含 status/error，A2 §2）——当该事件 status=error 且落在开着的 tool span 内时，把该 span status 置 "error" 并写 `error.type`。gate 补一条断言。

**测试**：①unit：dispatch_tool 遇 ErpMcpError 返回观察不 raise；②integration（fake stream）：第 1 轮工具报 invalid_arguments → 第 2 轮模型带修正参数重调成功 → done，run 全程不 failed；③gate 扩：错误工具 span 标 error。

## F2 · 当前日期注入（G2 根因）

**现场**：chat 的 system prompt 组装（`ChatCapabilityHandler.build_initial_request` 一带，具体位置实现时定位）。
G2 把"上个月"算成 2025-11——模型不知道今天几号。

**改法**：system prompt 追加一行代码生成的时间事实（waku session.py:66-70 先例）：
`现在是 {YYYY-MM-DD HH:MM}（{本机时区}）。所有相对时间（上个月、今年）以此换算。`
**测试**：build_initial_request 产物含当日日期；若有 prompt 快照 pin 测试被碰碎，按实更新断言（≤5 处直修，>5 处报告再议）。

## F3 · demo-erp 无数据语义（H1 根因上游，独立仓）

**现场**：`Desktop/demo-erp`（独立 git 仓）——范围外期间（2030-03）返回 0 值 stub 而非"无数据"。
**改法**：finance 查询域逻辑对**无任何业务记录的期间**返回显式无数据语义（`{"no_data": true, "message": "该期间无业务数据（可用期间 2026-04 ~ 2026-06）", ...}` 或等价文案字段），不再回零表。demo-erp 自己的测试跟上（它有 pytest.ini）。**在 demo-erp 仓内独立 commit，不混入 Anna 仓。**
**Anna 侧零改动**（F1 之后观察是透传的，模型会如实转述）。

## F4 · Evaluator 第三触发器 multi_ask（G1/R1 根因）

**现场**：`services/chat/app/evaluator.py:115-130` `should_evaluate` 只有 `plan_pending` / `claim_no_tools` 两触发——
调了工具但问二答一的 run 直接放行，judge 无出场机会（G1 三连发 0/3 全是这条路）。

**改法**：加第三触发器 `multi_ask`（代码正则预过滤，零模型成本）：用户消息命中多问信号
（`分别|各是|和.+?(多少|如何|怎样)|？[^？]*？|、.*(多少|情况)`——实现时按测试打磨，宁窄勿宽）
且本段 `segment_had_tool_done` 为真 → 触发既有 judge（prompt 本来就判"是否真正完成了用户请求"，
runtime facts 机制原样复用）；not-achieved ≥ 置信阈 → 走已有补办 continuation。**零新机器，只开一扇门。**
**测试**：①trigger unit：G1 原句触发、单问句不触发（防误伤成本）；②integration（fake judge）：两问答一 →
not_achieved → 补办轮补答 → done；③既有 evaluator gate 不回退。

## 验收

1. 四门：pytest ≥925+新增全过 / tsc 0 / vitest ≥632 / build ✓；demo-erp 仓自测过。
2. **评测 v0 全量重跑**（重启 App 后，按 spec §4 /submit 路径）：目标 G1 G2 H1 S1 R1 翻绿 → 8/8；
   翻不绿的如实记 residual，不改判据凑分。R1 继续 ×3 验确定性。
3. 结果落 `evals/v0-smoke/runs/2026-08-06-r2/`，与首跑同 schema，出对比表（分数/tokens/时长环比）。
