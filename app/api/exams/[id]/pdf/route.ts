import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { PDF_DIR, getExamDetail } from "@/lib/db";
import { generateExamPdf } from "@/lib/pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const examId = Number(id);
    if (!Number.isFinite(examId)) {
      return NextResponse.json({ error: "IDが不正です" }, { status: 400 });
    }
    const detail = getExamDetail(examId);
    if (!detail) {
      return NextResponse.json({ error: "模試が見つかりません" }, { status: 404 });
    }

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind") === "answer" ? "answer" : "question";
    const inline = url.searchParams.get("inline") === "1";

    const stored =
      kind === "question" ? detail.exam.question_pdf_path : detail.exam.answer_pdf_path;
    let filePath = stored ? path.join(PDF_DIR, stored) : null;
    if (!filePath || !fs.existsSync(filePath)) {
      const generated = await generateExamPdf(examId, kind);
      filePath = generated.filePath;
    }

    const data = fs.readFileSync(filePath);
    const filename = `exam-${examId}-${kind}.pdf`;
    return new NextResponse(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "PDF生成に失敗しました" },
      { status: 500 }
    );
  }
}
