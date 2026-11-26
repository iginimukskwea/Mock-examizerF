"use client";

import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { RefreshIcon, TrashIcon } from "@/app/components/icons";

type ResetCategory = "templates" | "problems" | "fields" | "exams" | "uploads";

interface StatusResponse {
  mode: string;
  label: string;
  problemCount: number;
  templateCount: number;
  bookCount: number;
  examCount: number;
  fieldCount: number;
  uploadCount: number;
}

interface AlertState {
  kind: "success" | "error" | "info" | "warn";
  text: string;
}

interface ResetResponse {
  templates?: number;
  problems?: number;
  fields?: number;
  exams?: number;
  removedPdf?: number;
  removedUploads?: number;
  removedCovers?: number;
  error?: string;
}

const CATEGORY_META: Array<{
  key: ResetCategory;
  label: string;
  detail: string;
  countKey: keyof StatusResponse;
}> = [
  {
    key: "problems",
    label: "問題データ（参考書含む）",
    detail: "問題バンクの全問題と参考書を削除します",
    countKey: "problemCount",
  },
  {
    key: "fields",
    label: "分野タグ",
    detail: "登録済みの分野タグをすべて削除します",
    countKey: "fieldCount",
  },
  {
    key: "exams",
    label: "出力履歴（模試セット）",
    detail: "模試レコードと問題PDF・解答PDFを削除します",
    countKey: "examCount",
  },
  {
    key: "uploads",
    label: "アップロードファイル",
    detail: "data/uploads に保存された元ファイルを削除します",
    countKey: "uploadCount",
  },
];

export default function SettingsPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [selected, setSelected] = useState<ResetCategory[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState<AlertState | null>(null);

  async function loadStatus() {
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const json = (await response.json()) as StatusResponse & { error?: string };
      if (!response.ok) throw new Error(json.error ?? "状況の取得に失敗しました");
      setStatus(json);
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "状況の取得に失敗しました",
      });
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  const selectedLabels = useMemo(
    () =>
      CATEGORY_META.filter((meta) => selected.includes(meta.key)).map((meta) => meta.label),
    [selected]
  );

  function toggle(category: ResetCategory) {
    setSelected((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category]
    );
  }

  async function reset() {
    if (selected.length === 0) return;
    setBusy(true);
    setAlert(null);
    try {
      const response = await fetch("/api/admin/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categories: selected }),
      });
      const json = (await response.json()) as ResetResponse;
      if (!response.ok) throw new Error(json.error ?? "初期化に失敗しました");

      const parts: string[] = [];
      if (json.templates) parts.push(`テンプレート ${json.templates}件`);
      if (json.problems) parts.push(`問題 ${json.problems}件`);
      if (json.fields) parts.push(`分野 ${json.fields}件`);
      if (json.exams) parts.push(`模試 ${json.exams}件`);
      if (json.removedPdf) parts.push(`PDF ${json.removedPdf}件`);
      if (json.removedUploads) parts.push(`アップロード ${json.removedUploads}件`);
      if (json.removedCovers) parts.push(`表紙 ${json.removedCovers}件`);

      setAlert({
        kind: "success",
        text:
          parts.length > 0
            ? `選択したデータを消去しました（${parts.join(" / ")}）。`
            : "削除対象のデータはありませんでした。",
      });
      setSelected([]);
      setConfirmOpen(false);
      await loadStatus();
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "初期化に失敗しました",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">データ管理</h1>
        <p className="page-desc">
          保存されたデータをカテゴリ単位で消去します。個別削除は各一覧（問題データ・出力履歴）から行えます。
          AI設定は <code>.env.local</code> で管理され、ここでは変更されません。
        </p>
      </div>

      {alert ? <div className={`alert alert-${alert.kind}`}>{alert.text}</div> : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">現在の保存状況</h2>
            <p className="panel-sub">
              {status ? `${status.label}` : "読み込み中..."}
            </p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={loadStatus}>
            <RefreshIcon />
            再読み込み
          </button>
        </div>

        <div className="stats">
          <div className="stat">
            <div className="stat-value tabular">{status?.problemCount ?? "-"}</div>
            <div className="stat-label">登録問題</div>
          </div>
          <div className="stat">
            <div className="stat-value tabular">{status?.bookCount ?? "-"}</div>
            <div className="stat-label">参考書</div>
          </div>
          <div className="stat">
            <div className="stat-value tabular">{status?.examCount ?? "-"}</div>
            <div className="stat-label">出力履歴 模試</div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">選択したカテゴリを全消去</h2>
            <p className="panel-sub">
              チェックしたカテゴリだけを削除します。模試を消去すると、保存済みPDFも同時に削除されます。
            </p>
          </div>
        </div>

        <div className="stack">
          {CATEGORY_META.map((meta) => {
            const count = status ? (status[meta.countKey] as number) : null;
            const checked = selected.includes(meta.key);
            return (
              <label className="check-row" key={meta.key}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(meta.key)}
                />
                <span>
                  <strong>{meta.label}</strong>
                  <span className="hint" style={{ display: "block" }}>
                    {meta.detail}
                  </span>
                </span>
                <span className="count">{count ?? "-"}</span>
              </label>
            );
          })}
        </div>

        <div className="btn-row" style={{ marginTop: 16 }}>
          <button
            className="btn btn-lg btn-danger"
            onClick={() => setConfirmOpen(true)}
            disabled={selected.length === 0 || busy}
          >
            <TrashIcon />
            選択したカテゴリを全消去
          </button>
          <span className="hint">
            {selected.length === 0
              ? "カテゴリを1つ以上選択してください。"
              : `${selected.length}カテゴリを選択中`}
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">データの保存場所</h2>
            <p className="panel-sub">
              すべてローカルです。バックアップは <code>data/</code> ディレクトリを丸ごとコピーしてください。
            </p>
          </div>
        </div>
        <div className="list-item">
          <div className="list-meta" style={{ marginTop: 0 }}>
            <span className="badge">data/mock-examizer.db</span>
            <span className="badge">data/pdfs</span>
            <span className="badge">data/uploads</span>
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            模試PDFは data/pdfs、アップロードした元ファイルは data/uploads に保存されます。
          </p>
        </div>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="選択したデータを全消去"
        target={selectedLabels.join(" / ")}
        description="選択したカテゴリのデータをすべて削除します。模試を消去した場合は問題PDF・解答PDFの実体ファイルも削除されます。"
        confirmLabel="全消去する"
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={reset}
      />
    </main>
  );
}
