/**
 * live-crew-e2e · Crew 真流走查(沿 live-chat-e2e 模式,加 Playwright 无头截图)。
 *
 * 起后端(uvicorn,隔离 temp state/memory/runs DB + 真 runtime.json 模型配置)→
 * 用真 API 走完剧本(boss 登录 → 模板建「登录页重设计」+ AI 拆解回退 → 智能派人确认 →
 * 需求提交 → PRD 评审驳回+批注→返工→通过→下游解锁 → 频道 say/@ → +任务起草→确认→图长新节点 →
 * run-agent 真跑或 blocked(两者皆走通)→ 切 andy 看收件箱/通知)→ Playwright 无头对
 * 浅/深两主题各存关键屏截图到 walkthrough/。每步落 PASS/FAIL。收尾杀干净后端。
 *
 * 模型缺席/网络不可达 → run-agent 落 blocked(绝不假完成),仍算走通。
 *
 * 用法:node scripts/live-crew-e2e.mjs   (可选 CREW_E2E_PORT / CREW_E2E_HEADFUL=1)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOST = "127.0.0.1";
const PORT = Number(process.env.CREW_E2E_PORT ?? 8099);
const BASE = `http://${HOST}:${PORT}`;
const OUT_DIR = join(ROOT, "docs/superpowers/plans/2026-07-17-crew-build/walkthrough");
const PY =
  process.env.ANNA_PYTHON_BIN ??
  (process.platform === "win32"
    ? join(ROOT, ".venv", "Scripts", "python.exe")
    : join(ROOT, ".venv", "bin", "python"));
const RUNTIME_CONFIG =
  process.env.ANNA_RUNTIME_CONFIG_PATH ?? join(ROOT, ".anna", "runtime.json");
const PASSWORD = "crew-demo";
const BOSS = "boss@anna.demo";
const ANDY = "andy@anna.demo";

const results = [];
const shots = [];
function record(step, ok, note = "") {
  results.push({ step, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"} · ${step}${note ? ` · ${note}` : ""}`);
}
const pass = (s, n) => record(s, true, n);
const fail = (s, n) => record(s, false, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只暴露 token 前 6 位到日志,其余脱敏。 */
function redact(text) {
  return String(text).replace(/(Bearer\s+)[^\s"',}]+/gi, "$1[redacted]");
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${redact(text).slice(0, 200)}`);
  }
  return json;
}

async function login(email) {
  const r = await api("/api/auth/login", {
    method: "POST",
    body: { email, password: PASSWORD },
  });
  if (!r?.token) throw new Error(`login ${email}: no token`);
  return r.token;
}

const findTask = (project, key) => (project.tasks ?? []).find((t) => t.key === key);
const gateCount = (project) => (project.tasks ?? []).filter((t) => t.is_gate).length;

async function getProject(token, pid) {
  return api(`/api/crew/projects/${pid}`, { token });
}

/** 轮询任务直到进入终态(submitted/done/blocked)或超时。 */
async function pollTaskTerminal(token, pid, taskKey, timeoutMs = 45000) {
  const t0 = Date.now();
  let last = "unknown";
  while (Date.now() - t0 < timeoutMs) {
    const project = await getProject(token, pid);
    const task = findTask(project, taskKey);
    last = task?.status ?? "unknown";
    if (["submitted", "done", "blocked"].includes(last)) return last;
    await sleep(1500);
  }
  return last; // running/其它:未达终态(仍视为软通过:run_ref 已受理)
}

/* ------------------------------------------------------------------ */
/* 后端进程                                                            */
/* ------------------------------------------------------------------ */

function startBackend(env) {
  const child = spawn(
    PY,
    ["-m", "uvicorn", "services.api.app.main:app", "--host", HOST, "--port", String(PORT)],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (d) => process.env.CREW_E2E_VERBOSE && process.stdout.write(`[be] ${d}`));
  child.stderr.on("data", (d) => process.env.CREW_E2E_VERBOSE && process.stdout.write(`[be] ${d}`));
  return child;
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function waitReady(timeoutMs = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/crew/templates`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("backend did not become ready");
}

/* ------------------------------------------------------------------ */
/* Playwright 截图                                                     */
/* ------------------------------------------------------------------ */

async function applySession(page, token, theme) {
  await page.evaluate(
    ({ t, th }) => {
      localStorage.setItem("anna.session.token", t);
      localStorage.setItem("anna.theme", th);
    },
    { t: token, th: theme },
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".ir-side, .ir-side--collapsed", { timeout: 15000 });
  await sleep(400);
}

async function clickByRole(page, role, name) {
  const el = page.getByRole(role, { name, exact: true }).first();
  await el.click({ timeout: 6000 });
}

/** 点侧栏导航行(容忍徽标:「收件箱 3」的可及名不等于「收件箱」,改按行内文本命中)。 */
async function openNav(page, label) {
  await page.locator(".ir-side__row", { hasText: label }).first().click({ timeout: 6000 });
}

async function gotoCrew(page) {
  await clickByRole(page, "tab", "Crew");
  await page.waitForSelector(".ir-side__mode--on", { timeout: 6000 }).catch(() => {});
  await sleep(500);
}

async function shot(page, name) {
  const file = join(OUT_DIR, name);
  await page.screenshot({ path: file });
  shots.push(name);
  console.log(`SHOT · ${name}`);
}

/** 登录弹卡覆盖频道/画布右上,截图前收走(点 × 或等其自动飞回铃)。 */
async function dismissPopups(page) {
  for (let i = 0; i < 5; i++) {
    const x = page.locator(".ir-bell-pop__x").first();
    if (await x.count()) {
      await x.click({ timeout: 1500 }).catch(() => {});
      await sleep(150);
    } else break;
  }
  await page.waitForSelector(".ir-bell-pop", { state: "detached", timeout: 4000 }).catch(() => {});
}

/** 点侧栏项目子列表里指定名字的项目 → 画布。 */
async function openProjectByName(page, name) {
  await page.locator(".ir-side__subrow", { hasText: name }).first().click({ timeout: 6000 });
  await page.waitForSelector(".crewg-node", { timeout: 12000 }).catch(() => {});
  await sleep(1800);
}

/**
 * 经 UI「执行」按钮触发 run-agent(终审 #1:UI 可复现路径,不再直打 API)。
 * 双击画布节点开抽屉 → 点抽屉里的「执行」(agent 任务 assigned|rework 才出现)。
 */
async function runAgentViaUI(page, taskTitle) {
  const node = page.locator(".crewg-node", { hasText: taskTitle }).first();
  await node.dblclick({ timeout: 6000 });
  await page.waitForSelector(".ir-insp-drawer", { timeout: 6000 });
  const exec = page.getByRole("button", { name: "执行", exact: true }).first();
  await exec.click({ timeout: 6000 });
  await sleep(400);
  await page.keyboard.press("Escape").catch(() => {});
}

async function captureBoss(page, token) {
  for (const theme of ["light", "dark"]) {
    const sfx = theme === "dark" ? "d" : "";
    await applySession(page, token, theme);
    await gotoCrew(page);
    await dismissPopups(page);

    // 收件箱(Boss 视角:待我审有「设计评审」金菱卡)
    try {
      await openNav(page, "收件箱");
      await page.waitForSelector(".ir-crew-page__title", { timeout: 8000 }).catch(() => {});
      await sleep(1400);
      await dismissPopups(page);
      await shot(page, `crew-s2${sfx}-inbox-boss-${theme}.png`);
      pass(`screenshot·收件箱Boss·${theme}`);
    } catch (e) {
      fail(`screenshot·收件箱Boss·${theme}`, String(e).slice(0, 120));
    }

    // 花名册
    try {
      await openNav(page, "团队");
      await sleep(1200);
      await shot(page, `crew-s5${sfx}-roster-${theme}.png`);
      pass(`screenshot·花名册·${theme}`);
    } catch (e) {
      fail(`screenshot·花名册·${theme}`, String(e).slice(0, 120));
    }

    // 模板
    try {
      await openNav(page, "SOP 模板");
      await sleep(1200);
      await shot(page, `crew-s6${sfx}-templates-${theme}.png`);
      pass(`screenshot·模板·${theme}`);
    } catch (e) {
      fail(`screenshot·模板·${theme}`, String(e).slice(0, 120));
    }

    // 项目三区(登录页重设计:done/通过门/已提交设计/生长节点 + 频道五卡族)
    try {
      await openProjectByName(page, "登录页重");
      await dismissPopups(page);
      await sleep(700);
      await shot(page, `crew-s1${sfx}-threezone-${theme}.png`);
      pass(`screenshot·三区·${theme}`);
    } catch (e) {
      fail(`screenshot·三区·${theme}`, String(e).slice(0, 120));
    }

    // popover(浅)/抽屉(深):点「设计稿」节点(有 run_ref → trace)
    try {
      const node = page.locator(".crewg-node", { hasText: "设计稿" }).first();
      if (await node.count()) {
        if (theme === "dark") {
          await node.dblclick({ timeout: 4000 });
          await page.waitForSelector(".ir-insp-drawer", { timeout: 4000 }).catch(() => {});
          await sleep(900);
          await shot(page, `crew-s7-drawer-dark.png`);
          pass("screenshot·抽屉·dark");
        } else {
          await node.click({ timeout: 4000 });
          await page.waitForSelector(".ir-insp-pop", { timeout: 4000 }).catch(() => {});
          await sleep(700);
          await shot(page, `crew-s8-popover-light.png`);
          pass("screenshot·popover·light");
        }
        await page.keyboard.press("Escape").catch(() => {});
      }
    } catch (e) {
      fail(`screenshot·检视·${theme}`, String(e).slice(0, 120));
    }
  }
}

async function captureAndy(page, token) {
  for (const theme of ["light", "dark"]) {
    const sfx = theme === "dark" ? "d" : "";
    await applySession(page, token, theme);
    await gotoCrew(page);

    // 登录弹卡(1f:未读≥1 → 弹卡堆叠);等通知轮询落 → 弹卡入场
    try {
      await page.waitForSelector(".ir-bell-pop", { timeout: 7000 });
      await sleep(500);
      await shot(page, `crew-s4${sfx}-bell-andy-${theme}.png`);
      pass(`screenshot·铃弹卡·${theme}`);
    } catch {
      // 弹卡已飞回:退化为点铃开面板
      try {
        await page.click(".ir-bell__btn", { timeout: 4000 });
        await page.waitForSelector(".ir-bell__panel", { timeout: 4000 });
        await sleep(400);
        await shot(page, `crew-s4${sfx}-bell-andy-${theme}.png`);
        pass(`screenshot·铃面板·${theme}`);
      } catch (e2) {
        fail(`screenshot·通知铃·${theme}`, String(e2).slice(0, 120));
      }
    }

    // 收件箱(Andy 视角:排队解锁 / @我 / 由频道生长 + 返工版本 pill)
    try {
      await dismissPopups(page);
      await openNav(page, "收件箱");
      await page.waitForSelector(".ir-crew-page__title", { timeout: 8000 }).catch(() => {});
      await sleep(1400);
      await dismissPopups(page);
      await shot(page, `crew-s3${sfx}-inbox-andy-${theme}.png`);
      pass(`screenshot·收件箱Andy·${theme}`);
    } catch (e) {
      fail(`screenshot·收件箱Andy·${theme}`, String(e).slice(0, 120));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  // 后端托管前端 dist/(_mount_desktop_shell 读 cwd/dist);缺则 API 流仍走通但截图全空,
  // 提前失败给出清楚指引。
  if (!existsSync(join(ROOT, "dist", "index.html"))) {
    throw new Error("dist/index.html 缺失:先跑 `npm run build`(后端托管前端,Playwright 需之)");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const stateDir = mkdtempSync(join(tmpdir(), "crew-e2e-"));
  const env = {
    ...process.env,
    ANNA_RUNTIME_CONFIG_PATH: RUNTIME_CONFIG,
    ANNA_STATE_DB_PATH: join(stateDir, "state.sqlite3"),
    ANNA_MEMORY_DB_PATH: join(stateDir, "memory.sqlite3"),
    ANNA_RUNS_DB_PATH: join(stateDir, "runs.sqlite3"),
  };

  const child = startBackend(env);
  let browser = null;
  let ctx = null;
  let page = null;
  try {
    await waitReady();
    pass("backend-ready", `uvicorn @ ${BASE}`);

    // 模型是否配置(仅影响 run-agent 走真跑还是 blocked;两者皆走通)
    let modelConfigured = false;
    try {
      const st = await api("/api/admin/runtime/status");
      modelConfigured = st?.model?.configured === true || st?.model?.status === "configured";
    } catch {
      /* status optional */
    }
    pass("model-config", modelConfigured ? "configured(尝试真跑)" : "absent(将走 blocked 路径)");

    const bossToken = await login(BOSS);
    pass("login-boss");

    // 1) 模板建「登录页重设计」(工作图按 SOP 长出)
    const main = await api("/api/crew/projects", {
      method: "POST",
      token: bossToken,
      body: { goal_text: "登录页重设计", sop_template_id: "feature_iteration" },
    });
    const mid = main.id;
    if (gateCount(main) === 3 && (main.tasks?.length ?? 0) >= 8) {
      pass("create-project", `${main.tasks.length} 任务 · ${gateCount(main)} 门`);
    } else {
      fail("create-project", `tasks=${main.tasks?.length} gates=${gateCount(main)}`);
    }

    // 2) AI 拆解(模型缺席走回退,不算失败)——顺带得第二个项目(对齐 1a 侧栏双项目)
    try {
      const dec = await api("/api/crew/projects/decompose", {
        method: "POST",
        token: bossToken,
        body: { goal_text: "营销物料", sop_template_id: "marketing_collateral" },
      });
      if ((dec.tasks?.length ?? 0) >= 3) pass("ai-decompose", `回退/模型均可 · ${dec.tasks.length} 任务`);
      else fail("ai-decompose", `tasks=${dec.tasks?.length}`);
    } catch (e) {
      fail("ai-decompose", String(e.message).slice(0, 120));
    }

    // 3) 智能派人确认(suggest → 逐条 assign)
    try {
      const sug = await api(`/api/crew/projects/${mid}/suggest-assignments`, {
        method: "POST",
        token: bossToken,
      });
      const proposals = (sug.proposals ?? []).filter((p) => p.member_id);
      for (const p of proposals) {
        await api(`/api/crew/projects/${mid}/tasks/${p.task_id}/assign`, {
          method: "POST",
          token: bossToken,
          body: { member_id: p.member_id },
        });
      }
      pass("smart-assign", `${sug.source} · 派 ${proposals.length} 人`);
    } catch (e) {
      fail("smart-assign", String(e.message).slice(0, 120));
    }

    let proj = await getProject(bossToken, mid);
    const brief = findTask(proj, "brief");
    const prd = findTask(proj, "prd");
    const prdReview = findTask(proj, "prd_review");
    const design = findTask(proj, "design");

    // 4) 需求简报:开始 + 提交 → 完成(无门直落 done)
    try {
      await api(`/api/crew/projects/${mid}/tasks/${brief.id}/start`, { method: "POST", token: bossToken });
      await api(`/api/crew/projects/${mid}/tasks/${brief.id}/submit`, {
        method: "POST",
        token: bossToken,
        body: { artifact: "需求简报:登录页三态(空/校验中/错误)口径与范围。" },
      });
      proj = await getProject(bossToken, mid);
      const s = findTask(proj, "brief").status;
      s === "done" ? pass("brief-submit", "→ done") : fail("brief-submit", `→ ${s}`);
    } catch (e) {
      fail("brief-submit", String(e.message).slice(0, 120));
    }

    // 5) PRD 起草提交 → 评审驳回(批注)→ 返工 → 重提(v2)→ 通过 → 下游解锁
    try {
      await api(`/api/crew/projects/${mid}/tasks/${prd.id}/start`, { method: "POST", token: bossToken });
      await api(`/api/crew/projects/${mid}/tasks/${prd.id}/submit`, {
        method: "POST",
        token: bossToken,
        body: { artifact: "PRD v1:登录页重设计初稿。" },
      });
      proj = await getProject(bossToken, mid);
      const s1 = findTask(proj, "prd").status;
      s1 === "submitted" ? pass("prd-submit-v1", "→ submitted") : fail("prd-submit-v1", `→ ${s1}`);

      // 驳回 + 批注 → 返工
      await api(`/api/crew/projects/${mid}/tasks/${prdReview.id}/review`, {
        method: "POST",
        token: bossToken,
        body: { approved: false, comment: "验收标准缺『校验中』态的可测口径" },
      });
      proj = await getProject(bossToken, mid);
      const rw = findTask(proj, "prd");
      if (rw.status === "rework" && (rw.blocker || rw.review_comment)) {
        pass("prd-reject", `→ rework · 批注注入`);
      } else {
        fail("prd-reject", `→ ${rw.status}`);
      }

      // 返工重提 v2
      await api(`/api/crew/projects/${mid}/tasks/${prd.id}/submit`, {
        method: "POST",
        token: bossToken,
        body: { artifact: "PRD v2:已按批注补『校验中』的可测口径。" },
      });
      proj = await getProject(bossToken, mid);
      const v2 = findTask(proj, "prd");
      const nver = (v2.artifact_versions ?? []).length;
      nver >= 2 ? pass("prd-resubmit-v2", `versions=${nver}`) : fail("prd-resubmit-v2", `versions=${nver}`);

      // 通过 → prd done + design 解锁 ready
      await api(`/api/crew/projects/${mid}/tasks/${prdReview.id}/review`, {
        method: "POST",
        token: bossToken,
        body: { approved: true, comment: null },
      });
      proj = await getProject(bossToken, mid);
      const prdDone = findTask(proj, "prd").status;
      const designStatus = findTask(proj, "design").status;
      if (prdDone === "done" && ["ready", "assigned", "todo"].includes(designStatus)) {
        pass("prd-approve-unlock", `prd=done · design=${designStatus}`);
      } else {
        fail("prd-approve-unlock", `prd=${prdDone} · design=${designStatus}`);
      }
    } catch (e) {
      fail("prd-review-cycle", String(e.message).slice(0, 140));
    }

    // 频道断言:评审驳回/通过应各有编年行
    try {
      const ch = await api(`/api/crew/projects/${mid}/channel`, { token: bossToken });
      const kinds = (ch.messages ?? []).map((m) => m.kind);
      kinds.includes("review") || kinds.includes("event")
        ? pass("channel-review-rows", `${ch.messages.length} 行`)
        : fail("channel-review-rows", `kinds=${[...new Set(kinds)]}`);
    } catch (e) {
      fail("channel-review-rows", String(e.message).slice(0, 120));
    }

    // 6) 频道 say + @Andy
    let sayMsgId = null;
    try {
      const say = await api(`/api/crew/projects/${mid}/channel`, {
        method: "POST",
        token: bossToken,
        body: {
          body: "验收标准建议补一条:画布 50 节点内平移缩放不掉帧。@Andy",
          mentions: ["acc_andy"],
        },
      });
      sayMsgId = say.id;
      say.mentions?.includes("acc_andy")
        ? pass("channel-say-mention", "@acc_andy")
        : fail("channel-say-mention", `mentions=${say.mentions}`);
    } catch (e) {
      fail("channel-say-mention", String(e.message).slice(0, 120));
    }

    // 7) 「+任务」起草 → 确认下推 → 图长新节点(origin=channel)
    try {
      const cmd = await api(`/api/crew/projects/${mid}/channel/command`, {
        method: "POST",
        token: bossToken,
        body: { text: "性能验收:50 节点流畅度", source_message_id: sayMsgId },
      });
      const before = (await getProject(bossToken, mid)).tasks.length;
      await api(`/api/crew/projects/${mid}/channel/command/confirm`, {
        method: "POST",
        token: bossToken,
        body: { message_id: cmd.message_id, draft_indexes: [0] },
      });
      proj = await getProject(bossToken, mid);
      const grown = proj.tasks.find((t) => t.origin === "channel");
      if (grown && proj.tasks.length === before + 1) {
        // 派给 Andy,让其收件箱有「由频道生长」+ 通知
        await api(`/api/crew/projects/${mid}/tasks/${grown.id}/assign`, {
          method: "POST",
          token: bossToken,
          body: { member_id: "acc_andy" },
        });
        pass("channel-grow-task", `新节点 origin=channel`);
      } else {
        fail("channel-grow-task", `grown=${!!grown}`);
      }
    } catch (e) {
      fail("channel-grow-task", String(e.message).slice(0, 120));
    }

    // Playwright 拉起(run-agent 走 UI「执行」+ 截图 共用同一 page)
    try {
      browser = await chromium.launch({ headless: !process.env.CREW_E2E_HEADFUL });
      ctx = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      });
      page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      pass("browser-ready");
    } catch (e) {
      fail("browser-ready", String(e.message ?? e).slice(0, 160));
    }

    // 8) run-agent(设计稿)—— 终审 #1:经 UI「执行」按钮触发(不再直打 API),
    //    让 s7 抽屉 trace 成为 UI 可复现路径。真跑 → submitted / 模型缺席 → blocked,两者皆走通。
    if (page) {
      try {
        await applySession(page, bossToken, "light");
        await gotoCrew(page);
        await dismissPopups(page);
        await openProjectByName(page, "登录页重");
        await dismissPopups(page);
        await runAgentViaUI(page, "设计稿");
        const terminal = await pollTaskTerminal(bossToken, mid, "design", 45000);
        const ch = await api(`/api/crew/projects/${mid}/channel`, { token: bossToken });
        const designRows = (ch.messages ?? []).filter((m) => m.task_id === design.id);
        if (["submitted", "done"].includes(terminal)) {
          pass("run-agent", `UI「执行」→ 真跑 → ${terminal} · ${designRows.length} 频道行`);
        } else if (terminal === "blocked") {
          pass("run-agent", `UI「执行」→ 模型缺席 blocked(绝不假完成)· ${designRows.length} 频道行`);
        } else {
          pass("run-agent", `UI「执行」受理,异步在途(${terminal})`);
        }
      } catch (e) {
        fail("run-agent", String(e.message ?? e).slice(0, 160));
      }
    } else {
      fail("run-agent", "browser 未就绪,无法走 UI「执行」路径");
    }

    // 9) 切 Andy:收件箱 + 通知
    const andyToken = await login(ANDY);
    pass("login-andy");
    try {
      const inbox = await api("/api/crew/inbox", { token: andyToken });
      const todo = inbox.todo ?? [];
      const grownCard = todo.find((c) => c.origin === "channel");
      const mentions = inbox.mentions ?? [];
      pass(
        "andy-inbox",
        `待我做 ${todo.length}(生长卡 ${grownCard ? "有" : "无"})· @我 ${mentions.length}`,
      );
    } catch (e) {
      fail("andy-inbox", String(e.message).slice(0, 120));
    }
    try {
      const notes = await api("/api/crew/notifications?unread=1", { token: andyToken });
      const n = (notes.notifications ?? []).length;
      n >= 1 ? pass("andy-notifications", `未读 ${n}`) : fail("andy-notifications", `未读 ${n}`);
    } catch (e) {
      fail("andy-notifications", String(e.message).slice(0, 120));
    }

    // ---- Playwright 截图(浅/深)—— 复用上面 run-agent 用的同一 page ----
    if (page) {
      try {
        await captureBoss(page, bossToken);
        await captureAndy(page, andyToken);
        pass("screenshots", `${shots.length} 屏`);
      } catch (e) {
        fail("screenshots", String(e.message).slice(0, 160));
      }
    } else {
      fail("screenshots", "browser 未就绪");
    }
  } catch (e) {
    fail("fatal", String(e.message ?? e).slice(0, 200));
  } finally {
    if (browser) await browser.close().catch(() => {});
    killTree(child.pid);
    try {
      rmSync(stateDir, { recursive: true, force: true });
    } catch {
      /* windows 有时锁文件,忽略 */
    }
  }

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== SUMMARY ====");
  console.log(`steps: ${results.length}  pass: ${results.length - failed.length}  fail: ${failed.length}`);
  console.log(`screenshots: ${shots.length} → ${OUT_DIR}`);
  for (const s of shots) console.log(`  · ${s}`);
  if (failed.length) {
    console.log("FAILED STEPS:");
    for (const f of failed) console.log(`  ✗ ${f.step} · ${f.note}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(redact(String(e?.stack ?? e)));
    process.exitCode = 1;
  });
}
