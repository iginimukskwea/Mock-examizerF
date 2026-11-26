import { NextResponse } from "next/server";
import { extractItems, type UploadFile } from "@/lib/gemini";
import { pairItems } from "@/lib/pairing";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_FILES = 12;
const MAX_TOTAL_BYTES = 18 * 1024 * 1024;
const SUPPORTED = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

function detectMime(file: File): string {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "";
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "GEMINI_API_KEY が設定されていません。math-variant-app/.env.local に設定してください。",
        },
        { status: 400 }
      );
    }

    const form = await request.formData();
    const entries = form
      .getAll("files")
      .filter((entry): entry is File => typeof entry !== "string");

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "ファイルを選択してください。" },
        { status: 400 }
      );
    }
    if (entries.length > MAX_FILES) {
      return NextResponse.json(
        { error: `ファイルは最大${MAX_FILES}件までです。` },
        { status: 400 }
      );
    }

    const totalBytes = entries.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json(
        { error: "ファイルの合計サイズは18MB以下にしてください。" },
        { status: 400 }
      );
    }

    const files: UploadFile[] = [];
    for (const file of entries) {
      const mimeType = detectMime(file);
      if (!SUPPORTED.has(mimeType)) {
        return NextResponse.json(
          {
            error: `未対応の形式です: ${file.name}（PDF / PNG / JPEG / WebPのみ）`,
          },
          { status: 400 }
        );
      }
      files.push({
        name: file.name,
        mimeType,
        data: Buffer.from(await file.arrayBuffer()),
      });
    }

    const items = await extractItems(files, apiKey);
    const { pairs, warnings } = pairItems(items);

    return NextResponse.json({ items, pairs, warnings });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "抽出に失敗しました。";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
