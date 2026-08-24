import assert from "node:assert/strict";
import test from "node:test";

import { runLiveChatE2E } from "../../scripts/live-chat-e2e.mjs";

test("live chat e2e requires operator supplied message before API calls", async () => {
  const { requests, restore } = installFetchMock(async (url, init) => {
    requests.push({ method: init?.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ model: { configured: true } });
  });
  try {
    await assert.rejects(
      runLiveChatE2E({
        apiBase: "http://anna.test",
        templateId: "summarize",
      }),
      /live_chat_message_required/,
    );
    assert.deepEqual(requests, []);
  } finally {
    restore();
  }
});

test("live chat e2e rejects missing model configuration before creating a run", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    requests.push({ method: init.method ?? "GET", url: pathFromUrl(url) });
    return jsonResponse({ model: { configured: false, status: "not_configured" } });
  });
  try {
    await assert.rejects(
      runLiveChatE2E(validOptions()),
      /model_not_configured/,
    );
    assert.deepEqual(requests, [
      { method: "GET", url: "/api/admin/runtime/status" },
    ]);
  } finally {
    restore();
  }
});

test("live chat e2e redacts model status secrets and operator message", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse({
      model: {
        configured: false,
        status: "not_configured",
        api_key: "sk-live-secret",
        message: "请总结这段经营复盘纪要 failed with token=secret-token",
      },
    }),
  );
  try {
    await assert.rejects(
      runLiveChatE2E(validOptions()),
      (error) => {
        assert.match(error.message, /model_not_configured/);
        assert.doesNotMatch(error.message, /sk-live-secret/);
        assert.doesNotMatch(error.message, /secret-token/);
        assert.doesNotMatch(error.message, /经营复盘/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("live chat e2e requires the selected template to exist", async () => {
  const { requests, restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      headers: init.headers ?? {},
    };
    requests.push(request);
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true, status: "configured" } });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/chat/prompt-templates") {
      return jsonResponse({ templates: [{ id: "summarize", label: "总结" }] });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveChatE2E({
        ...validOptions(),
        templateId: "missing_template",
      }),
      /chat_template_not_available/,
    );
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", "/api/admin/runtime/status"],
        ["GET", "/api/session/current"],
        ["GET", "/api/chat/prompt-templates"],
      ],
    );
  } finally {
    restore();
  }
});

test("live chat e2e creates run with skill and zero tool-call audit evidence", async () => {
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
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/chat/prompt-templates") {
      return jsonResponse({
        templates: [
          { id: "summarize", label: "总结" },
          { id: "associate_goal", label: "转为 Associate 目标" },
        ],
      });
    }
    if (request.url === "/api/chat/runs") {
      return jsonResponse(validChatRun());
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    const result = await runLiveChatE2E(validOptions());

    assert.deepEqual(result, {
      run_id: "chat_run_001",
      status: "ready",
      template_id: "summarize",
      assistant_message_length: 8,
      associate_goal_available: false,
      saved_memory_id: null,
      audit_event_types: [
        "chat.response.generated",
        "chat.run.created",
        "model.call.completed",
        "model.call.started",
        "skill.loaded",
      ],
      audit_tool_call_count: 0,
      audit_skill_id_present: true,
    });
    assert.deepEqual(
      requests.map((request) => [request.method, request.url]),
      [
        ["GET", "/api/admin/runtime/status"],
        ["GET", "/api/session/current"],
        ["GET", "/api/chat/prompt-templates"],
        ["POST", "/api/chat/runs"],
      ],
    );
    assert.equal(requests[3].headers["X-Anna-Workspace-ID"], "demo");
    assert.equal(requests[3].headers["X-Anna-User-ID"], "u_demo");
    assert.equal(requests[3].body.workspace_id, "demo");
    assert.equal(requests[3].body.actor_user_id, "u_demo");
    assert.equal(requests[3].body.message, "请总结这段经营复盘纪要");
    assert.equal(requests[3].body.template_id, "summarize");
    assert.ok(
      requests.every((request) => !request.url.includes("/save")),
      "runner must not save chat result",
    );
  } finally {
    restore();
  }
});

test("live chat e2e requires complete chat audit evidence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true } });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/chat/prompt-templates") {
      return jsonResponse({ templates: [{ id: "summarize", label: "总结" }] });
    }
    if (request.url === "/api/chat/runs") {
      return jsonResponse({
        ...validChatRun(),
        audit_events: [{ type: "skill.loaded", payload: {} }],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveChatE2E(validOptions()),
      /chat_audit_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

test("live chat e2e requires loaded skill identity evidence", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true } });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/chat/prompt-templates") {
      return jsonResponse({ templates: [{ id: "summarize", label: "总结" }] });
    }
    if (request.url === "/api/chat/runs") {
      return jsonResponse({
        ...validChatRun(),
        audit_events: [
          { type: "chat.run.created", payload: {} },
          { type: "skill.loaded", payload: {} },
          { type: "model.call.started", payload: { tool_names: [] } },
          { type: "model.call.completed", payload: { tool_call_count: 0 } },
          { type: "chat.response.generated", payload: {} },
        ],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveChatE2E(validOptions()),
      /chat_audit_evidence_incomplete/,
    );
  } finally {
    restore();
  }
});

test("live chat e2e fails if model emitted tool calls", async () => {
  const { restore } = installFetchMock(async (url, init = {}) => {
    const request = {
      method: init.method ?? "GET",
      url: pathFromUrl(url),
      body: init.body ? JSON.parse(init.body) : null,
    };
    if (request.url === "/api/admin/runtime/status") {
      return jsonResponse({ model: { configured: true } });
    }
    if (request.url === "/api/session/current") {
      return jsonResponse(validSession());
    }
    if (request.url === "/api/chat/prompt-templates") {
      return jsonResponse({ templates: [{ id: "summarize", label: "总结" }] });
    }
    if (request.url === "/api/chat/runs") {
      return jsonResponse({
        ...validChatRun(),
        audit_events: [
          { type: "chat.run.created", payload: {} },
          { type: "skill.loaded", payload: {} },
          { type: "model.call.started", payload: { tool_names: [] } },
          { type: "model.call.completed", payload: { tool_call_count: 1 } },
          { type: "chat.response.generated", payload: {} },
        ],
      });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  });
  try {
    await assert.rejects(
      runLiveChatE2E(validOptions()),
      /chat_model_tool_calls_detected/,
    );
  } finally {
    restore();
  }
});

test("live chat e2e redacts generated assistant content from request failures", async () => {
  const { restore } = installFetchMock(async () =>
    jsonResponse(
      {
        error_code: "chat_generation_failed",
        message: "assistant replied: ACME has confidential 12000 revenue",
        assistant_message: "ACME has confidential 12000 revenue",
      },
      500,
    ),
  );
  try {
    await assert.rejects(
      runLiveChatE2E(validOptions()),
      (error) => {
        assert.match(error.message, /request_failed: 500/);
        assert.match(error.message, /chat_generation_failed/);
        assert.doesNotMatch(error.message, /ACME/);
        assert.doesNotMatch(error.message, /12000/);
        assert.doesNotMatch(error.message, /revenue/);
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
    message: "请总结这段经营复盘纪要",
    templateId: "summarize",
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

function validChatRun() {
  return {
    id: "chat_run_001",
    workspace_id: "demo",
    actor_user_id: "u_demo",
    message: "请总结这段经营复盘纪要",
    template_id: "summarize",
    status: "ready",
    assistant_message: "模型已生成摘要。",
    saved_memory_id: null,
    associate_goal_text: null,
    audit_events: [
      { type: "chat.run.created", payload: {} },
      { type: "skill.loaded", payload: { skill_id: "chat/general-assistant" } },
      {
        type: "model.call.started",
        payload: { tool_names: ["chat.emit_document", "plan.update"] },
      },
      { type: "model.call.completed", payload: { tool_call_count: 0 } },
      { type: "chat.response.generated", payload: {} },
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
