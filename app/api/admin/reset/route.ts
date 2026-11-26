import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { PDF_DIR, UPLOAD_DIR, resetData, type ResetCategory } from "@/lib/db";
import { removeCoverFile } from "@/lib/covers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATEGORIES: ResetCategory[] = ["templates", "problems", "fields", "exams", "uploads"];

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { categories?: unknown };
    const requested = Array.isArray(body.categories)
      ? (body.categories.filter((value) =>
          CATEGORIES.includes(value as ResetCategory)
        ) as ResetCategory[])
      : [];
    if (requested.length === 0) {
      return NextResponse.json({ error: "消去するカテゴリを選択してください" }, { status: 400 });
    }

    const result = resetData(requested.filter((category) => category !== "uploads"));

    let removedPdf = 0;
    for (const name of result.pdfFiles) {
      try {
        fs.rmSync(path.join(PDF_DIR, name), { force: true });
        removedPdf += 1;
      } catch {
        // 既に削除済みなどは無視
      }
    }

    let removedUploads = 0;
    if (requested.includes("uploads")) {
      try {
        for (const name of fs.readdirSync(UPLOAD_DIR)) {
          fs.rmSync(path.join(UPLOAD_DIR, name), { force: true });
          removedUploads += 1;
        }
      } catch {
        // アップロードディレクトリが無い場合は無視
      }
    }

    let removedCovers = 0;
    for (const coverPath of result.coverFiles) {
      if (removeCoverFile(coverPath)) removedCovers += 1;
    }

    return NextResponse.json({
      ok: true,
      ...result,
      removedPdf,
      removedUploads,
      removedCovers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "初期化に失敗しました" },
      { status: 500 }
    );
  }
}
