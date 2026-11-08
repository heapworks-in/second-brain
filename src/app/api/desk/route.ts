import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { deskPayload } from "@/domain/desk";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

/** What is on the desk right now. */
export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(deskPayload(getDb(), new Date()));
  } catch (err) {
    return errorResponse(err);
  }
}
