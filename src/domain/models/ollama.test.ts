import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { createOllamaChatProvider } from "./ollama";

const URL = "http://127.0.0.1:11434";
const Schema = z.object({ answer: z.string() });

const req = { system: "s", user: "u", schema: Schema, name: "answer", description: "d" };

/** What the runtime sends back when it answers. */
const ok = (content: unknown) =>
  new Response(JSON.stringify({ message: { role: "assistant", content: JSON.stringify(content) } }), { status: 200 });

function stub(...responses: (Response | Error)[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected extra request");
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const sent = (fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> =>
  JSON.parse(String((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].body));

afterEach(() => vi.unstubAllGlobals());

describe("createOllamaChatProvider", () => {
  /* The model this machine runs has a thinking mode whose default is on, and every call here is
   * schema-constrained -- so the reasoning is generated, paid for and thrown away. The same
   * question took 2.6 seconds with this off and over 305 seconds with it on, where it did not
   * finish at all. */
  it("asks the model not to think", async () => {
    const fetchMock = stub(ok({ answer: "yes" }));
    await createOllamaChatProvider(URL, "m").structured(req);
    expect(sent(fetchMock).think).toBe(false);
  });

  it("asks again without the field when the runtime refuses it", async () => {
    const fetchMock = stub(new Response("unknown field", { status: 400 }), ok({ answer: "yes" }));
    await expect(createOllamaChatProvider(URL, "m").structured(req)).resolves.toEqual({ answer: "yes" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sent(fetchMock, 0).think).toBe(false);
    expect(sent(fetchMock, 1)).not.toHaveProperty("think");
  });

  /* Only a refusal of the request, and only once. A model that is merely slow must not be asked
   * the same question twice and charged for both. */
  it("does not ask twice when the runtime fails for any other reason", async () => {
    const fetchMock = stub(new Response("boom", { status: 500 }));
    await expect(createOllamaChatProvider(URL, "m").structured(req)).rejects.toThrow("answered 500");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /* `fetch failed` at 305 seconds was the real symptom, and it named the wrong thing: Node's own
   * header limit, not the runtime, and not a limit this code had chosen. */
  it("says the runtime ran out of time rather than that the fetch failed", async () => {
    stub(Object.assign(new Error("fetch failed"), { name: "TypeError" }));
    await expect(createOllamaChatProvider(URL, "m").structured(req)).rejects.toThrow(/did not answer within \d+s/);
  });

  it("rejects an answer that satisfied the grammar but not the schema", async () => {
    stub(ok({ notTheAnswer: 1 }));
    await expect(createOllamaChatProvider(URL, "m").structured(req)).rejects.toThrow();
  });
});
