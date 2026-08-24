/**
 * CrewTeamPage · 花名册(F5 · 设计稿 1g + 设计说明 §五 P4)
 *
 * 人机同构身份五处一致:human=圆(40 r999)· agent=方圆角(40 r13)+ delegate 色 + AGENT 章 + 三图元。
 *   三 Agent 图元:Scribe=三横线 / Design=圆叠方 / Check=对勾(由职能识别)。
 *   负载真值:在手圆点(进行中=实/返工=红/空位=空)+ chips,数据从 projects 任务真聚合。
 *   技能:后端 roster 无 skills 列 → 由职能派生最小 chips(登记偏差,不造假)。
 *   Agent 卡「配置」→ 跳 Agent 中心(bus.navigate("agents"))。空态即空态。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { useShellBus } from "../../components/shell/AnnaShell";
import { listProjects, listTeam, type CrewProject, type TeamMember } from "../../lib/api/crew";
import {
  agentGlyph,
  deriveMemberLoad,
  deriveSkills,
  isOperationalProject,
  loadChips,
  type AgentGlyph,
  type LoadDot,
} from "./teamModel";
import "./crew.css";

function initialOf(name: string): string {
  const t = (name ?? "").trim();
  return t ? t[0].toUpperCase() : "·";
}

/* ---------------- Agent 图元(永不用人脸;1.5-2px 描边) ---------------- */

function AgentGlyphIcon({ glyph }: { glyph: AgentGlyph }) {
  const p = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  const body: Record<AgentGlyph, React.ReactNode> = {
    scribe: <path d="M6 8.5h12M6 12h12M6 15.5h8" {...p} />,
    design: (
      <>
        <rect x="8.5" y="8.5" width="9" height="9" rx="1.6" {...p} />
        <circle cx="9.5" cy="9.5" r="4" {...p} />
      </>
    ),
    check: <path d="M5 12.5 10 17.5 19 6.5" {...p} />,
    generic: (
      <>
        <circle cx="8.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
        <circle cx="15.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      </>
    ),
  };
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      {body[glyph]}
    </svg>
  );
}

function LoadDots({ dots }: { dots: LoadDot[] }) {
  if (dots.length === 0) return null;
  return (
    <span className="ir-crew-load__dots" aria-hidden="true">
      {dots.map((d, i) => (
        <span key={i} className={`ir-crew-load__dot ir-crew-load__dot--${d}`} />
      ))}
    </span>
  );
}

/* ---------------- 页 ---------------- */

export function CrewTeamPage() {
  const bus = useShellBus();
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [projects, setProjects] = useState<CrewProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listTeam()
      .then((m) => setMembers(m))
      .catch((e) => {
        setMembers(null);
        setError(String(e));
      })
      .finally(() => setLoading(false));
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const operationalProjects = useMemo(() => projects.filter(isOperationalProject), [projects]);
  const owners = useMemo(() => new Set(operationalProjects.map((p) => p.owner_user_id)), [operationalProjects]);
  const humans = (members ?? []).filter((m) => m.kind !== "agent");
  const agents = (members ?? []).filter((m) => m.kind === "agent");

  return (
    <div className="ir-crew-page">
      <div className="ir-crew-page__scroll">
        <div className="ir-crew-page__col">
          <div className="ir-crew-page__head">
            <div>
              <div className="ir-crew-page__eyebrow">CREW</div>
              <div className="ir-crew-page__title">
                团队
                {members && members.length > 0 && (
                  <span className="ir-crew-page__count">
                    {humans.length} 人 · {agents.length} Agent
                  </span>
                )}
              </div>
            </div>
            <button type="button" className="ir-crew-page__refresh" onClick={load} disabled={loading}>
              刷新
            </button>
          </div>

          {loading && !members ? (
            <StateNote kind="loading" text="正在装载团队" />
          ) : error ? (
            <StateNote kind="error" text={error} />
          ) : !members || members.length === 0 ? (
            <StateNote kind="empty" petal text="这个工作空间还没有成员。" />
          ) : (
            <div className="ir-crew-cards ir-crew-cards--team">
              {members.map((m) => {
                const isAgent = m.kind === "agent";
                const load = deriveMemberLoad(m.id, operationalProjects);
                const chips = loadChips(load, isAgent);
                const skills = deriveSkills(m.role);
                const boss = owners.has(m.id);
                return (
                  <div key={m.id} className="ir-crew-member">
                    <span
                      className={`ir-crew-member__ava${
                        isAgent ? " ir-crew-member__ava--agent" : boss ? " ir-crew-member__ava--boss" : " ir-crew-member__ava--human"
                      }`}
                    >
                      {isAgent ? <AgentGlyphIcon glyph={agentGlyph(m)} /> : initialOf(m.display_name)}
                      {isAgent && load.executingTitle && (
                        <span className="ir-crew-member__exec-dot" aria-hidden="true" />
                      )}
                    </span>
                    <div className="ir-crew-member__meta">
                      <div className="ir-crew-member__namerow">
                        <span className="ir-crew-member__name">{m.display_name}</span>
                        {isAgent && <span className="ir-crew-member__tag">AGENT</span>}
                      </div>
                      <div className="ir-crew-member__role">{m.role || "—"}</div>
                      {skills.length > 0 && (
                        <div className="ir-crew-member__skills">
                          {skills.map((s) => (
                            <span
                              key={s}
                              className={`ir-crew-skill${isAgent ? " ir-crew-skill--agent" : ""}`}
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="ir-crew-load">
                        <LoadDots dots={load.dots} />
                        {chips.map((c, i) => (
                          <span key={i} className={`ir-crew-loadchip ir-crew-loadchip--${c.tone}`}>
                            {c.text}
                          </span>
                        ))}
                      </div>
                      {isAgent && (
                        <button
                          type="button"
                          className="ir-crew-member__link"
                          onClick={() => bus.navigate("agents")}
                        >
                          配置
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CrewTeamPage;
