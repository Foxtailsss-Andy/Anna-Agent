import { createLiveHarnessV2Runtime } from "./production";
import { startHarnessService } from "./index";
import { startReviewApprovalService } from "./review-approval";

const localApproval = process.env.ANNA_HARNESS_V2_APPROVAL_BRIDGE_ENABLED === "1"
  ? await startReviewApprovalService({
      ownerId: requiredEnv("ANNA_T07_LIVE_OWNER_ID"),
      storePath: process.env.ANNA_HARNESS_V2_APPROVAL_STORE_PATH
        ?? ".anna/state/review-approval.jsonl",
      port: parsePort(process.env.ANNA_HARNESS_V2_APPROVAL_PORT),
    })
  : undefined;

let live: Awaited<ReturnType<typeof createLiveHarnessV2Runtime>> | undefined;
let service!: Awaited<ReturnType<typeof startHarnessService>>;
try {
  live = await createLiveHarnessV2Runtime({
    ...(localApproval === undefined
      ? {}
      : {
          reviewApprovalOrigin: localApproval.url,
          reviewOwnerId: process.env.ANNA_T07_LIVE_OWNER_ID,
        }),
  });
  const port = parsePort(process.env.ANNA_HARNESS_V2_PORT);
  const host = process.env.ANNA_HARNESS_V2_HOST ?? "127.0.0.1";
  service = await startHarnessService({
    runtime: live.runtime,
    eventStore: live.eventStore,
    host,
    port,
    ...(live.createActivation === undefined
      ? {}
      : { createActivation: live.createActivation }),
  });
} catch (error) {
  await live?.close();
  await localApproval?.close();
  throw error;
}

process.stdout.write(JSON.stringify({
  status: "ready",
  url: service.url,
  ...(localApproval === undefined ? {} : { approvalUrl: localApproval.url }),
}) + "\n");

const shutdown = async () => {
  await service.close();
  await live?.close();
  await localApproval?.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ANNA_HARNESS_V2_PORT must be a valid TCP port");
  }
  return port;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
