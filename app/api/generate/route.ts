import { NextResponse } from "next/server";
import {
  createExam,
  listFields,
  listProblems,
  recordHistory,
} from "@/lib/db";
import { generateExam } from "@/lib/generate";
import { DEFAULT_TEMPLATE, normalizeTemplate } from "@/lib/template";
import type { GenerationMode, Issue } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

interface SectionInput {
  questionCount?: unknown;
  field?: unknown;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      subject?: unknown;
      books?: unknown;
      sections?: unknown;
      targetDifficulty?: unknown;
      mode?: unknown;
      title?: unknown;
    };

    const subject = String(body.subject ?? "").trim();
    if (!subject) {
      return NextResponse.json(
        { error: "教科を選択してください" },
        { status: 400 }
      );
    }

    const books = Array.isArray(body.books)
      ? Array.from(
          new Set(
            body.books
              .map((book) => String(book).trim())
              .filter((book) => book.length > 0)
          )
        )
      : [];

    const rawSections = Array.isArray(body.sections)
      ? (body.sections as SectionInput[])
      : [];
    if (rawSections.length === 0) {
      return NextResponse.json(
        { error: "大問を1つ以上指定してください" },
        { status: 400 }
      );
    }

    const sections = rawSections.slice(0, 6).map((section) => ({
      questionCount: clamp(
        Math.round(Number(section.questionCount) || 3),
        1,
        10
      ),
      field: typeof section.field === "string" ? section.field.trim() : "",
    }));

    const target = clamp(Number(body.targetDifficulty) || 3, 1, 5);
    const mode: GenerationMode =
      body.mode === "fusion" ? "fusion" : "numeric_variant";

    const problems = listProblems({ subject });
    if (problems.length === 0) {
      return NextResponse.json(
        {
          error: `「${subject}」の問題が登録されていません。問題データを取り込んでください。`,
        },
        { status: 400 }
      );
    }

    const scoped =
      books.length > 0
        ? problems.filter(
            (problem) =>
              problem.book_name !== null && books.includes(problem.book_name)
          )
        : problems;

    if (scoped.length === 0) {
      return NextResponse.json(
        {
          error:
            "選択した参考書に該当する問題がありません。参考書の選択を変更してください。",
        },
        { status: 400 }
      );
    }

    const sectionPools = sections.map((section, index) => {
      const pool = section.field
        ? scoped.filter(
            (problem) =>
              (problem.field_name ?? "").toLowerCase() ===
              section.field.toLowerCase()
          )
        : scoped;
      if (pool.length < section.questionCount) {
        throw new Error(
          `第${index + 1}問（${section.field || "分野指定なし"}）は${section.questionCount}問必要ですが、条件に合う問題は${pool.length}問です。`
        );
      }
      return { problems: pool, count: section.questionCount };
    });

    const required = sections.reduce(
      (total, section) => total + section.questionCount,
      0
    );

    const template = normalizeTemplate({
      ...DEFAULT_TEMPLATE,
      examMinutes: clamp(required * 5, 30, 180),
      totalScore: required * 10,
      sections: sections.map((section, index) => ({
        no: index + 1,
        title: section.field,
        points: 0,
        induction: "",
        subQuestions: Array.from(
          { length: section.questionCount },
          (_, questionIndex) => ({
            no: questionIndex + 1,
            format: "written",
            points: 0,
          })
        ),
      })),
      layout: { ...DEFAULT_TEMPLATE.layout, showPoints: false },
      extras: { generated: true, formatForm: true, books },
    });

    const fieldNames = Array.from(
      new Set(sections.map((section) => section.field).filter(Boolean))
    );
    const allFields = listFields();
    const fields = fieldNames.map((name, index) => {
      const existing = allFields.find(
        (field) => field.name.toLowerCase() === name.toLowerCase()
      );
      return { id: existing?.id ?? -(index + 1), name };
    });
    const fieldIds = fields.map((field) => field.id);

    const outcome = await generateExam({
      problems: scoped,
      template,
      subject,
      targetDifficulty: target,
      mode,
      fields,
      fieldIds,
      sectionPools,
    });

    const title =
      String(body.title ?? "").trim() || `${subject} 模試（形式指定）`;
    const templateName = `形式指定（${subject}）`;
    const issueCount = outcome.runs.reduce(
      (total, run) =>
        total + run.issues.filter((issue: Issue) => issue.severity === "error").length,
      0
    );

    const examId = createExam({
      title,
      subject,
      templateId: null,
      templateName,
      targetDifficulty: target,
      avgDifficulty: outcome.avgDifficulty,
      mode,
      fields,
      config: {
        demo: outcome.demo,
        warnings: outcome.warnings,
        books,
        sections,
        mode,
      },
      template,
      verification: {
        demo: outcome.demo,
        warnings: outcome.warnings,
        issueCount,
      },
      items: outcome.items,
      runs: outcome.runs,
      verificationLogs: outcome.verificationLogs,
    });

    for (const book of books) {
      recordHistory("book", book);
    }

    return NextResponse.json({
      examId,
      title,
      avgDifficulty: outcome.avgDifficulty,
      targetDifficulty: target,
      demo: outcome.demo,
      warnings: outcome.warnings,
      runs: outcome.runs,
      verificationLogs: outcome.verificationLogs,
      items: outcome.items,
      sections,
      pdf: {
        question: `/api/exams/${examId}/pdf?kind=question`,
        answer: `/api/exams/${examId}/pdf?kind=answer`,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "生成に失敗しました";
    const status = /不足|必要|問題がありません|教科|分野|参考書/.test(message)
      ? 400
      : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
