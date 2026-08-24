/**
 * UserChip · 侧栏底部身份条(《R3 外壳》Task 2 Step 1)
 *
 * 显示 displayName + role;点击弹出菜单:
 *   source === "token"      → 「退出登录」(触发 onLogout)
 *   source === "local-runtime" → 「本机身份 · 桌面免登录」(无登出入口)
 * 样式并入 Sidebar.css(ir-userchip__*)。
 */

import { useEffect, useRef, useState } from "react";

import type { AnnaIdentity } from "../../lib/api/identity";
import "./Sidebar.css";

export interface UserChipProps {
  identity: AnnaIdentity | null;
  collapsed: boolean;
  onLogout: () => void;
  /** C1:设置入口移入 ⋯ 菜单(校对基准 P-02 侧栏无独立设置项) */
  onOpenSettings?: () => void;
}

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : "·";
}

function LogoutIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M10 12h10m0 0-3-3m3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function HomeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 11 12 4l8 7M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 8h8M16 8h4M4 16h4M12 16h8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="14" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="16" r="2.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function UserChip({ identity, collapsed, onLogout, onOpenSettings }: UserChipProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const displayName = identity?.displayName ?? "身份装载中";
  const role = identity?.role ?? "";
  const isToken = identity?.source === "token";

  return (
    <div className="ir-userchip" ref={rootRef}>
      {open && (
        <div className="ir-userchip__menu" role="menu">
          <span className="ir-userchip__menu-note">
            {identity ? `${identity.workspaceId} · ${identity.userId}` : "—"}
          </span>
          {onOpenSettings && (
            <button
              type="button"
              role="menuitem"
              className="ir-userchip__menu-btn"
              onClick={() => {
                setOpen(false);
                onOpenSettings();
              }}
            >
              <GearIcon />
              设置
            </button>
          )}
          {isToken ? (
            <button
              type="button"
              role="menuitem"
              className="ir-userchip__menu-btn ir-userchip__menu-btn--danger"
              onClick={() => {
                setOpen(false);
                onLogout();
              }}
            >
              <LogoutIcon />
              退出登录
            </button>
          ) : (
            <span className="ir-userchip__menu-local" role="menuitem">
              <HomeIcon />
              本机身份 · 桌面免登录
            </span>
          )}
        </div>
      )}
      <button
        type="button"
        className="ir-userchip__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? `${displayName}${role ? ` · ${role}` : ""}` : undefined}
      >
        <span className="ir-userchip__avatar" aria-hidden="true">
          {initialOf(displayName)}
        </span>
        <span className="ir-userchip__meta">
          <span className="ir-userchip__name">{displayName}</span>
          {role && <span className="ir-userchip__role">{role}</span>}
        </span>
      </button>
    </div>
  );
}

export default UserChip;
