"use client";

import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { PowerIcon } from "./icons";

export function ShutdownButton() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);

  async function shutdown() {
    setBusy(true);
    try {
      await fetch("/api/shutdown", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mock-examizer-shutdown": "1",
        },
        body: "{}",
      });
    } catch {
      // サーバーが応答前に停止する場合があるため無視
    }
    setBusy(false);
    setOpen(false);
    setStopped(true);
    window.setTimeout(() => {
      window.close();
    }, 250);
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-sm btn-danger"
        onClick={() => setOpen(true)}
        title="開発サーバーを停止してページを閉じる"
      >
        <PowerIcon />
        終了
      </button>

      <ConfirmDialog
        open={open}
        title="サーバーを停止"
        target="Mock examizerF 開発サーバー"
        description="開発サーバーを停止し、このページを閉じます。再度起動するにはデスクトップのショートカットを使ってください。"
        confirmLabel="停止する"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={shutdown}
      />

      {stopped ? (
        <div className="modal-overlay shutdown-overlay">
          <div className="modal" role="alertdialog" aria-modal="true">
            <div className="modal-head">
              <span className="modal-kicker">停止しました</span>
              <h2 className="modal-title">サーバーを停止しました</h2>
            </div>
            <div className="modal-body">
              <p className="modal-text">
                このタブを閉じてください。自動で閉じない場合は、ブラウザのタブを手動で閉じてください。
              </p>
              <p className="modal-warning">再度起動するにはデスクトップの「Mock examizerF」を開きます。</p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-danger" onClick={() => window.close()}>
                ページを閉じる
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
