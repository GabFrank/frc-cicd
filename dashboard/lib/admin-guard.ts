import { NextResponse } from "next/server";
import { getSession } from "./auth";

export async function requireAuth(): Promise<NextResponse | null> {
  const session = await getSession();
  if (!session.user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}
