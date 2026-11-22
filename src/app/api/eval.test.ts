import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "@/test/db";
import { getDb } from "@/db/client";
import { captureNote } from "@/domain/items/capture";

let dir: string;
let route: typeof import("./eval/route");

const post = () => new Request("http://localhost/api/eval", { method: "POST" });

beforeAll(async () => {
  dir = makeTempDataDir();
  route = await import("./eval/route");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function seed(contents: unknown) {
  fs.mkdirSync(path.join(dir, "eval"), { recursive: true });
  fs.writeFileSync(path.join(dir, "eval", "seed.json"), JSON.stringify(contents));
}

describe("POST /api/eval", () => {
  /* Refusing to guess is the point. A machine with no eval set must say so rather than report a
   * score, because a number with nothing behind it is the one output nobody can act on. */
  it("says where to put an eval set when there is none", async () => {
    const res = await route.POST(post());
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("No eval set at");
  });

  it("scores retrieval against the corpus", async () => {
    captureNote(getDb(), { title: "Weekly time budget", body: "Deep block, every workday morning, 90 minutes." });
    captureNote(getDb(), { title: "Handling slippage", body: "Never miss twice in a row. Shrink, do not skip." });
    seed({
      retrieval: [
        { question: "how long is the deep block?", expect: ["Weekly time budget"], forbid: ["Handling slippage"] },
        { question: "what do I do when I miss a week?", expect: ["Handling slippage"] },
      ],
      refusal: [],
    });
    const body = await (await route.POST(post())).json();
    expect(body.cases).toBe(2);
    expect(body.retrieval.recall).toBe(1);
    expect(body.retrieval.precisionAtOne).toBe(1);
    // No local model on a test machine, so the half that needs one is skipped rather than scored:
    // a machine that answers nothing refuses everything, and calling that a perfect refusal rate
    // would be a lie told in a number.
    expect(body.refusal).toBeNull();
  });
});
