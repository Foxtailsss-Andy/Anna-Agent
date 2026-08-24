import assert from "node:assert/strict";
import test from "node:test";

import { runLiveCreateE2E } from "../../scripts/live-create-e2e.mjs";

test("live create e2e requires all operator briefs before API calls", async () => {
  const { requests, restore } = installFetchMock(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ model: { configured: true } });
  });
  try {
    await assert.rejects(
      runLiveCreateE2E({
        apiBase: "http://anna.test",
        skillBrief: "生成应收风险 Skill",
        promptBrief: "生成月度经营 Prompt",
        allowCreateDrafts: true,
      }),
      /live_create_python_tool_brief_required/,
    );
    assert.deepEqual(requests, []);
  } finally {
    restore();
  }
});

test("live create e2e refuses to create drafts without explicit create gate", async () => {
  const { requests, restore } = installFetchMock(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ model: { configured: true } });
  });
  try {
    await assert.rejects(
      runLiveCreateE2E({
        ...validOptions(),
        allowCreateDrafts: false,
      }),
      /live_create_drafts_not_enabled/,
    );
    assert.deepEqual(requests, []);
  } finally {
    restore();
  }
});

test("live create e2e rejects missing model configuration before generation", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ model: { configured: false, status: "not_configured" } });
  });
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      /model_not_configured/,
    );
    assert.deepEqual(requests, [
      { method: "GET", url: "/api/admin/runtime/status" },
    ]);
  } finally {
    restore();
  }
});

test("live create e2e redacts status secrets and operator briefs", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse({
      model: {
        configured: false,
        status: "not_configured",
        api_key: "sk-live-secret",
        message: "生成应收风险 Skill failed with token=secret-token",
      },
    }),
  );
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      (error) => {
        assert.match(error.message, /model_not_configured/);
        assert.doesNotMatch(error.message, /sk-live-secret/);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.doesNotMatch(error.message, /生成应收风险/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live create e2e requires sandbox probe before Python draft generation", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: pathFromUrl(url) });
    if (pathFromUrl(url) === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true, status: "configured" } });
    }
    if (pathFromUrl(url) === "/api/admin/sandbox/probe") {
      return jsonResponse({
        status: "failed",
        writes_external_data: false,
        hardened_sandbox: false,
        network_isolated: false,
      });
    }
    throw new Error(`unexpected request: ${pathFromUrl(url)}`);
  });
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      /sandbox_probe_not_ready/,
    );
    assert.deepEqual(requests, [
      { method: "GET", url: "/api/admin/runtime/status" },
      { method: "POST", url: "/api/admin/sandbox/probe" },
    ]);
  } finally {
    restore();
  }
});

test("live create e2e generates skill prompt and python tool drafts with evidence", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true, status: "configured" } });
    }
    if (request.url === "/api/admin/sandbox/probe") {
      return jsonResponse(validSandboxProbe());
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "skill") {
      return jsonResponse(validSkillRun());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "prompt") {
      return jsonResponse(validPromptRun());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "python_tool") {
      return jsonResponse(validPythonToolRun());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const result = await runLiveCreateE2E(validOptions());

    assert.deepEqual(result, {
      skill: {
        run_id: "create_run_skill",
        status: "ready_for_review",
        skill_id: "finance/live-aging-risk",
        validation_valid: true,
        allowed_tool_count: 1,
        forbidden_tool_count: 1,
      },
      prompt: {
        run_id: "create_run_prompt",
        status: "ready_for_review",
        prompt_id: "finance/live-monthly-review",
        validation_valid: true,
      },
      python_tool: {
        run_id: "create_run_python",
        status: "ready_for_review",
        tool_id: "finance.live_overdue_ratio",
        validation_valid: true,
        sandbox_passed: true,
        preflight_policy: "ast_import_and_side_effect_preflight",
        timeout_seconds: 5,
        max_output_bytes: 8192,
        env_allowlist: ["PYTHONIOENCODING"],
        secret_boundary: "subprocess_env_allowlist",
      },
    });
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", "/api/admin/runtime/status"],
        ["POST", "/api/admin/sandbox/probe"],
        ["GET", "/api/session/current"],
        ["POST", "/api/create/drafts"],
        ["POST", "/api/create/drafts"],
        ["POST", "/api/create/drafts"],
      ],
    );
    assert.equal(requests[3].body.kind, "skill");
    assert.equal(requests[3].body.prompt, "生成应收风险 Skill");
    assert.equal(requests[4].body.kind, "prompt");
    assert.equal(requests[5].body.kind, "python_tool");
    for (const request of requests.slice(3)) {
      assert.equal(request.headers["X-Anna-Workspace-ID"], "demo");
      assert.equal(request.headers["X-Anna-User-ID"], "u_demo");
      assert.equal(request.body.workspace_id, "demo");
      assert.equal(request.body.actor_user_id, "u_demo");
    }
  } finally {
    restore();
  }
});

test("live create e2e requires skill validation and audit evidence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true } });
    }
    if (request.url === "/api/admin/sandbox/probe") {
      return jsonResponse(validSandboxProbe());
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "skill") {
      return jsonResponse({
        ...validSkillRun(),
        validation: { valid: false, errors: ["tool_not_registered"] },
        audit_events: [{ type: "model.call.completed", payload: {} }],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      /create_skill_(validation_failed|evidence_incomplete)/,
    );
  } finally {
    restore();
  }
});

test("live create e2e requires prompt validation and audit evidence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true } });
    }
    if (request.url === "/api/admin/sandbox/probe") {
      return jsonResponse(validSandboxProbe());
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "skill") {
      return jsonResponse(validSkillRun());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "prompt") {
      return jsonResponse({
        ...validPromptRun(),
        validation: { valid: true },
        audit_events: [{ type: "create.prompt.generated", payload: {} }],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      /create_prompt_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

test("live create e2e requires python fixture sandbox evidence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true } });
    }
    if (request.url === "/api/admin/sandbox/probe") {
      return jsonResponse(validSandboxProbe());
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "skill") {
      return jsonResponse(validSkillRun());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "prompt") {
      return jsonResponse(validPromptRun());
    }
    if (request.url === "/api/create/drafts" && request.body.kind === "python_tool") {
      return jsonResponse({
        ...validPythonToolRun(),
        sandbox_result: { passed: true },
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      /create_python_tool_sandbox_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

test("live create e2e redacts generated draft content from request failures", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse(
      {
        error_code: "create_generation_failed",
        message: "generated code print('ACME secret 12000')",
        artifact: {
          preview: "print('ACME secret 12000')",
        },
        sandbox_result: {
          stdout: "ACME secret 12000",
          stderr: "traceback with token=tool-secret",
        },
      },
      500,
    ),
  );
  try {
    await assert.rejects(
      runLiveCreateE2E(validOptions()),
      (error) => {
        assert.match(error.message, /request_failed: 500/);
        assert.match(error.message, /create_generation_failed/);
        assert.doesNotMatch(error.message, /ACME/);
        assert.doesNotMatch(error.message, /12000/);
        assert.doesNotMatch(error.message, /print/);
        assert.doesNotMatch(error.message, /tool-secret/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

function validOptions() {
  return {
    apiBase: "http://anna.test",
    skillBrief: "生成应收风险 Skill",
    promptBrief: "生成月度经营 Prompt",
    pythonToolBrief: "生成逾期比例 Python 工具",
    allowCreateDrafts: true,
  };
}

function validSession() {
  return {
    workspace_id: "demo",
    workspace_name: "Demo",
    user_id: "u_demo",
    user_display_name: "Demo User",
    source: "local-runtime",
  };
}

function validSkillRun() {
  return {
    id: "create_run_skill",
    workspace_id: "demo",
    actor_user_id: "u_demo",
    kind: "skill",
    status: "ready_for_review",
    artifact: {
      kind: "skill",
      skill_id: "finance/live-aging-risk",
      preview: "generated Skill content with business wording",
    },
    validation: {
      valid: true,
      loaded_skill_id: "finance/live-aging-risk",
      allowed_tools: ["erp.finance.query"],
      forbidden_tools: ["reimbursement.submit"],
      errors: [],
    },
    audit_events: [
      { type: "create.skill.run.created", payload: {} },
      { type: "model.call.started", payload: {} },
      { type: "model.call.completed", payload: {} },
      { type: "create.skill.generated", payload: {} },
      { type: "create.skill.validated", payload: { valid: true } },
    ],
  };
}

function validPromptRun() {
  return {
    id: "create_run_prompt",
    workspace_id: "demo",
    actor_user_id: "u_demo",
    kind: "prompt",
    status: "ready_for_review",
    artifact: {
      kind: "prompt",
      prompt_id: "finance/live-monthly-review",
      preview: "generated prompt body",
    },
    validation: { valid: true, errors: [] },
    audit_events: [
      { type: "create.prompt.run.created", payload: {} },
      { type: "model.call.started", payload: {} },
      { type: "model.call.completed", payload: {} },
      { type: "create.prompt.generated", payload: {} },
      { type: "create.prompt.validated", payload: { valid: true } },
    ],
  };
}

function validPythonToolRun() {
  return {
    id: "create_run_python",
    workspace_id: "demo",
    actor_user_id: "u_demo",
    kind: "python_tool",
    status: "ready_for_review",
    artifact: {
      kind: "python_tool",
      tool_id: "finance.live_overdue_ratio",
      preview: "print('generated code')",
    },
    validation: { valid: true, errors: [] },
    sandbox_result: {
      passed: true,
      stdout: "0.25",
      stderr: "",
      exit_code: 0,
      preflight_policy: "ast_import_and_side_effect_preflight",
      timeout_seconds: 5,
      max_output_bytes: 8192,
      env_allowlist: ["PYTHONIOENCODING"],
      secret_boundary: "subprocess_env_allowlist",
    },
    audit_events: [
      { type: "create.python_tool.run.created", payload: {} },
      { type: "model.call.started", payload: {} },
      { type: "model.call.completed", payload: {} },
      { type: "create.python_tool.generated", payload: {} },
      { type: "create.python_tool.fixture_ran", payload: { passed: true } },
    ],
  };
}

function validSandboxProbe() {
  return {
    status: "passed",
    writes_external_data: false,
    runner: "CreateToolSandbox",
    production_secrets_injected: false,
    preflight_policy: "ast_import_and_side_effect_preflight",
    timeout_enforced: true,
    output_limited: true,
    env_allowlist: ["PYTHONIOENCODING"],
    hardened_sandbox: false,
    network_isolated: false,
    checks: [
      { name: "python_fixture_execution", status: "passed" },
      { name: "production_secret_redaction", status: "passed" },
      { name: "filesystem_side_effect_preflight", status: "passed" },
      { name: "timeout_enforcement", status: "passed" },
      { name: "output_limit", status: "passed" },
      { name: "network_import_preflight", status: "passed" },
    ],
  };
}

function installFetchMock(handler) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => handler(url, init);
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function pathFromUrl(url) {
  return new URL(String(url)).pathname;
}
