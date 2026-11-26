import { NextResponse } from "next/server";
import { insertProblem, listProblems, type ProblemInput } from "@/lib/db";
import { normalizeDifficulty } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const subject = new URL(request.url).searchParams.get("subject") ?? undefined;
    return NextResponse.json({ problems: listProblems({ subject }) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取得に失敗しました" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      problems?: ProblemInput[];
      source_filename?: string;
    } & Partial<ProblemInput>;
    const rows = Array.isArray(body.problems) ? body.problems : [body as ProblemInput];
    const inserted = [];
    const errors: string[] = [];

    for (const [index, row] of rows.entries()) {
      const label = `問題${index + 1}`;
      if (!row || typeof row !== "object") {
        errors.push(`${label}: データが不正です`);
        continue;
      }
      if (!row.subject || !row.body_latex?.trim()) {
        errors.push(`${label}: 教科と問題文は必須です`);
        continue;
      }
      const fieldName = (row.fieldName ?? (row as unknown as { field?: string }).field) ?? "";
      const bookName = (
        row.bookName ??
        (row as unknown as { book?: string }).book ??
        ""
      ).trim();
      if (!bookName) {
        errors.push(`${label}: 参考書名は必須です`);
        continue;
      }
      if (!String(fieldName).trim()) {
        errors.push(`${label}: 分野は必須です`);
        continue;
      }
      try {
        inserted.push(
          insertProblem({
            subject: row.subject,
            difficulty: normalizeDifficulty(row.difficulty),
            fieldName,
            bookName,
            title: row.title,
            body_latex: row.body_latex,
            answer_latex: row.answer_latex,
            explanation_latex: row.explanation_latex,
            source_filename: row.source_filename ?? body.source_filename ?? null,
            structure: row.structure,
            questionType: row.questionType,
            targetWord: row.targetWord ?? null,
            options: Array.isArray(row.options) ? row.options : [],
          })
        );
      } catch (error) {
        errors.push(
          `${label}: ${error instanceof Error ? error.message : "保存に失敗しました"}`
        );
      }
    }

    return NextResponse.json({ ok: errors.length === 0, inserted, errors });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存に失敗しました" },
      { status: 500 }
    );
  }
}
