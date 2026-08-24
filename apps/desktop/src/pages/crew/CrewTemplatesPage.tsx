/**
 * CrewTemplatesPage · SOP 模板库(F5 · 设计稿 1g)
 *
 * 模板卡 = 名(feature_iteration 带「旗舰」pill)+ 真实计数(从模板真结构算,不用 mock 的 9)
 *   + DAG 骨架 SVG 小图(白 rect=任务 / delegate 底 rect=默认派 Agent / 金菱=评审门 / dashed=可生长)
 *   + 「用此模板建项目」(真建:项目名 → create API → 跳详情)+「编辑器 · P1」dashed 站位。
 * 空态即空态;失败降级不造数。
 */

import { useCallback, useEffect, useState } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { useShellBus } from "../../components/shell/AnnaShell";
import { createProject, listTemplates, type SopTemplate } from "../../lib/api/crew";
import { isFlagship, templateCounts, templateSkeleton, type SkeletonNode } from "./templateModel";
import "./crew.css";

/* ---------------- DAG 骨架小图(elk 布局的迷你投影) ---------------- */

const STEP = 44;
const PAD = 22;

function DagSkeleton({ nodes }: { nodes: SkeletonNode[] }) {
  const width = PAD * 2 + Math.max(0, nodes.length - 1) * STEP;
  const cy = 28;
  return (
    <svg
      className="ir-tpl-dag"
      viewBox={`0 0 ${width} 56`}
      preserveAspectRatio="xMinYMid meet"
      role="img"
      aria-label="流程骨架"
    >
      {nodes.map((n, i) => {
        const cx = PAD + i * STEP;
        const prevX = PAD + (i - 1) * STEP;
        return (
          <g key={n.key}>
            {i > 0 && (
              <line
                className="ir-tpl-dag__edge"
                x1={prevX + 13}
                y1={cy}
                x2={cx - 13}
                y2={cy}
              />
            )}
            {n.kind === "gate" ? (
              <rect
                className="ir-tpl-dag__gate"
                x={cx - 8}
                y={cy - 8}
                width={16}
                height={16}
                rx={2}
                transform={`rotate(45 ${cx} ${cy})`}
              />
            ) : (
              <rect
                className={`ir-tpl-dag__${n.kind}`}
                x={cx - 13}
                y={cy - 9}
                width={26}
                height={18}
                rx={3.5}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}

/* ---------------- 页 ---------------- */

export function CrewTemplatesPage() {
  const bus = useShellBus();
  const [templates, setTemplates] = useState<SopTemplate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listTemplates()
      .then((t) => setTemplates(t))
      .catch((e) => {
        setTemplates(null);
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onCreate = useCallback(
    async (t: SopTemplate) => {
      const name = window.prompt(`用“${t.name}”建项目 —— 给项目起个名字（如“登录页重设计”）`, "");
      if (!name || !name.trim()) return;
      setCreating(t.id);
      setCreateErr(null);
      try {
        const project = await createProject(name.trim(), t.id);
        bus.openCrewProject(project.id);
      } catch (e) {
        setCreateErr(String(e));
      } finally {
        setCreating(null);
      }
    },
    [bus],
  );

  return (
    <div className="ir-crew-page">
      <div className="ir-crew-page__scroll">
        <div className="ir-crew-page__col">
          <div className="ir-crew-page__head">
            <div>
              <div className="ir-crew-page__eyebrow">CREW</div>
              <div className="ir-crew-page__title">SOP 模板</div>
            </div>
            <button type="button" className="ir-crew-page__refresh" onClick={load} disabled={loading}>
              刷新
            </button>
          </div>

          {createErr && <StateNote kind="error" text={createErr} />}

          {loading && !templates ? (
            <StateNote kind="loading" text="正在装载模板" />
          ) : error ? (
            <StateNote kind="error" text={error} />
          ) : !templates || templates.length === 0 ? (
            <StateNote kind="empty" petal text="还没有可用的 SOP 模板。" />
          ) : (
            <div className="ir-crew-cards">
              {templates.map((t) => {
                const { tasks, gates } = templateCounts(t);
                const nodes = templateSkeleton(t);
                return (
                  <div key={t.id} className="ir-crew-card ir-crew-tpl">
                    <div className="ir-crew-card__row">
                      <span className="ir-crew-card__name">{t.name}</span>
                      {isFlagship(t.id) && <span className="ir-crew-tpl__flag">旗舰</span>}
                    </div>
                    <div className="ir-crew-tpl__count">
                      {tasks} 任务 · {gates} 评审门
                    </div>
                    {t.description && <div className="ir-crew-tpl__desc">{t.description}</div>}

                    <div className="ir-crew-tpl__dagwrap">
                      <DagSkeleton nodes={nodes} />
                    </div>

                    <div className="ir-crew-tpl__foot">
                      <button
                        type="button"
                        className="ir-crew-tpl__use"
                        onClick={() => onCreate(t)}
                        disabled={creating === t.id}
                      >
                        {creating === t.id ? "建项目中……" : "用此模板建项目"}
                      </button>
                      <span className="ir-crew-tpl__stub" aria-disabled="true">
                        编辑器 · P1 即将上线
                      </span>
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

export default CrewTemplatesPage;
