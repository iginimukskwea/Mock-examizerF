import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { PDF_DIR, deleteExam, getExamDetail } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const detail = getExamDetail(Number(id));
    if (!detail) {
      return NextResponse.json({ error: "模試が見つかりません" }, { status: 404 });
    }
    return NextResponse.json({
      exam: {
        ...detail.exam,
        fields: parseJson(detail.exam.fields_json, []),
        config: parseJson(detail.exam.config_json, {}),
        verification: parseJson(detail.exam.verification_json, {}),
        template: parseJson(detail.exam.template_json, {}),
      },
      items: detail.items,
      runs: detail.runs.map((run) => ({
        ...run,
        issues: parseJson(run.issues_json, []),
      })),
      verificationLogs: detail.verificationLogs.map((log) => ({
        ...log,
        issues: parseJson(log.issues_json, []),
        detail: parseJson(log.detail_json, {}),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取得に失敗しました" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const examId = Number(id);
    if (!Number.isFinite(examId)) {
      return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
    }
    const result = deleteExam(examId);
    if (!result.deleted) {
      return NextResponse.json({ error: "模試が見つかりません" }, { status: 404 });
    }
    let removedFiles = 0;
    for (const name of result.pdfFiles) {
      try {
        fs.rmSync(path.join(PDF_DIR, name), { force: true });
        removedFiles += 1;
      } catch {
        // 既に削除済みなどは無視
      }
    }
    return NextResponse.json({ ok: true, removedFiles });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "削除に失敗しました" },
      { status: 500 }
    );
  }
}
