import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { createTask, listTasks, projectProgress } from "@/domain/tasks";
import { goalRefsByContainer } from "@/domain/goals";
import { similarActualMinutes } from "@/domain/focus";
import { errorResponse, parseContainerParam, requesterRef, serializeTask, serializeTasks } from "@/lib/api";
import { TaskBody } from "@/lib/validation";
import { CaptureError } from "@/domain/items/capture";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const sp = new URL(req.url).searchParams;
    const containerId = parseContainerParam(sp.get("container"));
    const status = sp.get("status") ?? "open";
    if (!["open", "done", "dropped", "all"].includes(status)) throw new CaptureError("status must be open, done, dropped, or all", 400);
    const db = getDb();
    const tasks = serializeTasks(db, listTasks(db, { containerId, status: status as "open" | "done" | "dropped" | "all" }));
    return NextResponse.json(typeof containerId === "number" ? { tasks, progress: projectProgress(db, containerId) } : { tasks });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = TaskBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    const task = createTask(db, parsed.data);
    // A brand-new task has no blocks by construction, but it is not new to its project's goals —
    // it inherits them the instant it lands in a linked container, so the create response reads
    // them same as any other task in the list rather than answering `goals: []` for one request.
    const goals = task.containerId !== null ? (goalRefsByContainer(db, [task.containerId]).get(task.containerId) ?? []) : [];
    const likeThisMinutes = similarActualMinutes(db, task);
    return NextResponse.json(serializeTask(task, [], goals, 0, likeThisMinutes, requesterRef(db, task)), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
