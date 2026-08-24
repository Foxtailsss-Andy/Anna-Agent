# R1 · 拆旧与地基(teardown + copy-in + 依赖瘦身)

**目标:** 旧渲染器清零;交接包源码 verbatim 落进工程;依赖瘦身到零第三方样式;字体随包;纯逻辑测试起步;四门恢复全绿。
**边界:** 不做任何页面/接线;本切片结束时 app 只渲染一个临时的 tokens 验证屏(R3 会替换)。Electron/后端/vite 代理不动。

**Files:**
- Delete: `apps/desktop/src/**`(全部)、`components.json`
- Create(vendor): `docs/superpowers/handoff/2026-07-09-iris-frontend/**`(交接包全量:三 md + src/ + preview/)
- Create(copy-in): `apps/desktop/src/styles/tokens.css`、`apps/desktop/src/lib/{frames,turns,plan,runtime}.ts`、`apps/desktop/src/components/{agent,anna,cowork,surfaces}/**`、`apps/desktop/src/fixtures/demo-run.ts`(以上全部 = vendor 副本 verbatim)
- Create(new): `apps/desktop/src/main.tsx`、`apps/desktop/src/App.tsx`、`apps/desktop/src/vite-env.d.ts`、`apps/desktop/src/lib/turns.test.ts`、`apps/desktop/src/lib/plan.test.ts`
- Modify: `index.html`、`package.json`、`vite.config.ts`

**Interfaces:**
- Produces(后续全切片依赖): `@/lib/frames`(Frame union)、`@/lib/turns`(`reduceTurns/RunTree/Turn/Step/fmtDuration/fmtClock/turnSummary/DEFAULT_TOOL_LABELS`)、`@/lib/plan`(`planProgress/PlanProgress`)、`@/lib/runtime`(`apiBase()/apiUrl()`)、四组组件族(props 见交接包各 .tsx export)。
- 别名 `@` = `apps/desktop/src`(vite+tsconfig 已有,不动)。

## Task 1: vendor 交接包 + 拆旧清零

- [ ] **Step 1: 确认 vendor 副本在位**(规划轮已完成 vendor:`docs/superpowers/handoff/2026-07-09-iris-frontend/`;缺失时从设计交接归档重新解压补齐)

```bash
ls docs/superpowers/handoff/2026-07-09-iris-frontend/src/lib/frames.ts   # 必须存在
```

- [ ] **Step 2: 删除旧渲染器与 shadcn 配置**

```bash
git rm -r apps/desktop/src
git rm components.json
```

- [ ] **Step 3: commit(拆除独立成档,历史可回溯)**

```bash
git commit -m "feat(fe): R1 — 拆除旧渲染器(100 文件)与 shadcn 配置,Iris 重建起点"
```

## Task 2: 依赖瘦身

- [ ] **Step 1: 卸载样式栈**

```bash
npm uninstall tailwindcss @tailwindcss/vite tw-animate-css class-variance-authority clsx tailwind-merge radix-ui lucide-react
```

- [ ] **Step 2: vite.config.ts 去 tailwind 插件**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "apps/desktop/src") },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});
```

- [ ] **Step 3: 确认保留依赖仍在 package.json**(react/react-dom/react-markdown/@fontsource 三件/typescript/vite/@vitejs/plugin-react;dev: electron/electron-builder/vitest/playwright/png-to-ico/@types/*)

## Task 3: copy-in 交接包源码

- [ ] **Step 1: 从 vendor 副本复制(verbatim,不改一字)**

```bash
SRC=docs/superpowers/handoff/2026-07-09-iris-frontend/src
mkdir -p apps/desktop/src
cp -r $SRC/styles $SRC/lib $SRC/components $SRC/fixtures apps/desktop/src/
```

- [ ] **Step 2: 核对清单**(缺一即错):styles/tokens.css;lib/frames.ts turns.ts plan.ts runtime.ts;components/agent/{LoopCard,AgentSessionHeader,AgentComposer,PlanRail,ArtifactSandbox,ArtifactCard,ApprovalCard}.tsx+.css;components/anna/{IrisPetal,StateNote,MiniMarkdown}.tsx;components/cowork/DashboardKit.tsx+.css;components/surfaces/SurfaceKit.tsx+.css;fixtures/demo-run.ts

## Task 4: 入口三件 + index.html

- [ ] **Step 1: 写 `apps/desktop/src/main.tsx`**

```tsx
// 字体随包(禁 CDN,Electron 离线);权重按 ACCEPTANCE-CHECKLIST §C 用量引入
import "@fontsource/noto-sans-sc/300.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";
import "@fontsource/noto-serif-sc/500.css";
import "@fontsource/noto-serif-sc/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 2: 写临时 `apps/desktop/src/App.tsx`(R3 将整体替换;仅验证 tokens/组件可渲染,用 fixtures 数据并明示「预览」)**

```tsx
import { useMemo } from "react";
import { reduceTurns } from "./lib/turns";
import { planProgress } from "./lib/plan";
import { LoopCard } from "./components/agent/LoopCard";
import { StateNote } from "./components/anna/StateNote";
import { framesRunning, TOOL_LABELS_DEMO } from "./fixtures/demo-run";

// R1 临时验证屏:仅本切片存在,R3 替换为 AnnaShell。fixtures 仅在此屏出现。
export default function App() {
  const running = useMemo(() => reduceTurns(framesRunning, TOOL_LABELS_DEMO), []);
  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom))", padding: 40 }}>
      <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
        <StateNote kind="stub" text="R1 地基验证屏(fixtures 预览,R3 替换为真外壳)" />
        <LoopCard state="running" nowIntent={running.nowIntent} turns={running.turns} plan={planProgress(running.plan)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 `apps/desktop/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 4: 重写 `index.html`**

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Anna</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/apps/desktop/src/main.tsx"></script>
  </body>
</html>
```

## Task 5: 纯逻辑测试(TDD 起步,后续切片的安全网)

- [ ] **Step 1: 写 `apps/desktop/src/lib/turns.test.ts`**(fixtures 四态序列作输入,断言归约不变量)

```ts
import { describe, expect, it } from "vitest";
import { reduceTurns, turnSummary, fmtDuration } from "./turns";
import { framesRunning, framesDone, framesFailed, framesAwaiting, TOOL_LABELS_DEMO } from "../fixtures/demo-run";

describe("reduceTurns(交接包纯函数,copy-in 后行为锁定)", () => {
  it("running:状态 running,最后回合展开语义(status running)", () => {
    const t = reduceTurns(framesRunning, TOOL_LABELS_DEMO);
    expect(t.state).toBe("running");
    expect(t.turns.at(-1)?.status).toBe("running");
    expect(t.nowIntent).not.toBe("");
  });
  it("done:state done + run 摘要在场", () => {
    const t = reduceTurns(framesDone, TOOL_LABELS_DEMO);
    expect(t.state).toBe("done");
    expect(t.run?.runId).toBeTruthy();
  });
  it("failed:失败步 defaultOpen 且所在回合 fail", () => {
    const t = reduceTurns(framesFailed, TOOL_LABELS_DEMO);
    expect(t.state).toBe("error");
    const failTurn = t.turns.find((x) => x.status === "fail");
    expect(failTurn).toBeDefined();
    expect(failTurn!.steps.some((s) => s.status === "fail" && s.defaultOpen)).toBe(true);
  });
  it("awaiting:审批帧置 approval 并加「等您示下」步(有 L3 可掀)", () => {
    const t = reduceTurns(framesAwaiting, TOOL_LABELS_DEMO);
    expect(t.state).toBe("awaiting");
    expect(t.approval?.reason).toBeTruthy();
    const wait = t.turns.flatMap((x) => x.steps).find((s) => s.status === "waiting");
    expect(wait?.l3).toBeDefined();
  });
  it("系统步永无 l3(硬规则:不可掀)", () => {
    for (const frames of [framesRunning, framesDone, framesFailed]) {
      const t = reduceTurns(frames, TOOL_LABELS_DEMO);
      for (const s of t.turns.flatMap((x) => x.steps)) {
        if (s.kind === "system" && s.status !== "waiting") expect(s.l3).toBeUndefined();
      }
    }
  });
  it("turnSummary 真值聚合;fmtDuration 三段", () => {
    expect(fmtDuration(50)).toBe("50ms");
    expect(fmtDuration(1500)).toBe("1.5s");
    expect(fmtDuration(94_000)).toBe("1m34s");
    const t = reduceTurns(framesRunning, TOOL_LABELS_DEMO);
    expect(turnSummary(t.turns[t.turns.length - 1]!)).toMatch(/思考|工具|步/);
  });
});
```

- [ ] **Step 2: 写 `apps/desktop/src/lib/plan.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { planProgress } from "./plan";

describe("planProgress", () => {
  it("空计划返回 null(无计划不渲染,诚实纪律)", () => {
    expect(planProgress([])).toBeNull();
  });
  it("进行中按半项计(2 done + 1 in_progress / 4 → 62.5%)", () => {
    const p = planProgress([
      { id: "1", title: "a", status: "done" },
      { id: "2", title: "b", status: "done" },
      { id: "3", title: "c", status: "in_progress" },
      { id: "4", title: "d", status: "pending" },
    ])!;
    expect(p.done).toBe(2);
    expect(p.total).toBe(4);
    expect(p.currentTitle).toBe("c");
    expect(p.ratio).toBeCloseTo(0.625);
  });
});
```

- [ ] **Step 3: 跑测试**

Run: `npx vitest run`
Expected: 全绿(2 文件;若断言与 copy-in 行为不符 → 修**测试**对齐包行为并记录,禁改包源码)

## Task 6: 四门 + 视觉抽查 + commit

- [ ] **Step 1: 四门**

```bash
npx tsc --noEmit          # 0 error(包源码已预验证过 strict 零错)
npx vitest run            # 全绿
npm run build             # 成功(dist 产出)
python -m pytest services/ tests/ -q   # 全绿(后端未动,不减绿)
```

- [ ] **Step 2: 视觉抽查**:`npx vite` 开 5173,验证 R1 临时屏:LoopCard 呼吸点/微光在动、字体为 Noto Sans SC(DevTools 查 computed font-family 非 fallback)、`<html data-theme="dark">` 手工设置后深色 tokens 生效。
- [ ] **Step 3: commit**

```bash
git add -A
git commit -m "feat(fe): R1 — Iris 地基:copy-in 交接包源码 + 依赖瘦身 + 字体随包 + 纯逻辑测试"
```

## 风险

- **fixtures 泄漏进生产路径**:全仓 `demo-run` import 只允许出现在 `App.tsx`(R1 临时)与 `*.test.ts`;R3 替换 App 后只剩测试。R9 审计此项。
- **字体权重缺失**:tokens.css 若引用未 import 的权重会静默 fallback;抽查步必须看 computed 值。
- **npm uninstall 后类型残留**:tsc 若报 radix/lucide 类型错误说明还有残留 import(旧 src 未删净)。
