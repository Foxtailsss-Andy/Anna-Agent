import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { expect, test } from "vitest";

import { startPreviewHarnessService } from "../src/preview";

const safeSettings = (workspaceRoot: string) => ({
  model_name: "preview-model",
  model_endpoint: "https://provider.example/v1/chat/completions",
  workspace_root: workspaceRoot,
  model_api_key: "preview-key",
});

test("rejects a Preview workspace containing state through direct, ancestor, alias and external config paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-preview-admission-bootstrap-"));
  const stateRoot = join(directory, "state");
  const stateAlias = join(directory, "state-alias");
  const configDirectory = join(directory, "config");
  const externalConfigPath = join(configDirectory, "preview.json");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  await symlink(stateRoot, stateAlias, "dir");

  const cases = [
    { name: "direct state", workspaceRoot: stateRoot },
    { name: "ancestor", workspaceRoot: directory },
    { name: "realpath alias", workspaceRoot: stateAlias },
    { name: "external config parent", workspaceRoot: configDirectory, configPath: externalConfigPath },
  ];
  try {
    for (const candidate of cases) {
      await expect(startPreviewHarnessService({
        stateRoot,
        workspaceRoot: candidate.workspaceRoot,
        ...(candidate.configPath === undefined ? {} : { configPath: candidate.configPath }),
      }), candidate.name).rejects.toMatchObject({
        code: "workspace_conflicts_with_preview_state",
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unsafe settings before save or Runtime creation, including a realpath alias", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-preview-admission-put-"));
  const stateRoot = join(directory, "state");
  const safeWorkspaceRoot = join(await realpath(directory), "workspace");
  const stateAlias = join(directory, "state-alias");
  await mkdir(stateRoot, { recursive: true });
  await symlink(stateRoot, stateAlias, "dir");
  let factoryCalls = 0;
  const service = await startPreviewHarnessService({
    stateRoot,
    workspaceRoot: safeWorkspaceRoot,
    createRuntime: async () => {
      factoryCalls += 1;
      throw new Error("Runtime must not be created for rejected settings");
    },
  });
  try {
    for (const workspaceRoot of [stateRoot, directory, stateAlias]) {
      const response = await fetch(`${service.url}/api/preview/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(safeSettings(workspaceRoot)),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        code: "workspace_conflicts_with_preview_state",
      });
    }
    expect(factoryCalls).toBe(0);
    await expect(fetch(`${service.url}/api/preview/settings`).then((response) => response.json())).resolves.toEqual({
      model_name: "",
      model_endpoint: "",
      workspace_root: safeWorkspaceRoot,
      has_api_key: false,
    });
    await expect(readFile(join(stateRoot, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on persisted settings whose workspace contains Preview state or external config", async () => {
  const directory = await mkdtemp(join(tmpdir(), "anna-preview-admission-persisted-"));
  const stateRoot = join(directory, "state");
  const safeWorkspaceRoot = join(await realpath(directory), "workspace");
  const configDirectory = join(directory, "config");
  const externalConfigPath = join(configDirectory, "preview.json");
  await mkdir(stateRoot, { recursive: true });
  await mkdir(configDirectory, { recursive: true });
  let factoryCalls = 0;
  const persistedCases = [
    {
      workspaceRoot: directory,
      configPath: join(stateRoot, "runtime.json"),
      reason: "workspace_conflicts_with_preview_state",
    },
    {
      workspaceRoot: configDirectory,
      configPath: externalConfigPath,
      reason: "workspace_conflicts_with_preview_state",
    },
    {
      workspaceRoot: safeWorkspaceRoot,
      configPath: join(stateRoot, "runtime.json"),
      reason: "invalid_persisted_settings",
    },
  ];
  try {
    for (const [index, candidate] of persistedCases.entries()) {
      const settingsPath = join(stateRoot, "settings.json");
      await writeFile(settingsPath, JSON.stringify({
        ...safeSettings(candidate.workspaceRoot),
        model_api_key: `persisted-secret-${index}`,
        ...(candidate.reason === "invalid_persisted_settings" ? { kernel: "pi" } : {}),
      }), "utf8");
      const service = await startPreviewHarnessService({
        stateRoot,
        workspaceRoot: safeWorkspaceRoot,
        configPath: candidate.configPath,
        createRuntime: async () => {
          factoryCalls += 1;
          throw new Error("Runtime must not be created for rejected persisted settings");
        },
      });
      try {
        await expect(fetch(`${service.url}/api/preview/status`).then((response) => response.json())).resolves.toMatchObject({
          configured: false,
          ready: false,
          reason: candidate.reason,
        });
        await expect(fetch(`${service.url}/api/preview/settings`).then((response) => response.json())).resolves.toEqual({
          model_name: "",
          model_endpoint: "",
          workspace_root: safeWorkspaceRoot,
          has_api_key: false,
        });
        expect(factoryCalls).toBe(0);
      } finally {
        await service.close();
      }
      await writeFile(settingsPath, "{}", "utf8");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
