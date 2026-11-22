#!/usr/bin/env node
// Keeps the shipped payload free of two things that have no business in a public dmg: a multi-GB
// copy of a previous build, and the build machine's home directory.
//
// Runs in two places, because the payload is finished in two stages:
//
//   npm run build            -> the `postbuild` hook, so every caller gets it: brain.sh's three
//                               build sites, the release recipe, and a bare `npm run build`.
//   node scripts/postbuild.mjs --app <Second Brain.app>
//                            -> over the finished bundle, before the dmg is published. The Rust
//                               binary is a third source nobody expects: rustc embeds the source
//                               path of every crate for panic messages, so a release build held
//                               ~/.cargo/registry/... 375 times. `--remap-path-prefix` in the
//                               release recipe fixes it; this check is what makes forgetting the
//                               flag impossible rather than merely discouraged.
//   node scripts/postbuild.mjs --payload
//                            -> again at the end of the release recipe's assembly steps. Those
//                               steps (cp .next/static, bundle-externals.mjs) copy fresh files in
//                               AFTER the build, which is how a scrubbed payload came back dirty.
//                               Found exactly that way: 0.9.2 was clean at build time and had four
//                               leaking files by the time the dmg was about to be cut.
//
// Both jobs used to be instructions in desktop/README.md, and one had already been skipped once --
// it shipped a ~120MB release as 5GB.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
/** What the builder's path becomes. A plausible absolute path, belonging to nobody. */
const ANON = "/second-brain";

/** Replace every occurrence of the build machine's repo path. */
export const scrub = (text, root, anon = ANON) => text.split(root).join(anon);

/** The generated files that record where the build ran. Relative to .next/standalone. */
const GENERATED = ["server.js", ".next/required-server-files.json"];

/* `build/` is far too common a directory name to go on by itself: next/dist/build holds real
 * source, and deleting it cost a smoke test run with 12 failing routes and
 * "Cannot find module '../build/output/log'". config.gypi is the honest marker -- node-gyp writes
 * it into every directory it configures and nothing else produces one. */
const isGypDir = (dir) => fs.existsSync(path.join(dir, "config.gypi"));

/** Every node-gyp build directory under `dir`, found by its config.gypi. */
function gypDirs(dir, found = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === "build" && isGypDir(full)) found.push(full);
    else gypDirs(full, found);
  }
  return found;
}

const hasAddon = (dir) => {
  const stack = [dir];
  while (stack.length) {
    let entries;
    try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".node")) return true;
      if (e.isDirectory()) stack.push(path.join(e.parentPath, e.name));
    }
  }
  return false;
};

/* node-gyp leaves Makefile, config.gypi and gyp-mac-tool behind, and they record the builder's
 * nvm prefix, ~/.npm and ~/.npmrc. A gyp directory with no .node in it never produced anything:
 * better-sqlite3 resolves its addon from prebuilds/, so its build/ is pure scratch. Deleting only
 * the output-less ones keeps any package that genuinely compiles its addon working. */
function pruneGypScratch() {
  let removed = 0;
  for (const dir of gypDirs(STANDALONE)) {
    if (hasAddon(dir)) continue;
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  if (removed) console.log(`[postbuild] pruned ${removed} node-gyp build director${removed === 1 ? "y" : "ies"} with no addon in them`);
}

function scrubGenerated() {
  for (const rel of GENERATED) {
    const file = path.join(STANDALONE, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = scrub(before, ROOT);
    if (after === before) continue;
    fs.writeFileSync(file, after);
    console.log(`[postbuild] scrubbed the build path out of ${rel}`);
  }
}

/** Every file under `dir` still naming the builder's home directory. Binaries included -- grep
 *  reports a match in a compiled binary the same way it does in a text file, which is the point. */
function leaks(dir) {
  try {
    return execFileSync("grep", ["-rlF", os.homedir(), dir], { encoding: "utf8" })
      .split("\n").filter(Boolean);
  } catch (err) {
    if (err.status === 1) return [];   // grep's "no matches"
    throw err;
  }
}

/** Refuse to let `dir` be published while it still names the builder. */
function demandClean(dir, what) {
  const left = leaks(dir);
  if (left.length) {
    throw new Error(
      `${os.homedir()} survives in ${left.length} ${what} file(s), which would ship publicly:\n  ` +
      left.map((f) => path.relative(dir, f)).join("\n  "),
    );
  }
  console.log(`[postbuild] ${what} carries no trace of ${os.homedir()}`);
}

/** The finished .app bundle, payload and compiled binary alike. */
function checkApp(bundle) {
  if (!fs.existsSync(bundle)) throw new Error(`no app bundle at ${bundle}`);
  demandClean(bundle, "app bundle");
}

function main({ payload = false } = {}) {
  if (!fs.existsSync(STANDALONE)) return;   // not a standalone build; nothing to clean

  if (!payload) {
    const nested = path.join(STANDALONE, "desktop");
    if (fs.existsSync(nested)) {
      fs.rmSync(nested, { recursive: true, force: true });
      console.log("[postbuild] removed .next/standalone/desktop (Turbopack traced the Rust build dir)");
    }
  }

  pruneGypScratch();
  scrubGenerated();

  // The whole point is that nobody has to remember to look. Fail rather than publish.
  demandClean(STANDALONE, "payload");
}

function selfCheck() {
  const root = "/Users/someone/Documents/github/second-brain";
  const cases = [
    [`{"appDir":"${root}","x":1}`, '{"appDir":"/second-brain","x":1}'],
    [`a ${root} b ${root} c`, "a /second-brain b /second-brain c"],
    ["nothing to do here", "nothing to do here"],
  ];
  for (const [input, want] of cases) {
    const got = scrub(input, root);
    if (got !== want) throw new Error(`scrub(${input}) gave ${got}, wanted ${want}`);
  }
  const once = scrub(`x ${root} y`, root);
  if (scrub(once, root) !== once) throw new Error("scrub is not idempotent");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "postbuild-"));
  const make = (name, files) => {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(tmp, name, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    return path.join(tmp, name);
  };

  // hasAddon decides whether a gyp directory is scratch or somebody's compiled output.
  const scratch = make("scratch", { "config.gypi": "{}", Makefile: "gyp junk" });
  const real = make("real", { "config.gypi": "{}", "Release/thing.node": "" });
  if (hasAddon(scratch)) throw new Error("called scratch an addon");
  if (!hasAddon(real)) throw new Error("missed a nested addon");

  // And isGypDir is what keeps a package's own `build/` out of it. next/dist/build holds real
  // source and no config.gypi; deleting it broke every route in the smoke test.
  const source = make("node_modules/next/dist/build", { "output/log.js": "module.exports={}" });
  if (isGypDir(source)) throw new Error("mistook next/dist/build for a gyp directory");
  if (!isGypDir(scratch)) throw new Error("missed a real gyp directory");
  if (gypDirs(path.join(tmp, "node_modules")).length) throw new Error("gypDirs walked into package source");
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`[postbuild] self-check passed (${cases.length + 7} cases)`);
}

const appFlag = process.argv.indexOf("--app");
if (process.argv.includes("--self-check")) selfCheck();
else if (appFlag !== -1) checkApp(process.argv[appFlag + 1]);
else main({ payload: process.argv.includes("--payload") });
