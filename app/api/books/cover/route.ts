import { NextResponse } from "next/server";
import {
  clearReferenceBookCover,
  getReferenceBook,
  setReferenceBookCover,
} from "@/lib/db";
import {
  COVER_MAX_BYTES,
  detectCoverExtension,
  removeCoverFile,
  writeCoverFile,
} from "@/lib/covers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let writtenPath: string | null = null;

  try {
    const form = await request.formData();
    const bookName = String(form.get("bookName") ?? "").trim();
    const subject = String(form.get("subject") ?? "").trim();
    const file = form.get("file");

    if (!bookName) {
      return NextResponse.json(
        { error: "参考書名を入力してください" },
        { status: 400 }
      );
    }
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "表紙画像が選択されていません" },
        { status: 400 }
      );
    }
    if (file.size > COVER_MAX_BYTES) {
      return NextResponse.json(
        { error: "表紙画像は8MB以下にしてください" },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const extension = detectCoverExtension(buffer, file.type);
    if (!extension) {
      return NextResponse.json(
        { error: "JPG / PNG / WebP の画像を選択してください" },
        { status: 400 }
      );
    }

    const oldCover = getReferenceBook(bookName)?.cover_image_path ?? null;
    const saved = writeCoverFile(buffer, extension);
    writtenPath = saved.filePath;

    const book = setReferenceBookCover(
      bookName,
      saved.url,
      subject || null
    );
    if (oldCover && oldCover !== saved.url) {
      removeCoverFile(oldCover);
    }

    return NextResponse.json({
      ok: true,
      book,
      cover_image_path: saved.url,
    });
  } catch (error) {
    if (writtenPath) {
      removeCoverFile(writtenPath);
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "表紙画像の保存に失敗しました",
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const bookName = (
      new URL(request.url).searchParams.get("bookName") ?? ""
    ).trim();
    if (!bookName) {
      return NextResponse.json(
        { error: "参考書名を指定してください" },
        { status: 400 }
      );
    }
    const removedPath = clearReferenceBookCover(bookName);
    const removed = removedPath ? removeCoverFile(removedPath) : false;
    return NextResponse.json({ ok: true, removed });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "表紙画像の削除に失敗しました",
      },
      { status: 500 }
    );
  }
}
