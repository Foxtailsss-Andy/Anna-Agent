/**
 * ModelProfilesCard · 设置第 2 卡「模型档案」(《R8 设置》Task 1 Step 2.2)
 *
 * 列表 = 基座默认档(runtime model_name,不可删)+ config.values.model_profiles;
 * 每档只显 label/provider/model_name + `api_key_configured` 徽记(密钥只写不读)。
 * 新增表单 → addModelProfile(409/400 原文回显);删除(非 default)→ deleteModelProfile。
 * 任一写入成功 → requires_restart_after_save 提示 + 「重启运行时」(Electron 真重启,
 * 浏览器 dev 禁用 + 说明)。
 */

import { useState } from "react";

import { SettingsCard } from "../../components/surfaces/SurfaceKit";
import { StateNote } from "../../components/anna/StateNote";
import {
  addModelProfile,
  deleteModelProfile,
  type AddModelProfileInput,
} from "../../lib/api/admin";
import { isRestartAvailable, restartRuntime } from "../../lib/api/runtimeControl";

export interface ModelProfile {
  id: string;
  label: string;
  provider: string;
  model_name: string;
  api_key_configured: boolean;
}

export interface BaseModel {
  provider: string;
  model_name: string;
  api_key_configured: boolean;
}

const EMPTY_FORM: AddModelProfileInput = {
  id: "",
  label: "",
  provider: "openai-compatible",
  endpoint: "",
  model_name: "",
  api_key: "",
};

function KeyBadge({ configured }: { configured: boolean }) {
  return (
    <span className={`set-mp__key set-mp__key--${configured ? "on" : "off"}`}>
      {configured ? "密钥已配置" : "无密钥"}
    </span>
  );
}

export function ModelProfilesCard({
  base,
  profiles,
  onReload,
}: {
  base: BaseModel;
  profiles: ModelProfile[];
  onReload: () => void;
}) {
  const [form, setForm] = useState<AddModelProfileInput>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [restartMsg, setRestartMsg] = useState<string | null>(null);

  const restartOk = isRestartAvailable();

  const submit = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const payload: AddModelProfileInput = {
        id: form.id.trim(),
        label: form.label.trim() || form.model_name.trim(),
        provider: form.provider?.trim() || "openai-compatible",
        endpoint: form.endpoint.trim(),
        model_name: form.model_name.trim(),
        // api_key 只写不读:留空则不下发
        ...(form.api_key?.trim() ? { api_key: form.api_key.trim() } : {}),
      };
      await addModelProfile(payload);
      setForm(EMPTY_FORM);
      setAdding(false);
      setNeedsRestart(true);
      onReload();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    setFormError(null);
    try {
      await deleteModelProfile(id);
      setNeedsRestart(true);
      onReload();
    } catch (e) {
      setFormError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const doRestart = async () => {
    setRestarting(true);
    setRestartMsg(null);
    try {
      await restartRuntime();
      setRestartMsg("已请求重启运行时");
      setNeedsRestart(false);
    } catch (e) {
      setRestartMsg(String(e));
    } finally {
      setRestarting(false);
    }
  };

  const canSubmit = form.id.trim() && form.endpoint.trim() && form.model_name.trim() && !busy;

  return (
    <SettingsCard
      title="模型档案"
      statusChip={base.model_name}
      desc="基座默认档 + 多档并存；新增档位的密钥只写不读，列表仅显是否已配置。"
    >
      <div className="set-mp">
        <ul className="set-mp__list">
          <li className="set-mp__row">
            <span className="set-mp__name">
              {base.model_name}
              <span className="set-mp__default">默认</span>
            </span>
            <span className="set-mp__prov">{base.provider}</span>
            <KeyBadge configured={base.api_key_configured} />
          </li>
          {profiles.map((p) => (
            <li key={p.id} className="set-mp__row">
              <span className="set-mp__name">
                {p.label || p.model_name}
                <span className="set-mp__id">{p.id}</span>
              </span>
              <span className="set-mp__prov">
                {p.provider} · {p.model_name}
              </span>
              <KeyBadge configured={p.api_key_configured} />
              <button
                type="button"
                className="set-mp__del"
                onClick={() => remove(p.id)}
                disabled={busy}
              >
                删除
              </button>
            </li>
          ))}
        </ul>

        {adding ? (
          <div className="set-mp__form">
            <div className="set-mp__grid">
              <label className="set-mp__field">
                <span>档位 id</span>
                <input
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="如 lite 或 craft"
                />
              </label>
              <label className="set-mp__field">
                <span>展示名 label</span>
                <input
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  placeholder="可选，默认取模型名"
                />
              </label>
              <label className="set-mp__field">
                <span>provider</span>
                <input
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                />
              </label>
              <label className="set-mp__field">
                <span>model_name</span>
                <input
                  value={form.model_name}
                  onChange={(e) => setForm({ ...form, model_name: e.target.value })}
                  placeholder="如 deepseek-chat"
                />
              </label>
              <label className="set-mp__field set-mp__field--wide">
                <span>endpoint</span>
                <input
                  value={form.endpoint}
                  onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
                  placeholder="https://…/chat/completions"
                />
              </label>
              <label className="set-mp__field set-mp__field--wide">
                <span>api_key（只写不读）</span>
                <input
                  type="password"
                  value={form.api_key ?? ""}
                  onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  placeholder="可选"
                  autoComplete="off"
                />
              </label>
            </div>
            {formError && <StateNote kind="error" text={formError} />}
            <div className="set-mp__actions">
              <button
                type="button"
                className="set-mp__btn set-mp__btn--primary"
                onClick={submit}
                disabled={!canSubmit}
              >
                保存档位
              </button>
              <button
                type="button"
                className="set-mp__btn"
                onClick={() => {
                  setAdding(false);
                  setForm(EMPTY_FORM);
                  setFormError(null);
                }}
                disabled={busy}
              >
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            {formError && <StateNote kind="error" text={formError} />}
            <button type="button" className="set-mp__btn" onClick={() => setAdding(true)}>
              新增档案
            </button>
          </>
        )}

        {needsRestart && (
          <div className="set-mp__restart">
            <span className="set-mp__restart-note">
              档案已写入运行时配置，重启后生效。
            </span>
            <button
              type="button"
              className="set-mp__btn set-mp__btn--primary"
              onClick={doRestart}
              disabled={!restartOk || restarting}
              title={restartOk ? undefined : "桌面环境可用"}
            >
              {restarting ? "重启中……" : "重启运行时"}
            </button>
            {!restartOk && <span className="set-mp__restart-hint">桌面环境可用</span>}
          </div>
        )}
        {restartMsg && <span className="set-mp__restart-hint">{restartMsg}</span>}
      </div>
    </SettingsCard>
  );
}

export default ModelProfilesCard;
