import { expect, test } from "vitest";
import { createLiveProfile, selectProductModelConfig } from "../src/production";
import { validatedProductTask } from "../src/product-session";

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
    const profile = await createLiveProfile("fixture-model", undefined, false, surface, "none", undefined, true);
    expect(profile.allowedTools).toEqual(expectedTools);
    expect(profile.skills).toHaveLength(1);
  }
});

test("product model selection preserves profile identity when model names match", () => {
  const defaultConfig = {
    model_name: "deepseek-v4-pro",
    endpoint: "https://default.example/v1/chat/completions",
    api_key: "default-key",
  } as const;
  const modelProfiles = {
    primary: {
      model_name: "deepseek-v4-pro",
      endpoint: "https://primary.example/v1/chat/completions",
      api_key: "primary-key",
    },
    secondary: {
      model_name: "deepseek-v4-pro",
      endpoint: "https://secondary.example/v1/chat/completions",
      api_key: "secondary-key",
    },
  } as const;

  const primary = selectProductModelConfig(
    defaultConfig,
    modelProfiles,
    validatedProductTask({
      run_id: "run-primary",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Use primary.",
      model_profile_id: "primary",
    }),
  );
  const secondary = selectProductModelConfig(
    defaultConfig,
    modelProfiles,
    validatedProductTask({
      run_id: "run-secondary",
      workspace_id: "workspace-1",
      actor_user_id: "user-1",
      surface: "chat",
      prompt: "Use secondary.",
      model_profile_id: "secondary",
    }),
  );
  const fallback = selectProductModelConfig(defaultConfig, modelProfiles);

  expect(primary).toMatchObject({ profile_id: "primary", config: { endpoint: "https://primary.example/v1/chat/completions", api_key: "primary-key" } });
  expect(secondary).toMatchObject({ profile_id: "secondary", config: { endpoint: "https://secondary.example/v1/chat/completions", api_key: "secondary-key" } });
  expect(fallback).toEqual({ profile_id: "default", config: defaultConfig });
});
