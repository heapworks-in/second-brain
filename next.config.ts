import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Tauri app runs this build directly (node .next/standalone/server.js) rather than
  // building from source on the recipient's machine -- standalone traces exactly the
  // node_modules the server needs into .next/standalone, so nothing else has to ship separately.
  output: "standalone",
  // onnxruntime-node's own .node binary links against a sibling .dylib that Next's file tracer
  // doesn't follow (it only follows require/import, not a native binary's own dynamic-linker
  // dependencies) -- without this the standalone build starts but semantic search silently fails
  // with a dlopen error the moment it's first used.
  outputFileTracingIncludes: {
    "/*": ["node_modules/onnxruntime-node/bin/**/*"],
  },
  // `db/client.ts`'s `path.join(process.cwd(), "drizzle")` is a dynamic path nft can't statically
  // resolve, so the tracer falls back to sweeping in large swaths of the project root (desktop/,
  // including its multi-GB Rust build directory; helper/, but only partially -- see below) for
  // entries that transitively import it. This config is kept because it correctly filters the
  // *.nft.json trace files themselves (verifiable after a build: grep them for "desktop/"), but
  // -- found the hard way, after it silently stopped mattering -- `next build` defaults to
  // Turbopack, and Turbopack's standalone copy step does not consult this filtered result, so it
  // is NOT sufficient by itself to keep desktop/ out of .next/standalone. The actual fix is the
  // `postbuild` hook in package.json (`scripts/postbuild.mjs`), which deletes that directory after
  // every build -- it used to be a mandatory step in desktop/README.md, and living only in a README
  // is how it came to be skipped: it ballooned a shipped release from ~120MB to over 5GB.
  //
  // `helper/` (the Swift activity tracker and meeting recorder) isn't part of the server's module
  // graph at all -- it's built and invoked by scripts/brain.sh as separate binaries -- yet the same
  // fallback picked up its .swift source files (never Package.swift, never .build). Rather than
  // depend on tracer behavior for a directory it was never meant to reason about, desktop/README.md
  // copies it explicitly and completely instead, alongside public/ and .next/static. The partial
  // copy this left behind is exactly what broke `swift build`: "could not find Package.swift".
  outputFileTracingExcludes: {
    "**": ["desktop/**", ".git/**", "helper/**"],
  },
  serverExternalPackages: [
    "better-sqlite3",
    "sqlite-vec",
    "@huggingface/transformers",
    "pdf-parse",
    "tesseract.js",
    "linkedom",
    "@mozilla/readability",
  ],
};

export default nextConfig;
