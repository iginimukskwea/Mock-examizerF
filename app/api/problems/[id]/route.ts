import { NextResponse } from "next/server";
import {
  deleteProblem,
  updateProblem,
  type ProblemUpdateInput,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const problemId = Number(id);
    if (!Number.isFinite(problemId)) {
      return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
    }
    deleteProblem(problemId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "削除に失敗しました" },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const problemId = Number(id);
    if (!Number.isFinite(problemId)) {
      return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
    }
    const body = (await request.json()) as ProblemUpdateInput;
    const updated = updateProblem(problemId, {
      subject: body.subject,
      difficulty: body.difficulty,
      fieldName: body.fieldName,
      bookName: body.bookName,
      title: body.title,
      body_latex: body.body_latex,
      answer_latex: body.answer_latex,
      explanation_latex: body.explanation_latex,
      questionType: body.questionType,
      targetWord: body.targetWord,
      options: Array.isArray(body.options) ? body.options : undefined,
    });
    if (!updated) {
      return NextResponse.json({ error: "問題が見つかりません" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, problem: updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新に失敗しました" },
      { status: 400 }
    );
  }
}
