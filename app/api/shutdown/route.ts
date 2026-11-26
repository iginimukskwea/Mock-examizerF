import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (request.headers.get("x-mock-examizer-shutdown") !== "1") {
    return NextResponse.json({ error: "missing shutdown header" }, { status: 400 });
  }

  setTimeout(() => {
    process.exit(0);
  }, 700);

  return NextResponse.json({ ok: true });
}
