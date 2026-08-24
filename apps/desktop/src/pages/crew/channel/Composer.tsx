/**
 * Composer · 频道输入(R4a @拾取器 + R6 Enter 发送,3h/3k 规格)
 *
 * - Enter 发送 / Shift+Enter 换行 / Ctrl·⌘+Enter 兼容 / IME 组词守卫 —— 复用
 *   lib/composerKeys.handleComposerEnter(仅当拾取器关闭时)。
 * - 键入 `@` 于 composer 上方弹拾取器:继续输入过滤、↑↓ 循环、Enter 选中(不发送)、
 *   Esc 关、click 确认;插入沿 insertMentionAtCaret(光标处以纯文本 `@名 ` 替换 @partial)。
 *   textarea 内始终纯文本 —— token pill 只在消息渲染侧兑现(登记偏差:原生框不做内联 pill)。
 * - 「@ 成员」pill = 光标插 `@` 触发同一浮层(单一机制)。
 * - 窄栏让位(328):撤常驻微提示,「(Enter 发送)」并入 placeholder;动作行仅剩 @成员/＋任务/
 *   send 单行右簇。组词中才在动作行左侧短暂现 warn pill「组词中 · Enter 不发送」并暗化发送键。
 */

import { useEffect, useRef, useState } from "react";

import { handleComposerEnter } from "../../../lib/composerKeys";
import { ApiError } from "../../../lib/api/client";
import { channelCommand, postChannel, type TeamMember } from "../../../lib/api/crew";
import { MentionPicker } from "./MentionPicker";
import { buildSayPayload, type InsertedMention } from "./channelModel";
import {
  activeMentionQuery,
  cycleIndex,
  filterMembers,
  insertAtSign,
  insertMentionAtCaret,
  SYSTEM_ANNA_MENTION_ID,
  withAnnaCoordinator,
} from "./pickerModel";

function PaperPlane() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 3L3 10.5l6.5 2.5L12 20l3-8z" />
      <path d="M9.5 13L15 7.5" />
    </svg>
  );
}

export interface ComposerProps {
  projectId: string;
  members: TeamMember[];
  onRefresh: () => void;
}

export function Composer({ projectId, members, onRefresh }: ComposerProps) {
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [inserted, setInserted] = useState<InsertedMention[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [manuallyClosed, setManuallyClosed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const empty = text.trim() === "";

  const pickerMembers = withAnnaCoordinator(members);
  const active = composing ? null : activeMentionQuery(text, caret);
  const filtered = active ? filterMembers(pickerMembers, active.query) : [];
  const pickerOpen = active !== null && !manuallyClosed && filtered.length > 0;
  const clampedIndex = filtered.length ? Math.min(activeIndex, filtered.length - 1) : 0;

  // 点 composer 外 → 关拾取器
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setManuallyClosed(true);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  const restoreCaret = (pos: number) => {
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.selectionStart = el.selectionEnd = pos;
      setCaret(pos);
    });
  };

  const confirmMember = (m: { id: string; name: string }) => {
    const el = taRef.current;
    const caretNow = el?.selectionStart ?? text.length;
    const r = insertMentionAtCaret(text, caretNow, m.name);
    setText(r.text);
    setInserted((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, { id: m.id, name: m.name }]));
    setManuallyClosed(false);
    setActiveIndex(0);
    restoreCaret(r.caret);
  };

  const openPickerViaPill = () => {
    const el = taRef.current;
    const caretNow = el?.selectionStart ?? text.length;
    const r = insertAtSign(text, caretNow);
    setText(r.text);
    setManuallyClosed(false);
    setActiveIndex(0);
    restoreCaret(r.caret);
  };

  const submitSay = async () => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const payload = buildSayPayload(text.trim(), inserted, [
        { id: SYSTEM_ANNA_MENTION_ID, display_name: "Anna" },
        ...members.filter((m) => m.id !== SYSTEM_ANNA_MENTION_ID),
      ]);
      await postChannel(projectId, payload.body, payload.mentions);
      setText("");
      setInserted([]);
      setCaret(0);
      onRefresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.body || String(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCommand = async () => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await channelCommand(projectId, text.trim());
      setText("");
      setInserted([]);
      setCaret(0);
      onRefresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.body || String(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 拾取器开启:↑↓ 循环、Enter 选中(不发送)、Esc 关 —— 优先于发送键契约
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => cycleIndex(filtered.length, i, 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => cycleIndex(filtered.length, i, -1));
        return;
      }
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault();
        const pick = filtered[clampedIndex];
        if (pick) confirmMember(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setManuallyClosed(true);
        return;
      }
    }
    // 拾取器关闭:全局发送键契约(Enter 发送 / Shift+Enter 换行 / IME 守卫 / Ctrl·⌘ 兼容)
    handleComposerEnter(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        isComposing: e.nativeEvent.isComposing,
        preventDefault: () => e.preventDefault(),
      },
      { running: busy, hasText: !empty, onSend: () => void submitSay() },
    );
  };

  const syncCaret = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  return (
    <div className="ir-chan-composer" ref={rootRef}>
      {error && <div className="ir-chan-err ir-chan-composer__err">{error}</div>}

      {pickerOpen && (
        <MentionPicker
          members={filtered}
          query={active?.query ?? ""}
          activeIndex={clampedIndex}
          onSelect={confirmMember}
          onHover={setActiveIndex}
        />
      )}

      <div className="ir-chan-composer__inputrow">
        <textarea
          ref={taRef}
          className="ir-chan-composer__input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setManuallyClosed(false);
            setActiveIndex(0);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(e) => {
            setComposing(false);
            setText(e.currentTarget.value);
            setCaret(e.currentTarget.selectionStart ?? 0);
          }}
          placeholder="对 Boss 或 @成员 说……（Enter 发送）"
          rows={1}
          disabled={busy}
        />
      </div>

      <div className="ir-chan-composer__actionrow">
        {composing && (
          <span className="ir-chan-composer__warn">
            <span className="ir-chan-composer__warndot" aria-hidden="true" />
            组词中 · Enter 不发送
          </span>
        )}
        <div className="ir-chan-composer__tools">
          <button
            type="button"
            className={`ir-chan-toolpill${pickerOpen ? " is-open" : ""}`}
            onClick={openPickerViaPill}
            aria-expanded={pickerOpen}
          >
            @ 成员
          </button>
          <button
            type="button"
            className="ir-chan-toolpill"
            onClick={submitCommand}
            disabled={empty || busy}
            title="把当前输入起草为任务"
          >
            ＋任务
          </button>
          <button
            type="button"
            className={`ir-chan-composer__send${composing ? " is-composing" : ""}`}
            onClick={submitSay}
            disabled={empty || busy}
            aria-label="发送"
          >
            <PaperPlane />
          </button>
        </div>
      </div>
    </div>
  );
}

export default Composer;
