import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";

vi.mock("node:fs");

describe("hasGistModel / getGistProvider", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("is off when the model file is absent, same as summarize_meeting with no key", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { hasGistModel, getGistProvider } = await import("./index");
    expect(hasGistModel()).toBe(false);
    expect(await getGistProvider()).toBeNull();
  });

  it("is off when the model is present but llama-cli cannot be resolved on PATH", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { hasGistModel, getGistProvider } = await import("./index");
    expect(hasGistModel()).toBe(true);
    expect(await getGistProvider()).toBeNull();
  });

  it("is on when the model file is present and llama-cli resolves to an executable", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
    vi.mocked(fs.accessSync).mockReturnValue(undefined);
    const { hasGistModel, getGistProvider, gistBinary } = await import("./index");
    expect(hasGistModel()).toBe(true);
    expect(gistBinary()).not.toBeNull();
    expect(await getGistProvider()).not.toBeNull();
  });
});
