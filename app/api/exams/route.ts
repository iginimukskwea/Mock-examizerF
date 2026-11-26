import { NextResponse } from "next/server";
import { listExams } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  try {
    const subject = new URL(request.url).searchParams.get("subject") ?? undefined;
    const exams = listExams(subject).map((exam) => ({
      id: exam.id,
      title: exam.title,
      subject: exam.subject,
      template_name: exam.template_name,
      target_difficulty: exam.target_difficulty,
      avg_difficulty: exam.avg_difficulty,
      mode: exam.mode,
      created_at: exam.created_at,
      fields: parseJson<Array<{ id: number; name: string }>>(exam.fields_json, []),
      demo: parseJson<{ demo?: boolean }>(exam.config_json, {}).demo ?? false,
      verification: parseJson<{ issueCount?: number }>(exam.verification_json, {}),
      question_pdf: exam.question_pdf_path
        ? `/api/exams/${exam.id}/pdf?kind=question`
        : `/api/exams/${exam.id}/pdf?kind=question`,
      answer_pdf: `/api/exams/${exam.id}/pdf?kind=answer`,
    }));
    return NextResponse.json({ exams });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取得に失敗しました" },
      { status: 500 }
    );
  }
}
