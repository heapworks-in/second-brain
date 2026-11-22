import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { dataDir } from "@/lib/paths";
import type { EvalCase, RefusalCase } from "./eval";

/**
 * Where the eval set lives: outside the repo, beside the database.
 *
 * It has to be, and the reason is the same one that keeps programmes out of this repo. A useful
 * eval is written out of your own corpus -- the real note titles, the questions you actually ask
 * -- and this repo is public and ships its payload in a dmg. `eval/example.json` here documents
 * the shape; yours never leaves the machine.
 */
export const SEED_PATH = path.join(dataDir(), "eval", "seed.json");

const Seed = z.object({
  /** Questions the corpus should answer, and the documents that should come back. */
  retrieval: z
    .array(z.object({ question: z.string().min(1), expect: z.array(z.string()).default([]), forbid: z.array(z.string()).optional() }))
    .default([]),
  /** Questions the corpus genuinely cannot answer, and must decline rather than invent. */
  refusal: z.array(z.object({ question: z.string().min(1) })).default([]),
});

export interface Seeded {
  retrieval: EvalCase[];
  refusal: RefusalCase[];
  /** Why there are no cases, when there are none. */
  missing?: string;
}

/**
 * Read the eval set, or say why there is none.
 *
 * Never throws and never invents cases. An eval that silently falls back to a sample set scores
 * someone else's corpus and reports the number as yours, which is worse than no eval: a green
 * figure nobody can act on. Absent is reported as absent.
 */
export function loadEvalSeed(file = SEED_PATH): Seeded {
  if (!fs.existsSync(file)) return { retrieval: [], refusal: [], missing: `No eval set at ${file}` };
  try {
    const parsed = Seed.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    if (!parsed.success) return { retrieval: [], refusal: [], missing: `${file} is not a valid eval set: ${parsed.error.message}` };
    return { retrieval: parsed.data.retrieval, refusal: parsed.data.refusal };
  } catch (err) {
    return { retrieval: [], refusal: [], missing: `${file} could not be read: ${(err as Error).message}` };
  }
}
