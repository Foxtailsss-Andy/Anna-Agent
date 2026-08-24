/**
 * DevTakeover · 开发者接管屏(《R8 设置》Task 2)
 *
 * 「开发者模式」开启后整屏替换 Boss 5 卡;旧 RuntimeStatusPage 全部信息换 Iris 皮,
 * 内容不删只分层。各块独立加载/错误态(一块失败不拖垮整屏);数据密集 → 零点缀零光晕,
 * 宽表自身横向滚动。真值原文,零假数据。
 */

import { useCallback, useEffect, useState } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { Switch } from "../../components/surfaces/SurfaceKit";
import {
  getAgentRunsLedger,
  getDomainReadiness,
  getGovernanceStatus,
  getRuntimeStatus,
  getSkills,
  getValidationLedger,
  validateRuntime,
} from "../../lib/api/admin";
import { AgentDirectivesPanel } from "./AgentDirectivesPanel";
import "./DevTakeover.css";

type Rec = Record<string, unknown>;

/* ---------- 独立加载小钩子(每块自持) ---------- */
interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

function useAsync<T>(fn: () => Promise<T>): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fn()
      .then((d) => setData(d))
      .catch((e) => {
        setData(null);
        setError(String(e));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

/* ---------- 展示原子 ---------- */
function Block({
  title,
  sub,
  action,
  children,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="ir-dev__block">
      <div className="ir-dev__block-head">
        <span className="ir-dev__block-title">{title}</span>
        {sub && <span className="ir-dev__block-sub">{sub}</span>}
        {action && <span className="ir-dev__block-action">{action}</span>}
      </div>
      {children}
    </section>
  );
}

type Tone = "ok" | "warn" | "danger" | "mute";

function Dot({ tone }: { tone: Tone }) {
  return <span className={`ir-dev__dot ir-dev__dot--${tone}`} aria-hidden="true" />;
}

function Kv({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="ir-dev__kv">
      <span className="ir-dev__kv-k">{k}</span>
      <span className="ir-dev__kv-v">{v}</span>
    </div>
  );
}

function statusTone(status: string | undefined): Tone {
  switch (status) {
    case "connected":
    case "configured":
    case "passed":
    case "ready":
    case "completed":
      return "ok";
    case "needs_validation":
    case "waiting_confirmation":
    case "collecting":
    case "draft_created":
      return "warn";
    case "blocked":
    case "unhealthy":
    case "failed":
    case "not_configured":
      return "danger";
    default:
      return "mute";
  }
}

/* ---------- 各块 ---------- */

function OverviewBlock() {
  const { data, loading, error } = useAsync<Rec>(getRuntimeStatus);
  return (
    <Block title="运行时总览" sub="getRuntimeStatus · 真值原文">
      {loading ? (
        <StateNote kind="loading" text="正在拉取运行时状态" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : !data ? (
        <StateNote kind="empty" text="无运行时状态" />
      ) : (
        <div className="ir-dev__overview">
          {(() => {
            const model = (data.model as Rec) ?? {};
            const mcps: [string, Rec][] = [
              ["reimbursement_mcp", (data.reimbursement_mcp as Rec) ?? {}],
              ["erp_mcp", (data.erp_mcp as Rec) ?? {}],
              ["hiker_mcp", (data.hiker_mcp as Rec) ?? {}],
            ];
            const skill = (data.skill as Rec) ?? {};
            const tools = (data.tools as Rec[]) ?? [];
            return (
              <>
                <div className="ir-dev__panel">
                  <div className="ir-dev__panel-h">MODEL</div>
                  <Kv k="provider" v={String(model.provider ?? "—")} />
                  <Kv k="model_name" v={String(model.model_name ?? "—")} />
                  <Kv
                    k="status"
                    v={
                      <>
                        <Dot tone={statusTone(String(model.status))} />
                        {String(model.status ?? "—")}
                      </>
                    }
                  />
                </div>
                {mcps.map(([name, m]) => (
                  <div className="ir-dev__panel" key={name}>
                    <div className="ir-dev__panel-h">{name.toUpperCase()}</div>
                    <Kv
                      k="status"
                      v={
                        <>
                          <Dot tone={statusTone(String(m.status))} />
                          {String(m.status ?? "—")}
                        </>
                      }
                    />
                    <Kv k="tool_count" v={String(m.tool_count ?? "—")} />
                    {m.error_code != null && (
                      <Kv k="error_code" v={String(m.error_code)} />
                    )}
                  </div>
                ))}
                <div className="ir-dev__panel">
                  <div className="ir-dev__panel-h">SKILL</div>
                  <Kv k="id" v={String(skill.id ?? "—")} />
                  <Kv k="version" v={String(skill.version ?? "—")} />
                  <Kv
                    k="loaded"
                    v={
                      <>
                        <Dot tone={skill.loaded ? "ok" : "danger"} />
                        {String(skill.loaded ?? "—")}
                      </>
                    }
                  />
                </div>
                <div className="ir-dev__panel">
                  <div className="ir-dev__panel-h">TOOLS · {tools.length}</div>
                  {tools.map((t, i) => (
                    <div className="ir-dev__mono-line" key={i}>
                      {String(t.name ?? "")}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}
    </Block>
  );
}

function ReadinessBlock() {
  const { data, loading, error } = useAsync<Rec>(getDomainReadiness);
  const domains = (data?.domains as Rec[]) ?? [];
  return (
    <Block title="就绪矩阵" sub="getDomainReadiness · 每域一行">
      {loading ? (
        <StateNote kind="loading" text="正在评估域就绪度" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : domains.length === 0 ? (
        <StateNote kind="empty" text="无域就绪数据" />
      ) : (
        <div className="ir-table">
          <table className="ir-table__el">
            <thead>
              <tr>
                <th>域</th>
                <th>surface</th>
                <th>就绪</th>
                <th>阻塞原因</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d, i) => (
                <tr key={i}>
                  <td>{String(d.domain_id ?? "")}</td>
                  <td>{String(d.surface ?? "")}</td>
                  <td>
                    <Dot tone={statusTone(String(d.readiness_status))} />
                    {String(d.readiness_status ?? "")}
                  </td>
                  <td>
                    {Array.isArray(d.blocking_reasons) && d.blocking_reasons.length
                      ? (d.blocking_reasons as string[]).join(" · ")
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

function ValidationBlock() {
  const { data, loading, error, reload } = useAsync<Rec>(getValidationLedger);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const items = (data?.items as Rec[]) ?? [];

  const run = async () => {
    setRunning(true);
    setRunErr(null);
    try {
      await validateRuntime();
      reload();
    } catch (e) {
      setRunErr(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Block
      title="校验探针"
      sub="validateRuntime + 台账"
      action={
        <button
          type="button"
          className="ir-dev__btn ir-dev__btn--primary"
          onClick={run}
          disabled={running}
        >
          {running ? "校验中……" : "运行校验"}
        </button>
      }
    >
      {runErr && <StateNote kind="error" text={runErr} />}
      {loading ? (
        <StateNote kind="loading" text="正在载入校验台账" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : items.length === 0 ? (
        <StateNote kind="empty" text="尚无校验记录，点“运行校验”" />
      ) : (
        <div className="ir-table">
          <table className="ir-table__el">
            <thead>
              <tr>
                <th>validation_id</th>
                <th>结果</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td>{String(it.validation_id ?? "")}</td>
                  <td>
                    <Dot tone={statusTone(String(it.status))} />
                    {String(it.status ?? "")}
                  </td>
                  <td>{String(it.created_at ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

function SkillsBlock() {
  const { data, loading, error } = useAsync<Rec>(getSkills);
  const active = String(data?.active_skill_id ?? "");
  const skills = (data?.skills as Rec[]) ?? [];
  return (
    <Block title="Skill 注册表" sub={`getSkills · active ${active || "—"}`}>
      {loading ? (
        <StateNote kind="loading" text="正在载入 Skill 注册表" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : skills.length === 0 ? (
        <StateNote kind="empty" text="无已注册 Skill" />
      ) : (
        <ul className="ir-dev__skills">
          {skills.map((s, i) => {
            const isActive = String(s.id) === active;
            return (
              <li key={i} className="ir-dev__skill">
                <span className="ir-dev__skill-id">{String(s.id ?? "")}</span>
                <span className="ir-dev__skill-meta">
                  {String(s.name ?? "")} · v{String(s.version ?? "")}
                </span>
                {isActive && <span className="ir-dev__skill-active">active</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

function AgentRunsBlock() {
  const { data, loading, error } = useAsync<Rec>(getAgentRunsLedger);
  const runs = (data?.runs as Rec[]) ?? [];
  return (
    <Block title="Agent 台账" sub="getAgentRunsLedger · 宽表横向滚动">
      {loading ? (
        <StateNote kind="loading" text="正在载入 Agent 台账" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : runs.length === 0 ? (
        <StateNote kind="empty" text="尚无 Agent run" />
      ) : (
        <div className="ir-table">
          <table className="ir-table__el">
            <thead>
              <tr>
                <th>run_id</th>
                <th>域</th>
                <th>kind</th>
                <th>状态</th>
                <th>事件数</th>
                <th>最近事件</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.run_id ?? "")}</td>
                  <td>{String(r.domain ?? "")}</td>
                  <td>{String(r.kind ?? "")}</td>
                  <td>
                    <Dot tone={statusTone(String(r.status))} />
                    {String(r.status ?? "")}
                  </td>
                  <td>{String(r.event_count ?? "")}</td>
                  <td>{String(r.latest_event_at ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

function GovernanceBlock() {
  const { data, loading, error } = useAsync<Rec>(getGovernanceStatus);
  const harness = (data?.harness as Rec) ?? {};
  const registries = (data?.tool_registries as Rec[]) ?? [];
  const memory = (data?.memory as Rec) ?? {};
  return (
    <Block title="治理总览" sub="getGovernanceStatus">
      {loading ? (
        <StateNote kind="loading" text="正在载入治理总览" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : !data ? (
        <StateNote kind="empty" text="无治理数据" />
      ) : (
        <div className="ir-dev__overview">
          <div className="ir-dev__panel">
            <div className="ir-dev__panel-h">HARNESS</div>
            {Object.entries(harness).map(([k, v]) => (
              <Kv k={k} v={String(v)} key={k} />
            ))}
          </div>
          <div className="ir-dev__panel">
            <div className="ir-dev__panel-h">MEMORY</div>
            <Kv
              k="status"
              v={
                <>
                  <Dot tone={statusTone(String(memory.status))} />
                  {String(memory.status ?? "—")}
                </>
              }
            />
            <Kv k="business_memory_count" v={String(memory.business_memory_count ?? "—")} />
          </div>
          <div className="ir-dev__panel">
            <div className="ir-dev__panel-h">TOOL_REGISTRIES · {registries.length}</div>
            {registries.map((r, i) => (
              <Kv
                k={String(r.id ?? "")}
                v={`${String(r.tool_count ?? 0)} tools`}
                key={i}
              />
            ))}
          </div>
        </div>
      )}
    </Block>
  );
}

export function DevTakeover({
  devMode,
  onDevMode,
}: {
  devMode: boolean;
  onDevMode: (v: boolean) => void;
}) {
  return (
    <div className="ir-dev">
      <div className="ir-dev__scroll">
        <div className="ir-dev__col">
          <div className="ir-dev__hero">
            <div className="ir-dev__eyebrow">DEVELOPER · RUNTIME</div>
            <div className="ir-dev__title">开发者接管屏</div>
            <div className="ir-dev__note">
              运行时状态页全部面板在此接管（内容不删，只分层）；各块独立加载，真值原文。
            </div>
            <div className="ir-dev__toggle">
              <Switch
                checked={devMode}
                onChange={onDevMode}
                label="开发者模式"
                note="关闭 · 回 Boss 视角 5 卡"
              />
            </div>
          </div>
          <OverviewBlock />
          <ReadinessBlock />
          <ValidationBlock />
          <SkillsBlock />
          <AgentRunsBlock />
          <GovernanceBlock />
          <AgentDirectivesPanel />
        </div>
      </div>
    </div>
  );
}

export default DevTakeover;
