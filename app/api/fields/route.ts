import { NextResponse } from "next/server";
import { listFields } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const subject = new URL(request.url).searchParams.get("subject") ?? undefined;
    return NextResponse.json({ fields: listFields(subject) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "取得に失敗しました" },
      { status: 500 }
    );
  }
}
