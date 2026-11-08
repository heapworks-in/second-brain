import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTempDataDir } from "@/test/db";
import { localModelPath, resolveRole } from "./resolve";
import type { ModelsConfig } from "./config";
import type { RuntimeModel } from "./ollama";

let dir: string;

beforeEach(() => {
  dir = makeTempDataDir();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** Every case states whether a `llama-cli` exists, rather than inheriting whatever this machine
 * happens to have installed. */
const WITH_CLI = "/opt/homebrew/bin/llama-cli";

const GEMMA: RuntimeModel = { name: "gemma4:26b", size: 17_000_000_000 };
const SMALL: RuntimeModel = { name: "gemma4:12b-it-qat", size: 7_200_000_000 };

/** The last-resort GGUF, present on disk the way `brain.sh setup` leaves it. */
function installLocalModel(role: "summary" | "gist") {
  const file = localModelPath(role);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "gguf");
}

const configured: ModelsConfig = { roles: { summary: { model: "gemma4:26b" } } };

describe("resolveRole", () => {
  it("prefers the file when the runtime actually holds what it names", () => {
    const state = resolveRole({ role: "summary", config: configured, available: [GEMMA, SMALL], runtimeReachable: true, llamaCli: WITH_CLI });
    expect(state).toMatchObject({ source: "config", model: "gemma4:26b", unavailable: null });
  });

  /**
   * The failure this ordering exists to stop: a config naming a model nobody pulled used to mean
   * a job that completed having done nothing, with the page saying "no summary yet" for ever.
   */
  it("reports a configured model the runtime does not have, rather than quietly using something else", () => {
    installLocalModel("summary");
    const state = resolveRole({ role: "summary", config: { roles: { summary: { model: "mistral:7b" } } }, available: [GEMMA], runtimeReachable: true, llamaCli: WITH_CLI });
    expect(state.source).toBe("none");
    expect(state.wanted).toBe("mistral:7b");
    expect(state.unavailable).toContain("does not have it");
  });

  it("says the runtime is down rather than blaming the model, when it is the runtime", () => {
    const state = resolveRole({ role: "summary", config: configured, available: [], runtimeReachable: false, llamaCli: WITH_CLI });
    expect(state.unavailable).toContain("not reachable");
    expect(state.wanted).toBe("gemma4:26b");
  });

  it("uses the runtime's single model when nothing is configured", () => {
    const state = resolveRole({ role: "gist", config: {}, available: [SMALL], runtimeReachable: true, llamaCli: WITH_CLI });
    expect(state).toMatchObject({ source: "runtime", model: "gemma4:12b-it-qat" });
  });

  /** Picking among several without being told is a guess, and a guess about which model wrote
   * your meeting summaries is not one to make on somebody's behalf. */
  it("will not choose between several models on its own: it asks", () => {
    const state = resolveRole({ role: "summary", config: {}, available: [GEMMA, SMALL], runtimeReachable: true, llamaCli: WITH_CLI });
    expect(state.source).toBe("none");
    expect(state.unavailable).toContain("pick one of the 2 models");
  });

  it("prefers a local model over asking, when there is one", () => {
    installLocalModel("summary");
    const state = resolveRole({ role: "summary", config: {}, available: [GEMMA, SMALL], runtimeReachable: true, llamaCli: WITH_CLI });
    expect(state.source).toBe("local");
    expect(state.model).toBe(localModelPath("summary"));
  });

  it("falls back to the local model on a machine with no config and no runtime", () => {
    installLocalModel("gist");
    const state = resolveRole({ role: "gist", config: {}, available: [], runtimeReachable: false, llamaCli: WITH_CLI });
    expect(state).toMatchObject({ source: "local", unavailable: null });
  });

  /** The model is there and the thing that runs it is not — two independent installs, which is
   * exactly how `brain.sh setup` fails on a Mac without Homebrew. */
  it("blames the missing binary, not the missing model, when the model is there", () => {
    installLocalModel("summary");
    const state = resolveRole({ role: "summary", config: {}, available: [], runtimeReachable: false, llamaCli: null });
    expect(state.source).toBe("none");
    expect(state.unavailable).toContain("brew install llama.cpp");
  });

  it("says nothing is installed when nothing is, which is a fresh install", () => {
    const state = resolveRole({ role: "summary", config: {}, available: [], runtimeReachable: false, llamaCli: WITH_CLI });
    expect(state).toMatchObject({ source: "none", model: null, wanted: null });
    // Names the role and ends in something to do: a reason that only reports a state is how
    // "No summary yet" came to sit on every meeting for ever.
    expect(state.unavailable).toContain("no summary model is installed yet");
    expect(state.unavailable).toContain("Settings");
  });
});
