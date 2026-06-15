// Route HANDLER (producer of `/api/admin/payments`). The front-end never touches the DB directly — it
// fetches THIS route, which is the second data-flow boundary. No import edge reaches the UI that calls it.
import { NextResponse } from "next/server";
export async function GET(request: Request) {
  const { data } = await client.from("payments").select("*");   // db-table READER + http-route producer
  return NextResponse.json({ payments: data });
}
