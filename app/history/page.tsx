"use client";

import { useEffect, useMemo, useState } from "react";
import { downloadPdf, safeFilename } from "@/app/components/downloadPdf";
import { ConfirmDialog } from "@/app/components/ConfirmDialog";
import { DownloadIcon, RefreshIcon, TrashIcon } from "@/app/components/icons";
import {
  GENERATION_MODE_LABELS,
  SUBJECTS,
  type ExamItem,
  type GenerationMode,
  type Issue,
  type RunLog,
  type VerificationStatus,
} from "@/lib/types";

interface ExamSummary {
  id: number;
  title: string;
  subject: string;
  template_name: string;
  target_difficulty: number;
  avg_difficulty: number;
  mode: GenerationMode;
  created_at: string;
  fields: Array<{ id: number; name: string }>;
  demo: boolean;
  verification: { issueCount?: number };
  question_pdf: string;
  answer_pdf: string;
}

interface VerificationLog {
  id: number;
  iteration: number;
  step: string;
  status: VerificationStatus;
  summary: string;
  issues: Issue[];
  detail: Record<string, unknown>;
  created_at: string;
}

interface ExamDetail {
  exam: {
    id: number;
    title: string;
    subject: string;
    template_name: string;
    mode: GenerationMode;
    avg_difficulty: number;
    target_difficulty: number;
    created_at: string;
    config: { warnings?: string[]; demo?: boolean };
    verification: { warnings?: string[]; issueCount?: number };
  };
  items: ExamItem[];
  runs: Array<RunLog & { id: number; created_at: string; issues: Issue[] }>;
  verificationLogs?: VerificationLog[];
}

interface AlertState {
  kind: "success" | "error" | "info" | "warn";
  text: string;
}

const STEP_LABELS: Record<string, string> = {
  select: "選定",
  A: "Step A 決定論的ソルバー",
  B: "Step B ドメイン制約",
  C: "Step C 融合バックトラック",
  D: "Step D ブラインド検算",
  finalize: "確定",
};

const STATUS_LABELS: Record<VerificationStatus, string> = {
  pass: "通過",
  fail: "要修正",
  warn: "注意",
  skip: "対象外",
};

export default function HistoryPage() {
  const [exams, setExams] = useState<ExamSummary[]>([]);
  const [filter, setFilter] = useState("すべて");
  const [busy, setBusy] = useState<string | null>(null);
  const [alert, setAlert] = useState<AlertState | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, ExamDetail>>({});
  const [deleteTarget, setDeleteTarget] = useState<ExamSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/exams", { cache: "no-store" });
      const json = (await response.json()) as { exams?: ExamSummary[]; error?: string };
      if (!response.ok) throw new Error(json.error ?? "履歴の取得に失敗しました");
      setExams(json.exams ?? []);
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "履歴の取得に失敗しました",
      });
    }
  }

  useEffect(() => {
    load();
  }, []);

  const subjects = useMemo(() => {
    const present = new Set(exams.map((exam) => exam.subject));
    const ordered: string[] = SUBJECTS.filter((subject) => present.has(subject));
    for (const subject of present) {
      if (!ordered.includes(subject)) ordered.push(subject);
    }
    return ordered;
  }, [exams]);

  const filtered = useMemo(
    () => (filter === "すべて" ? exams : exams.filter((exam) => exam.subject === filter)),
    [exams, filter]
  );

  async function download(exam: ExamSummary, kind: "question" | "answer") {
    const key = `${exam.id}-${kind}`;
    setBusy(key);
    setAlert(null);
    try {
      await downloadPdf(
        kind === "question" ? exam.question_pdf : exam.answer_pdf,
        `${safeFilename(exam.title)}-${kind === "question" ? "問題" : "解答解説"}.pdf`
      );
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "PDFの生成に失敗しました",
      });
    } finally {
      setBusy(null);
    }
  }

  async function toggleDetail(exam: ExamSummary) {
    if (expanded === exam.id) {
      setExpanded(null);
      return;
    }
    setExpanded(exam.id);
    if (details[exam.id]) return;
    try {
      const response = await fetch(`/api/exams/${exam.id}`, { cache: "no-store" });
      const json = (await response.json()) as ExamDetail & { error?: string };
      if (!response.ok || !json.exam) throw new Error(json.error ?? "詳細の取得に失敗しました");
      setDetails((current) => ({ ...current, [exam.id]: json }));
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "詳細の取得に失敗しました",
      });
      setExpanded(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const response = await fetch(`/api/exams/${deleteTarget.id}`, { method: "DELETE" });
      const json = (await response.json()) as { error?: string; removedFiles?: number };
      if (!response.ok) throw new Error(json.error ?? "削除に失敗しました");
      setExams((current) => current.filter((exam) => exam.id !== deleteTarget.id));
      setDetails((current) => {
        const next = { ...current };
        delete next[deleteTarget.id];
        return next;
      });
      if (expanded === deleteTarget.id) setExpanded(null);
      setAlert({
        kind: "success",
        text: `「${deleteTarget.title}」を削除しました。PDFファイル${json.removedFiles ?? 0}件も削除しました。`,
      });
      setDeleteTarget(null);
    } catch (error) {
      setAlert({
        kind: "error",
        text: error instanceof Error ? error.message : "削除に失敗しました",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <main className="page">
      <div className="page-head">
        <h1 className="page-title">出力履歴</h1>
        <p className="page-desc">
          生成した模試を問題PDF・解答PDFのセットで一覧表示します。教科タブで絞り込み、いつでも再ダウンロードできます。
          各模試の検算ログ（Step A〜D）と削除もここから行えます。
        </p>
      </div>

      {alert ? <div className={`alert alert-${alert.kind}`}>{alert.text}</div> : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">生成済み模試</h2>
            <p className="panel-sub">{exams.length}件</p>
          </div>
          <button className="btn btn-sm btn-ghost" onClick={load}>
            <RefreshIcon />
            再読み込み
          </button>
        </div>

        <div className="tabs">
          <button
            className={`tab ${filter === "すべて" ? "active" : ""}`}
            onClick={() => setFilter("すべて")}
          >
            すべて（{exams.length}）
          </button>
          {subjects.map((subject) => (
            <button
              key={subject}
              className={`tab ${filter === subject ? "active" : ""}`}
              onClick={() => setFilter(subject)}
            >
              {subject}（{exams.filter((exam) => exam.subject === subject).length}）
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <p className="hint">
            該当する模試がありません。「出力（模試生成）」ページから模試を生成してください。
          </p>
        ) : (
          <div className="stack">
            {filtered.map((exam) => {
              const isOpen = expanded === exam.id;
              const detail = details[exam.id];
              const issueCount = exam.verification.issueCount ?? 0;
              return (
                <div className="list-item" key={exam.id}>
                  <div className="list-item-head">
                    <div style={{ minWidth: 0 }}>
                      <div className="list-title">{exam.title}</div>
                      <div className="list-meta">
                        <span className="badge badge-red">{exam.subject}</span>
                        <span className="badge">{GENERATION_MODE_LABELS[exam.mode] ?? exam.mode}</span>
                        <span className="badge">
                          平均難易度 {Number(exam.avg_difficulty).toFixed(1)} / 目標{" "}
                          {exam.target_difficulty}
                        </span>
                        {exam.demo ? (
                          <span className="badge badge-amber">デモ生成</span>
                        ) : issueCount > 0 ? (
                          <span className="badge badge-amber">検算指摘 {issueCount}件</span>
                        ) : (
                          <span className="badge badge-green">検算済み</span>
                        )}
                        <span>{exam.template_name}</span>
                        <span>
                          {new Date(exam.created_at).toLocaleString("ja-JP", {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      {exam.fields.length > 0 ? (
                        <div className="list-meta">
                          <span>融合分野:</span>
                          {exam.fields.map((field) => (
                            <span className="badge" key={field.id}>
                              {field.name}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="btn-row">
                      <button
                        className="btn btn-sm btn-download"
                        onClick={() => download(exam, "question")}
                        disabled={busy !== null}
                      >
                        {busy === `${exam.id}-question` ? (
                          <span className="spinner spinner-dark" />
                        ) : (
                          <DownloadIcon />
                        )}
                        {busy === `${exam.id}-question` ? "生成中..." : "問題PDF"}
                      </button>
                      <button
                        className="btn btn-sm btn-download"
                        onClick={() => download(exam, "answer")}
                        disabled={busy !== null}
                      >
                        {busy === `${exam.id}-answer` ? (
                          <span className="spinner spinner-dark" />
                        ) : (
                          <DownloadIcon />
                        )}
                        {busy === `${exam.id}-answer` ? "生成中..." : "解答PDF"}
                      </button>
                      <button className="btn btn-sm btn-ghost" onClick={() => toggleDetail(exam)}>
                        {isOpen ? "閉じる" : "詳細"}
                      </button>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => setDeleteTarget(exam)}
                        disabled={busy !== null || deleting}
                      >
                        <TrashIcon />
                        削除
                      </button>
                    </div>
                  </div>

                  {isOpen ? (
                    <div style={{ marginTop: 14 }}>
                      {!detail ? (
                        <p className="hint">読み込み中...</p>
                      ) : (
                        <>
                          {detail.exam.verification.warnings?.map((warning, index) => (
                            <div className="alert alert-warn" key={index}>
                              {warning}
                            </div>
                          ))}
                          <div className="list-meta" style={{ marginTop: 8 }}>
                            <span>全{detail.items.length}問</span>
                            <span>
                              難易度:{" "}
                              {detail.items.map((item) => item.difficulty).join(" / ")}
                            </span>
                          </div>

                          {detail.verificationLogs && detail.verificationLogs.length > 0 ? (
                            <div style={{ marginTop: 12 }}>
                              <div className="list-title" style={{ marginBottom: 8 }}>
                                検算ログ
                              </div>
                              <div className="pipeline">
                                {detail.verificationLogs.map((log) => {
                                  const code =
                                    typeof log.detail?.code === "string"
                                      ? (log.detail.code as string)
                                      : null;
                                  const results =
                                    log.detail?.results !== undefined
                                      ? JSON.stringify(log.detail.results, null, 2)
                                      : null;
                                  return (
                                    <div className="step-card" key={log.id}>
                                      <div className="step-head">
                                        <span className="step-label">
                                          #{log.iteration} {STEP_LABELS[log.step] ?? log.step}
                                        </span>
                                        <span className={`step-badge ${log.status}`}>
                                          {STATUS_LABELS[log.status] ?? log.status}
                                        </span>
                                      </div>
                                      <div className="step-summary">{log.summary}</div>
                                      {log.issues.length > 0 ? (
                                        <div style={{ marginTop: 6 }}>
                                          {log.issues.map((issue, issueIndex) => (
                                            <div
                                              className={`issue ${issue.severity}`}
                                              key={issueIndex}
                                            >
                                              {issue.location ? `[${issue.location}] ` : ""}
                                              {issue.message}
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                      {code ? (
                                        <details className="step-detail">
                                          <summary>検証コード / 出力を見る</summary>
                                          <pre>
                                            {code}
                                            {results ? `\n\n// results\n${results}` : ""}
                                          </pre>
                                        </details>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div className="stack" style={{ marginTop: 10 }}>
                              {detail.runs
                                .filter((run) => run.issues.length > 0)
                                .map((run) => (
                                  <div className="verification-run" key={run.id}>
                                    <div className="list-title">
                                      #{run.iteration} [{run.stage}] — {run.issues.length}件
                                    </div>
                                    {run.issues.map((issue, issueIndex) => (
                                      <div className={`issue ${issue.severity}`} key={issueIndex}>
                                        {issue.location ? `[${issue.location}] ` : ""}
                                        {issue.message}
                                      </div>
                                    ))}
                                  </div>
                                ))}
                              {detail.runs.every((run) => run.issues.length === 0) ? (
                                <p className="hint">検算での指摘はありません。</p>
                              ) : null}
                            </div>
                          )}

                          <div className="stack" style={{ marginTop: 12 }}>
                            {detail.items.slice(0, 12).map((item, index) => (
                              <div className="section-card" key={index}>
                                <div className="list-item-head">
                                  <span className="list-title">
                                    第{item.section_no}問（{item.question_no}）
                                  </span>
                                  <span className="badge">難易度 {item.difficulty}</span>
                                </div>
                                <div className="item-text mono pre-wrap">
                                  {item.body_latex.slice(0, 240)}
                                  {item.body_latex.length > 240 ? "…" : ""}
                                </div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="模試を削除"
        target={deleteTarget?.title}
        description="この模試のDBレコード（出題内容・検算ログ）と、ローカルに保存された問題PDF・解答PDFを削除します。"
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </main>
  );
}
