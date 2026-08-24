/**
 * AttachmentPicker · 报销附件真控件(R6)
 *
 * 页面级控件(不改交接包 AgentComposer 的「附件」站位 chip)。选文件 → uploadAttachment
 * (raw body + X-Anna-Attachment-Name)→ 得 {name,uri} chip 列于 composer 上方(可删)。
 * 上传中禁用;失败由宿主以 StateNote error 行内呈现(onError 回真实原文,不吞)。
 * 诚实纪律:未上传成功不入 chips;uri 必为 anna://attachment/...(后端校验,前端如实透传)。
 */

import { useCallback, useRef, useState } from "react";
import { uploadAttachment, type AttachmentRef } from "../../lib/api/reimbursement";

export interface AttachmentPickerProps {
  attachments: AttachmentRef[];
  onAdd: (ref: AttachmentRef) => void;
  onRemove: (uri: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}

export function AttachmentPicker({ attachments, onAdd, onRemove, onError, disabled }: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 允许重复选同名文件
      if (!file) return;
      setUploading(true);
      try {
        const ref = await uploadAttachment(file.name, file);
        onAdd(ref);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [onAdd, onError],
  );

  return (
    <div className="ir-r6-att">
      <input
        ref={inputRef}
        type="file"
        className="ir-r6-att__file"
        onChange={onFile}
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        type="button"
        className="ir-r6-att__add"
        onClick={pick}
        disabled={disabled || uploading}
      >
        {uploading ? (
          <>
            <span className="ir-r6-att__spin anna-spin" />
            正在上传发票……
          </>
        ) : (
          "＋ 附加发票"
        )}
      </button>
      {attachments.map((a) => (
        <span key={a.uri} className="ir-r6-att__chip" title={a.uri}>
          <span className="ir-r6-att__chip-name">{a.name}</span>
          <button
            type="button"
            className="ir-r6-att__chip-x"
            aria-label={`移除 ${a.name}`}
            onClick={() => onRemove(a.uri)}
            disabled={disabled}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

export default AttachmentPicker;
