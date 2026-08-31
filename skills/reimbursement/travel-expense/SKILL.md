---
name: travel-expense-reimbursement
description: Create, validate, submit, and verify employee travel and expense reimbursements through Anna Cowork and MCP.
version: 0.1.0
owner: Anna
domain: reimbursement
allowed_tools:
  - todo
  - reimbursement.get_capabilities
  - reimbursement.get_policy
  - reimbursement.validate_draft
  - reimbursement.create_draft
  - reimbursement.submit_intent
  - reimbursement.get_status
forbidden_tools:
  - reimbursement.submit
required_fields:
  - category
  - amount
  - currency
  - expense_date
  - merchant
  - reason
  - department_id
  - cost_center_id
---

# Travel Expense Reimbursement Skill

You help employees create reimbursement drafts and submit them after explicit approval.

## When To Use

Use this Skill when a user wants to create, validate, submit, or check the status of a travel or expense reimbursement.

## Required Fields

Collect these fields before creating a draft:

- category
- amount
- currency
- expense_date
- merchant
- reason
- department_id
- cost_center_id
- attachments when required by policy or connector capabilities

Do not invent department, cost center, merchant, project, attachment, or expense date values.

## Workflow

1. Read the user's reimbursement request.
2. Call `reimbursement.get_capabilities` when connector capabilities are needed.
3. Ask concise questions for missing required fields.
4. Call `reimbursement.validate_draft` before draft creation.
5. Call `reimbursement.create_draft` only after required fields are present and validation succeeds.
6. Explain the created draft and ask for confirmation.
7. When the user wants to submit, call `reimbursement.submit_intent` with the draft ID, external draft ID, amount, currency, reason, and policy summary.
8. After Anna backend submits, use `reimbursement.get_status` to explain readback status when needed.

## Tool Policy

Use only the provided reimbursement tools. Never call or request a final submit tool directly. The final submit is backend-only and happens after Cowork approval.

Allowed model-visible tools:

- `reimbursement.get_capabilities`
- `reimbursement.get_policy`
- `reimbursement.validate_draft`
- `reimbursement.create_draft`
- `reimbursement.submit_intent`
- `reimbursement.get_status`

Forbidden model-visible tool:

- `reimbursement.submit`

## Missing Field Questions

Ask for only the missing fields. Keep the question short and specific.

Good:

```text
还需要费用承担部门、成本中心和发票附件。请补充这三项。
```

Avoid asking for fields that are already known.

## Draft Output

When a draft is ready, summarize:

- expense category;
- amount and currency;
- expense date;
- merchant;
- reason;
- department and cost center;
- attachment status;
- external draft ID when available.

## Approval Summary

Before submission, make clear:

- what will be submitted;
- which external reimbursement draft will be submitted;
- policy or risk summary;
- that the submit action will write to the external reimbursement system.

## Forbidden Behavior

- Do not invent external reimbursement IDs.
- Do not mark a reimbursement as submitted.
- Do not call or request `reimbursement.submit`.
- Do not assume policy results without a tool result.
- Do not hide missing connector or model configuration problems.
