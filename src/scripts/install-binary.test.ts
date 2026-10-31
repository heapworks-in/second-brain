import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * `scripts/brain.sh`'s `install_binary`, run as itself rather than re-implemented here: what is
 * under test is what the kernel does to a file, so a stand-in would prove nothing about the real
 * thing. Nothing else in brain.sh is sourced -- the file dispatches a command at the bottom.
 */
const REPO_ROOT = path.resolve(__dirname, "../..");
const INSTALL_BINARY = fs
  .readFileSync(path.join(REPO_ROOT, "scripts/brain.sh"), "utf8")
  .match(/^install_binary\(\) \{[\s\S]*?^\}$/m)?.[0];

function install(src: string, dest: string): number | null {
  const script = `set -euo pipefail\n${INSTALL_BINARY}\ninstall_binary "$1" "$2"`;
  return spawnSync("bash", ["-c", script, "bash", src, dest], { encoding: "utf8" }).status;
}

/** A real Mach-O, built here because a copy of a system binary will not run (the trust cache ties
 * `/bin/echo` and friends to their original path) and a shell script is never mapped as an image,
 * which is the whole mechanism this file is about. `body` makes the two programs differ. */
function buildExecutable(dir: string, name: string, body: string): string {
  const source = path.join(dir, `${name}.c`);
  const out = path.join(dir, name);
  fs.writeFileSync(source, `#include <stdio.h>\n#include <unistd.h>\nint main(void){ ${body} }\n`);
  const cc = spawnSync("cc", ["-O0", "-o", out, source], { encoding: "utf8" });
  if (cc.status !== 0) throw new Error(`cc failed: ${cc.stderr}`);
  return out;
}

const haveCompiler = spawnSync("cc", ["--version"], { encoding: "utf8" }).status === 0;

describe("install_binary", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-install-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("is still a function in brain.sh", () => {
    expect(INSTALL_BINARY).toBeTruthy();
  });

  it("installs an executable copy, leaving no temporary behind", () => {
    const src = path.join(dir, "src.sh");
    fs.writeFileSync(src, "#!/bin/sh\necho hello\n");
    const dest = path.join(dir, "bin", "tool");
    expect(install(src, dest)).toBe(0);
    expect(fs.statSync(dest).mode & 0o111).toBeTruthy();
    expect(spawnSync(dest, [], { encoding: "utf8" }).stdout.trim()).toBe("hello");
    expect(fs.existsSync(`${dest}.new`)).toBe(false);
  });

  /**
   * The bug this file exists for. Overwriting a Mach-O while something is executing it leaves the
   * kernel's cached page hashes for that inode disagreeing with the file, and every exec of the
   * path afterwards is killed with SIGKILL (exit 137) -- permanently, not only while the first
   * process lives. That is what made the meeting recorder fail at random on an installed machine:
   * the desktop app reinstalls both helpers on every launch, while the server is already running
   * `sb-recorder --permissions` on page loads. A plain `cp` to `dest` fails this test.
   */
  it.skipIf(!haveCompiler)("leaves the destination runnable when it is reinstalled while a copy of it is running", async () => {
    const dest = path.join(dir, "bin", "tool");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // The one being replaced has to still be executing when the install lands, so it waits.
    fs.copyFileSync(buildExecutable(dir, "first", "sleep(30); return 0;"), dest);
    fs.chmodSync(dest, 0o755);
    const replacement = buildExecutable(dir, "second", 'printf("2\\n"); return 0;');

    const running = spawn(dest, [], { stdio: "ignore" });
    try {
      await new Promise((resolve) => running.once("spawn", resolve));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(install(replacement, dest)).toBe(0);
      const after = spawnSync(dest, [], { encoding: "utf8" });
      expect(after.status).toBe(0);
      expect(after.stdout.trim()).toBe("2");
    } finally {
      running.kill("SIGKILL");
    }
  });
});
