import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const modelConfigKeys = new Set([
  "model_provider",
  "model_endpoint",
  "model_name",
  "model_api_key",
  "model_profiles",
]);

export type ProductConfig = Record<string, unknown>;

export async function readProductConfig(path?: string): Promise<ProductConfig> {
  if (path === undefined || path.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeProductConfig(
  path: string | undefined,
  updates: ProductConfig,
): Promise<ProductConfig> {
  if (path === undefined || path.trim() === "") throw new Error("product runtime config path is unavailable");
  const current = await readProductConfig(path);
  const next = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (!modelConfigKeys.has(key)) continue;
    if (key === "model_api_key" && (value === undefined || value === "")) continue;
    next[key] = value;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return next;
}

export function publicProductConfig(
  path: string | undefined,
  host: ProductConfig,
  business?: ProductConfig,
): ProductConfig {
  const businessValues = isRecord(business?.values) ? business.values : {};
  const businessSecrets = isRecord(business?.secrets) ? business.secrets : {};
  const profiles = Array.isArray(host.model_profiles)
    ? host.model_profiles.filter(isRecord).map((profile) => ({
        id: stringValue(profile.id),
        label: stringValue(profile.label) || stringValue(profile.model_name),
        provider: stringValue(profile.provider),
        model_name: stringValue(profile.model_name),
        endpoint: redactEndpoint(profile.endpoint),
        api_key_configured: hasSecret(profile.api_key),
      }))
    : [];
  return {
    runtime_config_path: path,
    exists: path !== undefined && Object.keys(host).length > 0,
    values: {
      ...businessValues,
      model_provider: stringValue(host.model_provider) || "openai-compatible",
      model_endpoint: redactEndpoint(host.model_endpoint),
      model_name: stringValue(host.model_name) || "deepseek-v4-pro",
      model_profiles: profiles,
    },
    secrets: {
      ...businessSecrets,
      model_api_key_configured: hasSecret(host.model_api_key),
    },
    requires_restart_after_save: true,
  };
}

export function productModelStatus(host: ProductConfig): ProductConfig {
  const configured = hasSecret(host.model_api_key) && stringValue(host.model_endpoint) !== "";
  return {
    provider: stringValue(host.model_provider) || "openai-compatible",
    model_name: stringValue(host.model_name) || "deepseek-v4-pro",
    configured,
    status: configured ? "configured" : "not_configured",
    ...(configured ? {} : { error_code: "model_not_configured" }),
  };
}

export function redactEndpoint(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (raw === "") return undefined;
  try {
    const endpoint = new URL(raw);
    if (endpoint.username || endpoint.password) {
      endpoint.username = "[redacted]";
      endpoint.password = "[redacted]";
    }
    for (const key of ["api_key", "access_token", "token", "secret", "password"]) {
      if (endpoint.searchParams.has(key)) endpoint.searchParams.set(key, "[redacted]");
    }
    return endpoint.toString();
  } catch {
    return raw.includes("Bearer ") ? raw.replace(/Bearer\s+\S+/i, "Bearer [redacted]") : raw;
  }
}

function hasSecret(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
