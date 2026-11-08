import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "@/test/db";

let dir: string;
let configFile: string;
let original: string | undefined;
let r: typeof import("./settings/models/route");

const json = (method: string, body?: unknown) =>
  new Request("http://localhost/api/settings/models", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

/** The runtime, answered the way ollama would, without one running. */
function stubRuntime(models: { name: string; size: number }[] | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (models === null) throw new Error("connect ECONNREFUSED");
      if (url.endsWith("/api/version")) return Response.json({ version: "0.40.6" });
      if (url.endsWith("/api/tags")) return Response.json({ models });
      return Response.json({});
    }),
  );
}

beforeAll(async () => {
  dir = makeTempDataDir();
  r = await import("./settings/models/route");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  original = process.env.SB_MODELS_CONFIG;
  configFile = path.join(dir, `models-${Math.random().toString(36).slice(2)}.json`);
  process.env.SB_MODELS_CONFIG = configFile;
});
afterEach(() => {
  process.env.SB_MODELS_CONFIG = original;
  vi.unstubAllGlobals();
});

const GEMMA = { name: "gemma4:26b", size: 17_000_000_000 };
const SMALL = { name: "gemma4:12b-it-qat", size: 7_200_000_000 };

describe("GET /api/settings/models", () => {
  it("reports the runtime, its models, and every role with what answers it", async () => {
    stubRuntime([GEMMA, SMALL]);
    const body = await (await r.GET()).json();
    expect(body.runtime).toMatchObject({ reachable: true, version: "0.40.6" });
    expect(body.runtime.models).toHaveLength(2);
    expect(body.roles.map((role: { role: string }) => role.role)).toEqual(["summary", "gist"]);
    // Each row carries what it is for, so the page never has to know.
    expect(body.roles[0]).toMatchObject({ title: "Summary", source: "none" });
    expect(body.roles[0].what).toBeTruthy();
  });

  it("says the runtime is down without failing, which is a machine that never installed one", async () => {
    stubRuntime(null);
    const body = await (await r.GET()).json();
    expect(body.runtime).toMatchObject({ reachable: false, models: [] });
    expect(body.runtime.error).toBeTruthy();
    // And every role still says what to do about it.
    for (const role of body.roles) expect(role.unavailable).toContain("install");
  });

  it("reports a hand-edited file that cannot be read, rather than appearing empty", async () => {
    fs.writeFileSync(configFile, "{ broken");
    stubRuntime([GEMMA]);
    const body = await (await r.GET()).json();
    expect(body.configError).toBeTruthy();
  });

  it("offers nothing to revert until something has been overwritten", async () => {
    stubRuntime([GEMMA]);
    expect((await (await r.GET()).json()).canRevert).toBe(false);
  });
});

describe("PATCH /api/settings/models", () => {
  it("points a role at a model the runtime holds, and says so in the answer", async () => {
    stubRuntime([GEMMA, SMALL]);
    const body = await (await r.PATCH(json("PATCH", { role: "summary", model: "gemma4:26b" }))).json();
    const summary = body.roles.find((x: { role: string }) => x.role === "summary");
    expect(summary).toMatchObject({ source: "config", model: "gemma4:26b", unavailable: null });
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).roles.summary.model).toBe("gemma4:26b");
  });

  /**
   * The check that matters: a save that wrote first and validated later would replace a working
   * configuration with a broken one while showing a success message.
   */
  it("refuses a model the runtime does not have, without touching the file", async () => {
    stubRuntime([GEMMA]);
    await r.PATCH(json("PATCH", { role: "summary", model: "gemma4:26b" }));
    const res = await r.PATCH(json("PATCH", { role: "summary", model: "mistral:7b" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("pull it first");
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).roles.summary.model).toBe("gemma4:26b");
  });

  it("refuses when the runtime cannot be asked at all, and says which runtime", async () => {
    stubRuntime(null);
    const res = await r.PATCH(json("PATCH", { role: "summary", model: "gemma4:26b" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("not reachable");
  });

  /** Clearing is the inverse of setting, and it cannot be wrong, so it never consults the
   * runtime — which matters because the runtime being down is the likeliest reason to clear. */
  it("clears a role without needing the runtime, handing it back to the fallback order", async () => {
    stubRuntime([GEMMA]);
    await r.PATCH(json("PATCH", { role: "summary", model: "gemma4:26b" }));
    stubRuntime(null);
    const body = await (await r.PATCH(json("PATCH", { role: "summary", model: null }))).json();
    expect(body.roles.find((x: { role: string }) => x.role === "summary").wanted).toBeNull();
    expect(JSON.parse(fs.readFileSync(configFile, "utf8")).roles).toBeUndefined();
  });

  it("refuses a role it does not know, and a body of the wrong shape", async () => {
    stubRuntime([GEMMA]);
    expect((await r.PATCH(json("PATCH", { role: "transcribe", model: "whisper" }))).status).toBe(400);
    expect((await r.PATCH(json("PATCH", { model: "gemma4:26b" }))).status).toBe(400);
  });

  it("refuses a cross-site write, and a cross-site revert", async () => {
    const foreign = (method: string) =>
      new Request("http://localhost/api/settings/models", {
        method,
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ role: "summary", model: "gemma4:26b" }),
      });
    expect((await r.PATCH(foreign("PATCH"))).status).toBe(403);
    expect((await r.DELETE(foreign("DELETE"))).status).toBe(403);
  });
});

describe("DELETE /api/settings/models", () => {
  it("puts the previous file back", async () => {
    stubRuntime([GEMMA, SMALL]);
    await r.PATCH(json("PATCH", { role: "summary", model: "gemma4:26b" }));
    await r.PATCH(json("PATCH", { role: "summary", model: "gemma4:12b-it-qat" }));
    expect((await (await r.GET()).json()).canRevert).toBe(true);

    const body = await (await r.DELETE(json("DELETE"))).json();
    expect(body.reverted).toBe(true);
    expect(body.roles.find((x: { role: string }) => x.role === "summary").model).toBe("gemma4:26b");
    // One level of history: the revert spends the backup rather than leaving one.
    expect(body.canRevert).toBe(false);
  });

  it("says plainly that there was nothing to put back", async () => {
    stubRuntime([GEMMA]);
    expect((await (await r.DELETE(json("DELETE"))).json()).reverted).toBe(false);
  });
});
