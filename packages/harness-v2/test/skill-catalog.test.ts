import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { loadSkillCatalogEntry } from "../src/skill-catalog";

test("loads a versioned, provenance-bearing Skill catalog entry from its exact document", () => {
  const skill = {
    id: "release-review",
    document: `---
name: release-review
version: 1.2.0
allowed_tools:
  - read_workspace
  - create_artifact
forbidden_tools:
  - shell
  - network
---
# Release review

Compare the PRD with the recorded decision and return a cited delta.
`,
    provenance: {
      source: "workspace",
      uri: "skills/release-review/SKILL.md",
    },
  };

  const entry = loadSkillCatalogEntry(skill);

  skill.document = "changed document";
  skill.provenance.source = "registry";
  skill.provenance.uri = "registry://release-review/2.0.0";

  expect(entry).toEqual({
    id: "release-review",
    name: "release-review",
    version: "1.2.0",
    hash: "sha256:38f7d40bc2dca3e824c82b5bf1069c239a35b0a5a8f69d06719157d14349326d",
    provenance: {
      source: "workspace",
      uri: "skills/release-review/SKILL.md",
    },
    allowedTools: ["read_workspace", "create_artifact"],
    forbiddenTools: ["shell", "network"],
    content:
      "# Release review\n\nCompare the PRD with the recorded decision and return a cited delta.\n",
  });
});

test("loads every repository Agent Skill SKILL.md with stable provenance and tool declarations", () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const skills = [
    {
      id: "associate/receivables-recovery",
      relativePath: "skills/associate/receivables-recovery/SKILL.md",
    },
    {
      id: "chat/general-assistant",
      relativePath: "skills/chat/general-assistant/SKILL.md",
    },
    {
      id: "hiker/global-customer",
      relativePath: "skills/hiker/global-customer/SKILL.md",
    },
    {
      id: "reimbursement/travel-expense",
      relativePath: "skills/reimbursement/travel-expense/SKILL.md",
    },
  ];

  const entries = skills.map(({ id, relativePath }) =>
    loadSkillCatalogEntry({
      id,
      document: readFileSync(resolve(repositoryRoot, relativePath), "utf8"),
      provenance: { source: "workspace", uri: relativePath },
    }),
  );

  expect(entries).toMatchObject([
    {
      id: "associate/receivables-recovery",
      name: "associate-receivables-recovery",
      version: "0.1.0",
      hash: "sha256:93f45f0b8cab03212a025d0d028beaac4c3ab09af3240f77bbdb130c53996df0",
      provenance: {
        source: "workspace",
        uri: "skills/associate/receivables-recovery/SKILL.md",
      },
      allowedTools: [
        "erp.finance.get_receivables_aging",
        "associate.emit_goal_plan",
      ],
      forbiddenTools: [
        "erp.collection_task.create",
        "erp.action.execute",
        "reimbursement.submit",
      ],
    },
    {
      id: "chat/general-assistant",
      name: "general-assistant-chat",
      version: "0.1.0",
      hash: "sha256:f9fe48cafea57380553ccf3a6b0ba66cb8ebbe8608cf18d4a3e41f8e786f5473",
      provenance: {
        source: "workspace",
        uri: "skills/chat/general-assistant/SKILL.md",
      },
      allowedTools: [],
      forbiddenTools: [
        "reimbursement.submit",
        "erp.collection_task.create_draft",
        "erp.collection_task.get_status",
      ],
    },
    {
      id: "hiker/global-customer",
      name: "hiker-global-customer",
      version: "0.1.0",
      hash: "sha256:fda5cc92bb69dce68ebfdf3cea9741ee79b932d29fad975feaf349dc08853839",
      provenance: {
        source: "workspace",
        uri: "skills/hiker/global-customer/SKILL.md",
      },
      allowedTools: [
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
      ],
      forbiddenTools: [
        "hiker.execute_sql",
        "hiker.call_api",
        "hiker.update_record",
        "hiker.delete_record",
        "hiker.admin.reset_password",
        "hiker.file.read_any_path",
      ],
    },
    {
      id: "reimbursement/travel-expense",
      name: "travel-expense-reimbursement",
      version: "0.1.0",
      hash: "sha256:9d16d248cbe88aa88a9e4641cf9b161035e223d171f4614dca1fb33c22b9c4a6",
      provenance: {
        source: "workspace",
        uri: "skills/reimbursement/travel-expense/SKILL.md",
      },
      allowedTools: [
        "reimbursement.get_capabilities",
        "reimbursement.get_policy",
        "reimbursement.validate_draft",
        "reimbursement.create_draft",
        "reimbursement.submit_intent",
        "reimbursement.get_status",
      ],
      forbiddenTools: ["reimbursement.submit"],
    },
  ]);

  expect(entries[0]!.content).toContain("# Associate Receivables Recovery Skill");
  expect(entries[1]!.content).toContain("# Anna General Assistant Chat");
  expect(entries[2]!.content).toContain("# Hiker 全球客户副驾");
  expect(entries[3]!.content).toContain("# Travel Expense Reimbursement Skill");
});
