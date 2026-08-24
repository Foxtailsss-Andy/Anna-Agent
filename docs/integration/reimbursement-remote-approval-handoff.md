# 报销 MCP 任务书:远程审批工具(Anna 反写)

> 给报销系统(MCP server)负责人。Anna 要在对话里让审批人**拉取待审批单 + 审批链**,并**远程同意/驳回**。你的系统已经有审批流(审批人/多级审批链/状态),**本任务 = 把既有审批流暴露为 4 个 MCP 工具**,不是从零新建审批流。

- 协议:沿用现有 JSON-RPC 2.0 over HTTP + `Bearer` token(和现有 6 个工具同端点)。
- 上线前先用 HTTP 联调,生产前换 HTTPS 域名(与现有约定一致)。
- Anna 侧已按本任务书开发并用内存桩测试通过;你交付后即可端到端联调。

## 0. 权威与边界(重要)

- **你的系统是审批的唯一权威**。Anna 只是远程控制 + 角色门 + 审计。
- 每个写操作(approve/reject)你**必须校验** `actor_user_id` 确实是该 `approval_id` **当前待审步骤**的合法审批人;不合法返回 `not_authorized`。Anna 的角色门只是前置过滤,不能替代你的校验。
- **多级审批**:`approve` 表示"当前步骤通过",由你的系统推进到下一级或终态;Anna 不假设层级数。
- **幂等**:同一 `idempotency_key` 重复调用必须返回与首次相同的结果,且不重复推进审批链。

## 1. `reimbursement.list_approvals`(读)

列出某审批人**当前待处理**的单。

- 入参:
  ```json
  { "workspace_id": "...", "actor_user_id": "...", "status": "pending",
    "filters": { "risk_level": "low|medium|high", "applicant": "...",
                 "date_from": "ISO", "date_to": "ISO" } }
  ```
  `filters` 可选;`status` 目前固定 `pending`。
- 出参(`structuredContent`):
  ```json
  { "approvals": [
      { "approval_id": "ap_1", "reimbursement_id": "rb_1", "applicant_name": "王伟",
        "amount": 880.0, "currency": "CNY", "category": "travel",
        "submitted_at": "2026-06-20T10:00:00Z", "current_step_no": 1,
        "risk_level": "low", "policy_flags": [], "can_act": true } ] }
  ```
  - `can_act`:该 `actor_user_id` 是否可对当前步骤行动(用于 Anna 置灰按钮)。
  - `risk_level` / `policy_flags`:你侧的合规预判(Anna 仅展示;Phase 2 才会用于快速规则)。

## 2. `reimbursement.get_approval`(读)

单据明细 + **有序审批链** + 合规结果。

- 入参:`{ "workspace_id": "...", "actor_user_id": "...", "approval_id": "ap_1" }`
- 出参:
  ```json
  { "approval_id": "ap_1", "reimbursement_id": "rb_1", "applicant_name": "王伟",
    "amount": 880.0, "currency": "CNY", "category": "travel",
    "submitted_at": "2026-06-20T10:00:00Z", "current_step_no": 1,
    "risk_level": "low", "policy_flags": [], "can_act": true,
    "status": "pending",
    "draft": { "reason": "出差", "...": "行项目/金额/类别等" },
    "attachments": [ { "name": "发票.pdf", "uri": "https://.../发票.pdf" } ],
    "approval_flow": [
      { "step_no": 1, "approver_role": "manager", "approver_name": "李娜",
        "status": "pending", "acted_at": null, "comment": null },
      { "step_no": 2, "approver_role": "finance", "approver_name": "张敏",
        "status": "pending" } ],
    "compliance": { "status": "compliant|violation|unknown", "flags": [] },
    "snapshot_hash": "h1" }
  ```
  - `approval_flow`:**按 `step_no` 升序**;每步 `status ∈ pending|approved|rejected|skipped`。
  - `snapshot_hash`:单据当前状态的哈希,用于写时乐观锁(见下)。

## 3. `reimbursement.approve`(写,幂等)

对 `actor_user_id` 的**当前步骤**同意。

- 入参:
  ```json
  { "workspace_id": "...", "actor_user_id": "...", "approval_id": "ap_1",
    "comment": "可选意见", "idempotency_key": "...", "expected_snapshot_hash": "h1" }
  ```
- 出参:`{ "approval_id": "ap_1", "status": "approved|pending", "approval_flow": [ ... ], "external_status": "approved|in_review|..." }`
  - 若推进后还有下一级,`status` 可为 `pending`(链未走完),`external_status` 反映外部真实态。
- 乐观锁:`expected_snapshot_hash` 与当前不符 → 返回 `stale_snapshot`(Anna 会刷新重试)。

## 4. `reimbursement.reject`(写,幂等)

- 入参:同 approve,但 `comment` 换成**必填** `reason`:
  ```json
  { "workspace_id": "...", "actor_user_id": "...", "approval_id": "ap_1",
    "reason": "金额超标", "idempotency_key": "...", "expected_snapshot_hash": "h1" }
  ```
- 出参:`{ "approval_id": "ap_1", "status": "rejected", "approval_flow": [ ... ], "external_status": "rejected" }`

## 5. 错误码(JSON-RPC `error.code`)

| code | 含义 |
|---|---|
| `not_authorized` | `actor_user_id` 不是该单当前步骤的合法审批人 |
| `already_acted` | 该步骤已处理 / 重复操作(配合幂等返回原结果亦可) |
| `stale_snapshot` | `expected_snapshot_hash` 与当前不符 |
| `not_found` | `approval_id` 不存在 |

错误对象沿用现有格式:`{ "code": "...", "message": "...", "retryable": false }`。

## 6. 能力上报

在 `reimbursement.get_capabilities` / `tools/list` 中**报告以上 4 个工具**。Anna 据此判定 `approval_supported`:未报告时审批入口自动禁用并提示"该连接器未启用审批流",不会报错。

## 7. 交付清单

- [ ] 4 个工具按上述契约可用(含 4 个错误码 + 幂等 + 乐观锁)。
- [ ] `get_capabilities` 报告审批能力。
- [ ] 1~2 个**审批人测试账号** + 含多级审批链的测试单,线下发我。
- [ ] 说明你侧审批人身份与 `actor_user_id` 的映射(Anna 用同一 `actor_user_id` 调用)。

对应 Anna 侧设计/计划:`docs/superpowers/specs/2026-06-22-reimbursement-remote-approval-design.md`、`docs/superpowers/plans/2026-06-22-reimbursement-remote-approval.md`。
