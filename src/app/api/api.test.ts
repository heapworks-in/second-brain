import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { makeTempDataDir } from "@/test/db";
import { MINIMAL_PDF } from "@/test/fixtures";
import { createFakeEmbedProvider } from "@/providers/embed/fake";
import type { ItemDTO, SearchResultDTO } from "@/lib/dto";

let dir: string;
let routes: {
  items: typeof import("./items/route");
  item: typeof import("./items/[id]/route");
  retry: typeof import("./items/[id]/retry/route");
  file: typeof import("./items/[id]/file/route");
  upload: typeof import("./upload/route");
  search: typeof import("./search/route");
  tags: typeof import("./tags/route");
};
let drain: () => Promise<void>;

const json = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

beforeAll(async () => {
  dir = makeTempDataDir();
  const { setEmbedProviderForTests } = await import("@/server/providers");
  setEmbedProviderForTests(createFakeEmbedProvider());
  routes = {
    items: await import("./items/route"),
    item: await import("./items/[id]/route"),
    retry: await import("./items/[id]/retry/route"),
    file: await import("./items/[id]/file/route"),
    upload: await import("./upload/route"),
    search: await import("./search/route"),
    tags: await import("./tags/route"),
  };
  const { getDb } = await import("@/db/client");
  const { JobWorker } = await import("@/jobs/worker");
  const { createJobHandlers } = await import("@/jobs/handlers");
  // The audio upload queues a transcript job; with the tools left null it fails on the spot
  // instead of scanning this machine's PATH for whisper.
  const worker = new JobWorker(
    getDb(),
    createJobHandlers({ db: getDb(), embed: createFakeEmbedProvider(), whisperBin: null, ffmpegBin: null }),
  );
  drain = async () => {
    while (await worker.runOnce()) {
      /* drain */
    }
  };
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("items api", () => {
  it("creates, lists, reads, updates, and deletes a note", async () => {
    const created = await routes.items.POST(json("POST", "/api/items", { type: "note", body: "API note body", tags: ["api"] }));
    expect(created.status).toBe(201);
    const dto = (await created.json()) as ItemDTO;
    expect(dto.title).toBe("API note body");
    expect(dto.tags).toEqual(["api"]);

    const list = (await (await routes.items.GET(json("GET", "/api/items?tag=api"))).json()) as ItemDTO[];
    expect(list.map((i) => i.id)).toEqual([dto.id]);

    const read = await routes.item.GET(json("GET", `/api/items/${dto.id}`), params(dto.id));
    expect(((await read.json()) as ItemDTO).body).toBe("API note body");
    expect((await routes.item.GET(json("GET", "/api/items/999"), params(999))).status).toBe(404);
    expect((await routes.item.GET(json("GET", "/api/items/abc"), params("abc"))).status).toBe(400);

    const patched = await routes.item.PATCH(json("PATCH", `/api/items/${dto.id}`, { title: "Renamed", tags: [] }), params(dto.id));
    expect(((await patched.json()) as ItemDTO).title).toBe("Renamed");

    expect((await routes.item.PATCH(json("PATCH", `/api/items/${dto.id}`, { pinned: true }), params(dto.id))).status).toBe(200);
    const pinnedRead = (await (await routes.item.GET(json("GET", `/api/items/${dto.id}`), params(dto.id))).json()) as ItemDTO;
    expect(pinnedRead.pinned).toBe(true);
    const unpinned = await routes.item.PATCH(json("PATCH", `/api/items/${dto.id}`, { pinned: false }), params(dto.id));
    expect(((await unpinned.json()) as ItemDTO).pinned).toBe(false);

    expect((await routes.item.DELETE(json("DELETE", `/api/items/${dto.id}`), params(dto.id))).status).toBe(204);
    expect((await routes.item.GET(json("GET", `/api/items/${dto.id}`), params(dto.id))).status).toBe(404);
  });

  it("rejects invalid bodies", async () => {
    expect((await routes.items.POST(json("POST", "/api/items", { type: "note" }))).status).toBe(400);
    expect((await routes.items.POST(json("POST", "/api/items", { type: "link", url: "nope" }))).status).toBe(400);
  });

  it("creates a note with an empty body when the title is non-empty, and rejects both empty", async () => {
    const created = await routes.items.POST(json("POST", "/api/items", { type: "note", title: "Untitled note", body: "" }));
    expect(created.status).toBe(201);
    const dto = (await created.json()) as ItemDTO;
    expect(dto.title).toBe("Untitled note");
    expect(dto.body).toBe("");

    expect((await routes.items.POST(json("POST", "/api/items", { type: "note", title: "", body: "" }))).status).toBe(400);
  });

  it("rejects invalid list filters", async () => {
    expect((await routes.items.GET(json("GET", "/api/items?type=bogus"))).status).toBe(400);
    expect((await routes.items.GET(json("GET", "/api/items?status=nope"))).status).toBe(400);
  });

  it("uploads a pdf, serves it back, and rejects audio", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(MINIMAL_PDF)], "hello.pdf", { type: "application/pdf" }));
    form.append("tags", "docs, PDF");
    const res = await routes.upload.POST(new Request("http://localhost/api/upload", { method: "POST", body: form }));
    expect(res.status).toBe(201);
    const dto = (await res.json()) as ItemDTO;
    expect(dto.type).toBe("file");
    expect(dto.tags).toEqual(["docs", "pdf"]);

    const served = await routes.file.GET(json("GET", `/api/items/${dto.id}/file`), params(dto.id));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await served.arrayBuffer()).equals(MINIMAL_PDF)).toBe(true);
    expect(served.headers.get("content-disposition")).toMatch(/^inline/);
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");

    const htmlForm = new FormData();
    htmlForm.append("file", new File([new Uint8Array(Buffer.from("<script>1</script>"))], "page.html", { type: "text/html" }));
    const htmlRes = await routes.upload.POST(new Request("http://localhost/api/upload", { method: "POST", body: htmlForm }));
    expect(htmlRes.status).toBe(201);
    const htmlDto = (await htmlRes.json()) as ItemDTO;
    const servedHtml = await routes.file.GET(json("GET", `/api/items/${htmlDto.id}/file`), params(htmlDto.id));
    expect(servedHtml.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(servedHtml.headers.get("x-content-type-options")).toBe("nosniff");

    // Audio arrives as a meeting waiting on its transcript, not as a plain file.
    const audio = new FormData();
    audio.append("file", new File([new Uint8Array(Buffer.from("x"))], "call.m4a", { type: "audio/mp4" }));
    const audioRes = await routes.upload.POST(new Request("http://localhost/api/upload", { method: "POST", body: audio }));
    expect(audioRes.status).toBe(201);
    expect((await audioRes.json()).type).toBe("meeting");
    expect((await routes.upload.POST(new Request("http://localhost/api/upload", { method: "POST", body: new FormData() }))).status).toBe(400);
  });

  it("searches after the worker has processed captures", async () => {
    await routes.items.POST(json("POST", "/api/items", { type: "note", body: "Sourdough starter needs feeding twice a day" }));
    await drain();
    const res = await routes.search.GET(json("GET", "/api/search?q=sourdough+feeding"));
    const results = (await res.json()) as SearchResultDTO[];
    expect(results[0].item.title).toMatch(/Sourdough/);
    expect(results[0].snippet).toMatch(/feeding/);
    expect((await (await routes.search.GET(json("GET", "/api/search?q="))).json())).toEqual([]);
    expect((await (await routes.tags.GET(json("GET", "/api/tags"))).json()) as string[]).toContain("docs");
    const counted = (await (await routes.tags.GET(json("GET", "/api/tags?counts=1"))).json()) as { name: string; count: number }[];
    expect(counted.find((t) => t.name === "docs")?.count).toBeGreaterThan(0);
  });

  it("retries failed jobs for an item", async () => {
    const { getDb } = await import("@/db/client");
    const { enqueueJob, failJob } = await import("@/jobs/queue");
    const { captureNote } = await import("@/domain/items/capture");
    const item = captureNote(getDb(), { body: "will fail" });
    const job = enqueueJob(getDb(), "embed", { itemId: item.id }, item.id);
    // failJob does not require the job to be running; three failures make it permanent.
    for (let i = 0; i < 3; i++) failJob(getDb(), job.id, "x", new Date("2026-01-01T00:00:00Z"));
    const res = await routes.retry.POST(json("POST", `/api/items/${item.id}/retry`), params(item.id));
    expect(await res.json()).toEqual({ retried: 1 });
  });
});
