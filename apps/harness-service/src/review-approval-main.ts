import { startReviewApprovalService } from "./review-approval";

const ownerId = requiredEnv(
  "ANNA_HARNESS_V2_APPROVAL_OWNER_ID",
  process.env.ANNA_T07_LIVE_OWNER_ID,
);
const service = await startReviewApprovalService({
  ownerId,
  storePath: process.env.ANNA_HARNESS_V2_APPROVAL_STORE_PATH
    ?? ".anna/state/review-approval.jsonl",
  host: process.env.ANNA_HARNESS_V2_APPROVAL_HOST ?? "127.0.0.1",
  port: parsePort(process.env.ANNA_HARNESS_V2_APPROVAL_PORT),
});

process.stdout.write(JSON.stringify({
  status: "ready",
  url: service.url,
  ownerId,
  storePath: service.storePath,
}) + "\n");

const shutdown = async () => {
  await service.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

function requiredEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("ANNA_HARNESS_V2_APPROVAL_PORT must be a valid TCP port");
  }
  return port;
}
