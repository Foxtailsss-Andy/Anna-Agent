# R3 · 外壳(侧栏/导航/主题/引导/登录)

**目标:** 建 Iris 语言的应用壳:可折叠侧栏(248→64)、五区导航 + Crew 站位、深浅主题(`<html data-theme>` + 持久化)、会话引导(免登录回落/登录页)、各区先挂 StateNote 占位屏(后续切片逐区替换)。
**边界:** 不接任何业务流;问候起始页的**内容**在 R4(Chat 空态),本切片只给壳与路由位。

**前置:** R1(组件族)、R2(identity)。

**Files:**
- Create: `apps/desktop/src/components/shell/AnnaShell.tsx`+`.css`、`Sidebar.tsx`+`.css`、`UserChip.tsx`(并入 Sidebar.css)
- Create: `apps/desktop/src/lib/theme.ts`、`apps/desktop/src/pages/auth/LoginPage.tsx`+`.css`
- Modify: `apps/desktop/src/App.tsx`(替换 R1 临时屏)

**Interfaces:**
- Consumes: `getIdentity/setToken/getToken`(R2)、`StateNote/IrisPetal`(R1)
- Produces: `type ShellSection = "chat" | "cowork" | "create" | "hub" | "settings"`;`type CoworkItem = "finance" | "hiker" | "reimbursement"`;`<AnnaShell renderSection={(section, coworkItem) => ReactNode}>`;`applyTheme(t: "light"|"dark")` + `loadTheme()`(R8 外观卡复用)

## Task 1: 主题工具(TDD 可测的纯逻辑)

- [ ] **Step 1: `lib/theme.ts`**

```ts
export type ThemeMode = "light" | "dark";
const KEY = "anna.theme";

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem(KEY, mode);
}

export function loadTheme(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  return saved === "dark" ? "dark" : "light";
}
```

- [ ] **Step 2:** `App.tsx` 启动时 `applyTheme(loadTheme())`。

## Task 2: Sidebar + AnnaShell

- [ ] **Step 1: `Sidebar.tsx`**——结构与纪律:
  - 宽度 248px,折叠 64px;宽度过渡 `240ms cubic-bezier(.2,0,0,1)`(唯一动的东西;折叠态只显图标)。
  - 顶部品牌行:衬线「Anna」+ `IrisPetal size={13}`(白名单「品牌行 13」,占本屏点缀名额 1/2)。
  - 导航项(上→下):对话 Chat / 看板 Cowork(子项 财务·Hiker·报销,展开式)/ 构建 Create / 产物中心 / —分隔— / Crew(**站位**:虚线边 + 「即将上线」+ disabled,StateNote 语法的行内变体)/ 设置。
  - 图标:内联 SVG,1.5px 描边,`stroke="currentColor"`;禁 emoji、禁引第三方图标库。
  - 底部 `UserChip`:显示 `displayName` + role;`source === "token"` 时菜单含「退出登录」(调 `POST /api/auth/logout` + `setToken(null)` + 刷新身份),`local-runtime` 时显示「本机身份」。
  - 激活态:iris tinted(`background: var(--iris-soft)` + `color: var(--iris-deep)` + 1px 内描边),同交接包 tab 语言;颜色一律 `var(--*)`。

```tsx
export interface SidebarProps {
  section: ShellSection;
  coworkItem: CoworkItem;
  collapsed: boolean;
  onNavigate: (s: ShellSection, cw?: CoworkItem) => void;
  onToggleCollapsed: () => void;
  identity: AnnaIdentity | null;
  onLogout: () => void;
}
```

- [ ] **Step 2: `AnnaShell.tsx`**——布局 `display:flex; height:100vh`;左 Sidebar,右 `<main>`(`flex:1; min-width:0; overflow:auto`,背景 `linear-gradient(180deg, var(--bg-grad-top), var(--bg-grad-bottom))`)。**各 section 用 visited-mounted 保活**(切走 `display:none`,免流中断——Chat 运行中切去看板再回来,流不断):

```tsx
export function AnnaShell({ identity, onLogout, renderSection }: {
  identity: AnnaIdentity | null;
  onLogout: () => void;
  renderSection: (section: ShellSection, coworkItem: CoworkItem) => React.ReactNode;
}) {
  const [section, setSection] = useState<ShellSection>("chat");
  const [coworkItem, setCoworkItem] = useState<CoworkItem>("finance");
  const [collapsed, setCollapsed] = useState(false);
  const [visited, setVisited] = useState<Set<string>>(new Set(["chat"]));
  const key = (s: ShellSection) => (s === "cowork" ? `cowork:${coworkItem}` : s);
  // onNavigate 时把 key 加入 visited;渲染 visited 全集,非当前 display:none
  ...
}
```

- [ ] **Step 3: `App.tsx` 重写**——引导流:

```tsx
export default function App() {
  const [identity, setIdentity] = useState<AnnaIdentity | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  useEffect(() => { applyTheme(loadTheme()); }, []);
  useEffect(() => {
    getIdentity().then(setIdentity).catch((e) => setBootError(String(e)));
  }, []);
  if (bootError) return <BootScreen note={<StateNote kind="error" text={bootError} />} onRetry={...} />;
  if (needLogin) return <LoginPage onDone={(id) => { setIdentity(id); setNeedLogin(false); }} />;
  if (!identity) return <BootScreen note={<StateNote kind="loading" text="正在装载运行时身份" />} />;
  return <AnnaShell identity={identity} onLogout={...} renderSection={renderSection} />;
}
```

  - `renderSection` 本切片全部返回 `<SectionPlaceholder>`(瓷面卡 + `StateNote kind="stub"` + 该区名),R4-R8 逐个替换成真页面。
  - 登出后 `getIdentity(true)` 重取:token 模式登出回落 local-runtime 即直接继续;若 session/current 4xx(远程部署形态)→ `setNeedLogin(true)`。

## Task 3: LoginPage

- [ ] **Step 1:** 素面居中卡(瓷面配方 §B):衬线标题「Anna」(无点缀——白名单只有品牌行/空态/问候页,登录页不占名额)+ email/password 输入(focus 边框 iris 35%)+ filled 渐变按钮「登录」;错误用 `StateNote kind="error"`(401 → 帧原文样式显示 message)。dev 便利:`import.meta.env.DEV` 时预填 `boss@anna.demo` / `crew-demo`(与旧 DEV_LOGIN_AUTOFILL 等价,发布档不生效)。
- [ ] **Step 2:** 成功:`setToken(body.token)` → `getIdentity(true)` → `onDone(identity)`。

## Task 4: 验收 + commit

- [ ] **Step 1: 四门**(tsc/vitest/build/pytest 全绿)
- [ ] **Step 2: Playwright 走查**:①冷启动 → 直接进壳(本机免登录),侧栏五区 + Crew 站位可见;②逐区点击 → 占位屏各就位;③折叠/展开侧栏 240ms 平滑;④`applyTheme("dark")` 后整壳深色(非反相:背景 #232328→#1E1E22 系);⑤Crew 项 disabled 不可点;⑥无 console error。截图存 `docs/superpowers/progress/`(命名 `2026-07-XX-r3-*.png`)。
- [ ] **Step 3: commit** `feat(fe): R3 — Iris 外壳(侧栏/主题/引导/登录)`

## 风险

- **visited-mounted 与 Playwright**:隐藏区仍在 DOM,定位必须 `:visible` 限定(沿用夺舍轮经验)。
- **点缀名额**:侧栏品牌行占 1 处;各区页面自己的名额单独核算(每屏 ≤2)。
- **登录形态分歧**:桌面本机永远免登录;LoginPage 只在 session/current 失败(远程/多用户形态)出现——不要为它加菜单入口,入口就是引导流本身。
