import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(REPOSITORY_ROOT, "evals/jev-crew/fixtures");
const PRICE_DATA_PATH = join(REPOSITORY_ROOT, "evals/jev-crew/prices-20260921.json");
const DEFAULT_OUTPUT_ROOT = join(REPOSITORY_ROOT, "evals/jev-crew/runs");
const DEFAULT_STATE_ROOT = join(homedir(), ".local/share/anna-jev-preview-20260921");
const DEFAULT_LEDGER_PATH = join(DEFAULT_STATE_ROOT, "budget-ledger.json");
const QUESTION_VERSION = "crew-assignee-v1";
const REQUESTED_MODEL = "jev-1.13.0";
const SERVICE_PATH = "/_harness/crew/assignee-decision";
const MAX_JEV_REQUESTS = 500;
const MAX_JEV_USD = 2;
const MAX_TOTAL_USD = 10;
const CONSERVATIVE_RESERVATION_USD = 0.002688;
const PRICE_DATA = JSON.parse(await readFile(PRICE_DATA_PATH, "utf8"));
const INPUT_USD_PER_MILLION = PRICE_DATA.jev.input_usd_per_million;
const MAIN_INPUT_USD_PER_MILLION = PRICE_DATA.main_model.input_usd_per_million;
const MAIN_OUTPUT_USD_PER_MILLION = PRICE_DATA.main_model.output_usd_per_million;
const MAIN_MODEL_NAMES = new Set(["deepseek-v4-pro", "DeepSeek-V4-Pro-0813"]);
const MAIN_MAX_INPUT_BYTES = 64 * 1024;
const MAIN_MAX_INPUT_TOKENS = MAIN_MAX_INPUT_BYTES + 1_024;
const MAIN_MAX_OUTPUT_TOKENS = 4_096;
const MAIN_RESERVATION_USD = (MAIN_MAX_INPUT_TOKENS * MAIN_INPUT_USD_PER_MILLION + MAIN_MAX_OUTPUT_TOKENS * MAIN_OUTPUT_USD_PER_MILLION) / 1_000_000;
const PRICE_DATE = PRICE_DATA.effective_date;

export function parseArgs(argv) {
  const args = {
    live: false,
    mode: "jev",
    roundId: undefined,
    limit: 8,
    limitSpecified: false,
    split: "development",
    groups: undefined,
    finalFreeze: false,
    outputDir: undefined,
    ledgerPath: DEFAULT_LEDGER_PATH,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--live") args.live = true;
    else if (value === "--dry-run") args.live = false;
    else if (value === "--mode") args.mode = requiredValue(argv, ++index, "--mode");
    else if (value === "--help" || value === "-h") args.help = true;
    else if (value === "--round") args.roundId = requiredValue(argv, ++index, "--round");
    else if (value === "--limit") { args.limit = positiveInteger(requiredValue(argv, ++index, "--limit"), "--limit"); args.limitSpecified = true; }
    else if (value === "--split") args.split = requiredValue(argv, ++index, "--split");
    else if (value === "--groups") args.groups = requiredValue(argv, ++index, "--groups").split(",").filter(Boolean);
    else if (value === "--final-freeze") args.finalFreeze = true;
    else if (value === "--output-dir") args.outputDir = requiredValue(argv, ++index, "--output-dir");
    else if (value === "--ledger") args.ledgerPath = requiredValue(argv, ++index, "--ledger");
    else throw new Error(`unknown argument: ${value}`);
  }
  if (args.live && args.roundId === undefined) throw new Error("--live requires --round <id>");
  if (!["jev", "comparison"].includes(args.mode)) throw new Error("--mode must be jev or comparison");
  if (!["development", "heldout", "all"].includes(args.split)) throw new Error("--split must be development, heldout, or all");
  if (args.groups !== undefined && (args.groups.length === 0 || args.groups.some((group) => !COMPARISON_GROUPS.includes(group)))) throw new Error("--groups must contain A,B,C,D");
  if (args.roundId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args.roundId)) {
    throw new Error("--round must be a simple identifier");
  }
  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

export async function loadFrozenFixtures(repositoryRoot = REPOSITORY_ROOT) {
  const fixtureDir = join(repositoryRoot, "evals/jev-crew/fixtures");
  const manifestPath = join(fixtureDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.synthetic !== true || typeof manifest.fixture_version !== "string") {
    throw new Error("invalid_fixture_manifest");
  }
  const files = manifest.files;
  if (!files || typeof files !== "object") throw new Error("invalid_fixture_manifest_files");
  const loaded = {};
  for (const fileName of ["development.json", "heldout.json"]) {
    const expected = files[fileName]?.sha256;
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`missing_fixture_hash:${fileName}`);
    const bytes = await readFile(join(fixtureDir, fileName));
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`fixture_hash_mismatch:${fileName}`);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error(`invalid_fixture_array:${fileName}`);
    loaded[fileName] = parsed;
  }
  const development = loaded["development.json"];
  const heldout = loaded["heldout.json"];
  validateFixtureCases(development, "development");
  validateFixtureCases(heldout, "heldout");
  const all = [...development, ...heldout];
  if (all.length !== 32 || new Set(all.map((item) => item.case_id)).size !== all.length) throw new Error("fixture_case_count_or_ids_invalid");
  const byCategory = countBy(all, (item) => item.category);
  const expectedCategories = { distinguishable: 16, ambiguous: 8, no_fit: 8 };
  if (JSON.stringify(byCategory) !== JSON.stringify(expectedCategories)) throw new Error("fixture_category_distribution_invalid");
  if (all.filter((item) => item.provider_eligible).length < 24) throw new Error("fixture_provider_eligibility_too_low");
  if (development.filter((item) => item.provider_eligible).length < 6 || heldout.filter((item) => item.provider_eligible).length < 18) {
    throw new Error("fixture_split_provider_eligibility_too_low");
  }
  if (manifest.counts?.total !== 32 || manifest.counts?.development !== 8 || manifest.counts?.heldout !== 24) {
    throw new Error("fixture_manifest_counts_invalid");
  }
  return {
    manifest,
    development,
    heldout,
    all,
    counts: { by_category: byCategory, provider_eligible: all.filter((item) => item.provider_eligible).length },
    hashes: {
      development: files["development.json"].sha256,
      heldout: files["heldout.json"].sha256,
    },
  };
}

function validateFixtureCases(cases, split) {
  for (const item of cases) {
    if (!isRecord(item) || item.split !== split || typeof item.case_id !== "string") throw new Error(`invalid_fixture_case:${item?.case_id ?? "unknown"}`);
    if (!isRecord(item.input) || !isRecord(item.input.state) || !isRecord(item.input.qualification)) throw new Error(`invalid_fixture_input:${item.case_id}`);
    if ("expected" in item.input || "label_rationale" in item.input || "provider_eligible" in item.input) throw new Error(`fixture_label_leak:${item.case_id}`);
    const state = item.input.state;
    if (!isRecord(state.task) || !Array.isArray(state.candidates)) throw new Error(`invalid_fixture_state:${item.case_id}`);
    const candidateIds = state.candidates.map((candidate) => candidate?.id);
    if (candidateIds.some((id) => typeof id !== "string") || new Set(candidateIds).size !== candidateIds.length) throw new Error(`invalid_fixture_candidates:${item.case_id}`);
    if (!isRecord(item.expected) || !Array.isArray(item.expected.allowed_member_ids) || typeof item.expected.must_abstain !== "boolean") throw new Error(`invalid_fixture_expected:${item.case_id}`);
    if (item.expected.allowed_member_ids.some((id) => !candidateIds.includes(id))) throw new Error(`fixture_allowed_id_outside_roster:${item.case_id}`);
    if (typeof item.provider_eligible !== "boolean") throw new Error(`invalid_fixture_eligibility:${item.case_id}`);
  }
}

export function createHostInput(item, uuid = randomUUID) {
  const state = clone(item.input.state);
  const scope = {
    workspace_id: `jev-eval-${item.split}`,
    actor_user_id: "jev-eval-reviewer",
    project_id: `project-${item.case_id}`,
    task_id: `task-${item.case_id}`,
  };
  return {
    scope,
    body: {
      schema_version: 1,
      decision_id: uuid(),
      ...scope,
      input_hash: sha256(stableJson(state)),
      question_version: QUESTION_VERSION,
      state,
    },
  };
}

/** Build the common, fair input shared by all four comparison groups. */
export function buildFairState(item) {
  if (!isRecord(item?.input?.state)) throw new Error("invalid_comparison_case");
  const state = clone(item.input.state);
  state.task = {
    title: state.task?.title ?? null,
    description: "",
    role_required: state.task?.role_required ?? null,
    acceptance_criteria: null,
  };
  state.candidates = Array.isArray(state.candidates)
    ? state.candidates.map((candidate) => ({
      id: candidate.id,
      display_name: candidate.id,
      role: candidate.role,
      kind: candidate.kind,
    }))
    : [];
  return state;
}

/** Reproduce the existing Crew deterministic_proposals rule for one fixture case. */
export function deterministicProposal(item, { repositoryRoot = REPOSITORY_ROOT, pythonPath } = {}) {
  const state = buildFairState(item);
  const helper = join(repositoryRoot, "scripts/jev-crew-baseline.py");
  const executable = pythonPath ?? join(repositoryRoot, ".venv/bin/python");
  const child = spawnSync(executable, [helper], {
    cwd: repositoryRoot,
    input: JSON.stringify({ item: { ...item, input: { ...item.input, state } } }),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PYTHONPATH: repositoryRoot },
  });
  if (child.error?.code === "ENOENT") throw new Error("baseline_python_venv_missing");
  if (child.status !== 0) throw new Error("baseline_helper_failed");
  return normalizeBaselineProposal(item, JSON.parse(child.stdout));
}

function normalizeBaselineProposal(item, proposal) {
  return {
    case_id: item.case_id,
    source: "role_rules",
    provider_called: false,
    provider_calls: 0,
    status: proposal.member_id === null ? "abstained" : "suggested",
    member_id: proposal.member_id,
    member_name: proposal.member_name,
    reason_code: proposal.member_id === null ? "no_matching_role" : "role_match",
    error_code: null,
    usage: { input_tokens: null, output_tokens: null },
    requested_model: null,
    returned_model: null,
  };
}

export async function runEvaluation(options) {
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const fixtures = options.fixtures ?? await loadFrozenFixtures(repositoryRoot);
  const roundId = options.roundId;
  if (typeof roundId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(roundId)) throw new Error("round_id_required");
  const executionMode = options.requestHost === undefined ? "live" : "fixture";
  const signal = options.signal;
  const outputRoot = resolve(options.outputDir ?? DEFAULT_OUTPUT_ROOT);
  const roundDir = join(outputRoot, roundId);
  const ledgerPath = resolve(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  await mkdir(roundDir, { recursive: true });
  const roundLock = await acquireRoundLock(roundDir);
  try {
    const roundMetadata = await ensureRoundMetadata(roundDir, roundId, fixtures, repositoryRoot, options.now, executionMode);
    const existing = await readAttemptedResults(join(roundDir, "results.jsonl"), executionMode);
    const candidates = fixtures.development.filter((item) => !existing.has(item.case_id));
    const limit = Math.min(options.limit ?? fixtures.development.length, candidates.length);
    const requestHost = options.requestHost === undefined
      ? createProductionRequester({
        repositoryRoot,
        roundId,
        stateRoot: options.stateRoot,
        fetchImpl: options.fetchImpl,
      })
      : typeof options.requestHost === "function"
        ? { request: options.requestHost }
        : options.requestHost;
    const attempted = [];
    let stoppedReason = null;
    try {
      let hostRuntime;
      if (typeof requestHost.start === "function") hostRuntime = await requestHost.start({ signal });
      try {
        for (const item of candidates.slice(0, limit)) {
          if (signal?.aborted) {
            stoppedReason = "interrupted";
            break;
          }
          try {
            await reserveBudget(ledgerPath);
          } catch (error) {
            stoppedReason = error.code ?? "budget_exhausted";
            break;
          }
          if (signal?.aborted) {
            await settleBudget(ledgerPath, { providerCalls: null, usageKnown: false, hostKnown: false, hostResult: null });
            stoppedReason = "interrupted";
            break;
          }
          const { scope, body } = createHostInput(item, options.uuid ?? randomUUID);
          const requestStarted = nowMs(options.now);
          let response;
          let requestError = null;
          try {
            response = await requestHost.request({ body, scope, case: item, signal });
          } catch (error) {
            requestError = error instanceof Error && ["host_timeout", "host_cancelled"].includes(error.message)
              ? error.message
              : "host_request_failed";
          }
          const httpElapsedMs = Math.max(0, nowMs(options.now) - requestStarted);
          const hostResult = response?.body ?? null;
          const providerCalls = providerCallsFrom(hostResult);
          const usageKnown = hasKnownUsage(hostResult);
          const settlement = await settleBudget(ledgerPath, { providerCalls, usageKnown, hostKnown: response !== undefined && requestError === null, hostResult });
          const attempt = makeAttemptRecord({
            item,
            fixtures,
            roundId,
            roundMetadata,
            executionMode,
            body,
            scope,
            response,
            requestError,
            httpElapsedMs,
            settlement,
            inference: response?.inference,
          });
          await appendFile(join(roundDir, "results.jsonl"), `${JSON.stringify(attempt)}\n`, "utf8");
          attempted.push(attempt);
          if (settlement.stopReason !== null || signal?.aborted) {
            stoppedReason = settlement.stopReason ?? "interrupted";
            break;
          }
        }
      } finally {
        if (typeof hostRuntime?.close === "function") await hostRuntime.close();
      }
      const allAttempts = [...await readResultRecords(join(roundDir, "results.jsonl"))];
      await writeSummary(roundDir, fixtures, roundMetadata, allAttempts, stoppedReason);
      return {
        roundId,
        execution_mode: executionMode,
        attempted: attempted.length,
        skipped: existing.size,
        remaining: Math.max(0, fixtures.development.length - existing.size - attempted.length),
        stopped_reason: stoppedReason,
        outputDir: roundDir,
      };
    } catch (error) {
      const failureReason = stoppedReason ?? evaluationFailureReason(error);
      const allAttempts = await readResultRecords(join(roundDir, "results.jsonl"));
      await writeSummary(roundDir, fixtures, roundMetadata, allAttempts, failureReason);
      throw error;
    }
  } finally {
    await rm(roundLock, { recursive: true, force: true });
  }
}

const COMPARISON_GROUPS = ["A", "B", "C", "D"];
const COMPARISON_SPLITS = ["development", "heldout"];

/**
 * Run a bounded A/B/C/D comparison through injected public seams.
 * A is always the real deterministic rule. B/C/D are supplied by a caller
 * that owns the corresponding Host/business boundary; the evaluator never
 * substitutes a fake runtime for those groups.
 */
export async function runComparison(options) {
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const fixtures = options.fixtures ?? await loadFrozenFixtures(repositoryRoot);
  const roundId = options.roundId;
  if (typeof roundId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(roundId)) throw new Error("round_id_required");
  const split = options.split ?? "development";
  if (![...COMPARISON_SPLITS, "all"].includes(split)) throw new Error("invalid_comparison_split");
  if ((split === "heldout" || split === "all") && options.finalFreeze !== true) throw new Error("heldout_requires_final_freeze");
  const groups = options.groups ?? COMPARISON_GROUPS;
  if (!Array.isArray(groups) || groups.length === 0 || groups.some((group) => !COMPARISON_GROUPS.includes(group))) throw new Error("invalid_comparison_groups");
  if (typeof options.requestGroup !== "function" && typeof options.requestGroup?.request !== "function") throw new Error("comparison_request_group_required");
  const requestGroup = typeof options.requestGroup === "function" ? { request: options.requestGroup } : options.requestGroup;
  const outputRoot = resolve(options.outputDir ?? DEFAULT_OUTPUT_ROOT);
  const roundDir = join(outputRoot, roundId);
  await mkdir(roundDir, { recursive: true });
  const roundLock = await acquireRoundLock(roundDir);
  const ledgerPath = resolve(options.ledgerPath ?? DEFAULT_LEDGER_PATH);
  try {
    const selectedSplits = split === "all" ? COMPARISON_SPLITS : [split];
    const items = selectedSplits.flatMap((name) => fixtures[name]);
    const metadata = await ensureComparisonMetadata(roundDir, roundId, fixtures, repositoryRoot, selectedSplits, groups, options);
    const resultPath = join(roundDir, "results.jsonl");
    const prior = await readResultRecords(resultPath);
    if (prior.some((record) => record.execution_mode !== "comparison")) throw new Error("round_execution_mode_mismatch");
    if (new Set(prior.map((record) => `${record.case_id}:${record.group}`)).size !== prior.length) throw new Error("duplicate_comparison_slot");
    if (prior.some((record) => record.final_freeze === true) && options.finalFreeze !== true) throw new Error("comparison_final_round_locked");
    const existing = new Set(prior.map((record) => `${record.case_id}:${record.group}`));
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : positiveInteger(String(options.limit), "--limit");
    const candidates = items.filter((item) => !groups.every((group) => existing.has(`${item.case_id}:${group}`))).slice(0, limit);
    const written = [];
    let stoppedReason = null;
    let groupRuntime;
    if (typeof requestGroup.start === "function") groupRuntime = await requestGroup.start({ signal: options.signal });
    try {
      for (const item of candidates) {
        for (const group of groups) {
        const slotKey = `${item.case_id}:${group}`;
        if (existing.has(slotKey)) continue;
        if (options.signal?.aborted) { stoppedReason = "interrupted"; break; }
        const state = buildFairState(item);
        const started = performance.now();
        let raw;
        let requestError = null;
        const budget = group === "A" ? null : createProviderBudget(ledgerPath, group);
        try {
          raw = group === "A"
            ? deterministicProposal(item)
            : item.provider_eligible === false
              ? { status: "not_run", source: group === "D" ? "jev" : "host", provider_called: false, provider_calls: 0, reason_code: "ineligible_precheck", error_code: null }
              : await requestGroup.request({ group, case_id: item.case_id, split: item.split, state, signal: options.signal, roundId, runtime: groupRuntime, budget });
        } catch (error) {
          requestError = error instanceof Error ? error.message : "comparison_request_failed";
          raw = { status: "blocked", source: group === "D" ? "jev" : "host", provider_called: null, provider_calls: null, error_code: requestError };
        }
        const normalizedRaw = normalizeComparisonRaw(raw);
        if (budget !== null && Number.isSafeInteger(normalizedRaw?.provider_calls) && normalizedRaw.provider_calls > budget.calls) {
          requestError = "provider_call_budget_bypass";
          raw = { status: "blocked", source: group === "D" ? "jev" : "host", provider_called: null, provider_calls: null, error_code: requestError };
        }
        const elapsed = Math.max(0, performance.now() - started);
        const settled = budget?.settled ?? { estimatedCostUsd: 0, stopReason: null };
        const record = makeComparisonRecord({ item, state, group, roundId, metadata, raw, requestError, elapsed, settled, finalFreeze: options.finalFreeze === true });
        await appendFile(resultPath, `${JSON.stringify(record)}\n`, "utf8");
        written.push(record);
        existing.add(slotKey);
        if (settled.stopReason !== null) { stoppedReason = settled.stopReason; break; }
        }
        if (stoppedReason !== null) break;
      }
    } finally {
      if (typeof groupRuntime?.close === "function") await groupRuntime.close();
    }
    const records = await readResultRecords(resultPath);
    const summary = makeComparisonSummary(metadata, fixtures, records, stoppedReason, selectedSplits, groups);
    await writeFile(join(roundDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    return {
      roundId,
      split,
      groups,
      slots: records.length,
      attempted: written.length,
      stopped_reason: stoppedReason,
      counts: summary.counts,
      summaries: summary.summaries,
      outputDir: roundDir,
    };
  } finally {
    await rm(roundLock, { recursive: true, force: true });
  }
}

export async function recordReadyWorkerEvidence({ caseId, assignment, startWorker, readWorker }) {
  if (typeof caseId !== "string" || caseId === "") throw new Error("worker_case_id_required");
  if (!isRecord(assignment)) throw new Error("worker_assignment_required");
  if (typeof startWorker !== "function" || typeof readWorker !== "function") throw new Error("worker_seam_required");
  const run = await startWorker({ caseId, assignment });
  if (!isRecord(run) || run.started !== true || typeof run.run_ref !== "string" || run.run_ref === "") {
    return { case_id: caseId, assignment: clone(assignment), run: run ?? null, terminal: null, worker_status: "not_run" };
  }
  const terminal = await readWorker({ caseId, assignment, run_ref: run.run_ref });
  const workerStatus = isRecord(terminal) && typeof terminal.status === "string" ? terminal.status : "unknown";
  return { case_id: caseId, assignment: clone(assignment), run: clone(run), terminal: isRecord(terminal) ? clone(terminal) : null, worker_status: workerStatus };
}

export const runWorkerEvidence = recordReadyWorkerEvidence;

/** Reverse candidate order on four development semantic cases as a diagnostic only. */
export async function runOrderReversalDiagnostic({ fixtures, requestGroup }) {
  if (typeof requestGroup !== "function") throw new Error("diagnostic_request_group_required");
  const cases = fixtures.development.filter((item) => item.provider_eligible && ["distinguishable", "ambiguous"].includes(item.category)).slice(0, 4);
  const records = [];
  for (const item of cases) {
    const state = buildFairState(item);
    const reversed = { ...state, candidates: [...state.candidates].reverse() };
    const first = await requestGroup({ group: "D", case_id: item.case_id, state, diagnostic: "original_order" });
    const second = await requestGroup({ group: "D", case_id: item.case_id, state: reversed, diagnostic: "reversed_order" });
    const reversedItem = { ...item, input: { ...item.input, state: reversed } };
    records.push({ case_id: item.case_id, split: item.split, diagnostic: true, original_order: state.candidates.map((candidate) => candidate.id), reversed_order: reversed.candidates.map((candidate) => candidate.id), A: { original: deterministicProposal(item), reversed: deterministicProposal(reversedItem) }, D: { original: sanitizeComparisonResult(first), reversed: sanitizeComparisonResult(second) } });
  }
  return { denominator: records.length, records };
}

async function ensureComparisonMetadata(roundDir, roundId, fixtures, repositoryRoot, splits, groups, options) {
  const metadata = {
    schema_version: 2,
    round_id: roundId,
    execution_mode: "comparison",
    splits,
    groups,
    final_freeze: options.finalFreeze === true,
    fixture_version: fixtures.manifest.fixture_version,
    label_version: fixtures.manifest.label_version,
    question_version: QUESTION_VERSION,
    source_head: await gitHead(repositoryRoot),
    fixture_hashes: fixtures.hashes,
    candidate_order_policy: fixtures.manifest.label_policy?.candidate_order_policy ?? null,
    source_file_hashes: await sourceFileDigests(repositoryRoot),
    created_at: new Date().toISOString(),
  };
  const path = join(roundDir, "round.json");
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    for (const key of ["execution_mode", "fixture_version", "label_version", "question_version", "source_head"]) {
      if (existing[key] !== metadata[key]) throw new Error(`round_metadata_mismatch:${key}`);
    }
    if (stableJson(existing.fixture_hashes) !== stableJson(metadata.fixture_hashes)) throw new Error("round_metadata_mismatch:fixture_hashes");
    if (stableJson(existing.source_file_hashes) !== stableJson(metadata.source_file_hashes)) throw new Error("round_metadata_mismatch:source_file_hashes");
    if (stableJson(existing.splits) !== stableJson(splits) || stableJson(existing.groups) !== stableJson(groups)) throw new Error("round_metadata_mismatch:comparison_shape");
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return metadata;
  }
}

function makeComparisonRecord({ item, state, group, roundId, metadata, raw, requestError, elapsed, settled, finalFreeze }) {
  const rawResult = isRecord(raw?.raw) ? raw.raw : raw;
  const rawMeta = isRecord(rawResult?.meta) ? rawResult.meta : {};
  const providerCalls = Number.isSafeInteger(rawResult?.provider_calls) && rawResult.provider_calls >= 0
    ? rawResult.provider_calls
    : Number.isSafeInteger(rawMeta.provider_calls) && rawMeta.provider_calls >= 0 ? rawMeta.provider_calls : null;
  const candidates = new Set(state.candidates.map((candidate) => candidate.id));
  const memberId = typeof rawResult?.member_id === "string" && candidates.has(rawResult.member_id) ? rawResult.member_id : null;
  const hardInvalid = rawResult?.status === "suggested" && memberId === null;
  const policy = hardInvalid ? { status: "blocked", member_id: null, error_code: "invalid_member_id" } : { status: rawResult?.status ?? "blocked", member_id: memberId };
  const status = policy.status === "suggested" || policy.status === "abstained"
    ? classifyPolicyResult(item, policy)
    : policy.status === "not_run" ? "not_run" : "blocked";
  return {
    schema_version: 2,
    round_id: roundId,
    execution_mode: "comparison",
    final_freeze: finalFreeze,
    case_id: item.case_id,
    split: item.split,
    category: item.category,
    group,
    fixture_hash: metadata.fixture_hashes[item.split],
    source_head: metadata.source_head,
    question_version: QUESTION_VERSION,
    input_hash: sha256(stableJson(state)),
    candidate_hash: sha256(stableJson(state.candidates)),
    input: clone(state),
    expected: clone(item.expected),
    provider_eligible: item.provider_eligible,
    status,
    raw_result: sanitizeComparisonResult(rawResult),
    policy_result: { status: policy.status, member_id: policy.member_id, error_code: policy.error_code ?? null },
    raw_outcome: stringOrNull(rawResult?.status),
    source: typeof rawResult?.source === "string" ? rawResult.source : null,
    provider_called: typeof rawResult?.provider_called === "boolean" ? rawResult.provider_called : providerCalls === null ? null : providerCalls > 0,
    provider_calls: providerCalls,
    requested_model: stringOrNull(rawResult?.requested_model ?? rawMeta.requested_model),
    returned_model: stringOrNull(rawResult?.returned_model ?? rawMeta.returned_model),
    usage: { input_tokens: numberOrNull(rawResult?.meta?.input_tokens ?? rawResult?.usage?.input_tokens), output_tokens: numberOrNull(rawResult?.meta?.output_tokens ?? rawResult?.usage?.output_tokens) },
    elapsed_ms: elapsed,
    host_elapsed_ms: numberOrNull(rawResult?.meta?.elapsed_ms),
    estimated_cost_usd: settled.estimatedCostUsd,
    error_code: requestError ?? stringOrNull(rawResult?.error_code),
    retry_count: 0,
    price_basis: group === "D" ? "typesafe-jev-input" : group === "A" ? null : MAIN_MODEL_NAMES.has(rawResult?.returned_model ?? rawResult?.requested_model) ? "deepseek-v4-pro-peak-cache-miss-upper-bound" : null,
  };
}

function sanitizeComparisonResult(result) {
  if (!isRecord(result)) return null;
  const inference = isRecord(result.inference) ? result.inference : {};
  const inferenceMeta = isRecord(inference.meta) ? inference.meta : {};
  return {
    status: stringOrNull(result.status),
    member_id: stringOrNull(result.member_id),
    source: stringOrNull(result.source),
    reason_code: stringOrNull(result.reason_code),
    error_code: stringOrNull(result.error_code),
    provider_called: typeof result.provider_called === "boolean" ? result.provider_called : null,
    provider_calls: Number.isSafeInteger(result.provider_calls) ? result.provider_calls : null,
    requested_model: stringOrNull(result.requested_model),
    returned_model: stringOrNull(result.returned_model),
    raw_choice: stringOrNull(result.raw_choice ?? inference.raw_choice),
    raw_probabilities: sanitizeProbabilityMap(result.raw_probabilities ?? inference.raw_probabilities),
    final_member_id: stringOrNull(result.final_member_id ?? inference.final_member_id),
    run_refs: Array.isArray(result.run_refs) ? result.run_refs.filter((value) => typeof value === "string") : null,
    host_statuses: Array.isArray(result.host_statuses) ? result.host_statuses.filter((value) => typeof value === "string") : null,
    host_errors: Array.isArray(result.host_errors) ? result.host_errors.filter((value) => typeof value === "string") : null,
    host_event_types: Array.isArray(result.host_event_types) ? result.host_event_types : null,
    host_failures: Array.isArray(result.host_failures) ? result.host_failures.map((failure) => isRecord(failure) ? { error_code: stringOrNull(failure.error_code), reason: stringOrNull(failure.reason) } : null) : null,
    host_eval: Array.isArray(result.host_eval) ? result.host_eval.map((evaluation) => isRecord(evaluation) ? { passed: evaluation.passed === true, failedRules: Array.isArray(evaluation.failedRules) ? evaluation.failedRules.filter((value) => typeof value === "string") : null, error_code: stringOrNull(evaluation.error_code) } : null) : null,
    meta: isRecord(result.meta) ? {
      elapsed_ms: numberOrNull(result.meta.elapsed_ms),
      input_tokens: numberOrNull(result.meta.input_tokens),
      output_tokens: numberOrNull(result.meta.output_tokens),
    } : isRecord(inference.meta) ? {
      elapsed_ms: numberOrNull(inferenceMeta.elapsed_ms),
      input_tokens: numberOrNull(inferenceMeta.input_tokens),
      output_tokens: numberOrNull(inferenceMeta.output_tokens),
    } : null,
  };
}

function classifyPolicyResult(item, result) {
  if (item.expected.must_abstain) return result.status === "abstained" && result.member_id === null ? "pass" : "fail";
  return result.status === "suggested" && item.expected.allowed_member_ids.includes(result.member_id) ? "pass" : "fail";
}

async function reserveComparisonBudget(path, group) {
  if (group === "A") return { bucket: "none", reservedCostUsd: 0 };
  const reservation = group === "D" ? CONSERVATIVE_RESERVATION_USD : MAIN_RESERVATION_USD;
  return withLedger(path, (ledger) => {
    const bucketName = group === "D" ? "jev" : "main_model";
    const bucket = ledger[bucketName];
    if (ledger.jev.unknown_usage === true || ledger.main_model.unknown_usage === true) throw Object.assign(new Error("unknown_usage"), { code: "unknown_usage" });
    if (bucket.request_count + bucket.reserved_requests + 1 > (bucketName === "jev" ? MAX_JEV_REQUESTS : 100)) throw Object.assign(new Error(`${bucketName}_request_budget_exhausted`), { code: `${bucketName}_request_budget_exhausted` });
    if (bucket.spent_usd + bucket.reserved_usd + reservation > (bucketName === "jev" ? MAX_JEV_USD : MAX_TOTAL_USD)) throw Object.assign(new Error(`${bucketName}_cost_budget_exhausted`), { code: `${bucketName}_cost_budget_exhausted` });
    if (ledger.total.spent_usd + ledger.total.reserved_usd + reservation > MAX_TOTAL_USD) throw Object.assign(new Error("total_model_cost_budget_exhausted"), { code: "total_model_cost_budget_exhausted" });
    bucket.reserved_requests += 1;
    bucket.reserved_usd += reservation;
    ledger.total.reserved_usd += reservation;
    return { bucket: bucketName, reservedCostUsd: reservation };
  });
}

function createProviderBudget(path, group) {
  const state = { calls: 0, estimatedCostUsd: 0, stopReason: null };
  return {
    get calls() { return state.calls; },
    get settled() { return { estimatedCostUsd: state.estimatedCostUsd, stopReason: state.stopReason }; },
    async fetch({ execute, observe }) {
      if (typeof execute !== "function" || typeof observe !== "function") throw new Error("provider_fetch_seam_required");
      if (state.stopReason !== null) throw Object.assign(new Error(state.stopReason), { code: state.stopReason });
      let reservation;
      try {
        reservation = await reserveComparisonBudget(path, group);
      } catch (error) {
        state.stopReason = error?.code ?? "budget_exhausted";
        throw error;
      }
      state.calls += 1;
      let response;
      try {
        response = await execute();
      } catch (error) {
        const settled = await settleComparisonBudget(path, group, { raw: { provider_calls: 1 }, reservation });
        state.estimatedCostUsd = null;
        state.stopReason = settled.stopReason ?? "provider_call_failed";
        throw error;
      }
      const raw = await observe(response);
      const settled = await settleComparisonBudget(path, group, { raw: normalizeComparisonRaw(raw), reservation });
      state.estimatedCostUsd = state.estimatedCostUsd === null || settled.estimatedCostUsd === null ? null : state.estimatedCostUsd + settled.estimatedCostUsd;
      state.stopReason = settled.stopReason;
      return response;
    },
    async call({ execute }) {
      if (typeof execute !== "function") throw new Error("provider_execute_required");
      if (state.stopReason !== null) throw Object.assign(new Error(state.stopReason), { code: state.stopReason });
      let reservation;
      try {
        reservation = await reserveComparisonBudget(path, group);
      } catch (error) {
        state.stopReason = error?.code ?? "budget_exhausted";
        throw error;
      }
      let raw;
      try {
        raw = await execute();
      } catch (error) {
        state.calls += 1;
        const settled = await settleComparisonBudget(path, group, { raw: { provider_calls: 1 }, reservation });
        state.estimatedCostUsd = null;
        state.stopReason = settled.stopReason ?? "provider_call_failed";
        throw error;
      }
      state.calls += 1;
      const settled = await settleComparisonBudget(path, group, { raw: normalizeComparisonRaw(raw), reservation });
      state.estimatedCostUsd = state.estimatedCostUsd === null || settled.estimatedCostUsd === null
        ? null
        : state.estimatedCostUsd + settled.estimatedCostUsd;
      state.stopReason = settled.stopReason;
      return raw;
    },
  };
}

function normalizeComparisonRaw(raw) {
  if (!isRecord(raw)) return raw;
  const meta = isRecord(raw.meta) ? raw.meta : {};
  return {
    ...raw,
    provider_calls: Number.isSafeInteger(raw.provider_calls) ? raw.provider_calls : numberOrNull(meta.provider_calls),
    requested_model: raw.requested_model ?? stringOrNull(meta.requested_model),
    returned_model: raw.returned_model ?? stringOrNull(meta.returned_model),
    usage: raw.usage ?? { input_tokens: numberOrNull(meta.input_tokens), output_tokens: numberOrNull(meta.output_tokens) },
  };
}

async function settleComparisonBudget(path, group, { raw, reservation }) {
  if (reservation.bucket === "none") return { estimatedCostUsd: 0, stopReason: null };
  return withLedger(path, (ledger) => {
    const bucket = ledger[reservation.bucket];
    const calls = Number.isSafeInteger(raw?.provider_calls) && raw.provider_calls >= 0 ? raw.provider_calls : null;
    const inputTokens = numberOrNull(raw?.meta?.input_tokens ?? raw?.usage?.input_tokens);
    const outputTokens = numberOrNull(raw?.meta?.output_tokens ?? raw?.usage?.output_tokens);
    const model = raw?.returned_model ?? raw?.requested_model;
    const priceKnown = reservation.bucket === "jev" || raw?.pricing_known === true || MAIN_MODEL_NAMES.has(model);
    if (calls === null || (calls > 0 && (inputTokens === null || outputTokens === null)) || (calls > 0 && !priceKnown)) {
      bucket.unknown_usage = true;
      if (calls !== null) bucket.request_count += calls;
      return { estimatedCostUsd: null, stopReason: "unknown_usage" };
    }
    bucket.reserved_requests = Math.max(0, bucket.reserved_requests - 1);
    bucket.reserved_usd = Math.max(0, bucket.reserved_usd - reservation.reservedCostUsd);
    ledger.total.reserved_usd = Math.max(0, ledger.total.reserved_usd - reservation.reservedCostUsd);
    if (calls === 0) return { estimatedCostUsd: 0, stopReason: null };
    const isJev = reservation.bucket === "jev";
    const inputPrice = isJev ? INPUT_USD_PER_MILLION : MAIN_INPUT_USD_PER_MILLION;
    const outputPrice = isJev ? 0 : MAIN_OUTPUT_USD_PER_MILLION;
    const estimatedCostUsd = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
    bucket.request_count += calls;
    bucket.spent_usd += estimatedCostUsd;
    ledger.total.spent_usd += estimatedCostUsd;
    return { estimatedCostUsd, stopReason: null };
  }, { allowPending: true });
}

function makeComparisonSummary(metadata, fixtures, records, stoppedReason, splits, groups) {
  const selected = new Set(splits);
  const selectedItems = fixtures.all.filter((item) => selected.has(item.split));
  const slots = [];
  for (const item of selectedItems) for (const group of groups) {
    const record = records.find((candidate) => candidate.case_id === item.case_id && candidate.group === group);
    slots.push(record ?? { case_id: item.case_id, split: item.split, category: item.category, group, status: "not_run", provider_eligible: item.provider_eligible });
  }
  const counts = { by_group: {}, by_split: {} };
  for (const group of groups) counts.by_group[group] = emptyStatusCounts();
  for (const split of splits) counts.by_split[split] = emptyStatusCounts();
  for (const slot of slots) {
    counts.by_group[slot.group][slot.status] += 1;
    counts.by_split[slot.split][slot.status] += 1;
  }
  const summaries = splits.map((split) => ({
    split,
    slots: slots.filter((slot) => slot.split === split).length,
    counts: Object.fromEntries(groups.map((group) => [group, statusCountsFor(slots.filter((slot) => slot.split === split && slot.group === group))])),
    raw_outcomes: Object.fromEntries(groups.map((group) => [group, rawOutcomeCounts(slots.filter((slot) => slot.split === split && slot.group === group))])),
    metrics: Object.fromEntries(groups.map((group) => [group, comparisonMetrics(slots.filter((slot) => slot.split === split && slot.group === group))])),
  }));
  return { schema_version: 2, round_id: metadata.round_id, execution_mode: "comparison", fixture_hashes: metadata.fixture_hashes, splits, groups, stopped_reason: stoppedReason, counts, summaries, slots, generated_at: new Date().toISOString() };
}

function emptyStatusCounts() { return { pass: 0, fail: 0, blocked: 0, not_run: 0 }; }

function statusCountsFor(values) {
  const result = emptyStatusCounts();
  for (const value of values) result[value.status] += 1;
  return result;
}

function rawOutcomeCounts(values) {
  const result = { suggested: 0, abstained: 0, blocked: 0, not_run: 0 };
  for (const value of values) {
    const outcome = value.raw_outcome ?? (value.status === "pass" || value.status === "fail" ? "abstained" : value.status);
    if (outcome in result) result[outcome] += 1;
  }
  return result;
}

function comparisonMetrics(values) {
  const eligible = values.filter((value) => value.provider_eligible === true);
  const measured = eligible.filter((value) => typeof value.elapsed_ms === "number" && value.provider_called !== false).map((value) => value.elapsed_ms).sort((a, b) => a - b);
  const usage = eligible.map((value) => value.usage ?? {}).filter((item) => item.input_tokens !== null || item.output_tokens !== null);
  const knownCosts = eligible.map((value) => value.estimated_cost_usd).filter((value) => typeof value === "number");
  return {
    denominator: eligible.length,
    pass: eligible.filter((value) => value.status === "pass").length,
    fail: eligible.filter((value) => value.status === "fail").length,
    blocked: eligible.filter((value) => value.status === "blocked").length,
    abstained: eligible.filter((value) => value.raw_outcome === "abstained").length,
    precheck_slots: values.length - eligible.length,
    p50_elapsed_ms: percentile(measured, 0.5),
    p95_elapsed_ms: percentile(measured, 0.95),
    measured_elapsed_count: measured.length,
    usage,
    estimated_cost_usd: knownCosts.length === 0 && eligible.some((value) => value.estimated_cost_usd === null) ? null : knownCosts.reduce((sum, value) => sum + value, 0),
    unknown_cost_slots: eligible.filter((value) => value.estimated_cost_usd === null).length,
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  return values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
}

function evaluationFailureReason(error) {
  const code = error?.code ?? error?.message;
  return typeof code === "string" && /^[a-z][a-z0-9_]{2,80}$/.test(code) ? code : "evaluation_failed";
}

async function acquireRoundLock(roundDir) {
  const lockPath = join(roundDir, ".round.lock");
  try {
    await mkdir(lockPath);
    return lockPath;
  } catch (error) {
    if (error?.code === "EEXIST") throw Object.assign(new Error("round_in_use"), { code: "round_in_use" });
    throw error;
  }
}

function makeAttemptRecord({ item, fixtures, roundId, roundMetadata, executionMode, body, scope, response, requestError, httpElapsedMs, settlement, inference }) {
  const hostResult = response?.body ?? null;
  const meta = isRecord(hostResult?.meta) ? hostResult.meta : {};
  const providerCalls = providerCallsFrom(hostResult);
  const status = classifyAttempt(item, hostResult, response?.http_status, requestError, providerCalls);
  return {
    schema_version: 1,
    round_id: roundId,
    execution_mode: executionMode,
    case_id: item.case_id,
    split: item.split,
    category: item.category,
    fixture_hash: fixtures.hashes[item.split === "development" ? "development" : "heldout"],
    source_head: roundMetadata.source_head,
    question_version: QUESTION_VERSION,
    input_hash: body.input_hash,
    candidate_hash: sha256(stableJson(body.state.candidates)),
    input: clone(body.state),
    scope,
    expected: clone(item.expected),
    label_rationale: item.label_rationale,
    provider_eligible: item.provider_eligible,
    status,
    provider_called: providerCalls === null ? null : providerCalls > 0,
    provider_calls: providerCalls,
    requested_model: typeof meta.requested_model === "string" ? meta.requested_model : null,
    returned_model: typeof meta.returned_model === "string" ? meta.returned_model : null,
    usage: { input_tokens: numberOrNull(meta.input_tokens), output_tokens: numberOrNull(meta.output_tokens) },
    host_elapsed_ms: numberOrNull(meta.elapsed_ms),
    http_elapsed_ms: httpElapsedMs,
    estimated_cost_usd: settlement.estimatedCostUsd,
    reserved_cost_usd: settlement.reservedCostUsd,
    reason_code: typeof hostResult?.reason_code === "string" ? hostResult.reason_code : null,
    error_code: requestError ?? (typeof meta.error_code === "string" ? meta.error_code : null),
    retry_count: 0,
    host_http_status: response?.http_status ?? null,
    host_result: sanitizeHostResult(hostResult),
    inference: sanitizeInference(inference),
  };
}

function classifyAttempt(item, result, httpStatus, requestError, providerCalls) {
  if (requestError !== null || result === null || httpStatus === undefined) return "blocked";
  if (httpStatus !== 200) return "blocked";
  if (item.provider_eligible === false && providerCalls !== 0) return "fail";
  if (result.status === "unavailable") return providerCalls === 0 ? "blocked" : "blocked";
  if (item.expected.must_abstain) return result.status === "abstained" && result.member_id === null ? "pass" : "fail";
  return result.status === "suggested" && item.expected.allowed_member_ids.includes(result.member_id) ? "pass" : "fail";
}

function sanitizeHostResult(result) {
  if (!isRecord(result)) return null;
  const safe = clone(result);
  if ("raw" in safe) delete safe.raw;
  if ("raw_response" in safe) delete safe.raw_response;
  return safe;
}

function sanitizeInference(value) {
  if (!isRecord(value)) return null;
  const meta = isRecord(value.meta) ? value.meta : {};
  return {
    decision_id: stringOrNull(value.decision_id),
    input_hash: stringOrNull(value.input_hash),
    status: stringOrNull(value.status),
    reason_code: stringOrNull(value.reason_code),
    source: stringOrNull(value.source),
    meta: {
      question_version: stringOrNull(meta.question_version),
      requested_model: stringOrNull(meta.requested_model),
      returned_model: stringOrNull(meta.returned_model),
      provider_request_id: stringOrNull(meta.provider_request_id),
      started_at: stringOrNull(meta.started_at),
      ended_at: stringOrNull(meta.ended_at),
      elapsed_ms: numberOrNull(meta.elapsed_ms),
      input_tokens: numberOrNull(meta.input_tokens),
      output_tokens: numberOrNull(meta.output_tokens),
      confidence: numberOrNull(meta.confidence),
      probabilities: sanitizeProbabilityMap(meta.probabilities),
      provider_calls: numberOrNull(meta.provider_calls),
      retry_count: 0,
      error_code: stringOrNull(meta.error_code),
    },
    raw_choice: stringOrNull(value.raw_choice),
    raw_probabilities: sanitizeProbabilityMap(value.raw_probabilities),
    final_member_id: stringOrNull(value.final_member_id),
  };
}

function sanitizeProbabilityMap(value) {
  if (!isRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).filter(([, probability]) => typeof probability === "number" && Number.isFinite(probability)).map(([key, probability]) => [key, probability]));
}

function providerCallsFrom(result) {
  const calls = result?.meta?.provider_calls;
  return Number.isSafeInteger(calls) && calls >= 0 ? calls : null;
}

function hasKnownUsage(result) {
  return Number.isSafeInteger(result?.meta?.input_tokens) && result.meta.input_tokens >= 0
    && Number.isSafeInteger(result?.meta?.output_tokens) && result.meta.output_tokens >= 0;
}

async function ensureRoundMetadata(roundDir, roundId, fixtures, repositoryRoot, now, executionMode) {
  const sourceHead = await gitHead(repositoryRoot);
  const sourceFileHashes = await sourceFileDigests(repositoryRoot);
  const builtMainSha256 = await optionalFileSha256(join(repositoryRoot, "apps/harness-service/dist/main.js"));
  const metadata = {
    schema_version: 1,
    round_id: roundId,
    execution_mode: executionMode,
    fixture_version: fixtures.manifest.fixture_version,
    label_version: fixtures.manifest.label_version,
    question_version: QUESTION_VERSION,
    source_head: sourceHead,
    fixture_hashes: fixtures.hashes,
    candidate_source_hash: sha256(stableJson(fixtures.all.map((item) => ({ case_id: item.case_id, candidates: item.input.state.candidates })))),
    candidate_order_policy: fixtures.manifest.label_policy?.candidate_order_policy ?? null,
    source_file_hashes: sourceFileHashes,
    built_main_sha256: builtMainSha256,
    created_at: (typeof now === "function" ? now : () => new Date().toISOString())(),
  };
  const path = join(roundDir, "round.json");
  try {
    const existing = JSON.parse(await readFile(path, "utf8"));
    for (const key of ["execution_mode", "fixture_version", "label_version", "question_version", "source_head", "candidate_source_hash"]) {
      if (existing[key] !== metadata[key]) throw new Error(`round_metadata_mismatch:${key}`);
    }
    if (stableJson(existing.fixture_hashes) !== stableJson(metadata.fixture_hashes)) throw new Error("round_metadata_mismatch:fixture_hashes");
    if (stableJson(existing.source_file_hashes) !== stableJson(metadata.source_file_hashes)) throw new Error("round_metadata_mismatch:source_file_hashes");
    if (existing.built_main_sha256 !== metadata.built_main_sha256) throw new Error("round_metadata_mismatch:built_main_sha256");
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return metadata;
  }
}

async function sourceFileDigests(repositoryRoot) {
  const relativePaths = [
    "apps/harness-service/src/jev-decision.ts",
    "apps/harness-service/src/product-facade.ts",
    "apps/harness-service/src/main.ts",
    "apps/desktop/electron/runtime-service.mjs",
    "scripts/jev-crew-eval.mjs",
    "scripts/jev-crew-baseline.py",
    "scripts/jev-crew-b-matcher.py",
    "evals/jev-crew/prices-20260921.json",
  ];
  const result = {};
  for (const relativePath of relativePaths) result[relativePath] = await optionalFileSha256(join(repositoryRoot, relativePath));
  return result;
}

async function optionalFileSha256(path) {
  try { return sha256(await readFile(path)); } catch (error) { if (error?.code === "ENOENT") return "unavailable"; throw error; }
}

async function gitHead(repositoryRoot) {
  try {
    const child = spawn("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    for await (const chunk of child.stdout) output += chunk;
    const code = await new Promise((resolveExit) => child.once("close", resolveExit));
    return code === 0 && /^[0-9a-f]{40}\n?$/.test(output) ? output.trim() : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function readAttemptedResults(path, executionMode) {
  try {
    const records = await readResultRecords(path);
    if (new Set(records.map((record) => record.case_id)).size !== records.length) throw new Error("duplicate_result_case");
    validateExistingExecutionMode(records, executionMode);
    return new Set(records.map((record) => record.case_id));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
}

function validateExistingExecutionMode(records, executionMode) {
  for (const record of records) {
    if (record.execution_mode !== executionMode) throw Object.assign(new Error("round_execution_mode_mismatch"), { code: "round_execution_mode_mismatch" });
  }
}

async function readResultRecords(path) {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeSummary(roundDir, fixtures, roundMetadata, records, stoppedReason) {
  const recordMap = new Map(records.map((record) => [record.case_id, record]));
  const slots = fixtures.development.map((item) => {
    const record = recordMap.get(item.case_id);
    return record === undefined
      ? { case_id: item.case_id, split: item.split, category: item.category, status: "not_run", provider_eligible: item.provider_eligible }
      : { case_id: record.case_id, split: record.split, category: record.category, execution_mode: record.execution_mode, status: record.status, provider_eligible: record.provider_eligible, provider_called: record.provider_called, provider_calls: record.provider_calls, error_code: record.error_code };
  });
  const counts = { pass: 0, fail: 0, blocked: 0, not_run: 0 };
  for (const slot of slots) counts[slot.status] += 1;
  const summary = {
    schema_version: 1,
    round_id: roundMetadata.round_id,
    execution_mode: roundMetadata.execution_mode,
    fixture_version: roundMetadata.fixture_version,
    label_version: roundMetadata.label_version,
    question_version: roundMetadata.question_version,
    source_head: roundMetadata.source_head,
    fixture_hashes: roundMetadata.fixture_hashes,
    split: "development",
    heldout_requests: 0,
    stopped_reason: stoppedReason,
    counts,
    slots,
    generated_at: new Date().toISOString(),
  };
  await writeFile(join(roundDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function reserveBudget(path) {
  return withLedger(path, (ledger) => {
    if (ledger.jev.unknown_usage === true || ledger.main_model.unknown_usage === true) throw Object.assign(new Error("unknown_usage"), { code: "unknown_usage" });
    if (ledger.jev.request_count + ledger.jev.reserved_requests + 1 > MAX_JEV_REQUESTS) throw Object.assign(new Error("jev_request_budget_exhausted"), { code: "jev_request_budget_exhausted" });
    if (ledger.jev.spent_usd + ledger.jev.reserved_usd + CONSERVATIVE_RESERVATION_USD > MAX_JEV_USD) throw Object.assign(new Error("jev_cost_budget_exhausted"), { code: "jev_cost_budget_exhausted" });
    if (ledger.total.spent_usd + ledger.total.reserved_usd + CONSERVATIVE_RESERVATION_USD > MAX_TOTAL_USD) throw Object.assign(new Error("total_model_cost_budget_exhausted"), { code: "total_model_cost_budget_exhausted" });
    ledger.jev.reserved_requests += 1;
    ledger.jev.reserved_usd += CONSERVATIVE_RESERVATION_USD;
    ledger.total.reserved_usd += CONSERVATIVE_RESERVATION_USD;
    return { reservedCostUsd: CONSERVATIVE_RESERVATION_USD };
  });
}

async function settleBudget(path, { providerCalls, usageKnown, hostKnown, hostResult }) {
  return withLedger(path, (ledger) => {
    const reservedCostUsd = CONSERVATIVE_RESERVATION_USD;
    if (!hostKnown || providerCalls === null) {
      ledger.jev.unknown_usage = true;
      return { estimatedCostUsd: null, reservedCostUsd, stopReason: "unknown_usage" };
    }
    if (providerCalls > 0 && !usageKnown) {
      ledger.jev.request_count += providerCalls;
      ledger.jev.unknown_usage = true;
      return { estimatedCostUsd: null, reservedCostUsd, stopReason: "unknown_usage" };
    }
    ledger.jev.reserved_requests = Math.max(0, ledger.jev.reserved_requests - 1);
    ledger.jev.reserved_usd = Math.max(0, ledger.jev.reserved_usd - reservedCostUsd);
    ledger.total.reserved_usd = Math.max(0, ledger.total.reserved_usd - reservedCostUsd);
    if (providerCalls === 0) return { estimatedCostUsd: 0, reservedCostUsd: 0, stopReason: null };
    const inputTokens = hostResult.meta.input_tokens;
    const estimatedCostUsd = inputTokens * INPUT_USD_PER_MILLION / 1_000_000;
    ledger.jev.request_count += providerCalls;
    ledger.jev.spent_usd += estimatedCostUsd;
    ledger.total.spent_usd += estimatedCostUsd;
    return { estimatedCostUsd, reservedCostUsd: 0, stopReason: null };
  }, { allowPending: true });
}

async function withLedger(path, mutator, { allowPending = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  await acquireLock(lockPath);
  try {
    const ledger = await readLedger(path, { allowPending });
    const result = await mutator(ledger);
    ledger.updated_at = new Date().toISOString();
    await writeAtomicJson(path, ledger);
    return result;
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await mkdir(path);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
    }
  }
  throw new Error("budget_ledger_lock_timeout");
}

async function readLedger(path, { allowPending = false } = {}) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return createEmptyLedger();
    throw error;
  }
  let existing;
  try { existing = JSON.parse(raw); } catch { throw ledgerError("ledger_corrupt"); }
  if (!isRecord(existing) || existing.schema_version !== 1 || !isRecord(existing.jev) || !isRecord(existing.main_model) || !isRecord(existing.total)) {
    throw ledgerError("ledger_schema_invalid");
  }
  const jev = validateLedgerBucket(existing.jev, "jev");
  const main = validateLedgerBucket(existing.main_model, "main_model");
  const totalSpent = strictNonnegative(existing.total.spent_usd, "total.spent_usd");
  const totalReserved = strictNonnegative(existing.total.reserved_usd, "total.reserved_usd");
  if (Math.abs(totalSpent - jev.spent_usd - main.spent_usd) > 1e-9 || Math.abs(totalReserved - jev.reserved_usd - main.reserved_usd) > 1e-9) {
    throw ledgerError("ledger_total_mismatch");
  }
  if (!allowPending && (jev.reserved_requests > 0 || jev.reserved_usd > 0 || main.reserved_requests > 0 || main.reserved_usd > 0 || totalReserved > 0)) {
    throw ledgerError("pending_budget_reservation");
  }
  return {
    ...existing,
    price: {
      ...(isRecord(existing.price) ? existing.price : {}),
      provider: "typesafe",
      effective_date: PRICE_DATE,
      input_usd_per_million: INPUT_USD_PER_MILLION,
      output_usd_per_million: 0,
      source: PRICE_DATA.jev.source,
      main_model: { model: "deepseek-v4-pro", input_usd_per_million: MAIN_INPUT_USD_PER_MILLION, output_usd_per_million: MAIN_OUTPUT_USD_PER_MILLION, basis: "peak-cache-miss-upper-bound", effective_date: PRICE_DATE },
    },
    jev,
    main_model: main,
    total: { ...existing.total, spent_usd: totalSpent, reserved_usd: totalReserved },
  };
}

function createEmptyLedger() {
  return {
    schema_version: 1,
    price: {
      provider: "typesafe",
      effective_date: PRICE_DATE,
      input_usd_per_million: INPUT_USD_PER_MILLION,
      output_usd_per_million: 0,
      source: PRICE_DATA.jev.source,
      main_model: { model: "deepseek-v4-pro", input_usd_per_million: MAIN_INPUT_USD_PER_MILLION, output_usd_per_million: MAIN_OUTPUT_USD_PER_MILLION, basis: "peak-cache-miss-upper-bound", effective_date: PRICE_DATE },
    },
    jev: { request_count: 0, reserved_requests: 0, spent_usd: 0, reserved_usd: 0, unknown_usage: false },
    main_model: { request_count: 0, reserved_requests: 0, spent_usd: 0, reserved_usd: 0, unknown_usage: false },
    total: { spent_usd: 0, reserved_usd: 0 },
  };
}

function validateLedgerBucket(bucket, name) {
  const result = {
    ...bucket,
    request_count: strictNonnegative(bucket.request_count, `${name}.request_count`),
    reserved_requests: strictNonnegative(bucket.reserved_requests, `${name}.reserved_requests`),
    spent_usd: strictNonnegative(bucket.spent_usd, `${name}.spent_usd`),
    reserved_usd: strictNonnegative(bucket.reserved_usd, `${name}.reserved_usd`),
  };
  if (typeof bucket.unknown_usage !== "boolean") throw ledgerError(`ledger_field_invalid:${name}.unknown_usage`);
  result.unknown_usage = bucket.unknown_usage;
  return result;
}

function strictNonnegative(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw ledgerError(`ledger_field_invalid:${name}`);
  return value;
}

function ledgerError(code) {
  return Object.assign(new Error(code), { code });
}

async function writeAtomicJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function createProductionRequester({ repositoryRoot, roundId, stateRoot, fetchImpl = fetch }) {
  let runtime;
  return {
    async start({ signal } = {}) {
      runtime = await spawnProductionHost({ repositoryRoot, roundId, stateRoot, signal });
      return runtime;
    },
    async request({ body, signal }) {
      if (runtime === undefined) throw new Error("production_host_not_started");
      const started = performance.now();
      let response;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6_000);
      const abortOuter = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener("abort", abortOuter, { once: true });
      let text;
      try {
        response = await fetchImpl(`${runtime.url}${SERVICE_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-anna-service-token": runtime.serviceToken },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        text = await response.text();
      } catch (error) {
        throw new Error(signal?.aborted ? "host_cancelled" : controller.signal.aborted ? "host_timeout" : error instanceof Error ? error.message : "host_network_error");
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortOuter);
      }
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* preserve no raw provider/HTTP body */ }
      return { http_status: response.status, body: parsed, http_elapsed_ms: Math.round(performance.now() - started), inference: await runtime.inferenceFor(body.decision_id) };
    },
    close: async () => { await runtime?.close?.(); },
  };
}

export function createProductionComparisonRequester({ repositoryRoot, roundId, stateRoot, fetchImpl = fetch }) {
  const jevRequester = createProductionRequester({ repositoryRoot, roundId, stateRoot, fetchImpl });
  return {
    start: jevRequester.start,
    async request({ group, case_id: caseId, state, signal, budget }) {
      if (group !== "D") throw new Error("comparison_group_adapter_required");
      if (budget === undefined) throw new Error("provider_budget_required");
      const jevState = {
        ...state,
        candidates: state.candidates.map(({ id, role, kind }) => ({ id, role, kind })),
      };
      const scope = { workspace_id: "jev-eval-comparison", actor_user_id: "jev-eval-reviewer", project_id: `project-${caseId}`, task_id: `task-${caseId}` };
      const body = { schema_version: 1, decision_id: randomUUID(), ...scope, input_hash: sha256(stableJson(state)), question_version: QUESTION_VERSION, state: jevState };
      const execute = async () => {
        const response = await jevRequester.request({ body, scope, signal });
      return response?.body === undefined
        ? { status: "blocked", source: "jev", provider_calls: null, error_code: "empty_host_response" }
        : { ...response.body, inference: response.inference };
      };
      return await budget.call({ execute });
    },
    close: async () => { await jevRequester.runtime?.close?.(); },
  };
}

export function createComparisonRequester({ repositoryRoot, roundId, stateRoot, fetchImpl = fetch }) {
  const d = createProductionComparisonRequester({ repositoryRoot, roundId, stateRoot, fetchImpl });
  let cConfig;
  let cConfigError;
  return {
    async start(options) {
      try { cConfig = await loadCConfig(process.env.ANNA_HARNESS_HOST_CONFIG_PATH); } catch (error) { cConfigError = error instanceof Error ? error.message : "price_unknown"; }
      return d.start(options);
    },
    async request({ group, case_id: caseId, state, signal, budget }) {
      if (group === "D") {
        if (budget === undefined) throw new Error("provider_budget_required");
        return d.request({ group, case_id: caseId, state, signal, budget });
      }
      if (group !== "C") throw new Error("comparison_group_adapter_required");
      if (cConfig === undefined) return { status: "blocked", source: "main_model", provider_called: false, provider_calls: 0, error_code: cConfigError ?? "main_model_config_unavailable" };
      return budget.call({ execute: () => requestCDecision({ caseId, state, signal, config: cConfig, fetchImpl }) });
    },
    async close() { await d.close?.(); },
  };
}

async function loadCConfig(path) {
  if (typeof path !== "string" || path.trim() === "") throw new Error("main_model_config_unavailable");
  const config = JSON.parse(await readFile(path, "utf8"));
  const model = config.model_name;
  const endpoint = new URL(String(config.model_endpoint ?? ""));
  if (model !== "deepseek-v4-pro" || endpoint.protocol !== "https:" || endpoint.hostname !== "api.deepseek.com" || !["/chat/completions", "/v1/chat/completions"].includes(endpoint.pathname) || endpoint.username || endpoint.password || endpoint.search) throw new Error("price_unknown");
  if (typeof config.model_api_key !== "string" || config.model_api_key.trim() === "") throw new Error("main_model_unconfigured");
  return { model, endpoint: endpoint.href, apiKey: config.model_api_key };
}

export async function requestCDecision({ caseId, state, signal, config, fetchImpl, timeoutMs = 60_000 }) {
  const localCandidates = state.candidates.map((candidate, index) => ({ id: `c${index + 1}`, role: candidate.role, kind: candidate.kind }));
  const body = {
    model: config.model,
    messages: [{ role: "system", content: "只返回JSON对象，例如 {\"choice\":\"c1\"}。choice只能是列表中的候选ID或abstain；只有任务与候选字段足以支持且能区分时才选择，否则abstain。" }, { role: "user", content: JSON.stringify({ project_goal: state.project_goal, task: state.task, candidates: localCandidates }) }],
    thinking: { type: "enabled" },
    reasoning_effort: "high",
    max_tokens: MAIN_MAX_OUTPUT_TOKENS,
    response_format: { type: "json_object" },
  };
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).byteLength > MAIN_MAX_INPUT_BYTES) return { status: "blocked", source: "main_model", provider_calls: 0, error_code: "main_model_request_too_large", requested_model: config.model, meta: { provider_calls: 0, input_tokens: null, output_tokens: null } };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });
  let response;
  const finish = (value) => { clearTimeout(timeout); signal?.removeEventListener("abort", forwardAbort); return value; };
  try { response = await fetchImpl(config.endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }, body: encoded, signal: controller.signal }); }
  catch (error) { finish(undefined); throw new Error(controller.signal.aborted ? "main_model_timeout" : error instanceof Error ? error.message : "main_model_fetch_failed"); }
  let bytes;
  try { bytes = await readBoundedResponseBytes(response, 1024 * 1024, controller.signal); }
  catch { finish(undefined); throw new Error("main_model_timeout"); }
  if (bytes === null) return finish({ status: "blocked", source: "main_model", provider_calls: 1, error_code: "main_model_response_too_large", requested_model: config.model, meta: { provider_calls: 1, input_tokens: null, output_tokens: null } });
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { return finish({ status: "fail", source: "main_model", provider_calls: 1, error_code: "invalid_response", requested_model: config.model, meta: { provider_calls: 1, input_tokens: null, output_tokens: null } }); }
  if (!response.ok) return finish({ status: "blocked", source: "main_model", provider_calls: 1, error_code: `main_model_http_${response.status}`, requested_model: config.model, meta: { provider_calls: 1, input_tokens: null, output_tokens: null } });
  const usage = payload.usage;
  let parsed;
  try { parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? ""); } catch { return finish({ status: "fail", source: "main_model", provider_calls: 1, error_code: "invalid_response", requested_model: config.model, meta: { provider_calls: 1, input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null } }); }
  const choice = parsed?.choice;
  if (typeof choice !== "string" || !(choice === "abstain" || /^c[1-9][0-9]*$/.test(choice))) return finish({ status: "fail", source: "main_model", provider_calls: 1, error_code: "invalid_choice", requested_model: config.model, meta: { provider_calls: 1, input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null } });
  const index = typeof choice === "string" && /^c[1-9][0-9]*$/.test(choice) ? Number(choice.slice(1)) - 1 : -1;
  if (choice !== "abstain" && (index < 0 || index >= state.candidates.length)) return finish({ status: "fail", source: "main_model", provider_calls: 1, error_code: "invalid_choice", requested_model: config.model, meta: { provider_calls: 1, input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null } });
  const selected = index >= 0 ? state.candidates[index] : null;
  return finish({ status: selected ? "suggested" : "abstained", member_id: selected?.id ?? null, source: "main_model", provider_called: true, provider_calls: 1, raw_choice: choice, final_member_id: selected?.id ?? null, requested_model: config.model, returned_model: payload.model ?? null, meta: { provider_calls: 1, input_tokens: usage?.prompt_tokens ?? null, output_tokens: usage?.completion_tokens ?? null } });
}

async function readBoundedResponseBytes(response, limit, signal) {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks = [];
  let total = 0;
  while (true) {
    signal?.throwIfAborted();
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) { await reader.cancel(); return null; }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function spawnProductionHost({ repositoryRoot, roundId, stateRoot, signal }) {
  if (signal?.aborted) throw new Error("run_cancelled");
  const buildPath = join(repositoryRoot, "apps/harness-service/dist/main.js");
  const isolatedRoot = resolve(stateRoot ?? join(DEFAULT_STATE_ROOT, "host", roundId));
  await mkdir(isolatedRoot, { recursive: true });
  const port = await freePort();
  const token = randomUUID();
  const keyFile = process.env.ANNA_JEV_API_KEY_FILE;
  const configuredHostConfig = process.env.ANNA_HARNESS_HOST_CONFIG_PATH?.trim() || undefined;
  const hostConfig = configuredHostConfig ?? join(isolatedRoot, "host.json");
  if (configuredHostConfig === undefined) {
    try {
      await writeFile(hostConfig, "{}\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existingConfig;
      try { existingConfig = JSON.parse(await readFile(hostConfig, "utf8")); } catch { throw new Error("isolated_host_config_invalid"); }
      if (!isRecord(existingConfig) || Object.keys(existingConfig).length !== 0) throw new Error("isolated_host_config_not_empty");
    }
  }
  const childEnv = {
    ...process.env,
    ANNA_HARNESS_HOST: "127.0.0.1",
    ANNA_HARNESS_HOST_PORT: String(port),
    ANNA_HARNESS_SERVICE_TOKEN: token,
    ANNA_JEV_ENABLED: "1",
    ANNA_HARNESS_SESSION_STORE_PATH: join(isolatedRoot, "session-store.json"),
    ANNA_HARNESS_HOST_EVENT_STORE_PATH: join(isolatedRoot, "event-store.sqlite"),
    ANNA_HARNESS_HOST_WORKSPACE_ROOT: join(isolatedRoot, "workdir"),
    ANNA_HARNESS_OMP_RUNTIME_ROOT: join(repositoryRoot, "build/omp-runtime/darwin-arm64"),
    ...(keyFile === undefined ? {} : { ANNA_JEV_API_KEY_FILE: keyFile }),
    ANNA_HARNESS_HOST_CONFIG_PATH: hostConfig,
  };
  for (const key of [
    "ANNA_RUNTIME_CONFIG_PATH",
    "ANNA_HARNESS_BUSINESS_ORIGIN",
    "ANNA_HARNESS_BUSINESS_SERVICE_TOKEN",
    "ANNA_JEV_API_KEY",
  ]) delete childEnv[key];
  const child = spawn(process.execPath, [buildPath], { cwd: repositoryRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const inferenceRecords = [];
  let stderrTail = "";
  let ready;
  const readyPromise = new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let readySeen = false;
    const timeout = setTimeout(() => { signal?.removeEventListener("abort", abortStartup); rejectReady(new Error("production_host_start_timeout")); }, 30_000);
    const abortStartup = () => { clearTimeout(timeout); rejectReady(new Error("run_cancelled")); };
    signal?.addEventListener("abort", abortStartup, { once: true });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.status === "ready" && typeof message.url === "string") {
            readySeen = true;
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abortStartup);
            resolveReady(message.url);
          }
        } catch { /* never expose child stdout */ }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrTail += chunk.toString("utf8");
      const lines = stderrTail.split("\n");
      stderrTail = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.type === "jev.inference") inferenceRecords.push(sanitizeInference(message));
        } catch { /* never expose child stderr */ }
      }
    });
    child.once("error", () => { clearTimeout(timeout); signal?.removeEventListener("abort", abortStartup); rejectReady(new Error("production_host_start_failed")); });
    child.once("exit", () => { if (!readySeen) { clearTimeout(timeout); signal?.removeEventListener("abort", abortStartup); rejectReady(new Error("production_host_exited")); } });
  });
  try {
    ready = await readyPromise;
  } catch (error) {
    await stopOwnedChild(child);
    throw error;
  }
  return {
    url: ready,
    serviceToken: token,
    inferenceRecords,
    inferenceFor: async (decisionId) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const record = inferenceRecords.find((candidate) => candidate?.decision_id === decisionId);
        if (record !== undefined) return record;
        await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      }
      return inferenceRecords.find((candidate) => candidate?.decision_id === decisionId) ?? null;
    },
    close: async () => {
      await stopOwnedChild(child);
    },
  };
}

async function stopOwnedChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), 5_000);
    child.once("exit", () => { clearTimeout(timer); resolveExit(true); });
  });
  if (!exited && child.exitCode === null) child.kill("SIGKILL");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => { server.once("error", rejectListen); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : null;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!Number.isInteger(port)) throw new Error("free_port_failed");
  return port;
}

function dryRunSummary(fixtures) {
  return {
    execution_mode: "dry-run",
    mode: "dry-run",
    fixture_version: fixtures.manifest.fixture_version,
    label_version: fixtures.manifest.label_version,
    question_version: QUESTION_VERSION,
    requests_sent: 0,
    heldout_requests: 0,
    source: {
      development_sha256: fixtures.hashes.development,
      heldout_sha256: fixtures.hashes.heldout,
    },
    counts: {
      development: fixtures.development.length,
      heldout: fixtures.heldout.length,
      total: fixtures.all.length,
      by_category: fixtures.counts.by_category,
      provider_eligible_total: fixtures.counts.provider_eligible,
    },
  };
}

function dryRunComparisonSummary(fixtures, split, groups) {
  const selectedSplits = split === "all" ? COMPARISON_SPLITS : [split];
  return {
    execution_mode: "dry-run",
    mode: "comparison",
    groups,
    split,
    requests_sent: 0,
    heldout_requests: 0,
    source: { development_sha256: fixtures.hashes.development, heldout_sha256: fixtures.hashes.heldout },
    counts: Object.fromEntries(selectedSplits.map((name) => [name, fixtures[name].length * groups.length])),
  };
}

function countBy(values, selector) {
  const result = {};
  for (const value of values) {
    const key = selector(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function nowMs(now) {
  return typeof now === "function" ? Date.parse(now()) : performance.now();
}

const isMain = process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write("Usage: node scripts/jev-crew-eval.mjs [--mode jev|comparison] [--live --round ID] [--split development|heldout|all] [--groups A,B,C,D] [--final-freeze] [--limit N] [--output-dir DIR] [--ledger PATH]\n");
    } else {
      const fixtures = await loadFrozenFixtures(REPOSITORY_ROOT);
      if (!args.live) {
        if (args.mode === "comparison" && (args.split === "heldout" || args.split === "all") && !args.finalFreeze) throw new Error("heldout_requires_final_freeze");
        const summary = args.mode === "comparison"
          ? dryRunComparisonSummary(fixtures, args.split, args.groups ?? COMPARISON_GROUPS)
          : dryRunSummary(fixtures);
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      } else {
        const abortController = new AbortController();
        const onSignal = () => abortController.abort();
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        let result;
        try {
          result = args.mode === "comparison"
            ? await runComparison({
              repositoryRoot: REPOSITORY_ROOT,
              roundId: args.roundId,
              limit: args.limitSpecified ? args.limit : args.split === "all" ? 32 : args.limit,
              outputDir: args.outputDir,
              ledgerPath: args.ledgerPath,
              split: args.split,
              groups: args.groups ?? COMPARISON_GROUPS,
              finalFreeze: args.finalFreeze,
              signal: abortController.signal,
              requestGroup: createComparisonRequester({ repositoryRoot: REPOSITORY_ROOT, roundId: args.roundId, stateRoot: undefined }),
            })
            : await runEvaluation({
              repositoryRoot: REPOSITORY_ROOT,
              roundId: args.roundId,
              limit: args.limit,
              outputDir: args.outputDir,
              ledgerPath: args.ledgerPath,
              signal: abortController.signal,
            });
        } finally {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (result.stopped_reason === "interrupted") process.exitCode = 130;
      }
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "jev_eval_failed"}\n`);
    process.exitCode = 1;
  }
}
