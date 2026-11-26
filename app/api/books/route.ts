import { NextResponse } from "next/server";
import { deleteReferenceBook, listBooks } from "@/lib/db";
import { removeCoverFile } from "@/lib/covers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ books: listBooks() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取得に失敗しました" },
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
    if (bookName === "未分類") {
      return NextResponse.json(
        { error: "未分類の問題は個別削除で処理してください" },
        { status: 400 }
      );
    }

    const result = deleteReferenceBook(bookName, true);
    const removedCover = result.coverImagePath
      ? removeCoverFile(result.coverImagePath)
      : false;
    return NextResponse.json({
      ok: true,
      deletedProblems: result.deletedProblems,
      removedCover,
      found: result.found,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "削除に失敗しました" },
      { status: 500 }
    );
  }
}
