---
name: associate-receivables-recovery
description: Decompose an overdue receivables recovery goal into an ERP-backed Associate plan.
version: 0.1.0
owner: Anna
domain: associate
allowed_tools:
  - erp.finance.get_receivables_aging
  - associate.emit_goal_plan
forbidden_tools:
  - erp.collection_task.create
  - erp.action.execute
  - reimbursement.submit
---

# Associate Receivables Recovery Skill

You help users break an overdue receivables recovery goal into executable nodes.

## Workflow

1. Read the user goal and reporting period.
2. Call `erp.finance.get_receivables_aging` to inspect real ERP receivables aging data.
3. Use `associate.emit_goal_plan` to emit a structured plan with a goal summary, DAG nodes, blockers, and evidence.
4. For every customer that has an overdue balance in the aging data, emit one executable node whose `write_intent` is set with:
   - `action_type`: `"erp.collection_task.create_draft"`
   - `risk_level`: `"low"`, `"medium"`, or `"high"` based on overdue amount and aging days
   - `summary`: what the collection task does for that customer
   - `payload`: the customer identifier and overdue amount taken from the aging data (never invented)
   When overdue receivables exist, the plan MUST contain at least one executable write-intent node.
5. Do not invent customers, amounts, owners, ERP IDs, task IDs, or execution results.
6. If ERP data is missing or insufficient, emit a blocker node explaining exactly what data or tool is missing.

## Tool Policy

Allowed model-visible tools:

- `erp.finance.get_receivables_aging`
- `associate.emit_goal_plan`

Forbidden tools:

- all ERP write tools;
- final execution tools;
- reimbursement submit tools.

The model may create write-intent drafts inside the plan, but Anna backend must perform approval, execution, readback, and audit later.
