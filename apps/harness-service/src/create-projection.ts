import type { CanonicalEvent, JsonValue } from "@anna/harness-v2";

export type CreateRunStatus =
  | "generating"
  | "validating"
  | "ready_for_review"
  | "saved"
  | "failed";

export interface CreateArtifactProjection {
  readonly kind: string;
  readonly skill_id?: string;
  readonly prompt_id?: string;
  readonly tool_id?: string;
  readonly path: string;
  readonly preview: string;
  readonly hash: string;
}

export interface CreateValidationProjection {
  readonly valid: boolean;
  readonly loaded_skill_id?: string;
  readonly errors: readonly string[];
}

export type CreateActivationProjection =
  | { readonly status: "blocked"; readonly reason: string }
  | { readonly status: "activated" };

export interface CreateRunProjection {
  readonly runId: string;
  readonly status: CreateRunStatus;
  readonly artifact?: CreateArtifactProjection;
  readonly validation?: CreateValidationProjection;
  readonly activation: CreateActivationProjection;
  readonly error?: { readonly code: string; readonly message: string };
}

export function projectCreateRun(
  runId: string,
  events: readonly CanonicalEvent[],
): CreateRunProjection {
  let artifact: CreateArtifactProjection | undefined;
  let validation: CreateValidationProjection | undefined;
  let terminal: "completed" | "failed" | undefined;
  let activated = false;
  let error: CreateRunProjection["error"];

  for (const event of events) {
    if (event.type === "create.artifact.created") {
      artifact = readArtifact(payloadField(event.payload, "artifact"));
      continue;
    }
    if (event.type === "create.artifact.validated") {
      validation = readValidation(payloadField(event.payload, "validation"));
      continue;
    }
    if (event.type === "create.artifact.activated") {
      activated = true;
      continue;
    }
    if (event.type === "run.completed") {
      terminal = "completed";
      continue;
    }
    if (event.type === "run.failed") {
      terminal = "failed";
      const payload = asRecord(event.payload);
      const code = stringValue(payload?.errorCode)
        ?? stringValue(payload?.errorType)
        ?? "create_run_failed";
      const message = stringValue(payload?.message)
        ?? stringValue(payload?.reason)
        ?? "Create Run failed.";
      error = { code, message };
    }
  }

  if (terminal === "failed") {
    return {
      runId,
      status: "failed",
      ...(artifact === undefined ? {} : { artifact }),
      ...(validation === undefined ? {} : { validation }),
      activation: {
        status: "blocked",
        reason: validation?.valid === false
          ? "create_validation_failed"
          : "create_run_failed",
      },
      error,
    };
  }

  if (terminal === "completed" && artifact === undefined) {
    return {
      runId,
      status: "failed",
      activation: { status: "blocked", reason: "create_artifact_missing" },
      error: {
        code: "create_artifact_missing",
        message: "Create Run completed without an artifact.",
      },
    };
  }

  if (terminal === "completed" && validation?.valid === false) {
    return {
      runId,
      status: "failed",
      artifact,
      validation,
      activation: { status: "blocked", reason: "create_validation_failed" },
      error: {
        code: "create_validation_failed",
        message: "Create artifact validation failed.",
      },
    };
  }

  if (terminal === "completed" && validation === undefined) {
    return {
      runId,
      status: "failed",
      artifact,
      activation: { status: "blocked", reason: "create_validation_missing" },
      error: {
        code: "create_validation_missing",
        message: "Create artifact completed without validation.",
      },
    };
  }

  if (activated && (artifact === undefined || validation?.valid !== true)) {
    return {
      runId,
      status: "failed",
      ...(artifact === undefined ? {} : { artifact }),
      ...(validation === undefined ? {} : { validation }),
      activation: { status: "blocked", reason: "create_validation_missing" },
      error: {
        code: "create_activation_evidence_invalid",
        message: "Create activation requires a valid artifact and validation.",
      },
    };
  }

  if (activated) {
    return {
      runId,
      status: "saved",
      ...(artifact === undefined ? {} : { artifact }),
      ...(validation === undefined ? {} : { validation }),
      activation: { status: "activated" },
    };
  }

  if (terminal === "completed" && artifact !== undefined && validation?.valid === true) {
    return {
      runId,
      status: "ready_for_review",
      artifact,
      validation,
      activation: { status: "blocked", reason: "create_activation_not_implemented" },
      error: undefined,
    };
  }

  return {
    runId,
    status: artifact === undefined ? "generating" : "validating",
    ...(artifact === undefined ? {} : { artifact }),
    ...(validation === undefined ? {} : { validation }),
    activation: {
      status: "blocked",
      reason: validation?.valid === false
        ? "create_validation_failed"
        : "create_run_not_complete",
    },
    ...(error === undefined ? {} : { error }),
  };
}

function payloadField(payload: JsonValue, field: string): JsonValue | undefined {
  const record = asRecord(payload);
  return record?.[field];
}

function readArtifact(value: JsonValue | undefined): CreateArtifactProjection | undefined {
  const record = asRecord(value);
  if (
    record === undefined
    || stringValue(record.kind) === undefined
    || stringValue(record.path) === undefined
    || stringValue(record.preview) === undefined
    || stringValue(record.hash) === undefined
  ) {
    return undefined;
  }
  return {
    kind: stringValue(record.kind)!,
    path: stringValue(record.path)!,
    preview: stringValue(record.preview)!,
    hash: stringValue(record.hash)!,
    ...(stringValue(record.skill_id) === undefined ? {} : { skill_id: stringValue(record.skill_id) }),
    ...(stringValue(record.prompt_id) === undefined ? {} : { prompt_id: stringValue(record.prompt_id) }),
    ...(stringValue(record.tool_id) === undefined ? {} : { tool_id: stringValue(record.tool_id) }),
  };
}

function readValidation(value: JsonValue | undefined): CreateValidationProjection | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.valid !== "boolean") {
    return undefined;
  }
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((item): item is string => typeof item === "string")
    : [];
  return {
    valid: record.valid,
    errors,
    ...(stringValue(record.loaded_skill_id) === undefined
      ? {}
      : { loaded_skill_id: stringValue(record.loaded_skill_id) }),
  };
}

function asRecord(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return value !== undefined && typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
