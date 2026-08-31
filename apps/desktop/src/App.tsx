/**
 * App · 会话引导流(《R3 外壳》Task 2 Step 3)
 *
 * 启动:applyTheme(loadTheme()) → getIdentity()。
 *   本机桌面:session/current 回落 local-runtime(200)→ LoginPage 预填演示账号,登录后进壳。
 *   远程 / 多用户:session/current 4xx → LoginPage(入口即引导流本身,不设菜单入口)。
 *   其他失败(后端未起 / 5xx / 网络)→ BootScreen error + 重试。
 * renderSection 本切片全部返回 SectionPlaceholder,R4-R8 逐区替换真页面。
 */

import { useCallback, useEffect, useState } from "react";

import { StateNote } from "./components/anna/StateNote";
import {
  AnnaShell,
  SectionPlaceholder,
  type CoworkItem,
  type CrewItem,
  type ShellSection,
} from "./components/shell/AnnaShell";
import { getIdentity, getToken, setToken, type AnnaIdentity } from "./lib/api/identity";
import { PersonaProvider } from "./lib/persona";
import { apiUrl } from "./lib/runtime";
import { applyTheme, loadTheme } from "./lib/theme";
import { AgentsPage } from "./pages/agents/AgentsPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { HikerPage } from "./pages/cowork/HikerPage";
import { ReimbursementPage } from "./pages/cowork/ReimbursementPage";
import { CrewInboxPage } from "./pages/crew/CrewInboxPage";
import { CrewProjectDetailPage } from "./pages/crew/CrewProjectDetailPage";
import { CrewProjectsPage } from "./pages/crew/CrewProjectsPage";
import { CrewTeamPage } from "./pages/crew/CrewTeamPage";
import { CrewTemplatesPage } from "./pages/crew/CrewTemplatesPage";
import { HomePage } from "./pages/home/HomePage";
import { HubPage } from "./pages/hub/HubPage";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { ReviewChannelInspector } from "./pages/review/ReviewChannelInspector";
import "./App.css";

/** 从 getIdentity 抛错文案里解析 session/current 的 HTTP 状态码 */
function statusFromError(e: unknown): number | null {
  const match = /session\/current (\d{3})/.exec(String(e));
  return match ? Number(match[1]) : null;
}

function isClientError(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500;
}

function BootScreen({ note, onRetry }: { note: React.ReactNode; onRetry?: () => void }) {
  return (
    <div className="ir-boot">
      <div className="ir-boot__card">
        <div className="ir-boot__word">Anna</div>
        {note}
        {onRetry && (
          <button type="button" className="ir-boot__retry" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [identity, setIdentity] = useState<AnnaIdentity | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [needLogin, setNeedLogin] = useState(false);
  const [prefillDemo, setPrefillDemo] = useState(false);

  const boot = useCallback(() => {
    setBootError(null);
    getIdentity(true)
      .then((id) => {
        if (id.source === "local-runtime" && !getToken()) {
          setIdentity(null);
          setPrefillDemo(true);
          setNeedLogin(true);
          return;
        }
        setPrefillDemo(false);
        setIdentity(id);
        setNeedLogin(false);
      })
      .catch((e) => {
        if (isClientError(statusFromError(e))) {
          setPrefillDemo(false);
          setNeedLogin(true);
        } else {
          setBootError(String(e));
        }
      });
  }, []);

  useEffect(() => {
    applyTheme(loadTheme());
  }, []);

  useEffect(() => {
    boot();
  }, [boot]);

  const handleLogout = useCallback(async () => {
    const token = getToken();
    try {
      await fetch(apiUrl("/api/auth/logout"), {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      /* 网络失败也继续本地登出 */
    }
    setToken(null);
    setIdentity(null);
    setPrefillDemo(true);
    setNeedLogin(true);
  }, []);

  const renderSection = useCallback(
    (section: ShellSection, coworkItem: CoworkItem, crewItem: CrewItem, crewProjectId: string | null) => {
      if (section === "home") {
        return <HomePage displayName={identity?.displayName ?? ""} />;
      }
      if (section === "cowork" && coworkItem === "hiker") {
        return <HikerPage />;
      }
      if (section === "cowork" && coworkItem === "reimbursement") {
        return <ReimbursementPage />;
      }
      if (section === "crew") {
        if (crewItem === "inbox") return <CrewInboxPage />;
        if (crewItem === "team") return <CrewTeamPage />;
        if (crewItem === "templates") return <CrewTemplatesPage />;
        if (crewItem === "project") return <CrewProjectDetailPage projectId={crewProjectId} />;
        return <CrewProjectsPage />;
      }
      if (section === "hub") {
        return <HubPage />;
      }
      if (section === "review") {
        return <ReviewChannelInspector workspaceId={identity?.workspaceId ?? ""} />;
      }
      if (section === "settings") {
        return <SettingsPage />;
      }
      if (section === "agents") {
        return <AgentsPage />;
      }
      return <SectionPlaceholder section={section} coworkItem={coworkItem} />;
    },
    [identity?.displayName, identity?.workspaceId],
  );

  if (bootError) {
    return <BootScreen note={<StateNote kind="error" text={bootError} />} onRetry={boot} />;
  }
  if (needLogin) {
    return (
      <LoginPage
        prefillDemo={prefillDemo}
        onDone={(id) => {
          setIdentity(id);
          setNeedLogin(false);
        }}
      />
    );
  }
  if (!identity) {
    return <BootScreen note={<StateNote kind="loading" text="正在装载运行时身份" />} />;
  }
  return (
    <PersonaProvider>
      <AnnaShell identity={identity} onLogout={handleLogout} renderSection={renderSection} />
    </PersonaProvider>
  );
}
