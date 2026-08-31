import { expect, test } from "vitest";
import { createLiveProfile } from "../src/production";

test("product profiles resolve each surface Skill and admitted tools", async () => {
  const cases = [
    ["general", ["read_only"]],
    ["chat", ["todo", "chat.emit_page", "chat.emit_document", "workdir.read_file"]],
    ["create", ["todo", "create.emit_skill_draft", "create.emit_prompt_draft", "create.emit_python_tool_draft"]],
    ["hiker", [
      "todo",
      "hiker.system.list_capabilities",
      "hiker.system.get_current_user_context",
      "hiker.master_data.search",
      "hiker.master_data.get_detail",
      "hiker.contract.list_contracts",
      "hiker.contract.get_contract_detail",
      "hiker.contract.get_business_chain",
      "hiker.report.get_dashboard_summary",
      "hiker.report.get_collection_summary",
      "hiker.report.get_invoice_summary",
      "hiker.report.get_po_receivable_summary",
    ]],
    ["reimbursement", [
      "todo",
      "reimbursement.get_policy",
      "reimbursement.validate_draft",
      "reimbursement.create_draft",
      "reimbursement.get_status",
      "reimbursement.submit_intent",
    ]],
    ["crew", ["read_only", "todo", "crew.emit_project_plan", "crew.emit_assignments", "crew.emit_task_drafts"]],
  ] as const;

  for (const [surface, expectedTools] of cases) {
    const profile = await createLiveProfile("fixture-model", undefined, false, surface);
    expect(profile.allowedTools).toEqual(expectedTools);
    expect(profile.skills).toHaveLength(1);
  }
});
