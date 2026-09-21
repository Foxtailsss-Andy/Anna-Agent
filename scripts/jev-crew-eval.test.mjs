import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildFairState,
  deterministicProposal,
  loadFrozenFixtures,
  parseArgs,
  runComparison,
  recordReadyWorkerEvidence,
  requestCDecision,
  runEvaluation,
} from "./jev-crew-eval.mjs";

const repositoryRoot = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

test("default args are dry-run and live is explicit", () => {
  assert.equal(parseArgs([]).live, false);
  assert.equal(parseArgs(["--dry-run"]).live, false);
  assert.equal(parseArgs(["--limit", "1"]).limit, 1);
  assert.throws(() => parseArgs(["--live"]), /--round/);
  assert.deepEqual(parseArgs(["--mode", "comparison", "--split", "heldout", "--groups", "A,D", "--final-freeze"]), {
    live: false,
    mode: "comparison",
    roundId: undefined,
    limit: 8,
    limitSpecified: false,
    split: "heldout",
    groups: ["A", "D"],
    finalFreeze: true,
    outputDir: undefined,
    ledgerPath: parseArgs([]).ledgerPath,
    help: false,
  });
});

test("frozen fixtures validate both splits and manifest hashes", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  assert.equal(fixtures.development.length, 8);
  assert.equal(fixtures.heldout.length, 24);
  assert.equal(fixtures.all.filter((item) => item.provider_eligible).length, 29);
  assert.deepEqual(fixtures.counts.by_category, {
    distinguishable: 16,
    ambiguous: 8,
    no_fit: 8,
  });
});

test("live runner sends only state and never sends heldout or labels", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const requests = [];
  const result = await runEvaluation({
    repositoryRoot,
    roundId: "test-state-boundary",
    limit: 1,
    outputDir,
    ledgerPath: join(outputDir, "budget-ledger.json"),
    requestHost: async ({ body }) => {
      requests.push(body);
      return {
        http_status: 200,
        body: {
          schema_version: 1,
          decision_id: body.decision_id,
          status: "abstained",
          member_id: null,
          reason_code: "model_abstain",
          source: "jev",
          meta: {
            question_version: "crew-assignee-v1",
            requested_model: "jev-1.13.0",
            returned_model: "jev-1.13.0",
            provider_request_id: "fixture-request",
            started_at: "2026-09-21T00:00:00.000Z",
            ended_at: "2026-09-21T00:00:00.010Z",
            elapsed_ms: 10,
            input_tokens: 10,
            output_tokens: 1,
            confidence: 1,
            probabilities: { abstain: 1 },
            provider_calls: 1,
            retry_count: 0,
            error_code: null,
          },
        },
      };
    },
  });
  assert.equal(result.attempted, 1);
  assert.equal(result.execution_mode, "fixture");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].state);
  assert.equal("expected" in requests[0], false);
  assert.equal("qualification" in requests[0], false);
  assert.equal(requests[0].state.candidates[0].id, "dev01-member-a");
  assert.match(requests[0].decision_id, /^[0-9a-f-]{36}$/);
  const raw = await readFile(join(outputDir, "test-state-boundary", "results.jsonl"), "utf8");
  assert.equal(raw.split("\n").filter(Boolean).length, 1);
  assert.match(raw, /"split":"development"/);
  assert.doesNotMatch(raw, /heldout-01/);
  const record = JSON.parse(raw.trim());
  assert.equal(record.reason_code, "model_abstain");
  assert.equal(record.error_code, null);
});

test("unknown usage blocks the next case and retains a nonzero reservation", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  let calls = 0;
  const result = await runEvaluation({
    repositoryRoot,
    roundId: "test-unknown-usage",
    limit: 2,
    outputDir,
    ledgerPath: join(outputDir, "budget-ledger.json"),
    requestHost: async ({ body }) => {
      calls += 1;
      return {
        http_status: 200,
        body: {
          schema_version: 1,
          decision_id: body.decision_id,
          status: "unavailable",
          member_id: null,
          reason_code: "jev_timeout",
          source: "none",
          meta: {
            question_version: "crew-assignee-v1",
            requested_model: "jev-1.13.0",
            returned_model: null,
            provider_request_id: null,
            started_at: "2026-09-21T00:00:00.000Z",
            ended_at: "2026-09-21T00:00:04.000Z",
            elapsed_ms: 4000,
            input_tokens: null,
            output_tokens: null,
            confidence: null,
            probabilities: null,
            provider_calls: 1,
            retry_count: 0,
            error_code: "jev_timeout",
          },
        },
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.attempted, 1);
  assert.equal(result.stopped_reason, "unknown_usage");
  const ledger = JSON.parse(await readFile(join(outputDir, "budget-ledger.json"), "utf8"));
  assert.equal(ledger.main_model.request_count, 0);
  assert.equal(ledger.jev.request_count, 1);
  assert.equal(ledger.jev.unknown_usage, true);
  assert.ok(ledger.jev.reserved_usd > 0);
});

test("rerunning a round does not repeat a completed case", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  let calls = 0;
  const requestHost = async ({ body }) => {
    calls += 1;
    return { http_status: 200, body: {
      schema_version: 1,
      decision_id: body.decision_id,
      status: "abstained",
      member_id: null,
      reason_code: "no_candidates",
      source: "none",
      meta: { question_version: "crew-assignee-v1", requested_model: "jev-1.13.0", returned_model: null, provider_request_id: null, started_at: "2026-09-21T00:00:00.000Z", ended_at: "2026-09-21T00:00:00.000Z", elapsed_ms: 0, input_tokens: null, output_tokens: null, confidence: null, probabilities: null, provider_calls: 0, retry_count: 0, error_code: null },
    } };
  };
  await runEvaluation({ repositoryRoot, roundId: "test-repeat", limit: 1, outputDir, ledgerPath, requestHost });
  await runEvaluation({ repositoryRoot, roundId: "test-repeat", limit: 1, outputDir, ledgerPath, requestHost });
  assert.equal(calls, 2);
});

test("budget exhaustion makes zero Host requests and preserves main-model ledger fields", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const original = {
    schema_version: 1,
    jev: { request_count: 0, reserved_requests: 0, spent_usd: 2, reserved_usd: 0, unknown_usage: false },
    main_model: { request_count: 4, reserved_requests: 0, spent_usd: 1, reserved_usd: 0, unknown_usage: false },
    total: { spent_usd: 3, reserved_usd: 0 },
  };
  await writeFile(ledgerPath, `${JSON.stringify(original)}\n`);
  let calls = 0;
  const result = await runEvaluation({
    repositoryRoot,
    roundId: "test-budget",
    limit: 1,
    outputDir,
    ledgerPath,
    requestHost: async () => { calls += 1; throw new Error("must_not_call"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.attempted, 0);
  assert.equal(result.stopped_reason, "jev_cost_budget_exhausted");
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8")), original);
});

test("unknown main-model usage also blocks Jev before any Host request", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    schema_version: 1,
    jev: { request_count: 0, reserved_requests: 0, spent_usd: 0, reserved_usd: 0, unknown_usage: false },
    main_model: { request_count: 3, reserved_requests: 0, spent_usd: 0.5, reserved_usd: 0, unknown_usage: true },
    total: { spent_usd: 0.5, reserved_usd: 0 },
  })}\n`);
  let calls = 0;
  const result = await runEvaluation({
    repositoryRoot,
    roundId: "test-main-unknown",
    limit: 1,
    outputDir,
    ledgerPath,
    requestHost: async () => { calls += 1; throw new Error("must_not_call"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.stopped_reason, "unknown_usage");
});

test("malformed existing ledger is rejected without zeroing or overwriting it", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const original = "{\"schema_version\":1,\"jev\":{\"spent_usd\":\"unknown\"}}\n";
  await writeFile(ledgerPath, original);
  const result = await runEvaluation({
    repositoryRoot,
    roundId: "test-corrupt-ledger",
    limit: 1,
    outputDir,
    ledgerPath,
    requestHost: async () => { throw new Error("must_not_call"); },
  });
  assert.equal(result.attempted, 0);
  assert.equal(result.stopped_reason, "ledger_schema_invalid");
  assert.equal(await readFile(ledgerPath, "utf8"), original);
});

test("a round rejects resume after a tracked source file changes", async () => {
  const temporaryRepository = await mkdtemp(join(tmpdir(), "anna-jev-repo-"));
  const tracked = [
    "evals/jev-crew/fixtures/development.json",
    "evals/jev-crew/fixtures/heldout.json",
    "evals/jev-crew/fixtures/manifest.json",
    "apps/harness-service/src/jev-decision.ts",
    "apps/harness-service/src/product-facade.ts",
    "apps/harness-service/src/main.ts",
    "apps/desktop/electron/runtime-service.mjs",
    "scripts/jev-crew-eval.mjs",
  ];
  for (const relativePath of tracked) {
    const target = join(temporaryRepository, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, await readFile(join(repositoryRoot, relativePath)));
  }
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const requestHost = async ({ body }) => ({ http_status: 200, body: {
    schema_version: 1,
    decision_id: body.decision_id,
    status: "abstained",
    member_id: null,
    reason_code: "model_abstain",
    source: "jev",
    meta: { provider_calls: 0, input_tokens: null, output_tokens: null, retry_count: 0 },
  } });
  await runEvaluation({ repositoryRoot: temporaryRepository, roundId: "test-source-pin", limit: 1, outputDir, ledgerPath, requestHost });
  const mainPath = join(temporaryRepository, "apps/harness-service/src/main.ts");
  await writeFile(mainPath, `${await readFile(mainPath, "utf8")}\n`);
  await assert.rejects(
    runEvaluation({ repositoryRoot: temporaryRepository, roundId: "test-source-pin", limit: 1, outputDir, ledgerPath, requestHost }),
    /round_metadata_mismatch:source_file_hashes/,
  );
});

test("a pending reservation blocks a later process until usage is resolved", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    schema_version: 1,
    jev: { request_count: 1, reserved_requests: 1, spent_usd: 0, reserved_usd: 0.002688, unknown_usage: false },
    main_model: { request_count: 0, reserved_requests: 0, spent_usd: 0, reserved_usd: 0, unknown_usage: false },
    total: { spent_usd: 0, reserved_usd: 0.002688 },
  })}\n`);
  const result = await runEvaluation({
    repositoryRoot,
    roundId: "test-pending-ledger",
    limit: 1,
    outputDir,
    ledgerPath,
    requestHost: async () => { throw new Error("must_not_call"); },
  });
  assert.equal(result.attempted, 0);
  assert.equal(result.stopped_reason, "pending_budget_reservation");
});

test("round lock rejects an overlapping caller and preserves one result per case", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  let release;
  const releasePromise = new Promise((resolve) => { release = resolve; });
  const requestHost = async ({ signal }) => {
    entered();
    await new Promise((resolve) => {
      const onAbort = () => resolve();
      signal?.addEventListener("abort", onAbort, { once: true });
      releasePromise.then(resolve);
    });
    return { http_status: 200, body: { status: "abstained", member_id: null, reason_code: "model_abstain", source: "jev", meta: { provider_calls: 0, input_tokens: null, output_tokens: null, retry_count: 0 } } };
  };
  const first = runEvaluation({ repositoryRoot, roundId: "test-round-lock", limit: 1, outputDir, ledgerPath, requestHost });
  await enteredPromise;
  await assert.rejects(
    runEvaluation({ repositoryRoot, roundId: "test-round-lock", limit: 1, outputDir, ledgerPath, requestHost }),
    /round_in_use/,
  );
  release();
  await first;
  const records = (await readFile(join(outputDir, "test-round-lock", "results.jsonl"), "utf8")).trim().split("\n");
  assert.equal(records.length, 1);
});

test("round mode is fixed and existing records cannot be resumed under another mode", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const requestHost = async ({ body }) => ({ http_status: 200, body: {
    schema_version: 1,
    decision_id: body.decision_id,
    status: "suggested",
    member_id: "dev01-member-a",
    reason_code: "model_choice",
    source: "jev",
    meta: { provider_calls: 0, input_tokens: null, output_tokens: null, retry_count: 0, error_code: null },
  } });
  await runEvaluation({ repositoryRoot, roundId: "test-mode-pin", limit: 1, outputDir, ledgerPath, requestHost });
  const roundPath = join(outputDir, "test-mode-pin", "round.json");
  const round = JSON.parse(await readFile(roundPath, "utf8"));
  assert.equal(round.execution_mode, "fixture");
  await writeFile(roundPath, `${JSON.stringify({ ...round, execution_mode: "live" })}\n`);
  await assert.rejects(
    runEvaluation({ repositoryRoot, roundId: "test-mode-pin", limit: 1, outputDir, ledgerPath, requestHost }),
    /round_metadata_mismatch:execution_mode/,
  );
  await writeFile(roundPath, `${JSON.stringify(round)}\n`);
  const resultsPath = join(outputDir, "test-mode-pin", "results.jsonl");
  const record = JSON.parse((await readFile(resultsPath, "utf8")).trim());
  await writeFile(resultsPath, `${JSON.stringify({ ...record, execution_mode: "live" })}\n`);
  await assert.rejects(
    runEvaluation({ repositoryRoot, roundId: "test-mode-pin", limit: 1, outputDir, ledgerPath, requestHost }),
    /round_execution_mode_mismatch/,
  );
});

test("startup failure still writes an eight-slot summary and releases the round lock", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const requestHost = {
    async start() { throw Object.assign(new Error("production_host_exited"), { code: "production_host_exited" }); },
    async request() { throw new Error("must_not_call"); },
  };
  await assert.rejects(
    runEvaluation({ repositoryRoot, roundId: "test-startup-failure", limit: 1, outputDir, ledgerPath, requestHost }),
    /production_host_exited/,
  );
  const summary = JSON.parse(await readFile(join(outputDir, "test-startup-failure", "summary.json"), "utf8"));
  assert.equal(summary.execution_mode, "fixture");
  assert.equal(summary.stopped_reason, "production_host_exited");
  assert.equal(summary.counts.not_run, 8);
  assert.equal(summary.counts.pass, 0);
  await assert.rejects(readFile(join(outputDir, "test-startup-failure", ".round.lock")));
  await assert.rejects(readFile(ledgerPath));
});

test("startup failure summary preserves records from the same round", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const completedHost = async ({ body }) => ({ http_status: 200, body: {
    schema_version: 1,
    decision_id: body.decision_id,
    status: "suggested",
    member_id: "dev01-member-a",
    reason_code: "model_choice",
    source: "jev",
    meta: { provider_calls: 0, input_tokens: null, output_tokens: null, retry_count: 0, error_code: null },
  } });
  await runEvaluation({ repositoryRoot, roundId: "test-startup-preserve", limit: 1, outputDir, ledgerPath, requestHost: completedHost });
  const failingHost = { async start() { throw Object.assign(new Error("production_host_exited"), { code: "production_host_exited" }); } };
  await assert.rejects(
    runEvaluation({ repositoryRoot, roundId: "test-startup-preserve", limit: 1, outputDir, ledgerPath, requestHost: failingHost }),
    /production_host_exited/,
  );
  const summary = JSON.parse(await readFile(join(outputDir, "test-startup-preserve", "summary.json"), "utf8"));
  assert.equal(summary.counts.pass, 1);
  assert.equal(summary.counts.not_run, 7);
  assert.equal(summary.slots[0].execution_mode, "fixture");
});

test("fixture runner abort stops the current request and leaves an unresolved reservation", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-eval-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  const controller = new AbortController();
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const resultPromise = runEvaluation({
    repositoryRoot,
    roundId: "test-interrupt",
    limit: 1,
    outputDir,
    ledgerPath,
    signal: controller.signal,
    requestHost: async ({ signal }) => {
      entered();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("host_cancelled");
    },
  });
  await enteredPromise;
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.execution_mode, "fixture");
  assert.equal(result.stopped_reason, "unknown_usage");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.ok(ledger.jev.reserved_usd > 0);
});

test("fair comparison input keeps shared fields, candidate order, and hides labels", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const item = fixtures.development[0];
  const fair = buildFairState(item);
  assert.equal(fair.task.description, "");
  assert.equal(fair.task.acceptance_criteria, null);
  assert.equal(fair.project_goal, item.input.state.project_goal);
  assert.deepEqual(fair.candidates.map((candidate) => candidate.id), item.input.state.candidates.map((candidate) => candidate.id));
  assert.deepEqual(fair.candidates.map((candidate) => candidate.display_name), fair.candidates.map((candidate) => candidate.id));
  assert.equal("expected" in fair, false);
  assert.equal("qualification" in fair, false);
});

test("deterministic comparison group reports the real role rule and zero provider calls", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const item = fixtures.development[0];
  const result = deterministicProposal(item);
  assert.equal(result.source, "role_rules");
  assert.equal(result.provider_called, false);
  assert.equal(result.provider_calls, 0);
  assert.equal(result.member_id, "dev01-member-a");
  assert.equal(result.status, "suggested");
});

test("comparison keeps one slot per case and group, with separate split summaries", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-compare-"));
  const requests = [];
  const result = await runComparison({
    repositoryRoot,
    roundId: "test-abcd-slots",
    fixtures,
    split: "development",
    outputDir,
    ledgerPath: join(outputDir, "budget-ledger.json"),
    groups: ["A", "B", "C", "D"],
    requestGroup: async ({ group, case_id, state, budget }) => {
      requests.push({ group, case_id, state });
      if (group === "B") return { status: "blocked", source: "host", provider_calls: 0, error_code: "provider_unavailable" };
      if (group === "C") return { status: "not_run", source: "main_model", provider_calls: 0, error_code: "price_unknown" };
      return budget.call({ execute: async () => ({ status: "abstained", member_id: null, source: "jev", requested_model: "jev-1.13.0", returned_model: "jev-1.13.0", meta: { provider_calls: 1, input_tokens: 10, output_tokens: 1 } }) });
    },
  });
  assert.equal(result.slots, 32);
  assert.equal(result.split, "development");
  assert.deepEqual(result.counts.by_group, { A: { pass: 3, fail: 5, blocked: 0, not_run: 0 }, B: { pass: 0, fail: 0, blocked: 7, not_run: 1 }, C: { pass: 0, fail: 0, blocked: 0, not_run: 8 }, D: { pass: 3, fail: 4, blocked: 0, not_run: 1 } });
  assert.equal(requests.length, 21);
  assert.ok(requests.every(({ state }) => !("expected" in state) && !("qualification" in state)));
  assert.equal(result.summaries.length, 1);
  assert.equal(result.summaries[0].split, "development");
});

test("ready Worker evidence separates assignment, run, terminal state, and artifacts", async () => {
  const evidence = await recordReadyWorkerEvidence({
    caseId: "dev-01",
    assignment: { task_id: "task-dev-01", member_id: "dev01-member-b", receipt_id: "receipt-1" },
    startWorker: async () => ({ run_ref: "run-1", started: true }),
    readWorker: async () => ({ status: "completed", artifact_ids: ["artifact-1"] }),
  });
  assert.deepEqual(evidence, {
    case_id: "dev-01",
    assignment: { task_id: "task-dev-01", member_id: "dev01-member-b", receipt_id: "receipt-1" },
    run: { run_ref: "run-1", started: true },
    terminal: { status: "completed", artifact_ids: ["artifact-1"] },
    worker_status: "completed",
  });
});

test("heldout comparison requires an explicit final freeze", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-heldout-"));
  await assert.rejects(
    runComparison({
      repositoryRoot,
      roundId: "test-heldout-guard",
      split: "heldout",
      outputDir,
      ledgerPath: join(outputDir, "budget-ledger.json"),
      groups: ["A"],
      requestGroup: async () => ({ status: "abstained", provider_calls: 0 }),
    }),
    /heldout_requires_final_freeze/,
  );
});

test("provider budget rejects the second B call before its transport executes", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const outputDir = await mkdtemp(join(tmpdir(), "anna-jev-b-budget-"));
  const ledgerPath = join(outputDir, "budget-ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify({
    schema_version: 1,
    jev: { request_count: 0, reserved_requests: 0, spent_usd: 0, reserved_usd: 0, unknown_usage: false },
    main_model: { request_count: 99, reserved_requests: 0, spent_usd: 0, reserved_usd: 0, unknown_usage: false },
    total: { spent_usd: 0, reserved_usd: 0 },
  })}\n`);
  let executed = 0;
  const result = await runComparison({
    repositoryRoot,
    roundId: "test-b-provider-budget",
    fixtures,
    split: "development",
    limit: 1,
    groups: ["B"],
    outputDir,
    ledgerPath,
    requestGroup: async ({ budget }) => {
      await budget.call({ execute: async () => { executed += 1; return { status: "abstained", provider_calls: 1, requested_model: "deepseek-v4-pro", returned_model: "deepseek-v4-pro", meta: { input_tokens: 1, output_tokens: 1 } }; } });
      await budget.call({ execute: async () => { executed += 1; return { status: "abstained", provider_calls: 1, requested_model: "deepseek-v4-pro", returned_model: "deepseek-v4-pro", meta: { input_tokens: 1, output_tokens: 1 } }; } });
      return { status: "abstained", provider_calls: 2 };
    },
  });
  assert.equal(executed, 1);
  assert.equal(result.stopped_reason, "main_model_request_budget_exhausted");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger.main_model.request_count, 100);
});

test("C sends fair JSON-only input with bounded output and maps local choice", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const cFixture = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/jev-crew/c-config.json"), "utf8"));
  let request;
  const result = await requestCDecision({
    caseId: "dev-01",
    state: buildFairState(fixtures.development[0]),
    config: { ...cFixture, apiKey: "fixture" },
    fetchImpl: async (_input, init) => {
      request = JSON.parse(init.body);
      return new Response(JSON.stringify({ model: "deepseek-v4-pro", choices: [{ message: { content: JSON.stringify({ choice: "c1" }) } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(result.member_id, "dev01-member-a");
  assert.equal(request.max_tokens, 4096);
  assert.deepEqual(request.response_format, { type: "json_object" });
  assert.equal("tools" in request, false);
  assert.equal(request.messages[1].content.includes("description"), true);
  assert.equal(JSON.parse(request.messages[1].content).task.description, "");
});

test("C keeps invalid choices separate from abstention and preserves usage", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const state = buildFairState(fixtures.development[0]);
  const cFixture = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/jev-crew/c-config.json"), "utf8"));
  for (const content of ["{}", JSON.stringify({ choice: "c99" }), "not-json"]) {
    const result = await requestCDecision({
      caseId: "invalid-c",
      state,
      config: { ...cFixture, apiKey: "fixture" },
      fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 2 } }), { status: 200 }),
    });
    assert.equal(result.status, "fail");
    assert.equal(result.error_code, content === "not-json" ? "invalid_response" : "invalid_choice");
    assert.equal(result.meta.input_tokens, 7);
  }
});

test("C deadline covers delayed response body", async () => {
  const fixtures = await loadFrozenFixtures(repositoryRoot);
  const state = buildFairState(fixtures.development[0]);
  const cFixture = JSON.parse(await readFile(join(repositoryRoot, "tests/fixtures/jev-crew/c-config.json"), "utf8"));
  await assert.rejects(
    requestCDecision({
      caseId: "timeout-c",
      state,
      config: { ...cFixture, apiKey: "fixture" },
      timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { setTimeout(() => { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }, 100); } }), { status: 200 }),
    }),
    /main_model_timeout/,
  );
});
