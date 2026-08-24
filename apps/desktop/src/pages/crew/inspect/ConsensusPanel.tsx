/**
 * ConsensusPanel · 项目共识面板(面包屑「共识·N」pill 点开右滑)
 *   条目列表 [约束]/[口径]/[决策] kind 章 + text;Boss 可增/改/删(B1b memory API),
 *   成员只读。N = 真条数。零捏造:一切来自 GET .../memory。
 */

import { useEffect, useState } from "react";

import { ApiError } from "../../../lib/api/client";
import {
  deleteProjectMemory,
  upsertProjectMemory,
  type MemoryItem,
} from "../../../lib/api/crew";

const KINDS = ["约束", "口径", "决策"] as const;
type Kind = (typeof KINDS)[number];

function CloseX() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export interface ConsensusPanelProps {
  projectId: string;
  items: MemoryItem[];
  isOwner: boolean;
  onClose: () => void;
  /** 增删改后回调(父级重载 memory) */
  onChanged: () => void;
}

export function ConsensusPanel({ projectId, items, isOwner, onClose, onChanged }: ConsensusPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.body || String(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (kind: Kind, text: string, id?: string) =>
    guard(async () => {
      await upsertProjectMemory(projectId, id ? { id, kind, text } : { kind, text });
      setEditingId(null);
      setAdding(false);
    });

  const remove = (id: string) => guard(() => deleteProjectMemory(projectId, id));

  return (
    <div className="ir-insp-consensus-layer" role="dialog" aria-label="项目共识">
      <div className="ir-insp-scrim ir-insp-scrim--light" onClick={onClose} aria-hidden="true" />
      <aside className="ir-insp-consensus">
        <div className="ir-insp-consensus__head">
          <span className="ir-insp-consensus__title">项目共识</span>
          <span className="ir-insp-consensus__count">{items.length}</span>
          <span className="ir-insp-sign__spacer" />
          <button type="button" className="ir-insp-x" aria-label="关闭" onClick={onClose}>
            <CloseX />
          </button>
        </div>

        <div className="ir-insp-consensus__body">
          {items.length === 0 && !adding && (
            <div className="ir-insp-empty-inline">尚无共识 —— {isOwner ? "记下第一条团队口径。" : "由 Boss 沉淀。"}</div>
          )}

          {items.map((it) =>
            editingId === it.id ? (
              <ConsensusEditor
                key={it.id}
                initialKind={(KINDS as readonly string[]).includes(it.kind) ? (it.kind as Kind) : "口径"}
                initialText={it.text}
                busy={busy}
                onCancel={() => setEditingId(null)}
                onSave={(k, t) => save(k, t, it.id)}
              />
            ) : (
              <div key={it.id} className="ir-insp-cons-item">
                <span className={`ir-insp-kind ir-insp-kind--${it.kind}`}>{it.kind}</span>
                <span className="ir-insp-cons-item__text">{it.text}</span>
                {isOwner && (
                  <span className="ir-insp-cons-item__act">
                    <button type="button" className="ir-insp-linkbtn" disabled={busy} onClick={() => setEditingId(it.id)}>改</button>
                    <button type="button" className="ir-insp-linkbtn ir-insp-linkbtn--danger" disabled={busy} onClick={() => remove(it.id)}>删</button>
                  </span>
                )}
              </div>
            ),
          )}

          {adding && (
            <ConsensusEditor
              initialKind="口径"
              initialText=""
              busy={busy}
              onCancel={() => setAdding(false)}
              onSave={(k, t) => save(k, t)}
            />
          )}
        </div>

        {isOwner && !adding && (
          <div className="ir-insp-consensus__foot">
            <button type="button" className="ir-insp-btn ir-insp-btn--primary" disabled={busy} onClick={() => setAdding(true)}>
              + 记一条共识
            </button>
          </div>
        )}
        {error && <div className="ir-insp-err">{error}</div>}
      </aside>
    </div>
  );
}

function ConsensusEditor({
  initialKind,
  initialText,
  busy,
  onCancel,
  onSave,
}: {
  initialKind: Kind;
  initialText: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (kind: Kind, text: string) => void;
}) {
  const [kind, setKind] = useState<Kind>(initialKind);
  const [text, setText] = useState(initialText);
  return (
    <div className="ir-insp-cons-edit">
      <div className="ir-insp-cons-edit__kinds" role="radiogroup" aria-label="类别">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={k === kind}
            className={`ir-insp-kindpick${k === kind ? " is-on" : ""}`}
            onClick={() => setKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      <textarea
        className="ir-insp-cons-edit__ta"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="一句可执行的口径、约束或决策"
        rows={2}
        autoFocus
      />
      <div className="ir-insp-cons-edit__act">
        <button type="button" className="ir-insp-btn ir-insp-btn--primary" disabled={busy || text.trim() === ""} onClick={() => onSave(kind, text.trim())}>
          保存
        </button>
        <button type="button" className="ir-insp-btn ir-insp-btn--default" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

export default ConsensusPanel;
