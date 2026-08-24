import assert from "node:assert/strict";
import test from "node:test";

import { runLiveAssociateE2E } from "../../scripts/live-associate-e2e.mjs";

test("live associate e2e requires operator supplied period before API calls", async () => {
  const { requests, restore } = installFetchMock(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ status: "ready", writes_external_data: false });
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        goalText: "把逾期 30 天以上应收金额降低 20%",
        allowExternalWrites: true,
      }),
      /live_associate_period_required/,
    );
    assert.deepEqual(requests, []);
  } finally {
    restore();
  }
});

test("live associate e2e requires operator supplied goal before API calls", async () => {
  const { requests, restore } = installFetchMock(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ status: "ready", writes_external_data: false });
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        allowExternalWrites: true,
      }),
      /live_associate_goal_required/,
    );
    assert.deepEqual(requests, []);
  } finally {
    restore();
  }
});

test("live associate e2e rejects runtime validation that writes external data", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ status: "ready", writes_external_data: true });
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
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

test("live associate e2e refuses to write without explicit approval flag", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({
      status: "ready",
      writes_external_data: false,
      erp_mcp_associate_execution_readiness: { status: "passed" },
    });
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
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

test("live associate e2e redacts runtime validation secrets and operator goal", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse({
      status: "blocked",
      message: "goal 把逾期 30 天以上应收金额降低 20% cannot run for ACME 12000",
      model: { api_key: "sk-live-secret" },
      erp_mcp: {
        token: "erp-token-secret",
        message: "Authorization: Bearer bearer-secret https://user:pass-secret@example.test",
      },
    }),
  );
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
        allowExternalWrites: true,
      }),
      (error) => {
        assert.match(error.message, /runtime_not_ready/);
        assert.doesNotMatch(error.message, /sk-live-secret/);
        assert.doesNotMatch(error.message, /erp-token-secret/);
        assert.doesNotMatch(error.message, /bearer-secret/);
        assert.doesNotMatch(error.message, /pass-secret/);
        assert.doesNotMatch(error.message, /把逾期/);
        assert.doesNotMatch(error.message, /ACME/);
        assert.doesNotMatch(error.message, /12000/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live associate e2e does not print raw receivables or customer data from request failures", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse(
      {
        error_code: "associate_execution_failed",
        message: "connector failed",
        plan: {
          nodes: [
            {
              title: "联系 ACME 财务",
              write_intent: {
                payload: { customer: "ACME", amount: 12000 },
              },
            },
          ],
        },
      },
      500,
    ),
  );
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
        allowExternalWrites: true,
      }),
      (error) => {
        assert.match(error.message, /request_failed: 500/);
        assert.match(error.message, /associate_execution_failed/);
        assert.doesNotMatch(error.message, /ACME/);
        assert.doesNotMatch(error.message, /12000/);
        assert.doesNotMatch(error.message, /联系/);
        assert.doesNotMatch(error.message, /write_intent/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live associate e2e approves node and requires ERP readback verification", async () => {
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
        erp_mcp_associate_execution_readiness: {
          status: "passed",
          tool_names: [
            "erp.collection_task.create_draft",
            "erp.collection_task.get_status",
          ],
        },
      });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs") {
      return jsonResponse({
        id: "associate_run_001",
        workspace_id: "demo",
        actor_user_id: "u_demo",
        period: "2026-06",
        goal_text: "把逾期 30 天以上应收金额降低 20%",
        status: "ready",
        plan: {
          goal: "把逾期 30 天以上应收金额降低 20%",
          summary: "优先处理大额逾期客户。",
          nodes: [writeIntentNode()],
        },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n1/approval"
    ) {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "把逾期 30 天以上应收金额降低 20%",
          summary: "优先处理大额逾期客户。",
          nodes: [
            {
              ...writeIntentNode(),
              approval: { id: "associate_approval_001", status: "pending" },
            },
          ],
        },
        audit_events: [
          ...validPlanningAudit(),
          { type: "associate.node.approval.requested", payload: {} },
        ],
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/approvals/associate_approval_001/approve"
    ) {
      return jsonResponse(verifiedAssociateRun());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs/associate_run_001") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "把逾期 30 天以上应收金额降低 20%",
          summary: "优先处理大额逾期客户。",
          nodes: [
            {
              ...writeIntentNode(),
              status: "completed",
              approval: { id: "associate_approval_001", status: "approved" },
              write_action: {
                id: "associate_write_001",
                status: "success",
                verify_status: "verified",
                external_task_id: "collection-task-api-001",
                external_status: "draft_created",
              },
            },
          ],
        },
        audit_events: validExecutionAudit(),
      });
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs/associate_run_001") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "把逾期 30 天以上应收金额降低 20%",
          summary: "优先处理大额逾期客户。",
          nodes: [
            {
              ...writeIntentNode(),
              status: "completed",
              approval: { id: "associate_approval_001", status: "approved" },
              write_action: {
                id: "associate_write_001",
                status: "success",
                verify_status: "verified",
                external_task_id: "collection-task-api-001",
                external_status: "draft_created",
              },
            },
          ],
        },
        audit_events: validExecutionAudit(),
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const result = await runLiveAssociateE2E({
      apiBase: "http://anna.test",
      period: "2026-06",
      goalText: "把逾期 30 天以上应收金额降低 20%",
      allowExternalWrites: true,
    });

    assert.deepEqual(result, {
      run_id: "associate_run_001",
      node_id: "n1",
      approval_id: "associate_approval_001",
      write_action_id: "associate_write_001",
      status: "completed",
      verify_status: "verified",
      external_task_id: "collection-task-api-001",
      external_status: "draft_created",
    });
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/associate/receivables-recovery/runs"],
        [
          "POST",
          "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n1/approval",
        ],
        [
          "POST",
          "/api/cowork/associate/receivables-recovery/approvals/associate_approval_001/approve",
        ],
        ["GET", "/api/cowork/associate/receivables-recovery/runs/associate_run_001"],
      ],
    );
    assert.equal(requests[2].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[2].headers["X-Anna-User-ID"], "u_demo");
    assert.equal(requests[2].body.period, "2026-06");
    assert.equal(requests[2].body.goal_text, "把逾期 30 天以上应收金额降低 20%");
    assert.equal(requests[3].body.requested_by, "u_demo");
    assert.equal(requests[4].body.approved_by, "u_demo");
  } finally {
    restore();
  }
});

test("live associate e2e requires explicit node id when multiple write-intent nodes exist", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({
        status: "ready",
        writes_external_data: false,
        erp_mcp_associate_execution_readiness: { status: "passed" },
      });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            writeIntentNode(),
            { ...writeIntentNode(), id: "n2", title: "生成第二个任务草案" },
          ],
        },
        audit_events: validPlanningAudit(),
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
        allowExternalWrites: true,
      }),
      /associate_node_id_required/,
    );
  } finally {
    restore();
  }
});

test("live associate e2e can select an explicit write-intent node id", async () => {
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
        erp_mcp_associate_execution_readiness: { status: "passed" },
      });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            writeIntentNode(),
            { ...writeIntentNode(), id: "n2", title: "生成第二个任务草案" },
          ],
        },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n2/approval"
    ) {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            writeIntentNode(),
            {
              ...writeIntentNode(),
              id: "n2",
              approval: { id: "associate_approval_002", status: "pending" },
            },
          ],
        },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/approvals/associate_approval_002/approve"
    ) {
      return jsonResponse(verifiedAssociateRun("n2", "associate_approval_002"));
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs/associate_run_001") {
      return jsonResponse(verifiedAssociateRun("n2", "associate_approval_002"));
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const result = await runLiveAssociateE2E({
      apiBase: "http://anna.test",
      period: "2026-06",
      goalText: "把逾期 30 天以上应收金额降低 20%",
      allowExternalWrites: true,
      nodeId: "n2",
    });

    assert.equal(result.node_id, "n2");
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["POST", "/api/admin/runtime/validate"],
        ["GET", "/api/session/current"],
        ["POST", "/api/cowork/associate/receivables-recovery/runs"],
        [
          "POST",
          "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n2/approval",
        ],
        [
          "POST",
          "/api/cowork/associate/receivables-recovery/approvals/associate_approval_002/approve",
        ],
        ["GET", "/api/cowork/associate/receivables-recovery/runs/associate_run_001"],
      ],
    );
  } finally {
    restore();
  }
});

test("live associate e2e fails when approval result is still waiting for readback", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({
        status: "ready",
        writes_external_data: false,
        erp_mcp_associate_execution_readiness: { status: "passed" },
      });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: { goal: "g", summary: "s", nodes: [writeIntentNode()] },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n1/approval"
    ) {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            {
              ...writeIntentNode(),
              approval: { id: "associate_approval_001", status: "pending" },
            },
          ],
        },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/approvals/associate_approval_001/approve"
    ) {
      return jsonResponse(verifiedAssociateRun());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs/associate_run_001") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            {
              ...writeIntentNode(),
              status: "verify_pending",
              approval: { id: "associate_approval_001", status: "approved" },
              write_action: {
                id: "associate_write_001",
                status: "success",
                verify_status: "verify_pending",
                external_task_id: "collection-task-api-001",
                external_status: "draft_created",
              },
            },
          ],
        },
        audit_events: [
          ...validPlanningAudit(),
          { type: "associate.node.verify_pending", payload: {} },
        ],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
        allowExternalWrites: true,
      }),
      /associate_readback_not_verified/,
    );
  } finally {
    restore();
  }
});

test("live associate e2e requires complete audit evidence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = { method: init.method ?? "GET", url: pathFromUrl(url) };
    if (request.url === "/api/admin/runtime/validate") {
      return jsonResponse({
        status: "ready",
        writes_external_data: false,
        erp_mcp_associate_execution_readiness: { status: "passed" },
      });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: { goal: "g", summary: "s", nodes: [writeIntentNode()] },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/runs/associate_run_001/nodes/n1/approval"
    ) {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            {
              ...writeIntentNode(),
              approval: { id: "associate_approval_001", status: "pending" },
            },
          ],
        },
        audit_events: validPlanningAudit(),
      });
    }
    if (
      request.url ===
      "/api/cowork/associate/receivables-recovery/approvals/associate_approval_001/approve"
    ) {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            {
              ...writeIntentNode(),
              status: "completed",
              approval: { id: "associate_approval_001", status: "approved" },
              write_action: {
                id: "associate_write_001",
                status: "success",
                verify_status: "verified",
                external_task_id: "collection-task-api-001",
                external_status: "draft_created",
              },
            },
          ],
        },
        audit_events: [{ type: "skill.loaded", payload: {} }],
      });
    }
    if (request.url === "/api/cowork/associate/receivables-recovery/runs/associate_run_001") {
      return jsonResponse({
        id: "associate_run_001",
        status: "ready",
        plan: {
          goal: "g",
          summary: "s",
          nodes: [
            {
              ...writeIntentNode(),
              status: "completed",
              approval: { id: "associate_approval_001", status: "approved" },
              write_action: {
                id: "associate_write_001",
                status: "success",
                verify_status: "verified",
                external_task_id: "collection-task-api-001",
                external_status: "draft_created",
              },
            },
          ],
        },
        audit_events: [{ type: "skill.loaded", payload: {} }],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveAssociateE2E({
        apiBase: "http://anna.test",
        period: "2026-06",
        goalText: "把逾期 30 天以上应收金额降低 20%",
        allowExternalWrites: true,
      }),
      /associate_audit_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

function validSession() {
  return {
    workspace_id: "demo",
    workspace_name: "Demo",
    user_id: "u_demo",
    user_display_name: "Demo User",
    source: "local-runtime",
  };
}

function writeIntentNode() {
  return {
    id: "n1",
    title: "生成客户跟进任务草案",
    status: "blocked",
    owner: "finance_user",
    depends_on: [],
    evidence: ["erp.finance.get_receivables_aging"],
    blocker: "需要审批后执行",
    write_intent: {
      action_type: "erp.collection_task.create_draft",
      risk_level: "medium",
      summary: "为高风险逾期客户创建催收跟进任务草案。",
    },
  };
}

function validPlanningAudit() {
  return [
    { type: "skill.loaded", payload: {} },
    { type: "model.call.started", payload: {} },
    { type: "model.call.completed", payload: {} },
    {
      type: "mcp.tool.called",
      payload: { tool_name: "erp.finance.get_receivables_aging", status: "success" },
    },
    { type: "associate.plan.emitted", payload: {} },
  ];
}

function validExecutionAudit() {
  return [
    ...validPlanningAudit(),
    { type: "associate.node.approval.requested", payload: {} },
    { type: "associate.node.approval.approved", payload: {} },
    {
      type: "mcp.tool.called",
      payload: { tool_name: "erp.collection_task.create_draft", status: "success" },
    },
    {
      type: "mcp.tool.called",
      payload: { tool_name: "erp.collection_task.get_status", status: "success" },
    },
    { type: "associate.node.verified", payload: {} },
  ];
}

function verifiedAssociateRun(nodeId = "n1", approvalId = "associate_approval_001") {
  return {
    id: "associate_run_001",
    status: "ready",
    plan: {
      goal: "g",
      summary: "s",
      nodes: [
        {
          ...writeIntentNode(),
          id: nodeId,
          status: "completed",
          approval: { id: approvalId, status: "approved" },
          write_action: {
            id: "associate_write_001",
            status: "success",
            verify_status: "verified",
            external_task_id: "collection-task-api-001",
            external_status: "draft_created",
          },
        },
      ],
    },
    audit_events: validExecutionAudit(),
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
