import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const python = resolve(repositoryRoot, ".venv/bin/python");

const businessScript = String.raw`
import os
import uvicorn
from services.api.app.main import create_app
from services.business.harness_client import HarnessHostClient
from services.business.mode import BusinessModeConfig
from services.identity.app.seed import seed_demo_workspace
from services.identity.app.passwords import hash_password
from services.identity.app.schemas import Account, Membership
from services.identity.app.service import IdentityService
from services.identity.app.store import SQLiteIdentityStore

state_db = os.environ["WB01_STATE_DB"]
service_token = os.environ["WB01_SERVICE_TOKEN"]
store = SQLiteIdentityStore(state_db)
seed_demo_workspace(store)
if store.get_workspace("ws_other") is None:
    store.create_workspace("ws_other", "Other Workspace")
    store.create_team("team_other", "ws_other", "Other Core")
    store.create_account(
        Account(
            id="acc_other",
            workspace_id="ws_other",
            email="other@anna.demo",
            display_name="Other User",
            role="member",
            kind="human",
        ),
        hash_password("other-demo"),
    )
    store.add_membership(
        Membership(
            account_id="acc_other",
            workspace_id="ws_other",
            team_id="team_other",
            role="member",
        )
    )
config = BusinessModeConfig(
    enabled=True,
    host_origin=os.environ["WB01_HOST_ORIGIN"],
    service_token=service_token,
)
host = HarnessHostClient(config)
application = create_app(
    product_mode=True,
    business_mode_config=config,
    harness_client=host,
    identity_service=IdentityService(store),
)
uvicorn.run(application, host="127.0.0.1", port=int(os.environ["WB01_PORT"]), log_level="error")
`;

export interface BusinessFixture {
  readonly origin: string;
  readonly authorization: string;
  readonly workspaceId: string;
  readonly actorUserId: string;
  close(): Promise<void>;
}

export async function startBusinessFixture(
  stateDbPath: string,
  hostOrigin: string,
): Promise<BusinessFixture> {
  const port = await findFreePort();
  const runtimeConfigPath = `${stateDbPath}.runtime.json`;
  await writeFile(runtimeConfigPath, "{}\n", "utf8");
  const serviceToken = "wb01-business-service-token";
  const child = spawn(python, ["-c", businessScript], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ANNA_STATE_DB_PATH: stateDbPath,
      ANNA_MEMORY_DB_PATH: `${stateDbPath}.memory`,
      ANNA_RUNS_DB_PATH: `${stateDbPath}.runs`,
      ANNA_RUNTIME_CONFIG_PATH: runtimeConfigPath,
      ANNA_CREATE_WORKSPACE_ROOT: `${stateDbPath}.create-runs`,
      ANNA_WORKDIRS_PATH: `${stateDbPath}.workdirs.json`,
      ANNA_MODEL_ENDPOINT: "",
      ANNA_MODEL_API_KEY: "",
      ANNA_MODEL_NAME: "fixture-model",
      WB01_STATE_DB: stateDbPath,
      WB01_SERVICE_TOKEN: serviceToken,
      WB01_HOST_ORIGIN: hostOrigin,
      WB01_PORT: String(port),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/health`, child);
    const origin = `http://127.0.0.1:${port}`;
    const login = await fetch(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "boss@anna.demo", password: "crew-demo" }),
    });
    if (!login.ok) throw new Error(`Business fixture login failed: ${login.status}`);
    const payload = await login.json() as { token: string; session: { workspace_id: string; user_id: string } };
    return {
      origin,
      authorization: `Bearer ${payload.token}`,
      workspaceId: payload.session.workspace_id,
      actorUserId: payload.session.user_id,
      close: () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:http");
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Business fixture did not bind");
  const port = address.port;
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return port;
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Business fixture exited with ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still binding its ephemeral port.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error("Business fixture did not become healthy");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolvePromise();
    }, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}
