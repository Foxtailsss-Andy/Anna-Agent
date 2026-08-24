import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { startHarnessService } from "../src/index";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));

async function servicePackageVersion(): Promise<string> {
  const manifest: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    typeof (manifest as { version?: unknown }).version !== "string"
  ) {
    throw new Error("Harness service package version must be a string");
  }

  return (manifest as { version: string }).version;
}

describe("Harness service health", () => {
  test("reports healthy through the public HTTP server seam", async () => {
    const service = await startHarnessService();

    try {
      const response = await fetch(`${service.url}/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
    } finally {
      await service.close();
    }
  });

  test("reports its service version through the public HTTP server seam", async () => {
    const service = await startHarnessService();

    try {
      const response = await fetch(`${service.url}/version`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        version: await servicePackageVersion(),
      });
    } finally {
      await service.close();
    }
  });

  test("returns explicit v2 capability boundaries and rejects unsupported runs", async () => {
    const service = await startHarnessService();

    try {
      const capabilities = await fetch(`${service.url}/capabilities`);
      expect(capabilities.status).toBe(200);
      const body = await capabilities.json() as {
        status: string;
        surfaces: Array<{ id: string; status: string }>;
      };
      expect(body.status).toBe("partial");
      expect(body.review_gate.status).toBe("blocked");
      expect(body.completed_prerequisites).toEqual(["desktop_decision_to_resume"]);
      expect(body.unsupported_capabilities.web_search).toEqual({
        status: "unsupported",
        reason: "provider_connector_not_implemented",
      });
      expect(body.surfaces.map((surface) => [surface.id, surface.status])).toEqual([
        ["create", "unsupported"],
        ["cowork", "unsupported"],
        ["hub", "unsupported"],
      ]);

      const response = await fetch(`${service.url}/v2/surfaces/create/runs`, { method: "POST" });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "legacy_surface_not_migrated",
        surface_id: "create",
      });
    } finally {
      await service.close();
    }
  });

  test("exposes an injected runtime as test_only and forwards a v2 run request", async () => {
    const requests: Array<{ surfaceId: string; body: unknown }> = [];
    const service = await startHarnessService({
      runtime: {
        evidenceMode: "test",
        surfaces: ["create"],
        async start(surfaceId, body) {
          requests.push({ surfaceId, body });
          return { runId: "run-injected", status: "queued" };
        },
      },
    });

    try {
      const capabilities = await fetch(`${service.url}/capabilities`);
      expect(capabilities.status).toBe(200);
      const body = await capabilities.json() as {
        surfaces: Array<{ id: string; status: string; reason?: string }>;
      };
      expect(body.surfaces.find((surface) => surface.id === "create")).toMatchObject({
        status: "test_only",
        reason: "injected_runtime_is_not_live_evidence",
      });

      const response = await fetch(`${service.url}/v2/surfaces/create/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: "exercise the bridge" }),
      });

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        surface_id: "create",
        run_id: "run-injected",
        status: "queued",
      });
      expect(requests).toEqual([{
        surfaceId: "create",
        body: { goal: "exercise the bridge" },
      }]);
    } finally {
      await service.close();
    }
  });

  test("forwards every migrated v2 surface through the same Runtime contract", async () => {
    const requests: string[] = [];
    const service = await startHarnessService({
      runtime: {
        evidenceMode: "test",
        surfaces: ["create", "cowork", "hub"],
        async start(surfaceId) {
          requests.push(surfaceId);
          return { runId: `run-${surfaceId}`, status: "queued" };
        },
      },
    });

    try {
      for (const surfaceId of ["create", "cowork", "hub"] as const) {
        const response = await fetch(`${service.url}/v2/surfaces/${surfaceId}/runs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ goal: `exercise ${surfaceId}` }),
        });
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({
          surface_id: surfaceId,
          run_id: `run-${surfaceId}`,
          status: "queued",
        });
      }
      expect(requests).toEqual(["create", "cowork", "hub"]);
    } finally {
      await service.close();
    }
  });

  test("forwards an explicit v2 Run resume through the Runtime contract", async () => {
    const calls: Array<{ surfaceId: string; runId: string; body: unknown }> = [];
    const service = await startHarnessService({
      runtime: {
        evidenceMode: "test",
        surfaces: ["create"],
        async start(surfaceId, body) {
          return { runId: `${surfaceId}-run`, status: "queued" };
        },
        async resume(surfaceId, runId, body) {
          calls.push({ surfaceId, runId, body });
          return { runId, status: "running" };
        },
      },
    });

    try {
      const response = await fetch(`${service.url}/v2/surfaces/create/runs/run-1/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: "workspace-1", channel_id: "channel-1" }),
      });
      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({
        surface_id: "create",
        run_id: "run-1",
        status: "running",
      });
      expect(calls).toEqual([{
        surfaceId: "create",
        runId: "run-1",
        body: { workspace_id: "workspace-1", channel_id: "channel-1" },
      }]);
    } finally {
      await service.close();
    }
  });

  test("reports WebSearch only when the Runtime has a configured provider", async () => {
    const service = await startHarnessService({
      runtime: {
        evidenceMode: "live",
        surfaces: ["create", "cowork", "hub"],
        webSearchConfigured: true,
        async start() {
          return { runId: "run-web-search", status: "queued" };
        },
      },
    });

    try {
      const response = await fetch(`${service.url}/capabilities`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        unsupported_capabilities: {
          web_search: {
            status: "available",
            reason: "provider_connector_configured",
          },
        },
      });
    } finally {
      await service.close();
    }
  });

  test("reports Review Gate ready only when the Runtime has verified the Owner bridge", async () => {
    const service = await startHarnessService({
      runtime: {
        evidenceMode: "live",
        surfaces: ["create", "cowork", "hub"],
        reviewGateConfigured: true,
        async start() {
          return { runId: "run-review", status: "queued" };
        },
      },
    });

    try {
      const response = await fetch(`${service.url}/capabilities`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        review_gate: {
          status: "ready",
          owner: "verified",
          provider: "verified",
          live_evidence: "pending",
        },
      });
    } finally {
      await service.close();
    }
  });

  test("rejects unknown paths and unsupported methods", async () => {
    const service = await startHarnessService();

    try {
      const responses = await Promise.all([
        fetch(`${service.url}/unknown`),
        fetch(`${service.url}/health`, { method: "POST" }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([404, 404]);
    } finally {
      await service.close();
    }
  });
});
