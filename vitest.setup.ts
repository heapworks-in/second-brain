import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach } from "vitest";
import { defaultDataDir } from "@/lib/paths";

/**
 * Defense in depth against the exact accident that happened while building the data-safety
 * slice: a test resolved `dataDir()` to the real path and briefly wrote a fixture snapshot into
 * the owner's real backups directory, because it never called `makeTempDataDir()`. A convention
 * every test author has to remember is exactly the kind that gets forgotten, so this makes the
 * unsafe state structurally hard to reach instead.
 *
 * Every worker gets a safe default the instant it starts, before any test file is even
 * imported, so a test that forgets `makeTempDataDir()` still never touches production -- and,
 * because `SB_DATA_DIR` is a plain process-global string any test could in principle clear or
 * overwrite, `beforeEach` below re-checks it before every single test rather than trusting the
 * default to survive the whole run. A CLI script a test spawns as a child process inherits this
 * from `process.env`, which is exactly the path the real incident went through.
 */
process.env.SB_DATA_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), "sb-vitest-default-"));

/**
 * The same defence for the model configuration, which is the second thing in this app that lives
 * outside its own data directory and can therefore be the developer's real one.
 *
 * Both halves matter and for different reasons. The config path keeps a test from reading — or,
 * worse, writing and backing up — the real `~/.config/local-models.json`. The runtime URL keeps
 * a test from probing whatever is actually listening on ollama's default port: a summary test
 * reached the developer's running ollama, found three models, and failed with a message about
 * picking one of them. A test's answer must not depend on what the machine happens to be running.
 *
 * Port 1 rather than a timeout-prone address: nothing listens there, so the connection is refused
 * immediately instead of costing every test a probe timeout.
 */
process.env.SB_MODELS_CONFIG ??= path.join(process.env.SB_DATA_DIR, "local-models.json");
process.env.SB_OLLAMA_URL ??= "http://127.0.0.1:1";

beforeEach(() => {
  const dir = process.env.SB_DATA_DIR;
  if (!dir || path.resolve(dir) === path.resolve(defaultDataDir())) {
    throw new Error(
      `SB_DATA_DIR is unset or resolves to the real data directory (${defaultDataDir()}). ` +
        "A test is about to touch production data. Call makeTempDataDir() from @/test/db.",
    );
  }
  const config = process.env.SB_MODELS_CONFIG;
  if (!config || config.startsWith(path.join(os.homedir(), ".config"))) {
    throw new Error(`SB_MODELS_CONFIG is unset or points at the real one (${config}). A test is about to read or rewrite it.`);
  }
});

// jsdom does not implement Range.getClientRects()/getBoundingClientRect(), which
// ProseMirror's view layer calls when computing cursor coordinates (e.g. on focus/
// scrollIntoView). Node-environment tests never load this file's jsdom globals, so
// guard on `document` being defined.
if (typeof document !== "undefined") {
  const rect = (): DOMRect => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this;
    },
  });

  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!Range.prototype.getBoundingClientRect) {
    Range.prototype.getBoundingClientRect = rect;
  }
}
