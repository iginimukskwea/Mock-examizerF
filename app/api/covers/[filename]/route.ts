import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { COVERS_DIR } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await context.params;
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      return NextResponse.json({ error: "不正なファイル名です" }, { status: 400 });
    }

    const base = path.resolve(COVERS_DIR);
    const target = path.resolve(base, filename);
    if (!target.toLowerCase().startsWith(`${base.toLowerCase()}${path.sep}`)) {
      return NextResponse.json({ error: "不正なパスです" }, { status: 400 });
    }
    if (!fs.existsSync(target)) {
      return NextResponse.json(
        { error: "表紙画像が見つかりません" },
        { status: 404 }
      );
    }

    const buffer = fs.readFileSync(target);
    const mime =
      MIME_BY_EXT[path.extname(filename).toLowerCase()] ??
      "application/octet-stream";
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "content-type": mime,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "表紙画像の取得に失敗しました",
      },
      { status: 500 }
    );
  }
}
