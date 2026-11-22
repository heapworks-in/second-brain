import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { loadEvalSeed } from "./seed";

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function file(contents: string): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-eval-"));
  const at = path.join(dir, "seed.json");
  fs.writeFileSync(at, contents);
  return at;
}

describe("loadEvalSeed", () => {
  it("reads the cases", () => {
    const seed = loadEvalSeed(
      file(JSON.stringify({ retrieval: [{ question: "q", expect: ["A"], forbid: ["B"] }], refusal: [{ question: "absent" }] })),
    );
    expect(seed.missing).toBeUndefined();
    expect(seed.retrieval).toEqual([{ question: "q", expect: ["A"], forbid: ["B"] }]);
    expect(seed.refusal).toEqual([{ question: "absent" }]);
  });

  it("allows a set that only measures one of the two", () => {
    const seed = loadEvalSeed(file(JSON.stringify({ refusal: [{ question: "absent" }] })));
    expect(seed.retrieval).toEqual([]);
    expect(seed.refusal).toHaveLength(1);
  });

  /* Absent, unreadable and malformed all report themselves rather than falling back to sample
   * cases. An eval that quietly scores somebody else's corpus and prints the number as yours is
   * worse than no eval: it is a green figure nobody can act on. */
  it("says so when there is no eval set", () => {
    const seed = loadEvalSeed(path.join(os.tmpdir(), "sb-eval-nonexistent", "seed.json"));
    expect(seed.missing).toContain("No eval set at");
    expect(seed.retrieval).toEqual([]);
  });

  it("says so when the file is not JSON", () => {
    expect(loadEvalSeed(file("{ not json"))?.missing).toContain("could not be read");
  });

  it("says so when a case is the wrong shape", () => {
    const seed = loadEvalSeed(file(JSON.stringify({ retrieval: [{ expect: ["A"] }] })));
    expect(seed.missing).toContain("not a valid eval set");
    expect(seed.retrieval).toEqual([]);
  });
});
