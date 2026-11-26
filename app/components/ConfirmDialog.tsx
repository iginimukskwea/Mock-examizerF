"use client";

import { useEffect } from "react";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  target?: string;
  description?: string;
  confirmLabel?: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  open,
  title,
  target,
  description,
  confirmLabel = "削除する",
  busy = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-head">
          <span className="modal-kicker">確認</span>
          <h2 className="modal-title" id="confirm-title">
            {title}
          </h2>
        </div>
        <div className="modal-body">
          {target ? <div className="modal-target">{target}</div> : null}
          {description ? <p className="modal-text">{description}</p> : null}
          <p className="modal-warning">この操作は取り消せません。</p>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-lg btn-ghost" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className="btn btn-lg btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {busy ? "処理中..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
