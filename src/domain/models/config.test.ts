import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupPath, configPath, hasBackup, readConfig, revertConfig, runtimeUrl, writeConfig, DEFAULT_OLLAMA_URL } from "./config";

let dir: string;
let file: string;
/** Restored rather than deleted: `vitest.setup.ts` refuses to run a test with this unset, which
 * is the guard that stops a test reading the real `~/.config/local-models.json`. */
let original: string | undefined;

beforeEach(() => {
  original = process.env.SB_MODELS_CONFIG;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-models-"));
  file = path.join(dir, "local-models.json");
  process.env.SB_MODELS_CONFIG = file;
});
afterEach(() => {
  process.env.SB_MODELS_CONFIG = original;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("configPath", () => {
  it("is outside this app, so other applications can read it", () => {
    delete process.env.SB_MODELS_CONFIG;
    try {
      expect(configPath()).toBe(path.join(os.homedir(), ".config", "local-models.json"));
      expect(configPath()).not.toContain("second-brain");
    } finally {
      process.env.SB_MODELS_CONFIG = file;
    }
  });

  it("is overridable, which is the seam these tests use", () => {
    expect(configPath()).toBe(file);
    expect(backupPath()).toBe(`${file}.bak`);
  });
});

describe("readConfig", () => {
  it("reads an empty config on a machine that has never had the file", () => {
    expect(readConfig()).toEqual({ config: {}, error: null });
  });

  it("reads roles and a runtime", () => {
    fs.writeFileSync(file, JSON.stringify({ runtime: { kind: "ollama", url: "http://localhost:9999" }, roles: { summary: { model: "gemma4:26b" } } }));
    const { config, error } = readConfig();
    expect(error).toBeNull();
    expect(config.roles?.summary?.model).toBe("gemma4:26b");
    expect(runtimeUrl(config)).toBe("http://localhost:9999");
  });

  /** Nobody's UI wrote this file, so a typo in it is the normal kind of mistake — and it must
   * read as "nothing configured" plus a reportable reason, never as a crash. */
  it("reports a broken file rather than throwing, and still answers an empty config", () => {
    fs.writeFileSync(file, "{ not json at all");
    const { config, error } = readConfig();
    expect(config).toEqual({});
    expect(error).toBeTruthy();
  });

  it("reports a file of the right syntax but the wrong shape", () => {
    fs.writeFileSync(file, JSON.stringify({ roles: { summary: "gemma4:26b" } }));
    const { config, error } = readConfig();
    expect(config).toEqual({});
    expect(error).toBeTruthy();
  });

  it("refuses a role it does not know rather than silently ignoring it", () => {
    fs.writeFileSync(file, JSON.stringify({ roles: { transcribe: { model: "whisper" } } }));
    expect(readConfig().error).toBeTruthy();
  });

  it("takes the runtime url from the file, then the environment, then the default port", () => {
    const originalEnv = process.env.SB_OLLAMA_URL;
    try {
      // The suite sets this to an unreachable port so no test ever probes a real runtime.
      process.env.SB_OLLAMA_URL = "http://127.0.0.1:1";
      expect(runtimeUrl(readConfig().config)).toBe("http://127.0.0.1:1");
      delete process.env.SB_OLLAMA_URL;
      expect(runtimeUrl(readConfig().config)).toBe(DEFAULT_OLLAMA_URL);
      // The file wins over both: it is what the settings page writes and what other
      // applications read.
      expect(runtimeUrl({ runtime: { kind: "ollama", url: "http://elsewhere:11434" } })).toBe("http://elsewhere:11434");
    } finally {
      process.env.SB_OLLAMA_URL = originalEnv;
    }
  });
});

describe("writeConfig", () => {
  it("writes the file, and creates the directory on a machine that has no ~/.config yet", () => {
    const nested = path.join(dir, "deeper", "local-models.json");
    process.env.SB_MODELS_CONFIG = nested;
    writeConfig({ roles: { summary: { model: "gemma4:26b" } } });
    expect(readConfig().config.roles?.summary?.model).toBe("gemma4:26b");
  });

  it("writes readable, hand-editable JSON, because a human is the other editor of this file", () => {
    writeConfig({ roles: { summary: { model: "gemma4:26b" } } });
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).toContain("\n  ");
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("leaves no temp file behind: another application could read mid-write", () => {
    writeConfig({ roles: { summary: { model: "gemma4:26b" } } });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
  });

  it("refuses to write a shape it could not read back", () => {
    expect(() => writeConfig({ roles: { summary: { model: "" } } })).toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("the one level of history", () => {
  it("offers nothing to revert before anything has been written", () => {
    expect(hasBackup()).toBe(false);
    expect(revertConfig()).toBe(false);
  });

  it("keeps the previous version when a second write replaces it", () => {
    writeConfig({ roles: { summary: { model: "first" } } });
    expect(hasBackup()).toBe(false);
    writeConfig({ roles: { summary: { model: "second" } } });
    expect(hasBackup()).toBe(true);
    expect(readConfig().config.roles?.summary?.model).toBe("second");

    expect(revertConfig()).toBe(true);
    expect(readConfig().config.roles?.summary?.model).toBe("first");
  });

  /** One level by design: a revert that could itself be reverted is a history, and this file has
   * four lines in it. */
  it("spends the backup on the revert rather than leaving one behind", () => {
    writeConfig({ roles: { summary: { model: "first" } } });
    writeConfig({ roles: { summary: { model: "second" } } });
    revertConfig();
    expect(hasBackup()).toBe(false);
  });
});
