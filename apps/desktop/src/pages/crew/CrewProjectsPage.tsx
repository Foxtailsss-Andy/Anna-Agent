/**
 * CrewProjectsPage · 项目列表(F1)
 *
 * 真数据 GET /api/crew/projects;卡片 = 名 + SOP + 进度 x/y + 执行中/等我处理(零值隐藏)。
 * 点卡 → 打开项目详情(工作图)。空态即空态;失败降级不造数。
 */

import { useCallback, useEffect, useState } from "react";

import { useShellBus } from "../../components/shell/AnnaShell";
import { StateNote } from "../../components/anna/StateNote";
import {
  ensureCrewShowcase,
  listProjects,
  listTemplates,
  type CrewProject,
  type SopTemplate,
} from "../../lib/api/crew";
import { awaitingCount, projectProgress, runningCount } from "./crewModel";
import {
  SHOWCASE_BADGES,
  SHOWCASE_CAPABILITIES,
  SHOWCASE_STAGES,
  SHOWCASE_STEPS,
  SHOWCASE_TITLE,
  showcaseStateLabel,
} from "./showcaseModel";
import "./crew.css";

export function CrewProjectsPage() {
  const bus = useShellBus();
  const [projects, setProjects] = useState<CrewProject[] | null>(null);
  const [templates, setTemplates] = useState<SopTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showcaseBusy, setShowcaseBusy] = useState(false);
  const [showcaseError, setShowcaseError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listProjects()
      .then((p) => setProjects(p))
      .catch((e) => {
        setProjects(null);
        setError(String(e));
      })
      .finally(() => setLoading(false));
    listTemplates()
      .then((t) => setTemplates(t))
      .catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? id;

  const openShowcase = () => {
    setShowcaseBusy(true);
    setShowcaseError(null);
    ensureCrewShowcase()
      .then(({ project }) => {
        setProjects((prev) => {
          const others = (prev ?? []).filter((p) => p.id !== project.id);
          return [project, ...others];
        });
        bus.openCrewProject(project.id);
      })
      .catch((e) => setShowcaseError(String(e)))
      .finally(() => setShowcaseBusy(false));
  };

  return (
    <div className="ir-crew-page">
      <div className="ir-crew-page__scroll">
        <div className="ir-crew-page__col">
          <div className="ir-crew-page__head">
            <div>
              <div className="ir-crew-page__eyebrow">CREW</div>
              <div className="ir-crew-page__title">项目</div>
            </div>
            <div className="ir-crew-page__actions">
              <button type="button" className="ir-crew-page__refresh" onClick={openShowcase} disabled={showcaseBusy}>
                {showcaseBusy ? "打开中" : "体验内置案例"}
              </button>
              <button type="button" className="ir-crew-page__refresh" onClick={load} disabled={loading}>
                刷新
              </button>
            </div>
          </div>

          {loading && !projects ? (
            <StateNote kind="loading" text="正在装载项目" />
          ) : error ? (
            <StateNote kind="error" text={error} />
          ) : !projects || projects.length === 0 ? (
            <CrewShowcasePanel
              busy={showcaseBusy}
              error={showcaseError}
              onOpen={openShowcase}
            />
          ) : (
            <>
              {showcaseError && <StateNote kind="error" text={showcaseError} />}
              <div className="ir-crew-cards">
                {projects.map((p) => {
                  const prog = projectProgress(p.tasks);
                  const running = runningCount(p.tasks);
                  const awaiting = awaitingCount(p.tasks);
                  const name = (p.goal_text ?? "").trim() || p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className="ir-crew-card ir-crew-card--project"
                      onClick={() => bus.openCrewProject(p.id)}
                    >
                      <div className="ir-crew-card__row">
                        <span className="ir-crew-card__name" title={name}>{name}</span>
                        <span className="ir-crew-card__prog">{prog.label}</span>
                      </div>
                      <span className="ir-crew-pill ir-crew-pill--sop">
                        <span className="ir-crew-pill__k">SOP</span>
                        {templateName(p.sop_template_id)}
                      </span>
                      <div className="ir-crew-card__meta">
                        {p.source === "showcase" && (
                          <span className="ir-crew-pill ir-crew-pill--showcase">内置案例</span>
                        )}
                        {running > 0 && (
                          <span className="ir-crew-chip ir-crew-chip--agent">
                            <span className="ir-crew-chip__dot" aria-hidden="true" />
                            执行中 · {running}
                          </span>
                        )}
                        {awaiting > 0 && (
                          <span className="ir-crew-chip ir-crew-chip--warn">等我处理 · {awaiting}</span>
                        )}
                        {running === 0 && awaiting === 0 && (
                          <span className="ir-crew-card__quiet">
                            {p.status === "completed" ? "已完成" : "静待推进"}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default CrewProjectsPage;

function CrewShowcasePanel({
  busy,
  error,
  onOpen,
}: {
  busy: boolean;
  error: string | null;
  onOpen: () => void;
}) {
  return (
    <div className="ir-crew-showcase">
      <div className="ir-crew-showcase__hero">
        <div className="ir-crew-showcase__copy">
          <div className="ir-crew-showcase__badges">
            {SHOWCASE_BADGES.map((badge) => (
              <span key={badge} className="ir-crew-showcase__badge">{badge}</span>
            ))}
          </div>
          <h2>{SHOWCASE_TITLE}</h2>
          <p>
            一个确定性 Crew 协作现场：Anna 先整理零散周会记录，行动项从 v1
            返工到 v2，协作看板和数据口径并行完成，纪要发布进入负责人评审门。
          </p>
          <div className="ir-crew-showcase__actions">
            <button type="button" className="ir-crew-showcase__primary" onClick={onOpen} disabled={busy}>
              {busy ? "正在打开" : "打开完整案例"}
            </button>
            <span className="ir-crew-showcase__hint">点击后写入本地工作区，并始终标记为示例数据</span>
          </div>
          {error && <div className="ir-crew-showcase__error">{error}</div>}
        </div>
        <div className="ir-crew-showcase__panel" aria-label="内置案例工作流预览">
          {SHOWCASE_STAGES.map((stage, index) => (
            <div key={stage.id} className={`ir-crew-showcase-stage ir-crew-showcase-stage--${stage.state}`}>
              <div className="ir-crew-showcase-stage__idx">{index + 1}</div>
              <div className="ir-crew-showcase-stage__body">
                <div className="ir-crew-showcase-stage__top">
                  <span>{stage.title}</span>
                  <span>{showcaseStateLabel(stage.state)}</span>
                </div>
                <div className="ir-crew-showcase-stage__owner">{stage.owner}</div>
                <div className="ir-crew-showcase-stage__detail">{stage.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="ir-crew-showcase__grid">
        <div className="ir-crew-showcase__block">
          <div className="ir-crew-showcase__block-title">体验路径</div>
          <div className="ir-crew-showcase-steps">
            {SHOWCASE_STEPS.map((step, index) => (
              <div key={step.title} className="ir-crew-showcase-step">
                <span>{index + 1}</span>
                <div>
                  <div>{step.title}</div>
                  <p>{step.detail}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="ir-crew-showcase__block">
          <div className="ir-crew-showcase__block-title">能力框架</div>
          <div className="ir-crew-showcase-caps">
            {SHOWCASE_CAPABILITIES.map((cap) => (
              <div key={cap.label} className="ir-crew-showcase-cap">
                <span>{cap.label}</span>
                <p>{cap.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
