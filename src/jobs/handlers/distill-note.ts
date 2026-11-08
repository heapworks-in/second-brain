import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { getItem, mergeItemMeta } from "@/domain/items";
import { buildDistillation, type Distillation } from "@/domain/distill";
import { getGistProvider, type GistProvider } from "@/providers/gist";

export interface DistillNoteDeps {
  db: DB;
  /** Injected by tests; left out, the provider is resolved when the job runs so a model file
   * added after boot takes effect without a restart. Passing null is a deliberate "there is none". */
  gist?: GistProvider | null;
  log?: (message: string) => void;
}

export function createDistillNoteHandler(deps: DistillNoteDeps): JobHandler {
  const { db } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));

  return async (job) => {
    const { itemId } = jobPayload<{ itemId: number }>(job);
    const item = getItem(db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);

    const gist = deps.gist !== undefined ? deps.gist : await getGistProvider();
    if (!gist) {
      log(`[distill_note] no local gist model; item ${itemId} keeps no distillation`);
      return;
    }

    let distillation: Distillation | null = null;
    try {
      distillation = await buildDistillation(item, gist);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[distill_note] item ${itemId} could not be distilled: ${message}`);
      distillation = null;
    }
    mergeItemMeta(db, itemId, {
      distillation: distillation ?? { gist: "", quotes: [], generatedAt: new Date().toISOString(), status: "dismissed" },
    });
  };
}
