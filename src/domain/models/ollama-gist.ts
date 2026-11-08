import { z } from "zod";
import type { GistProvider } from "@/providers/gist/types";

const SYSTEM = "Rewrite the following short quotes as one short, plain paragraph. Do not add anything that is not in the quotes.";

/** The same ceiling the subprocess gist has: one gist is never worth stalling the serial job
 * queue, which runs transcription, embedding and the nightly backup behind it. */
const GIST_TIMEOUT_MS = 120_000;
/** Shorter than the summary role's: a gist is a paragraph, and a resident small model should be
 * answering it in seconds. */
const KEEP_ALIVE = "5m";

/**
 * A gist from a resident model. Plain prose, not a structured answer, so this asks for text and
 * does no schema work — the only check that matters is that something came back.
 */
export function createOllamaGistProvider(url: string, model: string): GistProvider {
  return {
    async gist(quotes: string[]): Promise<string> {
      const res = await fetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0.2, num_predict: 160 },
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: quotes.map((q) => `- ${q}`).join("\n") },
          ],
        }),
        signal: AbortSignal.timeout(GIST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`the runtime answered ${res.status}`);
      const parsed = z.object({ message: z.object({ content: z.string() }) }).safeParse(await res.json());
      if (!parsed.success) throw new Error("the runtime answered in a shape this version does not understand");
      const gist = parsed.data.message.content.trim();
      if (!gist) throw new Error(`${model} answered with nothing`);
      return gist;
    },
  };
}
