/**
 * CreateProjectDialog · 「用此模板建项目」应用内对话框(替换 window.prompt —— Electron 不支持,review C0)。
 *
 * 无障碍:role="dialog" + aria-modal + aria-labelledby 标题 + aria-describedby 说明;打开即聚焦输入;
 * Enter 提交、Esc / 取消 关闭;Tab 在对话框内循环;提交中按钮/输入禁用并显示「建项目中……」;
 * 失败就地 role="alert" 报错、保留输入;关闭后焦点回到触发按钮(由调用方传 returnFocus)。
 * 建项目本身仍由调用方 onSubmit(name) 走 createProject(name, templateId) 并打开项目。
 */

import { useEffect, useId, useRef, useState } from "react";

export interface CreateProjectDialogProps {
  templateName: string;
  /** 提交项目名;resolve = 成功(调用方负责跳转),reject = 就地报错 */
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
  /** 关闭时把焦点还给它(触发按钮) */
  returnFocus?: HTMLElement | null;
}

function messageOf(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Error:\s*/, "") || "建项目失败，请稍后重试。";
}

export function CreateProjectDialog({ templateName, onSubmit, onClose, returnFocus }: CreateProjectDialogProps) {
  const titleId = useId();
  const descId = useId();
  const inputId = useId();
  const errorId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      // 卸载(取消 / 成功跳转)→ 焦点回触发按钮(若它仍在文档里)
      if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    };
  }, [returnFocus]);

  const close = () => {
    if (busyRef.current) return;
    onClose();
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (busyRef.current) return;
    if (!trimmed) {
      setError("请输入项目名。");
      inputRef.current?.focus();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(messageOf(e));
      busyRef.current = false;
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    busyRef.current = false;
    setBusy(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    // 焦点圈在对话框内(aria-modal)
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])") ?? [],
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="ir-crew-dialog-layer">
      <div className="ir-crew-dialog-scrim" aria-hidden="true" onMouseDown={close} />
      <div
        ref={dialogRef}
        className="ir-crew-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onKeyDown={onKeyDown}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h2 id={titleId} className="ir-crew-dialog__title">
            用“{templateName}”建项目
          </h2>
          <p id={descId} className="ir-crew-dialog__desc">
            给项目起个名字，工作图会按模板流程长出来。
          </p>
          <label htmlFor={inputId} className="ir-crew-dialog__label">
            项目名
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="ir-crew-dialog__input"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            placeholder="如“登录页重设计”"
            disabled={busy}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
          />
          {error && (
            <div id={errorId} className="ir-crew-dialog__error" role="alert">
              {error}
            </div>
          )}
          <div className="ir-crew-dialog__actions">
            <button type="button" className="ir-crew-dialog__cancel" onClick={close} disabled={busy}>
              取消
            </button>
            <button type="submit" className="ir-crew-tpl__use" disabled={busy} aria-busy={busy || undefined}>
              {busy ? "建项目中……" : "建项目"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CreateProjectDialog;
