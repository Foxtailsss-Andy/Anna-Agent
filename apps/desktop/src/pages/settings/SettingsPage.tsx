/**
 * SettingsPage · 设置(《R8 设置》Task 1)
 *
 * Boss 视角**恰 6 卡**:连接 / 模型档案 / 数据出境(J4)/ 记忆(W6 站位)/ 外观 / 关于;
 * PetalDivider + 「开发者模式」开关(localStorage anna.devmode)。开启后整屏接管
 * (DevTakeover),Boss 5 卡隐藏,关闭即回。零假数据,真值原文。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { PetalDivider } from "../../components/anna/IrisPetal";
import { StateNote } from "../../components/anna/StateNote";
import {
  SegmentedControl,
  SettingsCard,
  Switch,
} from "../../components/surfaces/SurfaceKit";
import { getEgress, getRuntimeConfig, getRuntimeStatus } from "../../lib/api/admin";
import {
  egressDesc,
  egressRows,
  egressScopeNote,
  egressSummary,
  egressWarning,
} from "./egressModel";
import { usePersona } from "../../lib/persona";
import { applyTheme, loadTheme, type ThemeMode } from "../../lib/theme";
import { DevTakeover } from "./DevTakeover";
import { ModelProfilesCard, type BaseModel, type ModelProfile } from "./ModelProfilesCard";
import "./SettingsPage.css";

type Rec = Record<string, unknown>;

const DEVMODE_KEY = "anna.devmode";

function loadDevMode(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem(DEVMODE_KEY) === "1";
}
function saveDevMode(v: boolean): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(DEVMODE_KEY, v ? "1" : "0");
}

/* 连接卡:三 MCP 状态行 */
interface ConnRow {
  label: string;
  tone: "ok" | "warn";
  stateText: string;
}

function connRows(status: Rec | null): ConnRow[] {
  const defs: [string, string][] = [
    ["reimbursement_mcp", "报销 MCP"],
    ["erp_mcp", "ERP MCP · 只读"],
    ["hiker_mcp", "Hiker MCP · 只读"],
  ];
  return defs.map(([key, label]) => {
    const m = (status?.[key] as Rec) ?? {};
    const s = String(m.status ?? "");
    if (s === "connected") {
      return { label, tone: "ok", stateText: `已连接 · ${String(m.tool_count ?? 0)} 工具` };
    }
    const err = m.error_code ? ` · ${String(m.error_code)}` : "";
    return { label, tone: "warn", stateText: `${s || "未连接"}${err}` };
  });
}

export function SettingsPage() {
  const { persona, setPersona } = usePersona();
  const [status, setStatus] = useState<Rec | null>(null);
  const [config, setConfig] = useState<Rec | null>(null);
  /* J4:出境披露载荷(null = 没拿到,卡片如实说不知道) */
  const [egress, setEgress] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeMode>(() => loadTheme());
  const [devMode, setDevMode] = useState<boolean>(() => loadDevMode());

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getRuntimeStatus(), getRuntimeConfig()])
      .then(([st, cfg]) => {
        setStatus(st as Rec);
        setConfig(cfg as Rec);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    /* J4 出境披露独立装载:拿不到就让这张卡自己空着说不知道,不连累整页
       —— 一张讲「我不瞒你」的卡,更不该在失败时静默显示一个漂亮的空表。 */
    getEgress()
      .then((e) => setEgress(e as Rec))
      .catch(() => setEgress(null));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // config 变更后只重拉 config(连接状态不变),供 ModelProfilesCard 增删后刷新
  const reloadConfig = useCallback(() => {
    getRuntimeConfig()
      .then((cfg) => setConfig(cfg as Rec))
      .catch((e) => setError(String(e)));
  }, []);

  const onTheme = useCallback((v: ThemeMode) => {
    setTheme(v);
    applyTheme(v);
  }, []);

  const onDevMode = useCallback((v: boolean) => {
    setDevMode(v);
    saveDevMode(v);
  }, []);

  const values = (config?.values as Rec | undefined) ?? {};
  const secrets = (config?.secrets as Rec | undefined) ?? {};
  const base: BaseModel = {
    provider: String(values.model_provider ?? "—"),
    model_name: String(values.model_name ?? "—"),
    api_key_configured: Boolean(secrets.model_api_key_configured),
  };
  const profiles = (values.model_profiles as ModelProfile[] | undefined) ?? [];
  const rows = useMemo(() => connRows(status), [status]);
  const connectedCount = rows.filter((r) => r.tone === "ok").length;
  /* J4:探针态从设置页手上这份 runtime status 合并进出境卡 —— 出境路由已不再自己
     探连接器(那会让「我只往你配置的端点发数据」这张卡自己造出六次出境请求)。 */
  const outRows = useMemo(() => egressRows(egress, status), [egress, status]);
  const outSummary = useMemo(() => egressSummary(egress), [egress]);
  const outDesc = useMemo(() => egressDesc(egress), [egress]);
  const outWarning = useMemo(() => egressWarning(egress), [egress]);
  const outScope = useMemo(() => egressScopeNote(egress), [egress]);

  if (devMode) {
    return <DevTakeover devMode={devMode} onDevMode={onDevMode} />;
  }

  return (
    <div className="ir-set">
      <div className="ir-set__scroll">
        <div className="ir-set__col">
          <div className="ir-set__head">
            <div className="ir-set__eyebrow">SETTINGS</div>
            <div className="ir-set__title">设置</div>
          </div>

          {loading ? (
            <StateNote kind="loading" text="正在装载运行时设置" />
          ) : error ? (
            <StateNote kind="error" text={error} />
          ) : (
            <>
              <div className="set-grid">
                {/* 1 · 连接 */}
                <SettingsCard
                  title="连接"
                  statusChip={`${connectedCount}/3 已连接`}
                  desc="数据源与权限边界；断开后对应看板进入未连接态，不做演示数字。"
                >
                  <ul className="set-conn">
                    {rows.map((r) => (
                      <li className="set-conn__row" key={r.label}>
                        <span className={`set-conn__dot set-conn__dot--${r.tone}`} aria-hidden="true" />
                        <span className="set-conn__name">{r.label}</span>
                        <span className="set-conn__state">{r.stateText}</span>
                      </li>
                    ))}
                  </ul>
                </SettingsCard>

                {/* 2 · 模型档案 */}
                <ModelProfilesCard base={base} profiles={profiles} onReload={reloadConfig} />

                {/* 3 · 数据出境(J4 v1:纯披露,不做计数/脱敏)
                    文案全部来自载荷:三条声明后端不给就不说,给了不诚实的值就出警示条。 */}
                <SettingsCard
                  title="数据出境"
                  statusChip={outRows === null ? "读不到" : outSummary || undefined}
                  statusTone={outRows === null ? "stub" : undefined}
                  desc={outDesc || undefined}
                >
                  {outWarning && <div className="set-egress__warn">{outWarning}</div>}
                  {outRows === null ? (
                    <span className="set-egress__unknown">
                      暂时读不到出境清单 —— 这里不猜，请稍后重开设置页。
                    </span>
                  ) : outRows.length === 0 ? (
                    /* 读到了,但后端一个目的地都没列 —— 与「读不到」是两回事,
                       各说各的实话,不由前端替它补一张表。 */
                    <span className="set-egress__unknown">
                      后端给出的出境清单是空的 —— 这里不替它补目的地。
                    </span>
                  ) : (
                    <ul className="set-egress">
                      {outRows.map((r) => (
                        <li className="set-egress__row" key={r.id}>
                          <span
                            className={`set-conn__dot set-conn__dot--${r.tone}`}
                            aria-hidden="true"
                          />
                          <span className="set-egress__main">
                            <span className="set-egress__name">
                              {r.label}
                              <span className="set-egress__state">{r.stateText}</span>
                            </span>
                            <span className="set-egress__dest">{r.destinationText}</span>
                            {r.categoriesText && (
                              <span className="set-egress__cats">发送：{r.categoriesText}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {outScope && <div className="set-egress__scope">{outScope}</div>}
                </SettingsCard>

                {/* 4 · 记忆(W6 站位) */}
                <SettingsCard
                  title="记忆"
                  statusChip="即将上线"
                  statusTone="stub"
                  desc="W6：业务记忆命中将以系统步形式进入时间线，此处管理条目。"
                />

                {/* 5 · 外观 */}
                <SettingsCard
                  title="外观"
                  desc="浅色主、深色补齐（非反相：瓷变墨、您的话语变纸）。"
                >
                  <div className="set-appearance">
                    <SegmentedControl
                      value={theme}
                      onChange={onTheme}
                      options={[
                        { value: "light", label: "浅色" },
                        { value: "dark", label: "深色" },
                      ]}
                    />
                    <Switch
                      checked={persona}
                      onChange={setPersona}
                      label="拟人陪伴层"
                      note="关闭后仅保留素颜权威信息，不影响任何真值"
                    />
                  </div>
                </SettingsCard>

                {/* 6 · 关于 */}
                <SettingsCard title="关于" desc="Anna · 鸢尾 Iris · 桌面版">
                  <span className="set-about__ver">
                    v{__APP_VERSION__} · tokens v2 · spec V1.0
                  </span>
                </SettingsCard>
              </div>

              <PetalDivider />

              <Switch
                checked={devMode}
                onChange={onDevMode}
                label="开发者模式"
                note="关闭 · Boss 视角只留 5 张卡；开启后整屏接管运行时状态页"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
