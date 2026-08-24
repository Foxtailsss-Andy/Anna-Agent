/**
 * AgentDirectivesPanel · 开发者接管屏「Agent 指令」块(《R8 设置》Task 2 Step 1 末)
 *
 * 四 Agent 附加指令(chat/hiker/reimbursement/create),载入
 * config.values.agent_directives;保存 → putRuntimeConfig({ agent_directives })。
 * 安全:PUT 走后端 read-modify-write + exclude_unset,只携 agent_directives 不动
 * model_profiles / 模型配置;面板另在内存合并未知键,避免丢弃非本表键。
 */

import { useCallback, useEffect, useState } from "react";

import { StateNote } from "../../components/anna/StateNote";
import { getRuntimeConfig, putRuntimeConfig } from "../../lib/api/admin";

const DIRECTIVE_KEYS: { key: string; label: string }[] = [
  { key: "chat", label: "Chat 助手" },
  { key: "hiker", label: "Hiker 客户" },
  { key: "reimbursement", label: "报销" },
  { key: "create", label: "构建 Create" },
];

type Rec = Record<string, unknown>;

function asDirectives(config: Rec): Record<string, string> {
  const values = (config.values as Rec | undefined) ?? {};
  const raw = values.agent_directives;
  if (raw && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Rec)) out[k] = String(v ?? "");
    return out;
  }
  return {};
}

export function AgentDirectivesPanel() {
  const [raw, setRaw] = useState<Record<string, string>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getRuntimeConfig()
      .then((cfg) => {
        const dir = asDirectives(cfg as Rec);
        setRaw(dir);
        setEdits(dir);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSaveMsg(null);
    setError(null);
    try {
      // 合并未知键 → 只覆盖本表 4 键,不丢弃任何既有指令
      const merged: Record<string, string> = { ...raw };
      for (const { key } of DIRECTIVE_KEYS) merged[key] = edits[key] ?? "";
      await putRuntimeConfig({ agent_directives: merged });
      setRaw(merged);
      setSaveMsg("已注入系统提示，下次 run 生效");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const dirty = DIRECTIVE_KEYS.some(({ key }) => (edits[key] ?? "") !== (raw[key] ?? ""));

  return (
    <section className="ir-dev__block">
      <div className="ir-dev__block-head">
        <span className="ir-dev__block-title">Agent 指令</span>
        <span className="ir-dev__block-sub">四 Agent 附加指令，注入系统提示</span>
      </div>
      {loading ? (
        <StateNote kind="loading" text="正在载入 agent_directives" />
      ) : error ? (
        <StateNote kind="error" text={error} />
      ) : (
        <div className="ir-dev__directives">
          {DIRECTIVE_KEYS.map(({ key, label }) => (
            <label key={key} className="ir-dev__dir">
              <span className="ir-dev__dir-label">
                {label}
                <span className="ir-dev__dir-key">{key}</span>
              </span>
              <textarea
                className="ir-dev__dir-input"
                value={edits[key] ?? ""}
                onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                placeholder="附加到该 Agent 系统提示的指令（留空 = 无附加）"
                rows={2}
              />
            </label>
          ))}
          <div className="ir-dev__dir-actions">
            <button
              type="button"
              className="ir-dev__btn ir-dev__btn--primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? "保存中……" : "保存指令"}
            </button>
            {saveMsg && <span className="ir-dev__dir-msg">{saveMsg}</span>}
          </div>
        </div>
      )}
    </section>
  );
}

export default AgentDirectivesPanel;
