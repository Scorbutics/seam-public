// Dynamic route HANDLER: `/api/admin/payments/[id]` — its `[id]` segment normalises to `*`, meeting the
// caller's `${id}` template on the same key.
import { NextResponse } from "next/server";
export async function GET(request: Request) {
  return NextResponse.json({ payment: null });
}
