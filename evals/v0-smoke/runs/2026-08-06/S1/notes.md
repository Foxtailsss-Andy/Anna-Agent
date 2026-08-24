# S1 · 插话转向 — **FAIL**（能力 FAIL，非 INFRA、非 SKIP）

- run_id: `chat_run_011` · status **`failed`** · 2026-08-06
- 输入：`详细分析 2026 年 4、5、6 三个月的收入趋势，逐月解释变化`
- 插话：`顺便把应付账款金额最大的供应商也带上`（POST 于 run 创建后 **+0.02s**，status=generating）
- 指标：turns 2 / duration_ms 13351 / tokens_in 2447 / tokens_out 710 / tool_calls 6（5 ok + **1 error**）
- 终局：`error_code` `invalid_arguments` · `error_message` `period 参数非法（应为 YYYY-MM）：None（演示数据）`
- `assistant_message` = **null**（用户什么都没拿到）

| 断言 | 结果 | 证据 |
|---|---|---|
| A1 interject 返回 accepted=true | ✓ | `interject-response.json`：`{"run_id":"chat_run_011","status":"generating","accepted":true}` |
| A2 终局答案包含应付/供应商内容 | **✗** | run 崩了，`assistant_message` 为 `null`，没有终局答案可言。真值本应为「蓝云数据科技有限公司 42 万」 |
| A3 trace 含插话留痕（帧原名可见） | ✓ | `trace.json` span events 含 **`run.interjected`**；`run.json` `audit_events` 中位置正确（`model.call.started` 之后即插入），J3 回执帧工作正常 |

## 关键发现：插话**被成功采纳**，却被一个工具参数错误连坐

采纳证据（比 A2 更硬的直接证据）——`run.json` 的 `plan` 里多出了第 5 项，
正是插话内容，说明模型确实收到了并纳入了计划：

```
1 查询 2026-04 收入数据      in_progress
2 查询 2026-05 收入数据      in_progress
3 查询 2026-06 收入数据      in_progress
4 汇总分析三个月收入趋势      pending
5 查询应付账款金额最大的供应商  in_progress   <- 插话产生的计划项
```

失败链条（`trace.json` turn 2 的 4 个 `mcp.tool.called` 事件）：
前三次 `erp.finance.query`（04/05/06 收入）`status: success`；
第四次——即插话衍生的应付查询——`status: failed`，
因为模型**没带 `period` 参数**（插话原文没写月份），demo-erp 返回
`invalid_arguments: period 参数非法（应为 YYYY-MM）：None`。

## 根因（代码级）

`services/chat/app/capability.py:233-234`：

```python
except ErpMcpError as exc:
    raise CapabilityError(exc.error_code, exc.message)
```

**任何** ERP 工具错误（含"参数写错了"这种模型自己就能改的错）都被升格为
`CapabilityError` 向上抛，直接终结整个 run —— 模型**看不到**这个错误，
因而没有任何机会补一个 `period` 重试。已完成的三个月收入分析（5 次成功调用、710 output tokens）
一并作废，用户拿到 `null`。

trace 上还留下了 `anna.orphaned: true`（失败的 `execute_tool erp.finance.query` span），
说明该 span 是被异常打断、未正常闭合的。

## 为什么判 FAIL 而不是 INFRA / SKIP

- **不是 INFRA**：demo-erp 全程健康，它**正确地**返回了一个参数校验错误（这是正常契约行为，
  不是连接/环境故障）。spec §2.3 的 INFRA 指连接/环境/时序故障。
- **不是 SKIP(时序)**：spec §3 S1 的重试/SKIP 条款只针对"run 结束太快导致插话落空"。
  本案插话 `accepted:true` 且已进计划，时序完全正常 → 重试条件不成立，故**未重试**（也未额外耗 token）。
- 因此计入能力分：**FAIL**。

**这是本轮最该修的一条**：工具错误应作为 tool result 回喂模型让其自我纠正，
而非杀死整个 run。当前设计下，模型任何一次参数手滑都会让长任务全盘归零。
