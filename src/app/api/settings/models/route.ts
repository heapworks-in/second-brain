import { NextResponse } from "next/server";
import { z } from "zod";
import { MODEL_ROLES, ROLE_LABELS, hasBackup, readConfig, revertConfig, runtimeUrl, writeConfig } from "@/domain/models/config";
import { probeRuntime } from "@/domain/models/ollama";
import { roleStates } from "@/domain/models/resolve";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

/** `model: null` clears a role, which hands it back to the resolution order rather than leaving
 * it pointed at something. Clearing is the inverse of setting, and every row offers it. */
const Body = z
  .object({ role: z.enum(MODEL_ROLES), model: z.string().min(1).max(200).nullable() })
  .strict();

async function payload() {
  const { states, runtime, configError, url } = await roleStates();
  return {
    url,
    runtime: { reachable: runtime.reachable, version: runtime.version, error: runtime.error, models: runtime.models },
    configError,
    canRevert: hasBackup(),
    roles: states.map((s) => ({ ...s, ...ROLE_LABELS[s.role] })),
  };
}

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(await payload());
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Point one role at one model.
 *
 * Validated against what the runtime actually holds, **before the file is touched**: a save that
 * wrote first and discovered later would leave a working configuration replaced by a broken one,
 * and the person who pressed it watching a success message. The only way past the check is
 * clearing the role, which cannot be wrong.
 */
export async function PATCH(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const { role, model } = parsed.data;

    const { config } = readConfig();
    const url = runtimeUrl(config);

    if (model !== null) {
      const runtime = await probeRuntime(url);
      if (!runtime.reachable) {
        return NextResponse.json({ error: `the runtime at ${url} is not reachable, so ${model} cannot be checked — start it and try again` }, { status: 409 });
      }
      if (!runtime.models.some((m) => m.name === model)) {
        return NextResponse.json({ error: `the runtime does not have ${model} — pull it first, then choose it here` }, { status: 409 });
      }
    }

    const roles = { ...config.roles };
    if (model === null) delete roles[role];
    else roles[role] = { model };
    writeConfig({ ...config, roles: Object.keys(roles).length > 0 ? roles : undefined });

    return NextResponse.json(await payload());
  } catch (err) {
    return errorResponse(err);
  }
}

/** Put the previous file back. Reports plainly when there is nothing to put back rather than
 * failing: the offer is only ever shown when there is, so arriving here without one means
 * somebody pressed it twice. */
export async function DELETE(req: Request): Promise<Response> {
  try {
    if (crossSite(req)) return forbidden();
    const reverted = revertConfig();
    return NextResponse.json({ reverted, ...(await payload()) });
  } catch (err) {
    return errorResponse(err);
  }
}
