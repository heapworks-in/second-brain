import { z } from "zod";
import type { ChatProvider, StructuredRequest } from "@/providers/chat/types";

/** A model held by the runtime, as the settings page offers it. */
export interface RuntimeModel {
  name: string;
  /** Bytes on disk, as the runtime reports them; the page reads this as the cost of keeping it. */
  size: number;
}

/** Long, because a 26B model answering over a whole transcript is minutes — but finite, because
 * the job queue runs one job at a time and must not stall behind one meeting forever. */
const ANSWER_TIMEOUT_MS = 10 * 60 * 1000;
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

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`the runtime answered ${res.status}`);
  return res.json();
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
      const answer = await fetchJson(`${url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, ANSWER_TIMEOUT_MS);

      const parsed = z.object({ message: z.object({ content: z.string() }) }).safeParse(answer);
      if (!parsed.success) throw new Error("the runtime answered in a shape this version does not understand");
      const content = parsed.data.message.content.trim();
      if (!content) throw new Error(`${model} answered with nothing`);
      return req.schema.parse(JSON.parse(content));
    },
  };
}
