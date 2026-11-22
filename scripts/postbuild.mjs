#!/usr/bin/env node
// Runs automatically after `npm run build` (npm's `postbuild` hook), so every caller gets it:
// brain.sh's three build sites, the release recipe in desktop/README.md, and a bare `npm run build`.
// Both jobs below used to be instructions in a README, which is a defence that works until the day
// somebody builds without reading it. One of them already failed that way once.
//
//   1. Delete .next/standalone/desktop. Turbopack's tracer cannot resolve db/client.ts's
//      `path.join(process.cwd(), "drizzle")`, so it sweeps the project root wholesale and drags in
//      desktop/src-tauri/target -- a multi-GB Rust build directory holding a complete prior copy of
//      Second Brain.app, which holds its own server/ payload in turn. `outputFileTracingExcludes`
//      filters the .nft.json trace files correctly but Turbopack's standalone copy step never
//      consults that result. This shipped a ~120MB release as 5GB before it was caught.
//
//   2. Scrub the absolute repo path out of the generated files. `next build` records where it ran
//      in four build-provenance fields, and the dmg is published publicly, so those fields hand out
//      the builder's macOS username. Nothing reads them at runtime: server.js resolves `dir` from
//      __dirname, chdir's to it, and passes its inlined config object to startServer directly.
//      Verified by grep -- next-server.js and start-server.js never read appDir.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STANDALONE = path.join(ROOT, ".next", "standalone");
/** What the builder's path becomes. A plausible absolute path, belonging to nobody. */
const ANON = "/second-brain";

/** Replace every occurrence of the build machine's repo path. Exported shape so the self-check can reach it. */
export const scrub = (text, root, anon = ANON) => text.split(root).join(anon);

/** The generated files that record where the build ran. Relative to .next/standalone. */
const GENERATED = ["server.js", ".next/required-server-files.json"];

function main() {
  if (!fs.existsSync(STANDALONE)) return;   // not a standalone build; nothing to clean

  const nested = path.join(STANDALONE, "desktop");
  if (fs.existsSync(nested)) {
    fs.rmSync(nested, { recursive: true, force: true });
    console.log("[postbuild] removed .next/standalone/desktop (Turbopack traced the Rust build dir)");
  }

  for (const rel of GENERATED) {
    const file = path.join(STANDALONE, rel);
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = scrub(before, ROOT);
    if (after === before) continue;
    fs.writeFileSync(file, after);
    console.log(`[postbuild] scrubbed the build path out of ${rel}`);
  }

  // The whole point is that nobody has to remember to check. Fail the build rather than publish it.
  const leaked = GENERATED
    .map((rel) => path.join(STANDALONE, rel))
    .filter((file) => fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(ROOT));
  if (leaked.length) throw new Error(`the build path survived in: ${leaked.join(", ")}`);
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
  // Idempotent: a second pass over scrubbed text changes nothing.
  const once = scrub(`x ${root} y`, root);
  if (scrub(once, root) !== once) throw new Error("scrub is not idempotent");
  console.log(`[postbuild] self-check passed (${cases.length + 1} cases)`);
}

if (process.argv.includes("--self-check")) selfCheck();
else main();
