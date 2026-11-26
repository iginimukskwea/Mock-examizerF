import { NextResponse } from "next/server";
import { analyzeTemplate, readFileInput, saveUpload } from "@/lib/extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "ファイルが選択されていません" }, { status: 400 });
    }
    const input = await readFileInput(file as File);
    const sourceFilename = saveUpload(input);
    const result = await analyzeTemplate(input);
    return NextResponse.json({ ...result, source_filename: sourceFilename });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "解析に失敗しました" },
      { status: 500 }
    );
  }
}
