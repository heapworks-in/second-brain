import { z } from "zod";
import type { ChatProvider, StructuredRequest } from "@/providers/chat/types";

/** A model held by the runtime, as the settings page offers it. */
export interface RuntimeModel {
  name: string;
  /** Bytes on disk, as the runtime reports them; the page reads this as the cost of keeping it. */
  size: number;
}

/**
 * Long, because a 26B model answering over a whole transcript is minutes — but finite, because
 * the job queue runs one job at a time and must not stall behind one meeting forever.
 *
 * Under five minutes on purpose, and this is not a preference. Node's fetch gives up waiting for
 * response headers after 300 seconds, and a non-streamed answer sends no headers until the whole
 * answer is written -- so a budget larger than that is a budget the platform will not honour.
 * What it produced instead was `fetch failed` at 305 seconds: the wrong error, naming the wrong
 * thing, from a limit nobody here had chosen. Four minutes is a limit this code actually owns,
 * and it fails saying so.
 */
const ANSWER_TIMEOUT_MS = 4 * 60 * 1000;
/** Reachability is a page-load question: it has to answer or be reported down, quickly. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * How long the runtime keeps the model in memory after answering.
 *
 * The reason to use a server at all. Every summary today spawns `llama-cli`, which reloads the
 * whole model from disk per call; a resident model answers the second question immediately. Ten
 * minutes rather than indefinitely: this machine has 32 GB and a 17 GB model it is not using
 * should give the memory back.
 */
const KEEP_ALIVE = "10m";

/**
 * No chain of thought.
 *
 * `gemma4:26b` -- the model this machine runs -- has a thinking mode, and its default is *on*.
 * Nothing here wants it: every call is schema-constrained, so the answer is a filled-in shape,
 * and the reasoning is generated, paid for and thrown away. The cost is not marginal. The same
 * question over the same sources took 2.6 seconds with this off and over 305 seconds with it on,
 * where it did not finish at all -- it died against Node's 300-second header limit and reached
 * the user as `fetch failed`.
 *
 * Sent to every model, because a runtime that has never heard of thinking ignores it, and the
 * one that has must be told. A runtime old enough to reject the field outright is handled by the
 * retry below rather than by a version check: what matters is whether this request worked.
 */
const NO_THINKING = { think: false };

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`the runtime answered ${res.status}`);
    return await res.json();
  } catch (err) {
    // `fetch failed` and `TimeoutError` both reach a caller as something that could be anything
    // -- the runtime being down, the network, a bug here. Named, because the answer to a model
    // that will not answer in time is a different one from the answer to a model that is off.
    if (err instanceof Error && (err.name === "TimeoutError" || err.message === "fetch failed")) {
      throw new Error(`the runtime did not answer within ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  }
}

const TagsResponse = z.object({
  models: z.array(z.object({ name: z.string(), size: z.number().optional() })).optional(),
});

/**
 * Whether the runtime is there, and what it holds.
 *
 * Never throws: "not reachable" is the normal state on a machine that has never installed a
 * runtime, and the settings page reports it as a row with an action rather than as an error.
 */
export async function probeRuntime(url: string): Promise<{ reachable: boolean; version: string | null; models: RuntimeModel[]; error: string | null }> {
  try {
    const version = await fetchJson(`${url}/api/version`, {}, PROBE_TIMEOUT_MS);
    const parsedVersion = z.object({ version: z.string() }).safeParse(version);
    const tags = TagsResponse.parse(await fetchJson(`${url}/api/tags`, {}, PROBE_TIMEOUT_MS));
    return {
      reachable: true,
      version: parsedVersion.success ? parsedVersion.data.version : null,
      models: (tags.models ?? []).map((m) => ({ name: m.name, size: m.size ?? 0 })),
      error: null,
    };
  } catch (err) {
    return { reachable: false, version: null, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The same `ChatProvider` the app already has, answered by a resident model over HTTP.
 *
 * Structure comes from the runtime's own `format` parameter, handed the schema as JSON Schema:
 * the server constrains generation to it, which is the same job `jsonSchemaToGbnf` does for
 * `llama-cli` and for the same reason. The Zod `.parse()` afterwards is still a second,
 * independent check that what came back means what the schema says — a constrained decode
 * guarantees shape, not sense.
 */
export function createOllamaChatProvider(url: string, model: string): ChatProvider {
  return {
    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      const body = {
        model,
        stream: false,
        keep_alive: KEEP_ALIVE,
        format: z.toJSONSchema(req.schema as z.ZodType),
        options: { temperature: 0 },
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
      };
      const post = (extra: Record<string, unknown>) =>
        fetchJson(`${url}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, ...extra }),
        }, ANSWER_TIMEOUT_MS);
      // One retry without the field, for a runtime too old to know it. Only ever the one, and
      // only for a refusal of the request itself: a model that is simply slow must not be asked
      // the same question twice and charged for both.
      const answer = await post(NO_THINKING).catch((err: unknown) => {
        if (err instanceof Error && /answered 4\d\d/.test(err.message)) return post({});
        throw err;
      });

      const parsed = z.object({ message: z.object({ content: z.string() }) }).safeParse(answer);
      if (!parsed.success) throw new Error("the runtime answered in a shape this version does not understand");
      const content = parsed.data.message.content.trim();
      if (!content) throw new Error(`${model} answered with nothing`);
      return req.schema.parse(JSON.parse(content));
    },
  };
}
