import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runLiveReimbursementE2E } from "../../scripts/live-reimbursement-e2e.mjs";

test("live reimbursement e2e refuses to write without explicit approval flag", async () => {
  const { requests, restore } = installFetchMock(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: pathFromUrl(url) });
    assert.equal(pathFromUrl(url), "/api/admin/runtime/validate");
    return jsonResponse({ status: "ready", writes_external_data: false });
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: false,
      }),
      /external_writes_not_enabled/,
    );
    assert.deepEqual(requests, [
      { method: "POST", url: "/api/admin/runtime/validate" },
    ]);
  } finally {
    restore();
  }
});

test("live reimbursement e2e discovers packaged desktop API base from runtime info", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "anna-live-runtime-info-"));
  const runtimeInfoPath = join(tempDir, "runtime-info.json");
  writeFileSync(
    runtimeInfoPath,
    JSON.stringify({ apiBase: "http://anna-runtime.test" }),
  );
  const originalApiBase = process.env.ANNA_API_BASE;
  delete process.env.ANNA_API_BASE;
  const requests = [];
  const { restore } = installFetchMock(async (url, init) => {
    requests.push({
      method: init?.method ?? "GET",
      origin: new URL(String(url)).origin,
      url: pathFromUrl(url),
    });
    return jsonResponse({ status: "ready", writes_external_data: false });
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        runtimeInfoPath,
        inputText: "真实报销验证请求",
        allowExternalWrites: false,
      }),
      /external_writes_not_enabled/,
    );
    assert.deepEqual(requests, [
      {
        method: "POST",
        origin: "http://anna-runtime.test",
        url: "/api/admin/runtime/validate",
      },
    ]);
  } finally {
    if (originalApiBase === undefined) {
      delete process.env.ANNA_API_BASE;
    } else {
      process.env.ANNA_API_BASE = originalApiBase;
    }
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("live reimbursement e2e approves and reports completed run through Anna API", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({
        status: "ready",
        writes_external_data: false,
      });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse({
        workspace_id: "demo",
        workspace_name: "Demo",
        user_id: "u_demo",
        user_display_name: "Demo User",
        source: "local-runtime",
      });
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: { external_reimbursement_id: "EXT-DRAFT-001" },
        missing_fields: [],
        approval: { id: "approval_001" },
      });
    }
    if (request.url === "/api/cowork/reimbursements/approvals/approval_001/approve") {
      return jsonResponse({
        id: "run_001",
        status: "completed",
        draft: {
          external_reimbursement_id: "EXT-001",
          external_status: "submitted",
        },
        missing_fields: [],
        approval: { id: "approval_001" },
        write_action: { id: "write_001", verify_status: "verified" },
      });
    }
    if (request.url === "/api/admin/audit/reimbursement/runs/run_001") {
      return jsonResponse(validAudit());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const result = await runLiveReimbursementE2E({
      apiBase: "http://anna.test",
      inputText: "真实报销验证请求",
      allowExternalWrites: true,
    });

    assert.deepEqual(result, {
      status: "completed",
      run_id: "run_001",
      approval_id: "approval_001",
      write_action_id: "write_001",
      external_reimbursement_id: "EXT-001",
      external_status: "submitted",
      verify_status: "verified",
    });
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/reimbursements/runs"],
        ["POST", "/api/cowork/reimbursements/approvals/approval_001/approve"],
        ["GET", "/api/admin/audit/reimbursement/runs/run_001"],
      ],
    );
    assert.equal(
      requests[2].body.input_text,
      "真实报销验证请求",
    );
    assert.equal(requests[2].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[2].headers["X-Anna-User-ID"], "u_demo");
    assert.equal(requests[3].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[3].headers["X-Anna-User-ID"], "u_demo");
    assert.equal(requests[3].body.approved_by, "u_demo");
  } finally {
    restore();
  }
});

test("live reimbursement e2e requires audit proof of agent and MCP sequence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
    };
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: { external_reimbursement_id: "EXT-DRAFT-001" },
        missing_fields: [],
        approval: { id: "approval_001" },
      });
    }
    if (request.url === "/api/cowork/reimbursements/approvals/approval_001/approve") {
      return jsonResponse({
        id: "run_001",
        status: "completed",
        draft: {
          external_reimbursement_id: "EXT-001",
          external_status: "submitted",
        },
        missing_fields: [],
        approval: { id: "approval_001" },
        write_action: { id: "write_001", verify_status: "verified" },
      });
    }
    if (request.url === "/api/admin/audit/reimbursement/runs/run_001") {
      return jsonResponse({
        run_id: "run_001",
        status: "completed",
        audit_events: [
          { type: "skill.loaded", payload: {} },
          { type: "mcp.tool.called", payload: { tool_name: "reimbursement.submit" } },
        ],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      /audit_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e redacts structured secrets from runtime validation errors", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse({
      status: "failed",
      model: {
        api_key: "sk-live-secret",
        endpoint: "https://model.example.test",
      },
      reimbursement_mcp: {
        token: "mcp-token-secret",
        accessToken: "access-token-secret",
        clientSecret: "client-secret-value",
        message: "Authorization: Bearer bearer-secret https://user:pass-secret@example.test",
      },
    }),
  );
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      (error) => {
        assert.match(error.message, /runtime_not_ready/);
        assert.doesNotMatch(error.message, /sk-live-secret/);
        assert.doesNotMatch(error.message, /mcp-token-secret/);
        assert.doesNotMatch(error.message, /access-token-secret/);
        assert.doesNotMatch(error.message, /client-secret-value/);
        assert.doesNotMatch(error.message, /bearer-secret/);
        assert.doesNotMatch(error.message, /pass-secret/);
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e redacts request failure bodies before surfacing errors", async () => {
  const { restore } = installFetchMock(async () =>
    textResponse(
      '{"error":"bad","api_key":"sk-live-secret","message":"token=mcp-token-secret"}',
      500,
    ),
  );
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      (error) => {
        assert.match(error.message, /request_failed: 500/);
        assert.doesNotMatch(error.message, /sk-live-secret/);
        assert.doesNotMatch(error.message, /mcp-token-secret/);
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e redacts colon-delimited plaintext failure secrets", async () => {
  const { restore } = installFetchMock(async () =>
    textResponse(
      "html error api_key: sk-live-secret token: mcp-token-secret clientSecret: client-secret-value Authorization: Bearer bearer-secret",
      502,
    ),
  );
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      (error) => {
        assert.match(error.message, /request_failed: 502/);
        assert.doesNotMatch(error.message, /sk-live-secret/);
        assert.doesNotMatch(error.message, /mcp-token-secret/);
        assert.doesNotMatch(error.message, /client-secret-value/);
        assert.doesNotMatch(error.message, /bearer-secret/);
        assert.match(error.message, /\[redacted\]/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e rejects runtime validation that writes external data", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ status: "ready", writes_external_data: true });
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      /runtime_validation_not_read_only/,
    );
    assert.deepEqual(requests, [
      { method: "POST", url: "/api/admin/runtime/validate" },
    ]);
  } finally {
    restore();
  }
});

test("live reimbursement e2e rejects malformed session identity before creating a run", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse({ workspace_id: "", user_id: null });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      /session_identity_invalid/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
      ],
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e trims session identity before headers and request body", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse({ workspace_id: " demo ", user_id: " u_demo " });
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: { external_reimbursement_id: "EXT-DRAFT-001" },
        missing_fields: [],
        approval: { id: "approval_001" },
      });
    }
    if (request.url === "/api/cowork/reimbursements/approvals/approval_001/approve") {
      return jsonResponse({
        id: "run_001",
        status: "completed",
        draft: {
          external_reimbursement_id: "EXT-001",
          external_status: "submitted",
        },
        missing_fields: [],
        approval: { id: "approval_001" },
        write_action: { id: "write_001", verify_status: "verified" },
      });
    }
    if (request.url === "/api/admin/audit/reimbursement/runs/run_001") {
      return jsonResponse(validAudit());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await runLiveReimbursementE2E({
      apiBase: "http://anna.test",
      inputText: "真实报销验证请求",
      allowExternalWrites: true,
    });

    assert.equal(requests[2].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[2].headers["X-Anna-User-ID"], "u_demo");
    assert.equal(requests[2].body.workspace_id, "demo");
    assert.equal(requests[2].body.actor_user_id, "u_demo");
    assert.equal(requests[3].body.approved_by, "u_demo");
  } finally {
    restore();
  }
});

test("live reimbursement e2e rejects session identity with control characters", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse({ workspace_id: "demo\nx", user_id: "u_demo" });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      /session_identity_invalid/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
      ],
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e stops before approval when missing fields have no answers", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "collecting",
        missing_fields: ["department_id", "api_key", "clientSecret"],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      (error) => {
        assert.match(error.message, /missing_fields_required/);
        assert.match(error.message, /department_id/);
        assert.doesNotMatch(error.message, /api_key/);
        assert.doesNotMatch(error.message, /clientSecret/);
        return true;
      },
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/reimbursements/runs"],
      ],
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e answers missing fields with session headers before approval", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "collecting",
        missing_fields: ["department_id"],
      });
    }
    if (request.url === "/api/cowork/reimbursements/runs/run_001/answers") {
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: { external_reimbursement_id: "EXT-DRAFT-001" },
        missing_fields: [],
        approval: { id: "approval_001" },
      });
    }
    if (request.url === "/api/cowork/reimbursements/approvals/approval_001/approve") {
      return jsonResponse({
        id: "run_001",
        status: "completed",
        draft: {
          external_reimbursement_id: "EXT-001",
          external_status: "submitted",
        },
        missing_fields: [],
        approval: { id: "approval_001" },
        write_action: { id: "write_001", verify_status: "verified" },
      });
    }
    if (request.url === "/api/admin/audit/reimbursement/runs/run_001") {
      return jsonResponse(validAudit());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await runLiveReimbursementE2E({
      apiBase: "http://anna.test",
      inputText: "真实报销验证请求",
      allowExternalWrites: true,
      answers: { department_id: "sales" },
    });

    assert.equal(requests[3].body.answers.department_id, "sales");
    assert.equal(requests[3].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[3].headers["X-Anna-User-ID"], "u_demo");
    assert.equal(requests[4].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[4].headers["X-Anna-User-ID"], "u_demo");
  } finally {
    restore();
  }
});

test("live reimbursement e2e refuses approval when answers response still has missing fields", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "collecting",
        missing_fields: ["department_id"],
      });
    }
    if (request.url === "/api/cowork/reimbursements/runs/run_001/answers") {
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: { external_reimbursement_id: "EXT-DRAFT-001" },
        missing_fields: ["cost_center_id"],
        approval: { id: "approval_001" },
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
        answers: { department_id: "sales" },
      }),
      /missing_fields_still_required/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/reimbursements/runs"],
        ["POST", "/api/cowork/reimbursements/runs/run_001/answers"],
      ],
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e imports local attachment files before answering missing fields", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "anna-live-attachments-"));
  const attachmentPath = join(tempDir, "receipt.pdf");
  writeFileSync(attachmentPath, "receipt-bytes");
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      headers: init.headers ?? {},
      body: parseMaybeJsonBody(init.body),
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/attachments") {
      assert.equal(request.headers["X-Anna-Attachment-Name"], "receipt.pdf");
      assert.equal(request.headers["X-Anna-Workspace-ID"], "demo");
      assert.equal(request.headers["X-Anna-User-ID"], "u_demo");
      assert.equal(Buffer.from(init.body).toString("utf8"), "receipt-bytes");
      return jsonResponse({
        name: "receipt.pdf",
        uri: `anna://attachment/${"a".repeat(64)}/receipt.pdf`,
        size_bytes: 13,
        sha256: "a".repeat(64),
      });
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "collecting",
        missing_fields: ["attachments"],
      });
    }
    if (request.url === "/api/cowork/reimbursements/runs/run_001/answers") {
      assert.deepEqual(request.body.answers.attachments, [
        {
          name: "receipt.pdf",
          uri: `anna://attachment/${"a".repeat(64)}/receipt.pdf`,
          size_bytes: 13,
          sha256: "a".repeat(64),
        },
      ]);
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: {
          external_reimbursement_id: "EXT-DRAFT-001",
          attachments: request.body.answers.attachments,
        },
        missing_fields: [],
        approval: { id: "approval_001" },
      });
    }
    if (request.url === "/api/cowork/reimbursements/approvals/approval_001/approve") {
      return jsonResponse({
        id: "run_001",
        status: "completed",
        draft: {
          external_reimbursement_id: "EXT-001",
          external_status: "submitted",
          attachments: [
            {
              name: "receipt.pdf",
              uri: `anna://attachment/${"a".repeat(64)}/receipt.pdf`,
            },
          ],
        },
        missing_fields: [],
        approval: { id: "approval_001" },
        write_action: { id: "write_001", verify_status: "verified" },
      });
    }
    if (request.url === "/api/admin/audit/reimbursement/runs/run_001") {
      return jsonResponse(validAudit());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await runLiveReimbursementE2E({
      apiBase: "http://anna.test",
      inputText: "真实报销验证请求",
      allowExternalWrites: true,
      attachmentPaths: [attachmentPath],
    });

    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/reimbursements/attachments"],
        ["POST", "/api/cowork/reimbursements/runs"],
        ["POST", "/api/cowork/reimbursements/runs/run_001/answers"],
        ["POST", "/api/cowork/reimbursements/approvals/approval_001/approve"],
        ["GET", "/api/admin/audit/reimbursement/runs/run_001"],
      ],
    );
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("live reimbursement e2e rejects unreadable attachment paths before creating a run", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
        attachmentPaths: ["/tmp/does-not-exist-receipt.pdf"],
      }),
      /attachment_file_unreadable/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
      ],
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e prevalidates all attachment files before uploading any", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "anna-live-attachments-"));
  const attachmentPath = join(tempDir, "receipt.pdf");
  writeFileSync(attachmentPath, "receipt-bytes");
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
        attachmentPaths: [attachmentPath, join(tempDir, "missing.pdf")],
      }),
      /attachment_file_unreadable: attachment 2/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
      ],
    );
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("live reimbursement e2e does not print sensitive unreadable attachment names", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
        attachmentPaths: ["/tmp/client_secret=abc123.pdf"],
      }),
      (error) => {
        assert.match(error.message, /attachment_file_unreadable: attachment 1/);
        assert.doesNotMatch(error.message, /client_secret/);
        assert.doesNotMatch(error.message, /abc123/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e rejects malformed attachment import responses before creating a run", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "anna-live-attachments-"));
  const attachmentPath = join(tempDir, "receipt.pdf");
  writeFileSync(attachmentPath, "receipt-bytes");
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    requests.push(request);
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/attachments") {
      return jsonResponse({ name: "receipt.pdf", uri: "file:///tmp/receipt.pdf" });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
        attachmentPaths: [attachmentPath],
      }),
      /attachment_import_invalid/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/reimbursements/attachments"],
      ],
    );
  } finally {
    restore();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("live reimbursement e2e requires external write evidence after approval", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
    };
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({ status: "ready", writes_external_data: false });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/reimbursements/runs") {
      return jsonResponse({
        id: "run_001",
        status: "waiting_confirmation",
        draft: { external_reimbursement_id: "EXT-DRAFT-001" },
        missing_fields: [],
        approval: { id: "approval_001" },
      });
    }
    if (request.url === "/api/cowork/reimbursements/approvals/approval_001/approve") {
      return jsonResponse({
        id: "run_001",
        status: "completed",
        draft: {},
        missing_fields: [],
        approval: { id: "approval_001" },
        write_action: null,
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveReimbursementE2E({
        apiBase: "http://anna.test",
        inputText: "真实报销验证请求",
        allowExternalWrites: true,
      }),
      /submit_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

test("live reimbursement e2e requires operator supplied input text", async () => {
  await assert.rejects(
    runLiveReimbursementE2E({
      apiBase: "http://127.0.0.1:1",
      inputText: "",
      allowExternalWrites: true,
    }),
    /live_input_required/,
  );
});

function installFetchMock(handler) {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = handler;
  return {
    requests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
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

function validAudit() {
  return {
    run_id: "run_001",
    status: "completed",
    audit_events: [
      { type: "skill.loaded", payload: {} },
      { type: "model.call.started", payload: {} },
      { type: "model.call.completed", payload: {} },
      {
        type: "mcp.tool.called",
        payload: { tool_name: "reimbursement.validate_draft", status: "success" },
      },
      {
        type: "mcp.tool.called",
        payload: { tool_name: "reimbursement.create_draft", status: "success" },
      },
      {
        type: "mcp.tool.called",
        payload: { tool_name: "reimbursement.submit", status: "success" },
      },
      {
        type: "mcp.tool.called",
        payload: { tool_name: "reimbursement.get_status", status: "success" },
      },
      { type: "approval.approved", payload: {} },
      { type: "reimbursement.submitted", payload: {} },
      { type: "reimbursement.verified", payload: {} },
    ],
  };
}

function parseMaybeJsonBody(body) {
  if (!body || typeof body !== "string") {
    return null;
  }
  return JSON.parse(body);
}

function pathFromUrl(url) {
  return new URL(String(url)).pathname;
}
