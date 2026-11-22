# Foundation: Capture and Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running local web app where notes, links, PDFs, and images can be captured, processed in the background, and found with hybrid keyword plus semantic search.

**Architecture:** One Next.js process serves the UI and API and runs an in-process job worker. SQLite holds everything: regular tables through Drizzle, an FTS5 table for keywords, and a sqlite-vec table for vectors. Providers (embedding now, chat and transcription later) sit behind small interfaces. Domain modules expose plain functions that take a database handle; routes and job handlers are thin wrappers over them.

**Tech Stack:** Next.js 16 (App Router, TypeScript), React 19, Tailwind 4, better-sqlite3 13, sqlite-vec 0.1.9, drizzle-orm 0.45 + drizzle-kit 0.31, @huggingface/transformers 4 (`Xenova/bge-small-en-v1.5`), @mozilla/readability 0.6 + linkedom, pdf-parse 2, tesseract.js 7, zod 4, vitest 5.

**Spec:** `docs/superpowers/specs/2026-09-12-second-brain-design.md` (sections 2, 3, 4, 5, 11, 13, 14 and slices 1 and 2 of section 15). Later plans cover tasks, journal, meetings, assistant, review, and install.

## Global Constraints

- Node 24 and npm 11 are installed; use npm, not pnpm or yarn.
- Port is `3141` for both `next dev` and `next start`.
- Data directory is `~/Library/Application Support/second-brain/`, overridable with the `SB_DATA_DIR` environment variable. Tests always set `SB_DATA_DIR` to a temp directory.
- Embedding model is `Xenova/bge-small-en-v1.5`, 384 dimensions, CLS pooling, normalized. The vector table is declared as `float[384] distance_metric=cosine`.
- Chunks are 375 words with 40 words of overlap (the spec's "roughly 500 tokens with 50 overlap").
- sqlite-vec rejects JavaScript numbers as rowids through better-sqlite3. Every rowid bound to `chunks_vec` must be a `BigInt`. This was verified on the installed versions.
- Item types: `note`, `link`, `file`, `meeting`, `journal`, `review`. Item statuses: `pending`, `processing`, `ready`, `failed`. Job types: `fetch_link`, `extract_pdf`, `ocr_image`, `transcribe_final`, `summarize_meeting`, `embed`, `weekly_reflect`, `backup`. Job statuses: `queued`, `running`, `done`, `failed`.
- Job retry backoff is 10 s, 60 s, 300 s; a job fails permanently after 3 attempts.
- Audio uploads are rejected with HTTP 415 in this plan. The meetings plan enables them.
- Visual direction (spec section 11): dark only, near-black ground `#0a0a0c`, layered surfaces, 1 px low-opacity borders, one cyan-blue accent `#4cc9ff`, Geist Sans for UI and Geist Mono for ids, counts, timestamps, and shortcuts. Dense layout, minimal motion (120 to 180 ms).
- Every commit message ends with the two attribution lines shown in Task 1 step 9.
- Run `npm test` before every commit. Run `npm run build` at the end of every UI task.

## File Structure

```
second-brain/
  package.json, next.config.ts, tsconfig.json, vitest.config.ts, drizzle.config.ts
  drizzle/                      generated SQL migrations (committed)
  src/
    instrumentation.ts          starts the job worker when the server boots
    server/
      boot.ts                   worker singleton
      providers.ts              embed provider singleton
    lib/
      paths.ts                  data, db, files, models, logs directories
      time.ts                   nowIso()
      files.ts                  saveFile, absoluteFilePath, kindForMime
      api.ts                    errorResponse, serializeItem
      dto.ts                    ItemDTO, SearchResultDTO shared with the client
      format.ts                 date formatting for the UI
    db/
      schema.ts                 Drizzle tables and shared enums
      search-tables.ts          FTS5 + vec0 virtual tables and triggers
      client.ts                 openDatabase, getDb
    domain/
      items/
        chunk.ts                chunkText
        index.ts                createItem, getItem, updateItem, listItems, tags, rechunkItem
        capture.ts              captureNote, captureLink, captureFile, updateItemContent
        links.ts                fetchPage, extractReadable
        extract.ts              extractPdfText, ocrImageText
      search/
        filter.ts               SearchFilter and filterSql
        fts.ts                  buildFtsQuery, ftsSearch
        vectors.ts              toBlob, upsertChunkVectors, countChunkVectors
        vector.ts               vectorSearch
        fuse.ts                 reciprocalRankFusion
        index.ts                search, makeSnippet
    providers/embed/
      types.ts                  EmbedProvider, EMBEDDING_DIMENSIONS
      transformers.ts           createTransformersEmbedProvider
      fake.ts                   createFakeEmbedProvider (tests)
    jobs/
      queue.ts                  enqueueJob, claimNextJob, completeJob, failJob, retry helpers
      worker.ts                 JobWorker
      payload.ts                jobPayload
      handlers/
        index.ts                createJobHandlers
        embed.ts, fetch-link.ts, extract-pdf.ts, ocr-image.ts
    test/
      db.ts                     makeTestDb, useTempDataDir
    components/
      sidebar.tsx, command-palette.tsx, badges.tsx, capture-box.tsx,
      recent-captures.tsx, item-editor.tsx, search-panel.tsx, library-filters.tsx
    app/
      layout.tsx, globals.css, page.tsx
      capture/page.tsx, library/page.tsx, search/page.tsx, items/[id]/page.tsx
      api/items/route.ts, api/items/[id]/route.ts, api/items/[id]/retry/route.ts,
      api/items/[id]/file/route.ts, api/upload/route.ts, api/search/route.ts
```

---

### Task 1: Project skeleton, theme, and app shell

**Files:**
- Create: `package.json`, `next.config.ts`, `vitest.config.ts`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/sidebar.tsx`, `src/components/command-palette.tsx`, `src/app/capture/page.tsx`, `src/app/library/page.tsx`, `src/app/search/page.tsx` (placeholders)
- Modify: `.gitignore`

**Interfaces:**
- Produces: the `@/` import alias mapped to `src/`, npm scripts `dev`, `build`, `start`, `test`, `db:generate`, and the Tailwind theme tokens `bg`, `surface-1`, `surface-2`, `surface-3`, `line`, `line-strong`, `fg`, `fg-muted`, `fg-faint`, `accent`, `accent-dim`, `danger`, `success`, `warn` used by every UI task.

- [ ] **Step 1: Scaffold Next.js into a sibling folder and merge it in**

The project folder already has `docs/` and `.git`, which create-next-app refuses to write into, so scaffold beside it and copy.

```bash
cd "$(git rev-parse --show-toplevel)"
npx create-next-app@latest ../second-brain-scaffold --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --yes --skip-install
rsync -a --exclude .git --exclude .gitignore ../second-brain-scaffold/ ./
cat ../second-brain-scaffold/.gitignore >> .gitignore
rm -rf ../second-brain-scaffold
```

- [ ] **Step 2: Install dependencies**

```bash
npm install
npm install better-sqlite3 sqlite-vec drizzle-orm @huggingface/transformers @mozilla/readability linkedom pdf-parse tesseract.js zod
npm install -D drizzle-kit vitest @types/better-sqlite3
```

- [ ] **Step 3: Set npm scripts**

Edit `package.json` so the `scripts` block is exactly:

```json
"scripts": {
  "dev": "next dev -p 3141",
  "build": "next build",
  "start": "next start -p 3141",
  "lint": "eslint",
  "test": "vitest run",
  "db:generate": "drizzle-kit generate"
}
```

- [ ] **Step 4: Configure Next.js for native packages**

Replace `next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
```

- [ ] **Step 5: Configure Vitest**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
```

Run: `npx vitest run --passWithNoTests`
Expected: exits 0 with "No test files found".

- [ ] **Step 6: Write the theme**

Replace `src/app/globals.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg: #0a0a0c;
  --color-surface-1: #111114;
  --color-surface-2: #17171b;
  --color-surface-3: #1e1e23;
  --color-line: rgba(255, 255, 255, 0.08);
  --color-line-strong: rgba(255, 255, 255, 0.14);
  --color-fg: #ededf0;
  --color-fg-muted: #8b8b94;
  --color-fg-faint: #5c5c66;
  --color-accent: #4cc9ff;
  --color-accent-dim: rgba(76, 201, 255, 0.15);
  --color-danger: #ff5c6c;
  --color-success: #52d38a;
  --color-warn: #f5c451;

  --font-sans: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), ui-monospace, "SF Mono", Menlo, monospace;

  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
}

:root {
  color-scheme: dark;
}

body {
  background: var(--color-bg);
  color: var(--color-fg);
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  font-size: 14px;
}

* {
  border-color: var(--color-line);
}

::selection {
  background: var(--color-accent-dim);
}

input,
textarea,
select,
button {
  font: inherit;
  color: inherit;
}

input::placeholder,
textarea::placeholder {
  color: var(--color-fg-faint);
}

:focus-visible {
  outline: 1px solid var(--color-accent);
  outline-offset: 1px;
}

@keyframes pulse-accent {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}

.live-dot {
  animation: pulse-accent 1.4s ease-in-out infinite;
}

.kbd {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--color-fg-faint);
  border: 1px solid var(--color-line-strong);
  border-radius: 4px;
  padding: 1px 5px;
  line-height: 1.4;
}
```

- [ ] **Step 7: Write the layout, sidebar, command palette, and placeholder pages**

Replace `src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Second Brain",
  description: "Personal capture, search, tasks, and meetings.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="min-h-screen flex bg-bg text-fg">
        <Sidebar />
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
        <CommandPalette />
      </body>
    </html>
  );
}
```

Create `src/components/sidebar.tsx`:

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  shortcut: string;
  enabled: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/today", label: "Today", shortcut: "g t", enabled: false },
  { href: "/capture", label: "Capture", shortcut: "g c", enabled: true },
  { href: "/library", label: "Library", shortcut: "g l", enabled: true },
  { href: "/search", label: "Search", shortcut: "g s", enabled: true },
  { href: "/chat", label: "Chat", shortcut: "g a", enabled: false },
  { href: "/journal", label: "Journal", shortcut: "g j", enabled: false },
  { href: "/review", label: "Review", shortcut: "g r", enabled: false },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="w-56 shrink-0 border-r border-line bg-surface-1 flex flex-col">
      <div className="h-12 flex items-center px-4 border-b border-line">
        <span className="w-2 h-2 rounded-full bg-accent mr-2" />
        <span className="font-medium tracking-tight">Second Brain</span>
      </div>
      <nav className="flex-1 py-2">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const base = "flex items-center justify-between px-4 h-8 text-[13px] transition-colors duration-150";
          if (!item.enabled) {
            return (
              <div key={item.href} className={`${base} text-fg-faint cursor-default`} aria-disabled>
                <span>{item.label}</span>
                <span className="font-mono text-[10px] uppercase tracking-wider">soon</span>
              </div>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`${base} ${active ? "text-fg bg-surface-3 border-l-2 border-accent pl-[14px]" : "text-fg-muted hover:text-fg hover:bg-surface-2"}`}
            >
              <span>{item.label}</span>
              <span className="kbd">{item.shortcut}</span>
            </Link>
          );
        })}
      </nav>
      <div className="px-4 py-3 border-t border-line text-[11px] text-fg-faint font-mono flex items-center justify-between">
        <span>localhost:3141</span>
        <span className="kbd">⌘K</span>
      </div>
    </aside>
  );
}
```

Create `src/components/command-palette.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { NAV_ITEMS } from "./sidebar";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(
    () =>
      NAV_ITEMS.filter((n) => n.enabled).map((n) => ({
        id: n.href,
        label: `Go to ${n.label}`,
        hint: n.shortcut,
        run: () => router.push(n.href),
      })),
    [router],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setIndex(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  function choose(c: Command) {
    setOpen(false);
    c.run();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center pt-[18vh]" onClick={() => setOpen(false)}>
      <div
        className="w-[520px] max-w-[92vw] bg-surface-2 border border-line-strong rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter" && filtered[index]) {
              choose(filtered[index]);
            }
          }}
          placeholder="Type a command"
          className="w-full h-11 px-4 bg-transparent border-b border-line outline-none"
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {filtered.length === 0 && <li className="px-4 py-2 text-fg-faint">No matches</li>}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(c)}
              className={`px-4 h-9 flex items-center justify-between cursor-pointer ${i === index ? "bg-surface-3 text-fg" : "text-fg-muted"}`}
            >
              <span>{c.label}</span>
              {c.hint && <span className="kbd">{c.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

Replace `src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/capture");
}
```

Create three placeholder pages with the same shape. `src/app/capture/page.tsx`:

```tsx
export default function CapturePage() {
  return <div className="p-6 text-fg-muted">Capture arrives in Task 12.</div>;
}
```

`src/app/library/page.tsx`:

```tsx
export default function LibraryPage() {
  return <div className="p-6 text-fg-muted">Library arrives in Task 13.</div>;
}
```

`src/app/search/page.tsx`:

```tsx
export default function SearchPage() {
  return <div className="p-6 text-fg-muted">Search arrives in Task 14.</div>;
}
```

Delete `public/*.svg` files created by the scaffold and any `src/app/page.module.css` if present.

- [ ] **Step 8: Verify the build and the dev server**

Run: `npm run build`
Expected: "Compiled successfully", no type errors.

Run: `npm run dev &` then `sleep 8 && curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3141/capture` then kill the dev server (`kill %1`).
Expected: `200`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: project skeleton, dark theme, sidebar and command palette

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 2: Paths, schema, migrations, and database client

**Files:**
- Create: `src/lib/paths.ts`, `src/lib/time.ts`, `src/db/enums.ts`, `src/db/schema.ts`, `src/db/search-tables.ts`, `src/db/client.ts`, `drizzle.config.ts`, `src/test/db.ts`
- Test: `src/db/client.test.ts`

**Interfaces:**
- Produces: `dataDir()`, `dbPath()`, `filesDir()`, `modelsDir()`, `logsDir()` from `@/lib/paths`; `nowIso()` from `@/lib/time`; enum arrays `ITEM_TYPES`, `ITEM_STATUSES`, `JOB_TYPES`, `JOB_STATUSES` and types `ItemType`, `ItemStatus`, `JobType`, `JobStatus` from `@/db/enums` (no Drizzle imports, safe for client components) and re-exported from `@/db/schema`; tables `items`, `tags`, `itemTags`, `chunks`, `jobs`, `settings` and types `Item`, `Chunk`, `Job` from `@/db/schema`; `openDatabase(file): DB`, `getDb(): DB`, type `DB` from `@/db/client`; `makeTestDb()` and `useTempDataDir()` from `@/test/db`.

- [ ] **Step 1: Write paths and time helpers**

Create `src/lib/paths.ts`:

```ts
import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  return process.env.SB_DATA_DIR ?? path.join(os.homedir(), "Library", "Application Support", "second-brain");
}

export function dbPath(): string {
  return path.join(dataDir(), "brain.db");
}

export function filesDir(): string {
  return path.join(dataDir(), "files");
}

export function modelsDir(): string {
  return path.join(dataDir(), "models");
}

export function logsDir(): string {
  return path.join(dataDir(), "logs");
}
```

Create `src/lib/time.ts`:

```ts
export function nowIso(): string {
  return new Date().toISOString();
}
```

- [ ] **Step 2: Write the enums and the Drizzle schema**

Create `src/db/enums.ts`. It has no Drizzle imports so client components can use the arrays.

```ts
export const ITEM_TYPES = ["note", "link", "file", "meeting", "journal", "review"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const ITEM_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const JOB_TYPES = [
  "fetch_link",
  "extract_pdf",
  "ocr_image",
  "transcribe_final",
  "summarize_meeting",
  "embed",
  "weekly_reflect",
  "backup",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
```

Create `src/db/schema.ts`:

```ts
import { sqliteTable, integer, text, primaryKey, index } from "drizzle-orm/sqlite-core";
import { ITEM_TYPES, ITEM_STATUSES, JOB_TYPES, JOB_STATUSES } from "./enums";

export { ITEM_TYPES, ITEM_STATUSES, JOB_TYPES, JOB_STATUSES } from "./enums";
export type { ItemType, ItemStatus, JobType, JobStatus } from "./enums";

export const items = sqliteTable(
  "items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: ITEM_TYPES }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    status: text("status", { enum: ITEM_STATUSES }).notNull().default("pending"),
    error: text("error"),
    sourceUrl: text("source_url"),
    filePath: text("file_path"),
    mimeType: text("mime_type"),
    extractedText: text("extracted_text").notNull().default(""),
    meta: text("meta").notNull().default("{}"),
    journalDate: text("journal_date").unique(),
    reviewWeek: text("review_week").unique(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("items_type_idx").on(t.type), index("items_created_idx").on(t.createdAt)],
);

export const tags = sqliteTable("tags", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
});

export const itemTags = sqliteTable(
  "item_tags",
  {
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.itemId, t.tagId] })],
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: integer("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
  },
  (t) => [index("chunks_item_idx").on(t.itemId)],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type", { enum: JOB_TYPES }).notNull(),
    payload: text("payload").notNull().default("{}"),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    runAfter: text("run_after").notNull(),
    itemId: integer("item_id").references(() => items.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("jobs_status_run_idx").on(t.status, t.runAfter)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type Chunk = typeof chunks.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Tag = typeof tags.$inferSelect;
```

- [ ] **Step 3: Generate the first migration**

Create `drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
```

Run: `npm run db:generate`
Expected: a file `drizzle/0000_*.sql` containing `CREATE TABLE \`items\`` and a `drizzle/meta/` folder. Both are committed.

- [ ] **Step 4: Write the search tables SQL**

Create `src/db/search-tables.ts`:

```ts
import type Database from "better-sqlite3";
import { EMBEDDING_DIMENSIONS } from "@/providers/embed/types";

export const SEARCH_TABLES_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id');

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${EMBEDDING_DIMENSIONS}] distance_metric=cosine);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  DELETE FROM chunks_vec WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

export function ensureSearchTables(sqlite: Database.Database): void {
  sqlite.exec(SEARCH_TABLES_SQL);
}
```

Create `src/providers/embed/types.ts` now, since the SQL needs the dimension constant:

```ts
export const EMBEDDING_DIMENSIONS = 384;

export interface EmbedProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

- [ ] **Step 5: Write the failing client test**

Create `src/test/db.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, type DB } from "@/db/client";

export interface TestDb {
  db: DB;
  dir: string;
  cleanup: () => void;
}

/** Point SB_DATA_DIR at a fresh temp directory and clear the singleton database. */
export function useTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"));
  process.env.SB_DATA_DIR = dir;
  const g = globalThis as unknown as { __sbDb?: unknown };
  delete g.__sbDb;
  return dir;
}

export function makeTestDb(): TestDb {
  const dir = useTempDataDir();
  const db = openDatabase(path.join(dir, "test.db"));
  return {
    db,
    dir,
    cleanup: () => {
      db.$client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
```

Create `src/db/client.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";

describe("openDatabase", () => {
  let t: TestDb;
  afterEach(() => t?.cleanup());

  it("creates regular tables, virtual tables, and loads sqlite-vec", () => {
    t = makeTestDb();
    const names = t.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const expected of ["items", "tags", "item_tags", "chunks", "jobs", "settings", "chunks_fts", "chunks_vec"]) {
      expect(names).toContain(expected);
    }
    const v = t.db.$client.prepare("SELECT vec_version() AS v").get() as { v: string };
    expect(v.v).toMatch(/^v\d/);
  });

  it("keeps chunks_fts in sync through triggers", () => {
    t = makeTestDb();
    const now = new Date().toISOString();
    t.db.$client
      .prepare("INSERT INTO items (type, title, created_at, updated_at) VALUES ('note', 'T', ?, ?)")
      .run(now, now);
    t.db.$client.prepare("INSERT INTO chunks (item_id, ordinal, text) VALUES (1, 0, 'quantum gardening tips')").run();
    const hit = t.db.$client.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'gardening'").all();
    expect(hit).toHaveLength(1);
    t.db.$client.prepare("DELETE FROM chunks WHERE id = 1").run();
    const gone = t.db.$client.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'gardening'").all();
    expect(gone).toHaveLength(0);
  });

  it("is idempotent when opened twice on the same file", async () => {
    t = makeTestDb();
    const { openDatabase } = await import("@/db/client");
    const again = openDatabase(t.db.$client.name);
    expect(again.$client.prepare("SELECT count(*) AS c FROM items").get()).toEqual({ c: 0 });
    again.$client.close();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run src/db/client.test.ts`
Expected: FAIL, cannot resolve `@/db/client`.

- [ ] **Step 7: Write the database client**

Create `src/db/client.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";
import { ensureSearchTables } from "./search-tables";
import { dbPath } from "@/lib/paths";

function createDrizzle(sqlite: Database.Database) {
  return drizzle(sqlite, { schema });
}

export type DB = ReturnType<typeof createDrizzle>;

export function openDatabase(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqliteVec.load(sqlite);
  const db = createDrizzle(sqlite);
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  ensureSearchTables(sqlite);
  return db;
}

const g = globalThis as unknown as { __sbDb?: DB };

export function getDb(): DB {
  if (!g.__sbDb) g.__sbDb = openDatabase(dbPath());
  return g.__sbDb;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/db/client.test.ts`
Expected: 3 passed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: sqlite schema, migrations, search tables, and db client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 3: Text chunking

**Files:**
- Create: `src/domain/items/chunk.ts`
- Test: `src/domain/items/chunk.test.ts`

**Interfaces:**
- Produces: `chunkText(text: string, opts?: ChunkOptions): string[]` and `DEFAULT_CHUNK_OPTIONS = { maxWords: 375, overlapWords: 40 }`.

- [ ] **Step 1: Write the failing tests**

Create `src/domain/items/chunk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chunkText, DEFAULT_CHUNK_OPTIONS } from "./chunk";

const words = (n: number, prefix = "w") => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");

describe("chunkText", () => {
  it("returns nothing for empty or whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n  ")).toEqual([]);
  });

  it("normalizes whitespace inside a short paragraph", () => {
    expect(chunkText("hello   world\n  again")).toEqual(["hello world again"]);
  });

  it("packs small paragraphs into one chunk", () => {
    expect(chunkText("one two\n\nthree four")).toEqual(["one two three four"]);
  });

  it("splits a long paragraph into overlapping windows", () => {
    const text = words(1000);
    const out = chunkText(text);
    expect(out).toHaveLength(3);
    const first = out[0].split(" ");
    const second = out[1].split(" ");
    expect(first).toHaveLength(375);
    expect(second.slice(0, 40)).toEqual(first.slice(335));
    expect(second[40]).toBe("w375");
    for (const c of out) {
      expect(c.split(" ").length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxWords + DEFAULT_CHUNK_OPTIONS.overlapWords);
    }
  });

  it("starts a new chunk when the next paragraph does not fit", () => {
    const text = `${words(300, "a")}\n\n${words(300, "b")}`;
    const out = chunkText(text);
    expect(out).toHaveLength(2);
    expect(out[0].split(" ")).toHaveLength(300);
    expect(out[1].split(" ").slice(40)[0]).toBe("b0");
  });

  it("honours custom options", () => {
    const out = chunkText(words(10), { maxWords: 4, overlapWords: 1 });
    expect(out).toEqual(["w0 w1 w2 w3", "w3 w4 w5 w6 w7", "w7 w8 w9"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/items/chunk.test.ts`
Expected: FAIL, cannot resolve `./chunk`.

- [ ] **Step 3: Implement chunking**

Create `src/domain/items/chunk.ts`:

```ts
export interface ChunkOptions {
  maxWords: number;
  overlapWords: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxWords: 375, overlapWords: 40 };

/**
 * Split text into word windows. Paragraphs are packed together until maxWords,
 * oversize paragraphs are cut into maxWords slices, and every chunk after the
 * first is prefixed with the last overlapWords words of the previous chunk.
 */
export function chunkText(text: string, opts: ChunkOptions = DEFAULT_CHUNK_OPTIONS): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

  const base: string[][] = [];
  let current: string[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.split(" ");
    if (words.length > opts.maxWords) {
      if (current.length) {
        base.push(current);
        current = [];
      }
      for (let i = 0; i < words.length; i += opts.maxWords) {
        base.push(words.slice(i, i + opts.maxWords));
      }
      continue;
    }
    if (current.length + words.length > opts.maxWords) {
      base.push(current);
      current = [];
    }
    current = current.concat(words);
  }
  if (current.length) base.push(current);

  return base.map((words, i) => {
    if (i === 0) return words.join(" ");
    const prev = base[i - 1];
    const overlap = prev.slice(Math.max(0, prev.length - opts.overlapWords));
    return [...overlap, ...words].join(" ");
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/items/chunk.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: word-window text chunking with overlap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 4: Items domain

**Files:**
- Create: `src/domain/items/index.ts`
- Test: `src/domain/items/index.test.ts`

**Interfaces:**
- Consumes: `DB` from `@/db/client`; `items`, `tags`, `itemTags`, `chunks` from `@/db/schema`; `chunkText` from `./chunk`; `nowIso` from `@/lib/time`.
- Produces:
  - `createItem(db, input: CreateItemInput): Item`
  - `getItem(db, id: number): Item | undefined`
  - `updateItem(db, id: number, patch: UpdateItemInput): Item`
  - `mergeItemMeta(db, id: number, patch: Record<string, unknown>): Item`
  - `parseMeta<T = Record<string, unknown>>(item: Item): T`
  - `listItems(db, filter?: ListItemsFilter): Item[]`
  - `deleteItem(db, id: number): void`
  - `setItemTags(db, id: number, names: string[]): void`, `getItemTags(db, id: number): string[]`, `listTagNames(db): string[]`
  - `rechunkItem(db, id: number): number`, `getItemChunks(db, id: number): Chunk[]`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/items/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import {
  createItem,
  getItem,
  updateItem,
  mergeItemMeta,
  parseMeta,
  listItems,
  deleteItem,
  setItemTags,
  getItemTags,
  listTagNames,
  rechunkItem,
  getItemChunks,
} from "./index";

describe("items domain", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("creates and reads an item with defaults", () => {
    const item = createItem(t.db, { type: "note", title: "Hello", body: "Body text" });
    expect(item.id).toBeGreaterThan(0);
    expect(item.status).toBe("pending");
    expect(item.extractedText).toBe("");
    expect(parseMeta(item)).toEqual({});
    expect(getItem(t.db, item.id)?.title).toBe("Hello");
    expect(getItem(t.db, 9999)).toBeUndefined();
  });

  it("updates fields and merges meta", () => {
    const item = createItem(t.db, { type: "link", title: "x", sourceUrl: "https://a.test", meta: { a: 1 } });
    const updated = updateItem(t.db, item.id, { title: "y", status: "ready", extractedText: "text" });
    expect(updated.title).toBe("y");
    expect(updated.status).toBe("ready");
    expect(updated.extractedText).toBe("text");
    expect(updated.updatedAt >= item.updatedAt).toBe(true);
    const merged = mergeItemMeta(t.db, item.id, { b: 2 });
    expect(parseMeta(merged)).toEqual({ a: 1, b: 2 });
    expect(() => updateItem(t.db, 9999, { title: "z" })).toThrow(/not found/);
  });

  it("lists newest first with type, status, and tag filters", () => {
    const a = createItem(t.db, { type: "note", title: "a" });
    const b = createItem(t.db, { type: "link", title: "b", sourceUrl: "https://b.test" });
    const c = createItem(t.db, { type: "note", title: "c", status: "ready" });
    setItemTags(t.db, a.id, ["Work"]);
    setItemTags(t.db, c.id, ["work", "idea"]);

    expect(listItems(t.db).map((i) => i.id)).toEqual([c.id, b.id, a.id]);
    expect(listItems(t.db, { type: "note" }).map((i) => i.id)).toEqual([c.id, a.id]);
    expect(listItems(t.db, { status: "ready" }).map((i) => i.id)).toEqual([c.id]);
    expect(listItems(t.db, { tag: "work" }).map((i) => i.id)).toEqual([c.id, a.id]);
    expect(listItems(t.db, { tag: "idea" }).map((i) => i.id)).toEqual([c.id]);
    expect(listItems(t.db, { tag: "nothing" })).toEqual([]);
    expect(listItems(t.db, { limit: 1, offset: 1 }).map((i) => i.id)).toEqual([b.id]);
  });

  it("normalizes, replaces, and lists tags", () => {
    const item = createItem(t.db, { type: "note", title: "t" });
    setItemTags(t.db, item.id, ["  Work ", "work", "Idea", ""]);
    expect(getItemTags(t.db, item.id)).toEqual(["idea", "work"]);
    setItemTags(t.db, item.id, ["other"]);
    expect(getItemTags(t.db, item.id)).toEqual(["other"]);
    expect(listTagNames(t.db)).toEqual(["idea", "other", "work"]);
  });

  it("rechunks title, body, and extracted text into searchable chunks", () => {
    const item = createItem(t.db, { type: "note", title: "Gardening", body: "Tomatoes need sun." });
    expect(rechunkItem(t.db, item.id)).toBe(1);
    expect(getItemChunks(t.db, item.id)[0].text).toBe("Gardening Tomatoes need sun.");
    const hit = t.db.$client.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'tomatoes'").all();
    expect(hit).toHaveLength(1);

    updateItem(t.db, item.id, { extractedText: Array.from({ length: 800 }, (_, i) => `word${i}`).join(" ") });
    // "Gardening" + "Tomatoes need sun." pack into one 4-word chunk, then 800 words become 375 + 375 + 50.
    expect(rechunkItem(t.db, item.id)).toBe(4);
    expect(getItemChunks(t.db, item.id).map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
    expect(t.db.$client.prepare("SELECT count(*) AS c FROM chunks").get()).toEqual({ c: 4 });

    updateItem(t.db, item.id, { body: "", extractedText: "", title: "" });
    expect(rechunkItem(t.db, item.id)).toBe(0);
    expect(() => rechunkItem(t.db, 9999)).toThrow(/not found/);
  });

  it("deletes an item and cascades chunks, fts rows, and tags", () => {
    const item = createItem(t.db, { type: "note", title: "Bye", body: "farewell text" });
    setItemTags(t.db, item.id, ["x"]);
    rechunkItem(t.db, item.id);
    deleteItem(t.db, item.id);
    expect(getItem(t.db, item.id)).toBeUndefined();
    expect(t.db.$client.prepare("SELECT count(*) AS c FROM chunks").get()).toEqual({ c: 0 });
    expect(t.db.$client.prepare("SELECT count(*) AS c FROM item_tags").get()).toEqual({ c: 0 });
    expect(t.db.$client.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'farewell'").all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/items/index.test.ts`
Expected: FAIL, cannot resolve `./index`.

- [ ] **Step 3: Implement the items domain**

Create `src/domain/items/index.ts`:

```ts
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, tags, itemTags, chunks, type Item, type Chunk, type ItemType, type ItemStatus } from "@/db/schema";
import { nowIso } from "@/lib/time";
import { chunkText } from "./chunk";

export interface CreateItemInput {
  type: ItemType;
  title: string;
  body?: string;
  sourceUrl?: string;
  filePath?: string;
  mimeType?: string;
  meta?: Record<string, unknown>;
  status?: ItemStatus;
  journalDate?: string;
  reviewWeek?: string;
}

export interface UpdateItemInput {
  title?: string;
  body?: string;
  extractedText?: string;
  status?: ItemStatus;
  error?: string | null;
  meta?: Record<string, unknown>;
  sourceUrl?: string | null;
  filePath?: string | null;
  mimeType?: string | null;
}

export interface ListItemsFilter {
  type?: ItemType;
  status?: ItemStatus;
  tag?: string;
  limit?: number;
  offset?: number;
}

export function createItem(db: DB, input: CreateItemInput): Item {
  const now = nowIso();
  const row = db
    .insert(items)
    .values({
      type: input.type,
      title: input.title,
      body: input.body ?? "",
      status: input.status ?? "pending",
      sourceUrl: input.sourceUrl ?? null,
      filePath: input.filePath ?? null,
      mimeType: input.mimeType ?? null,
      meta: JSON.stringify(input.meta ?? {}),
      journalDate: input.journalDate ?? null,
      reviewWeek: input.reviewWeek ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export function getItem(db: DB, id: number): Item | undefined {
  return db.select().from(items).where(eq(items.id, id)).get();
}

export function parseMeta<T = Record<string, unknown>>(item: Item): T {
  try {
    return JSON.parse(item.meta) as T;
  } catch {
    return {} as T;
  }
}

export function updateItem(db: DB, id: number, patch: UpdateItemInput): Item {
  const set: Partial<typeof items.$inferInsert> = { updatedAt: nowIso() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.body !== undefined) set.body = patch.body;
  if (patch.extractedText !== undefined) set.extractedText = patch.extractedText;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.meta !== undefined) set.meta = JSON.stringify(patch.meta);
  if (patch.sourceUrl !== undefined) set.sourceUrl = patch.sourceUrl;
  if (patch.filePath !== undefined) set.filePath = patch.filePath;
  if (patch.mimeType !== undefined) set.mimeType = patch.mimeType;
  const row = db.update(items).set(set).where(eq(items.id, id)).returning().get();
  if (!row) throw new Error(`Item ${id} not found`);
  return row;
}

export function mergeItemMeta(db: DB, id: number, patch: Record<string, unknown>): Item {
  const item = getItem(db, id);
  if (!item) throw new Error(`Item ${id} not found`);
  return updateItem(db, id, { meta: { ...parseMeta(item), ...patch } });
}

export function listItems(db: DB, filter: ListItemsFilter = {}): Item[] {
  const conds = [];
  if (filter.type) conds.push(eq(items.type, filter.type));
  if (filter.status) conds.push(eq(items.status, filter.status));
  if (filter.tag) {
    const ids = itemIdsWithTag(db, filter.tag);
    if (ids.length === 0) return [];
    conds.push(inArray(items.id, ids));
  }
  return db
    .select()
    .from(items)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(items.createdAt), desc(items.id))
    .limit(filter.limit ?? 100)
    .offset(filter.offset ?? 0)
    .all();
}

export function deleteItem(db: DB, id: number): void {
  db.transaction((tx) => {
    tx.delete(chunks).where(eq(chunks.itemId, id)).run();
    tx.delete(items).where(eq(items.id, id)).run();
  });
}

function normalizeTagNames(names: string[]): string[] {
  const set = new Set<string>();
  for (const n of names) {
    const name = n.trim().toLowerCase();
    if (name) set.add(name);
  }
  return [...set].sort();
}

export function setItemTags(db: DB, id: number, names: string[]): void {
  const normalized = normalizeTagNames(names);
  db.transaction((tx) => {
    tx.delete(itemTags).where(eq(itemTags.itemId, id)).run();
    for (const name of normalized) {
      tx.insert(tags).values({ name }).onConflictDoNothing().run();
      const tag = tx.select().from(tags).where(eq(tags.name, name)).get();
      if (!tag) throw new Error(`Tag ${name} missing after insert`);
      tx.insert(itemTags).values({ itemId: id, tagId: tag.id }).run();
    }
  });
}

export function getItemTags(db: DB, id: number): string[] {
  return db
    .select({ name: tags.name })
    .from(itemTags)
    .innerJoin(tags, eq(tags.id, itemTags.tagId))
    .where(eq(itemTags.itemId, id))
    .orderBy(asc(tags.name))
    .all()
    .map((r) => r.name);
}

export function listTagNames(db: DB): string[] {
  return db.select({ name: tags.name }).from(tags).orderBy(asc(tags.name)).all().map((r) => r.name);
}

function itemIdsWithTag(db: DB, name: string): number[] {
  return db
    .select({ itemId: itemTags.itemId })
    .from(itemTags)
    .innerJoin(tags, eq(tags.id, itemTags.tagId))
    .where(eq(tags.name, name.trim().toLowerCase()))
    .all()
    .map((r) => r.itemId);
}

/** Rebuild the chunks for an item from title, body, and extracted text. Returns the chunk count. */
export function rechunkItem(db: DB, id: number): number {
  const item = getItem(db, id);
  if (!item) throw new Error(`Item ${id} not found`);
  const text = [item.title, item.body, item.extractedText].filter((s) => s.trim().length > 0).join("\n\n");
  const parts = chunkText(text);
  db.transaction((tx) => {
    tx.delete(chunks).where(eq(chunks.itemId, id)).run();
    if (parts.length) {
      tx.insert(chunks)
        .values(parts.map((text, ordinal) => ({ itemId: id, ordinal, text })))
        .run();
    }
  });
  return parts.length;
}

export function getItemChunks(db: DB, id: number): Chunk[] {
  return db.select().from(chunks).where(eq(chunks.itemId, id)).orderBy(asc(chunks.ordinal)).all();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/domain/items/index.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: items domain with tags and chunking

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 5: Job queue, worker, and server boot

**Files:**
- Create: `src/jobs/queue.ts`, `src/jobs/payload.ts`, `src/jobs/worker.ts`, `src/jobs/handlers/index.ts`, `src/server/boot.ts`, `src/instrumentation.ts`
- Test: `src/jobs/queue.test.ts`, `src/jobs/worker.test.ts`

**Interfaces:**
- Consumes: `DB`, `jobs`, `items`, `Job`, `JobType` from the schema; `updateItem` from `@/domain/items`.
- Produces:
  - `enqueueJob(db, type: JobType, payload?: Record<string, unknown>, itemId?: number): Job`
  - `claimNextJob(db, now?: Date, allowedTypes?: JobType[]): Job | undefined`
  - `completeJob(db, id: number, now?: Date): void`
  - `failJob(db, id: number, error: string, now?: Date): Job`
  - `retryJob(db, id: number, now?: Date): Job`, `retryFailedJobsForItem(db, itemId: number, now?: Date): number`
  - `resetRunningJobs(db, now?: Date): number`, `listJobs(db, filter: { itemId?: number; status?: JobStatus }): Job[]`
  - `jobPayload<T>(job: Job): T`
  - `type JobHandler = (job: Job) => Promise<void>`, `type JobHandlers = Partial<Record<JobType, JobHandler>>`
  - `class JobWorker { constructor(db, handlers, opts?); runOnce(now?): Promise<boolean>; start(); stop(); restrictTo(types?: JobType[]) }`
  - `createJobHandlers(deps: HandlerDeps): JobHandlers` (empty in this task, filled by Tasks 6, 8, 9, 10)
  - `boot(): JobWorker`, `getWorker(): JobWorker | undefined`
  - Constants `BACKOFF_MS = [10_000, 60_000, 300_000]`, `MAX_ATTEMPTS = 3`.

- [ ] **Step 1: Write the failing queue tests**

Create `src/jobs/queue.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, getItem } from "@/domain/items";
import {
  enqueueJob,
  claimNextJob,
  completeJob,
  failJob,
  retryJob,
  retryFailedJobsForItem,
  resetRunningJobs,
  listJobs,
  BACKOFF_MS,
} from "./queue";
import { jobPayload } from "./payload";

// Fixed past date for backoff arithmetic; claims use real time so run_after (set to "now" on enqueue) is reachable.
const T0 = new Date("2026-01-01T00:00:00.000Z");
const plus = (ms: number) => new Date(Date.now() + ms);

describe("job queue", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("enqueues and claims oldest first, marking it running", () => {
    const a = enqueueJob(t.db, "embed", { itemId: 1 });
    const b = enqueueJob(t.db, "fetch_link", { itemId: 2 });
    expect(a.status).toBe("queued");
    expect(jobPayload<{ itemId: number }>(a).itemId).toBe(1);
    const claimed = claimNextJob(t.db, plus(1000));
    expect(claimed?.id).toBe(a.id);
    expect(claimed?.status).toBe("running");
    expect(claimNextJob(t.db, plus(1000))?.id).toBe(b.id);
    expect(claimNextJob(t.db, plus(1000))).toBeUndefined();
  });

  it("respects run_after and allowed types", () => {
    const job = enqueueJob(t.db, "embed", {});
    expect(claimNextJob(t.db, new Date(new Date(job.runAfter).getTime() - 1))).toBeUndefined();
    enqueueJob(t.db, "fetch_link", {});
    const claimed = claimNextJob(t.db, plus(60_000), ["fetch_link"]);
    expect(claimed?.type).toBe("fetch_link");
  });

  it("completes a job", () => {
    const job = enqueueJob(t.db, "embed", {});
    claimNextJob(t.db, plus(1));
    completeJob(t.db, job.id, plus(2));
    expect(listJobs(t.db, { status: "done" }).map((j) => j.id)).toEqual([job.id]);
  });

  it("requeues with backoff, then fails permanently and marks the item", () => {
    const item = createItem(t.db, { type: "note", title: "n" });
    const job = enqueueJob(t.db, "embed", { itemId: item.id }, item.id);

    claimNextJob(t.db, plus(1));
    const first = failJob(t.db, job.id, "boom 1", T0);
    expect(first.status).toBe("queued");
    expect(first.attempts).toBe(1);
    expect(new Date(first.runAfter).getTime()).toBe(T0.getTime() + BACKOFF_MS[0]);
    expect(getItem(t.db, item.id)?.error).toBe("boom 1");
    expect(getItem(t.db, item.id)?.status).toBe("pending");

    claimNextJob(t.db, plus(1));
    const second = failJob(t.db, job.id, "boom 2", T0);
    expect(second.status).toBe("queued");
    expect(new Date(second.runAfter).getTime()).toBe(T0.getTime() + BACKOFF_MS[1]);

    claimNextJob(t.db, plus(1));
    const third = failJob(t.db, job.id, "boom 3", T0);
    expect(third.status).toBe("failed");
    expect(third.attempts).toBe(3);
    expect(getItem(t.db, item.id)?.status).toBe("failed");
    expect(getItem(t.db, item.id)?.error).toBe("boom 3");
  });

  it("retries a failed job and clears the item error", () => {
    const item = createItem(t.db, { type: "note", title: "n" });
    const job = enqueueJob(t.db, "embed", { itemId: item.id }, item.id);
    for (let i = 0; i < 3; i++) {
      claimNextJob(t.db, plus(1));
      failJob(t.db, job.id, "x", T0);
    }
    expect(retryFailedJobsForItem(t.db, item.id, plus(1))).toBe(1);
    const again = listJobs(t.db, { itemId: item.id })[0];
    expect(again.status).toBe("queued");
    expect(again.attempts).toBe(0);
    expect(again.error).toBeNull();
    expect(getItem(t.db, item.id)?.status).toBe("pending");
    expect(getItem(t.db, item.id)?.error).toBeNull();
    const single = retryJob(t.db, job.id, plus(2));
    expect(single.status).toBe("queued");
  });

  it("resets jobs left running by a crashed process", () => {
    enqueueJob(t.db, "embed", {});
    claimNextJob(t.db, plus(1));
    expect(resetRunningJobs(t.db, plus(2))).toBe(1);
    expect(listJobs(t.db, { status: "queued" })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/jobs/queue.test.ts`
Expected: FAIL, cannot resolve `./queue`.

- [ ] **Step 3: Implement payload helper and queue**

Create `src/jobs/payload.ts`:

```ts
import type { Job } from "@/db/schema";

export function jobPayload<T = Record<string, unknown>>(job: Job): T {
  try {
    return JSON.parse(job.payload) as T;
  } catch {
    return {} as T;
  }
}
```

Create `src/jobs/queue.ts`:

```ts
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { DB } from "@/db/client";
import { jobs, type Job, type JobType, type JobStatus } from "@/db/schema";
import { updateItem } from "@/domain/items";

export const BACKOFF_MS = [10_000, 60_000, 300_000] as const;
export const MAX_ATTEMPTS = 3;

export function enqueueJob(db: DB, type: JobType, payload: Record<string, unknown> = {}, itemId?: number): Job {
  const now = new Date().toISOString();
  const row = db
    .insert(jobs)
    .values({
      type,
      payload: JSON.stringify(payload),
      status: "queued",
      attempts: 0,
      runAfter: now,
      itemId: itemId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  if (!row) throw new Error("Insert returned no row");
  return row;
}

export function claimNextJob(db: DB, now: Date = new Date(), allowedTypes?: JobType[]): Job | undefined {
  const iso = now.toISOString();
  return db.transaction((tx) => {
    const conds = [eq(jobs.status, "queued"), lte(jobs.runAfter, iso)];
    if (allowedTypes) {
      if (allowedTypes.length === 0) return undefined;
      conds.push(inArray(jobs.type, allowedTypes));
    }
    const next = tx
      .select()
      .from(jobs)
      .where(and(...conds))
      .orderBy(asc(jobs.runAfter), asc(jobs.id))
      .limit(1)
      .get();
    if (!next) return undefined;
    return tx.update(jobs).set({ status: "running", updatedAt: iso }).where(eq(jobs.id, next.id)).returning().get();
  });
}

function getJob(db: DB, id: number): Job {
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new Error(`Job ${id} not found`);
  return job;
}

export function completeJob(db: DB, id: number, now: Date = new Date()): void {
  db.update(jobs).set({ status: "done", error: null, updatedAt: now.toISOString() }).where(eq(jobs.id, id)).run();
}

export function failJob(db: DB, id: number, error: string, now: Date = new Date()): Job {
  const job = getJob(db, id);
  const attempts = job.attempts + 1;
  const permanent = attempts >= MAX_ATTEMPTS;
  const runAfter = permanent ? job.runAfter : new Date(now.getTime() + BACKOFF_MS[attempts - 1]).toISOString();
  const updated = db
    .update(jobs)
    .set({
      status: permanent ? "failed" : "queued",
      attempts,
      error,
      runAfter,
      updatedAt: now.toISOString(),
    })
    .where(eq(jobs.id, id))
    .returning()
    .get();
  if (!updated) throw new Error(`Job ${id} not found`);
  if (job.itemId) {
    updateItem(db, job.itemId, permanent ? { status: "failed", error } : { error });
  }
  return updated;
}

export function retryJob(db: DB, id: number, now: Date = new Date()): Job {
  const job = getJob(db, id);
  const updated = db
    .update(jobs)
    .set({ status: "queued", attempts: 0, error: null, runAfter: now.toISOString(), updatedAt: now.toISOString() })
    .where(eq(jobs.id, id))
    .returning()
    .get();
  if (!updated) throw new Error(`Job ${id} not found`);
  if (job.itemId) updateItem(db, job.itemId, { status: "pending", error: null });
  return updated;
}

export function retryFailedJobsForItem(db: DB, itemId: number, now: Date = new Date()): number {
  const failed = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.itemId, itemId), eq(jobs.status, "failed")))
    .all();
  for (const job of failed) retryJob(db, job.id, now);
  return failed.length;
}

/** Called once at boot: anything still "running" belonged to a process that died. */
export function resetRunningJobs(db: DB, now: Date = new Date()): number {
  const result = db
    .update(jobs)
    .set({ status: "queued", updatedAt: now.toISOString() })
    .where(eq(jobs.status, "running"))
    .run();
  return Number(result.changes);
}

export function listJobs(db: DB, filter: { itemId?: number; status?: JobStatus } = {}): Job[] {
  const conds = [];
  if (filter.itemId !== undefined) conds.push(eq(jobs.itemId, filter.itemId));
  if (filter.status) conds.push(eq(jobs.status, filter.status));
  return db
    .select()
    .from(jobs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(asc(jobs.id))
    .all();
}
```

- [ ] **Step 4: Run the queue tests to verify they pass**

Run: `npx vitest run src/jobs/queue.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Write the failing worker tests**

Create `src/jobs/worker.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { enqueueJob, listJobs } from "./queue";
import { JobWorker } from "./worker";

describe("JobWorker", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("runs a handler for the next job and reports whether it ran", async () => {
    const seen: number[] = [];
    const worker = new JobWorker(t.db, {
      embed: async (job) => {
        seen.push(job.id);
      },
    });
    const job = enqueueJob(t.db, "embed", {});
    expect(await worker.runOnce()).toBe(true);
    expect(seen).toEqual([job.id]);
    expect(listJobs(t.db, { status: "done" })).toHaveLength(1);
    expect(await worker.runOnce()).toBe(false);
  });

  it("records a failure when the handler throws or is missing", async () => {
    const worker = new JobWorker(t.db, {
      embed: async () => {
        throw new Error("nope");
      },
    });
    enqueueJob(t.db, "embed", {});
    enqueueJob(t.db, "fetch_link", {});
    await worker.runOnce(new Date(Date.now() + 1000));
    await worker.runOnce(new Date(Date.now() + 1000));
    const all = listJobs(t.db);
    expect(all[0].error).toBe("nope");
    expect(all[0].status).toBe("queued");
    expect(all[1].error).toMatch(/No handler for job type fetch_link/);
  });

  it("only claims allowed types when restricted", async () => {
    const worker = new JobWorker(t.db, { embed: async () => {}, fetch_link: async () => {} });
    enqueueJob(t.db, "embed", {});
    enqueueJob(t.db, "fetch_link", {});
    worker.restrictTo(["fetch_link"]);
    expect(await worker.runOnce()).toBe(true);
    expect(listJobs(t.db, { status: "done" })[0].type).toBe("fetch_link");
    expect(await worker.runOnce()).toBe(false);
    worker.restrictTo(undefined);
    expect(await worker.runOnce()).toBe(true);
  });

  it("polls in the background until stopped", async () => {
    let ran = 0;
    const worker = new JobWorker(t.db, { embed: async () => { ran++; } }, { pollMs: 20 });
    worker.start();
    enqueueJob(t.db, "embed", {});
    await new Promise((r) => setTimeout(r, 120));
    worker.stop();
    expect(ran).toBe(1);
  });
});
```

- [ ] **Step 6: Run the worker tests to verify they fail**

Run: `npx vitest run src/jobs/worker.test.ts`
Expected: FAIL, cannot resolve `./worker`.

- [ ] **Step 7: Implement the worker, empty handler registry, and boot**

Create `src/jobs/worker.ts`:

```ts
import type { DB } from "@/db/client";
import type { Job, JobType } from "@/db/schema";
import { claimNextJob, completeJob, failJob } from "./queue";

export type JobHandler = (job: Job) => Promise<void>;
export type JobHandlers = Partial<Record<JobType, JobHandler>>;

export interface WorkerOptions {
  pollMs?: number;
  log?: (message: string) => void;
}

export class JobWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private allowed: JobType[] | undefined;

  constructor(
    private readonly db: DB,
    private readonly handlers: JobHandlers,
    private readonly opts: WorkerOptions = {},
  ) {}

  /** Limit the worker to certain job types (used while a meeting is recording). Pass undefined to lift. */
  restrictTo(types: JobType[] | undefined): void {
    this.allowed = types;
  }

  /** Claim and run at most one job. Returns true if a job ran. */
  async runOnce(now: Date = new Date()): Promise<boolean> {
    const job = claimNextJob(this.db, now, this.allowed);
    if (!job) return false;
    const handler = this.handlers[job.type];
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job);
      completeJob(this.db, job.id);
      this.opts.log?.(`job ${job.id} ${job.type} done`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = failJob(this.db, job.id, message);
      this.opts.log?.(`job ${job.id} ${job.type} failed (${updated.status}, attempt ${updated.attempts}): ${message}`);
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try {
        let ran = true;
        while (ran && this.running) ran = await this.runOnce();
      } catch (err) {
        this.opts.log?.(`worker tick error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.running) this.timer = setTimeout(tick, this.opts.pollMs ?? 1000);
    };
    void tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
```

Create `src/jobs/handlers/index.ts` (filled in by later tasks):

```ts
import type { DB } from "@/db/client";
import type { JobHandlers } from "@/jobs/worker";

export interface HandlerDeps {
  db: DB;
}

export function createJobHandlers(_deps: HandlerDeps): JobHandlers {
  return {};
}
```

Create `src/server/boot.ts`:

```ts
import { getDb } from "@/db/client";
import { JobWorker } from "@/jobs/worker";
import { createJobHandlers } from "@/jobs/handlers";
import { resetRunningJobs } from "@/jobs/queue";

const g = globalThis as unknown as { __sbWorker?: JobWorker };

export function boot(): JobWorker {
  if (g.__sbWorker) return g.__sbWorker;
  const db = getDb();
  const reset = resetRunningJobs(db);
  if (reset > 0) console.log(`[boot] requeued ${reset} interrupted job(s)`);
  const worker = new JobWorker(db, createJobHandlers({ db }), { log: (m) => console.log(`[worker] ${m}`) });
  worker.start();
  g.__sbWorker = worker;
  console.log("[boot] job worker started");
  return worker;
}

export function getWorker(): JobWorker | undefined {
  return g.__sbWorker;
}
```

Create `src/instrumentation.ts`:

```ts
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { boot } = await import("./server/boot");
    boot();
  }
}
```

- [ ] **Step 8: Run all tests and the build**

Run: `npm test`
Expected: all pass (client, chunk, items, queue, worker).

Run: `npm run build`
Expected: success. Then `npm run dev &`, `sleep 8`, confirm the dev server log contains `[boot] job worker started`, then `kill %1`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: job queue with retry backoff, in-process worker, and boot hook

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 6: Embedding provider and embed job

**Files:**
- Create: `src/providers/embed/transformers.ts`, `src/providers/embed/fake.ts`, `src/domain/search/vectors.ts`, `src/jobs/handlers/embed.ts`
- Modify: `src/jobs/handlers/index.ts`
- Test: `src/providers/embed/fake.test.ts`, `src/providers/embed/transformers.test.ts`, `src/jobs/handlers/embed.test.ts`

**Interfaces:**
- Consumes: `EmbedProvider`, `EMBEDDING_DIMENSIONS` from `@/providers/embed/types`; `getItem`, `getItemChunks`, `updateItem` from `@/domain/items`; `jobPayload`.
- Produces:
  - `createTransformersEmbedProvider(opts: { cacheDir: string; model?: string }): EmbedProvider`, `DEFAULT_EMBED_MODEL`
  - `createFakeEmbedProvider(): EmbedProvider`
  - `toBlob(v: Float32Array): Buffer`, `upsertChunkVectors(db, rows: { chunkId: number; vector: Float32Array }[]): void`, `countChunkVectors(db): number`
  - `createEmbedHandler(deps: { db: DB; embed: EmbedProvider | null }): JobHandler`
  - `HandlerDeps` gains `embed: EmbedProvider | null`.

- [ ] **Step 1: Write the failing fake provider test**

Create `src/providers/embed/fake.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createFakeEmbedProvider } from "./fake";
import { EMBEDDING_DIMENSIONS } from "./types";

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

describe("fake embed provider", () => {
  it("returns unit vectors of the right size, deterministically", async () => {
    const p = createFakeEmbedProvider();
    const [a, b] = await p.embed(["hello world", "hello world"]);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(cosine(a, a)).toBeCloseTo(1, 5);
    expect(await p.embed([])).toEqual([]);
  });

  it("places overlapping texts closer than unrelated ones", async () => {
    const p = createFakeEmbedProvider();
    const [a, b, c] = await p.embed(["tomato garden sun", "garden tomato water", "quarterly revenue report"]);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/providers/embed/fake.test.ts`
Expected: FAIL, cannot resolve `./fake`.

- [ ] **Step 3: Implement the fake and real providers**

Create `src/providers/embed/fake.ts`:

```ts
import { EMBEDDING_DIMENSIONS, type EmbedProvider } from "./types";

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Deterministic bag-of-words hashing embedder for tests. Similar texts land close together. */
export function createFakeEmbedProvider(): EmbedProvider {
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((text) => {
        const v = new Float32Array(EMBEDDING_DIMENSIONS);
        const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
        for (const w of words) v[fnv1a(w) % EMBEDDING_DIMENSIONS] += 1;
        let norm = 0;
        for (const x of v) norm += x * x;
        norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < v.length; i++) v[i] /= norm;
        return v;
      });
    },
  };
}
```

Create `src/providers/embed/transformers.ts`:

```ts
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_DIMENSIONS, type EmbedProvider } from "./types";

export const DEFAULT_EMBED_MODEL = "Xenova/bge-small-en-v1.5";

export interface TransformersEmbedOptions {
  cacheDir: string;
  model?: string;
}

/** In-process embeddings via transformers.js (ONNX). The model loads lazily on first use. */
export function createTransformersEmbedProvider(opts: TransformersEmbedOptions): EmbedProvider {
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  let loading: Promise<FeatureExtractionPipeline> | undefined;

  function load(): Promise<FeatureExtractionPipeline> {
    if (!loading) {
      loading = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        env.cacheDir = opts.cacheDir;
        return (await pipeline("feature-extraction", model, { dtype: "fp32" })) as FeatureExtractionPipeline;
      })();
    }
    return loading;
  }

  return {
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const extractor = await load();
      const output = await extractor(texts, { pooling: "cls", normalize: true });
      const dims = output.dims[output.dims.length - 1];
      if (dims !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding model returned ${dims} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      }
      const data = output.data as Float32Array;
      const vectors = texts.map((_, i) => data.slice(i * dims, (i + 1) * dims));
      output.dispose();
      return vectors;
    },
  };
}
```

- [ ] **Step 4: Run the fake test to verify it passes**

Run: `npx vitest run src/providers/embed/fake.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Write and run the real provider test**

Create `src/providers/embed/transformers.test.ts`. It downloads about 35 MB into the models directory on first run, which is why it uses a stable cache dir instead of the temp dir.

```ts
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { createTransformersEmbedProvider } from "./transformers";
import { EMBEDDING_DIMENSIONS } from "./types";

const cacheDir = process.env.SB_TEST_MODELS_DIR ?? path.join(os.homedir(), ".cache", "second-brain-test-models");

describe("transformers embed provider", () => {
  it("produces normalized 384-dim vectors deterministically", async () => {
    const p = createTransformersEmbedProvider({ cacheDir });
    const [a, b, c] = await p.embed(["tomatoes need full sun", "tomatoes need full sun", "the stock market fell"]);
    expect(a).toHaveLength(EMBEDDING_DIMENSIONS);
    let norm = 0;
    let same = 0;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      norm += a[i] * a[i];
      same += a[i] * b[i];
      diff += a[i] * c[i];
    }
    expect(norm).toBeCloseTo(1, 3);
    expect(same).toBeCloseTo(1, 3);
    expect(diff).toBeLessThan(0.9);
  }, 180_000);
});
```

Run: `npx vitest run src/providers/embed/transformers.test.ts`
Expected: 1 passed (first run may take a minute while the model downloads).

- [ ] **Step 6: Write the failing embed handler test**

Create `src/jobs/handlers/embed.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, getItem, rechunkItem, updateItem } from "@/domain/items";
import { enqueueJob } from "@/jobs/queue";
import { createFakeEmbedProvider } from "@/providers/embed/fake";
import { countChunkVectors } from "@/domain/search/vectors";
import { createEmbedHandler } from "./embed";

describe("embed handler", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("embeds every chunk of the item and marks it ready", async () => {
    const item = createItem(t.db, { type: "note", title: "T", body: Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ") });
    // Title "T" packs into its own chunk, then 800 words split into 375 + 375 + 50.
    expect(rechunkItem(t.db, item.id)).toBe(4);
    const job = enqueueJob(t.db, "embed", { itemId: item.id }, item.id);
    const handler = createEmbedHandler({ db: t.db, embed: createFakeEmbedProvider() });
    await handler(job);
    expect(countChunkVectors(t.db)).toBe(4);
    expect(getItem(t.db, item.id)?.status).toBe("ready");

    updateItem(t.db, item.id, { body: "short now" });
    rechunkItem(t.db, item.id);
    await handler(job);
    expect(countChunkVectors(t.db)).toBe(1);
  });

  it("marks the item ready without vectors when no provider is configured", async () => {
    const item = createItem(t.db, { type: "note", title: "T", body: "hello" });
    rechunkItem(t.db, item.id);
    const job = enqueueJob(t.db, "embed", { itemId: item.id }, item.id);
    await createEmbedHandler({ db: t.db, embed: null })(job);
    expect(countChunkVectors(t.db)).toBe(0);
    expect(getItem(t.db, item.id)?.status).toBe("ready");
  });

  it("throws when the item is missing", async () => {
    const job = enqueueJob(t.db, "embed", { itemId: 404 });
    await expect(createEmbedHandler({ db: t.db, embed: createFakeEmbedProvider() })(job)).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run src/jobs/handlers/embed.test.ts`
Expected: FAIL, cannot resolve `@/domain/search/vectors`.

- [ ] **Step 8: Implement vector storage and the handler, and register it**

Create `src/domain/search/vectors.ts`:

```ts
import type { DB } from "@/db/client";

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Replace the vectors for the given chunk ids. Rowids must be bound as BigInt for sqlite-vec. */
export function upsertChunkVectors(db: DB, rows: { chunkId: number; vector: Float32Array }[]): void {
  if (rows.length === 0) return;
  const del = db.$client.prepare("DELETE FROM chunks_vec WHERE rowid = ?");
  const ins = db.$client.prepare("INSERT INTO chunks_vec(rowid, embedding) VALUES (?, ?)");
  const run = db.$client.transaction((batch: typeof rows) => {
    for (const r of batch) {
      del.run(BigInt(r.chunkId));
      ins.run(BigInt(r.chunkId), toBlob(r.vector));
    }
  });
  run(rows);
}

export function countChunkVectors(db: DB): number {
  const row = db.$client.prepare("SELECT count(*) AS c FROM chunks_vec").get() as { c: number };
  return row.c;
}
```

Create `src/jobs/handlers/embed.ts`:

```ts
import type { DB } from "@/db/client";
import type { EmbedProvider } from "@/providers/embed/types";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { getItem, getItemChunks, updateItem } from "@/domain/items";
import { upsertChunkVectors } from "@/domain/search/vectors";

const BATCH = 16;

export function createEmbedHandler(deps: { db: DB; embed: EmbedProvider | null }): JobHandler {
  return async (job) => {
    const { itemId } = jobPayload<{ itemId: number }>(job);
    const item = getItem(deps.db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    if (!deps.embed) {
      console.warn(`[embed] no embedding provider; item ${itemId} indexed for keyword search only`);
      updateItem(deps.db, itemId, { status: "ready", error: null });
      return;
    }
    updateItem(deps.db, itemId, { status: "processing" });
    const rows = getItemChunks(deps.db, itemId);
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const vectors = await deps.embed.embed(batch.map((c) => c.text));
      upsertChunkVectors(
        deps.db,
        batch.map((c, j) => ({ chunkId: c.id, vector: vectors[j] })),
      );
    }
    updateItem(deps.db, itemId, { status: "ready", error: null });
  };
}
```

Replace `src/jobs/handlers/index.ts`:

```ts
import type { DB } from "@/db/client";
import type { JobHandlers } from "@/jobs/worker";
import type { EmbedProvider } from "@/providers/embed/types";
import { createEmbedHandler } from "./embed";

export interface HandlerDeps {
  db: DB;
  embed: EmbedProvider | null;
}

export function createJobHandlers(deps: HandlerDeps): JobHandlers {
  return {
    embed: createEmbedHandler({ db: deps.db, embed: deps.embed }),
  };
}
```

Create `src/server/providers.ts`:

```ts
import { modelsDir } from "@/lib/paths";
import type { EmbedProvider } from "@/providers/embed/types";
import { createTransformersEmbedProvider } from "@/providers/embed/transformers";

const g = globalThis as unknown as { __sbEmbed?: EmbedProvider | null };

/** Returns null when SB_EMBED=off, which disables semantic search but keeps everything else working. */
export function getEmbedProvider(): EmbedProvider | null {
  if (g.__sbEmbed === undefined) {
    g.__sbEmbed = process.env.SB_EMBED === "off" ? null : createTransformersEmbedProvider({ cacheDir: modelsDir() });
  }
  return g.__sbEmbed;
}

export function setEmbedProviderForTests(p: EmbedProvider | null): void {
  g.__sbEmbed = p;
}
```

Update `src/server/boot.ts` so the worker receives the provider. Replace the file:

```ts
import { getDb } from "@/db/client";
import { JobWorker } from "@/jobs/worker";
import { createJobHandlers } from "@/jobs/handlers";
import { resetRunningJobs } from "@/jobs/queue";
import { getEmbedProvider } from "./providers";

const g = globalThis as unknown as { __sbWorker?: JobWorker };

export function boot(): JobWorker {
  if (g.__sbWorker) return g.__sbWorker;
  const db = getDb();
  const reset = resetRunningJobs(db);
  if (reset > 0) console.log(`[boot] requeued ${reset} interrupted job(s)`);
  const embed = getEmbedProvider();
  if (!embed) console.warn("[boot] SB_EMBED=off: semantic search disabled");
  const worker = new JobWorker(db, createJobHandlers({ db, embed }), { log: (m) => console.log(`[worker] ${m}`) });
  worker.start();
  g.__sbWorker = worker;
  console.log("[boot] job worker started");
  return worker;
}

export function getWorker(): JobWorker | undefined {
  return g.__sbWorker;
}
```

- [ ] **Step 9: Run all tests**

Run: `npm test`
Expected: all pass, including the 3 embed handler tests.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: local embedding provider, vector storage, and embed job

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 7: Hybrid search

**Files:**
- Create: `src/domain/search/filter.ts`, `src/domain/search/fts.ts`, `src/domain/search/vector.ts`, `src/domain/search/fuse.ts`, `src/domain/search/index.ts`
- Test: `src/domain/search/fuse.test.ts`, `src/domain/search/index.test.ts`

**Interfaces:**
- Consumes: `toBlob` from `./vectors`; `EmbedProvider`; `items` table; `Item` type.
- Produces:
  - `interface SearchFilter { type?: ItemType; tag?: string; from?: string; to?: string }`, `filterSql(filter): { where: string; params: unknown[] }`
  - `interface ChunkHit { chunkId: number; itemId: number; text: string; score: number }`
  - `buildFtsQuery(raw: string): string | null`, `ftsSearch(db, query, opts: { limit: number; filter?: SearchFilter }): ChunkHit[]`
  - `vectorSearch(db, vector: Float32Array, opts: { limit: number; filter?: SearchFilter }): ChunkHit[]`
  - `reciprocalRankFusion<T>(lists: T[][], key: (t: T) => number, k?: number): { key: number; score: number; item: T }[]`
  - `interface SearchResult { item: Item; snippet: string; score: number; chunkId: number }`, `search(db, embed: EmbedProvider | null, query: string, filter?: SearchFilter, limit?: number): Promise<SearchResult[]>`, `makeSnippet(text, query, width?): string`

- [ ] **Step 1: Write the failing fusion test**

Create `src/domain/search/fuse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { reciprocalRankFusion } from "./fuse";

describe("reciprocalRankFusion", () => {
  it("ranks items present in both lists above items in one", () => {
    const a = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const b = [{ id: 3 }, { id: 4 }];
    const fused = reciprocalRankFusion([a, b], (x) => x.id);
    expect(fused.map((f) => f.key)).toEqual([3, 1, 2, 4]);
    expect(fused[0].score).toBeCloseTo(1 / 63 + 1 / 61, 6);
  });

  it("keeps the first occurrence as the carried item and handles empty lists", () => {
    const fused = reciprocalRankFusion([[], [{ id: 9, tag: "b" }]], (x) => x.id);
    expect(fused).toEqual([{ key: 9, score: 1 / 61, item: { id: 9, tag: "b" } }]);
    expect(reciprocalRankFusion([[], []], (x: { id: number }) => x.id)).toEqual([]);
  });

  it("uses the k parameter", () => {
    const fused = reciprocalRankFusion([[{ id: 1 }]], (x) => x.id, 0);
    expect(fused[0].score).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/domain/search/fuse.test.ts`
Expected: FAIL, cannot resolve `./fuse`.

- [ ] **Step 3: Implement fusion**

Create `src/domain/search/fuse.ts`:

```ts
export interface FusedResult<T> {
  key: number;
  score: number;
  item: T;
}

/** Reciprocal rank fusion: score = sum over lists of 1 / (k + rank), rank starting at 1. */
export function reciprocalRankFusion<T>(lists: T[][], key: (t: T) => number, k = 60): FusedResult<T>[] {
  const scores = new Map<number, FusedResult<T>>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const id = key(item);
      const add = 1 / (k + index + 1);
      const existing = scores.get(id);
      if (existing) existing.score += add;
      else scores.set(id, { key: id, score: add, item });
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.key - b.key);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/domain/search/fuse.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Write the failing search integration test**

Create `src/domain/search/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, rechunkItem, setItemTags } from "@/domain/items";
import { createFakeEmbedProvider } from "@/providers/embed/fake";
import { enqueueJob } from "@/jobs/queue";
import { createEmbedHandler } from "@/jobs/handlers/embed";
import { buildFtsQuery, ftsSearch } from "./fts";
import { search, makeSnippet } from "./index";

async function seed(t: TestDb) {
  const embed = createFakeEmbedProvider();
  const handler = createEmbedHandler({ db: t.db, embed });
  const mk = async (title: string, body: string, type: "note" | "link" = "note", tags: string[] = []) => {
    const item = createItem(t.db, { type, title, body, sourceUrl: type === "link" ? "https://x.test" : undefined });
    if (tags.length) setItemTags(t.db, item.id, tags);
    rechunkItem(t.db, item.id);
    await handler(enqueueJob(t.db, "embed", { itemId: item.id }, item.id));
    return item;
  };
  const tomato = await mk("Tomato care", "Tomatoes need full sun and regular water in the garden.", "note", ["garden"]);
  const finance = await mk("Q3 numbers", "Quarterly revenue report shows growth in subscriptions.", "link", ["work"]);
  const garden = await mk("Garden layout", "Raised beds along the fence, tomato and basil together.", "note", ["garden"]);
  return { embed, tomato, finance, garden };
}

describe("search", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("builds a tolerant FTS query", () => {
    expect(buildFtsQuery("Tomato garden!")).toBe('"tomato"* OR "garden"*');
    expect(buildFtsQuery("  ")).toBeNull();
    expect(buildFtsQuery('"quoted" (term)')).toBe('"quoted"* OR "term"*');
  });

  it("finds by keyword without an embedding provider", async () => {
    const { tomato } = await seed(t);
    const results = await search(t.db, null, "tomatoes water");
    expect(results[0].item.id).toBe(tomato.id);
    expect(results[0].snippet).toMatch(/Tomatoes need full sun/);
  });

  it("finds semantically related items when embeddings exist", async () => {
    const { embed, finance } = await seed(t);
    const results = await search(t.db, embed, "revenue subscriptions growth");
    expect(results[0].item.id).toBe(finance.id);
  });

  it("ranks an item hit by both signals first and groups by item", async () => {
    const { embed, tomato, garden } = await seed(t);
    const results = await search(t.db, embed, "tomato garden");
    const ids = results.map((r) => r.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2).sort()).toEqual([tomato.id, garden.id].sort());
  });

  it("applies type, tag, and date filters", async () => {
    const { embed, finance, tomato } = await seed(t);
    // Vector search always returns nearest neighbours, so filters are asserted as exclusions.
    const links = await search(t.db, embed, "tomato", { type: "link" });
    expect(links.every((r) => r.item.type === "link")).toBe(true);
    expect(links.map((r) => r.item.id)).not.toContain(tomato.id);
    expect((await search(t.db, embed, "report", { tag: "work" })).map((r) => r.item.id)).toEqual([finance.id]);
    const work = await search(t.db, embed, "tomato", { tag: "work" });
    expect(work.map((r) => r.item.id)).not.toContain(tomato.id);
    t.db.$client.prepare("UPDATE items SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(tomato.id);
    const dated = await search(t.db, embed, "tomato", { from: "2021-01-01" });
    expect(dated.map((r) => r.item.id)).not.toContain(tomato.id);
    const old = await search(t.db, embed, "tomato", { to: "2020-12-31" });
    expect(old.map((r) => r.item.id)).toEqual([tomato.id]);
  });

  it("returns nothing for an empty query and respects the limit", async () => {
    const { embed } = await seed(t);
    expect(await search(t.db, embed, "   ")).toEqual([]);
    expect(await search(t.db, embed, "tomato garden", {}, 1)).toHaveLength(1);
    expect(ftsSearch(t.db, "tomato", { limit: 1 })).toHaveLength(1);
  });

  it("makes a snippet around the first matching term", () => {
    const text = `${"a ".repeat(200)}needle in the haystack ${"b ".repeat(200)}`;
    const s = makeSnippet(text, "haystack", 60);
    expect(s).toMatch(/needle in the haystack/);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(makeSnippet("short text", "zzz", 60)).toBe("short text");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/domain/search/index.test.ts`
Expected: FAIL, cannot resolve `./fts`.

- [ ] **Step 7: Implement filter, fts, vector, and search**

Create `src/domain/search/filter.ts`:

```ts
import type { ItemType } from "@/db/schema";

export interface SearchFilter {
  type?: ItemType;
  tag?: string;
  /** Inclusive lower bound on created date, YYYY-MM-DD. */
  from?: string;
  /** Inclusive upper bound on created date, YYYY-MM-DD. */
  to?: string;
}

/** Extra WHERE clauses against an `items` table aliased as `i`. Each starts with " AND ". */
export function filterSql(filter: SearchFilter = {}): { where: string; params: unknown[] } {
  let where = "";
  const params: unknown[] = [];
  if (filter.type) {
    where += " AND i.type = ?";
    params.push(filter.type);
  }
  if (filter.tag) {
    where += " AND i.id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE t.name = ?)";
    params.push(filter.tag.trim().toLowerCase());
  }
  if (filter.from) {
    where += " AND i.created_at >= ?";
    params.push(`${filter.from}T00:00:00.000Z`);
  }
  if (filter.to) {
    where += " AND i.created_at <= ?";
    params.push(`${filter.to}T23:59:59.999Z`);
  }
  return { where, params };
}
```

Create `src/domain/search/fts.ts`:

```ts
import type { DB } from "@/db/client";
import { filterSql, type SearchFilter } from "./filter";

export interface ChunkHit {
  chunkId: number;
  itemId: number;
  text: string;
  score: number;
}

/** Turn free text into an FTS5 query: each term quoted, prefix-matched, OR-joined. Null when no terms. */
export function buildFtsQuery(raw: string): string | null {
  const terms = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

export function ftsSearch(db: DB, query: string, opts: { limit: number; filter?: SearchFilter }): ChunkHit[] {
  const q = buildFtsQuery(query);
  if (!q) return [];
  const { where, params } = filterSql(opts.filter);
  const rows = db.$client
    .prepare(
      `SELECT c.id AS chunkId, c.item_id AS itemId, c.text AS text, bm25(chunks_fts) AS rank
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       JOIN items i ON i.id = c.item_id
       WHERE chunks_fts MATCH ?${where}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(q, ...params, opts.limit) as { chunkId: number; itemId: number; text: string; rank: number }[];
  return rows.map((r) => ({ chunkId: r.chunkId, itemId: r.itemId, text: r.text, score: -r.rank }));
}
```

Create `src/domain/search/vector.ts`:

```ts
import type { DB } from "@/db/client";
import { filterSql, type SearchFilter } from "./filter";
import { toBlob } from "./vectors";
import type { ChunkHit } from "./fts";

/** Nearest chunks by cosine distance. Filters run after the KNN, so the KNN fetches extra candidates. */
export function vectorSearch(db: DB, vector: Float32Array, opts: { limit: number; filter?: SearchFilter }): ChunkHit[] {
  const { where, params } = filterSql(opts.filter);
  const candidates = opts.limit * 4;
  const rows = db.$client
    .prepare(
      `SELECT v.rowid AS chunkId, v.distance AS distance, c.item_id AS itemId, c.text AS text
       FROM (SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?) v
       JOIN chunks c ON c.id = v.rowid
       JOIN items i ON i.id = c.item_id
       WHERE 1 = 1${where}
       ORDER BY v.distance
       LIMIT ?`,
    )
    .all(toBlob(vector), candidates, ...params, opts.limit) as { chunkId: number; distance: number; itemId: number; text: string }[];
  return rows.map((r) => ({ chunkId: r.chunkId, itemId: r.itemId, text: r.text, score: 1 - r.distance }));
}
```

Create `src/domain/search/index.ts`:

```ts
import { inArray } from "drizzle-orm";
import type { DB } from "@/db/client";
import { items, type Item } from "@/db/schema";
import type { EmbedProvider } from "@/providers/embed/types";
import { ftsSearch, type ChunkHit } from "./fts";
import { vectorSearch } from "./vector";
import { reciprocalRankFusion } from "./fuse";
import type { SearchFilter } from "./filter";

export type { SearchFilter } from "./filter";

export interface SearchResult {
  item: Item;
  snippet: string;
  score: number;
  chunkId: number;
}

const CANDIDATES = 50;

export async function search(
  db: DB,
  embed: EmbedProvider | null,
  query: string,
  filter: SearchFilter = {},
  limit = 20,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const keyword = ftsSearch(db, trimmed, { limit: CANDIDATES, filter });
  let semantic: ChunkHit[] = [];
  if (embed) {
    try {
      const [vector] = await embed.embed([trimmed]);
      semantic = vectorSearch(db, vector, { limit: CANDIDATES, filter });
    } catch (err) {
      console.warn(`[search] semantic search unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const fused = reciprocalRankFusion([keyword, semantic], (h) => h.chunkId);
  const best = new Map<number, { hit: ChunkHit; score: number }>();
  for (const f of fused) {
    if (!best.has(f.item.itemId)) best.set(f.item.itemId, { hit: f.item, score: f.score });
    if (best.size >= limit) break;
  }
  const ids = [...best.keys()];
  if (ids.length === 0) return [];
  const rows = db.select().from(items).where(inArray(items.id, ids)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const item = byId.get(id);
    const entry = best.get(id);
    if (!item || !entry) return [];
    return [{ item, snippet: makeSnippet(entry.hit.text, trimmed), score: entry.score, chunkId: entry.hit.chunkId }];
  });
}

/** A window of `width` characters around the first query term found in text. */
export function makeSnippet(text: string, query: string, width = 240): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= width) return clean;
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const lower = clean.toLowerCase();
  let pos = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (pos === -1 || idx < pos)) pos = idx;
  }
  if (pos === -1) return `${clean.slice(0, width - 1)}…`;
  const start = Math.max(0, pos - Math.floor(width / 3));
  const end = Math.min(clean.length, start + width);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: all pass, including 7 search tests.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: hybrid keyword and vector search with rank fusion

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 8: Link fetching and the fetch_link job

**Files:**
- Create: `src/domain/items/links.ts`, `src/jobs/handlers/fetch-link.ts`, `src/test/fixtures.ts`
- Test: `src/domain/items/links.test.ts`, `src/jobs/handlers/fetch-link.test.ts`

**Interfaces:**
- Consumes: `getItem`, `updateItem`, `parseMeta`, `rechunkItem` from `@/domain/items`; `enqueueJob`; `jobPayload`; `nowIso`.
- Produces:
  - `interface FetchedPage { title: string; text: string; byline: string | null; siteName: string | null }`
  - `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`
  - `fetchPage(url: string, fetchImpl?: FetchLike): Promise<FetchedPage>`, `extractReadable(html: string, url: string): FetchedPage`
  - `createFetchLinkHandler(deps: { db: DB; fetchImpl?: FetchLike }): JobHandler`

- [ ] **Step 1: Write the fixture and the failing extraction tests**

Create `src/test/fixtures.ts` (Task 9 adds a PDF fixture to this file):

```ts
const para =
  "The second brain keeps every note, link, and meeting in one place so that nothing gets lost and everything can be found again later. ";

/** An article page with enough text for Readability to extract it. */
export const ARTICLE_HTML = `<html><head><title>Test Article | Site</title><meta name="author" content="Ada"></head>
<body><nav>Home About</nav><article><h1>Test Article</h1>
<p>${para.repeat(3)}</p><p>${para.repeat(3)}</p><p>${para.repeat(3)}</p></article><footer>copyright</footer></body></html>`;
```

Create `src/domain/items/links.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ARTICLE_HTML } from "@/test/fixtures";
import { extractReadable, fetchPage } from "./links";

describe("extractReadable", () => {
  it("extracts the article title and body text", () => {
    const page = extractReadable(ARTICLE_HTML, "https://example.test/post");
    expect(page.title).toMatch(/Test Article/);
    expect(page.text.startsWith("The second brain keeps")).toBe(true);
    expect(page.text).not.toMatch(/copyright/);
    expect(page.text.length).toBeGreaterThan(1000);
  });

  it("falls back to the body text and document title for thin pages", () => {
    const page = extractReadable("<html><head><title>Tiny</title></head><body><p>hi there</p></body></html>", "https://t.test");
    expect(page.title).toBe("Tiny");
    expect(page.text).toBe("hi there");
  });

  it("uses the url as the title when the page has none", () => {
    const page = extractReadable("<html><body>x</body></html>", "https://t.test/a");
    expect(page.title).toBe("https://t.test/a");
  });
});

describe("fetchPage", () => {
  it("sends a browser-like user agent and rejects non-2xx", async () => {
    let seenUa = "";
    const ok: typeof fetch = async (_url, init) => {
      seenUa = String((init?.headers as Record<string, string>)["user-agent"]);
      return new Response(ARTICLE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const page = await fetchPage("https://example.test/post", ok);
    expect(page.title).toMatch(/Test Article/);
    expect(seenUa).toMatch(/Mozilla/);

    const bad: typeof fetch = async () => new Response("nope", { status: 404 });
    await expect(fetchPage("https://example.test/missing", bad)).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/domain/items/links.test.ts`
Expected: FAIL, cannot resolve `./links`.

- [ ] **Step 3: Implement link fetching**

Create `src/domain/items/links.ts`:

```ts
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export interface FetchedPage {
  title: string;
  text: string;
  byline: string | null;
  siteName: string | null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 SecondBrain/1.0";

export async function fetchPage(url: string, fetchImpl: FetchLike = fetch): Promise<FetchedPage> {
  const res = await fetchImpl(url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
  const html = await res.text();
  return extractReadable(html, url);
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractReadable(html: string, url: string): FetchedPage {
  const { document } = parseHTML(html);
  const docTitle = document.querySelector("title")?.textContent?.trim() ?? "";
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document as unknown as Document).parse();
  } catch {
    article = null;
  }
  const articleText = article?.textContent ? tidy(article.textContent) : "";
  if (!articleText) {
    const bodyText = tidy(document.body?.textContent ?? "");
    return { title: docTitle || url, text: bodyText, byline: null, siteName: null };
  }
  return {
    title: (article?.title || docTitle || url).trim(),
    text: articleText,
    byline: article?.byline ?? null,
    siteName: article?.siteName ?? null,
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/domain/items/links.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Write the failing handler test**

Create `src/jobs/handlers/fetch-link.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { createItem, getItem, getItemChunks, parseMeta } from "@/domain/items";
import { enqueueJob, listJobs } from "@/jobs/queue";
import { ARTICLE_HTML } from "@/test/fixtures";
import { createFetchLinkHandler } from "./fetch-link";

describe("fetch_link handler", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("fills title, extracted text, meta, chunks, and queues embedding", async () => {
    const url = "https://example.test/post";
    const item = createItem(t.db, { type: "link", title: url, sourceUrl: url });
    const job = enqueueJob(t.db, "fetch_link", { itemId: item.id }, item.id);
    const fetchImpl: typeof fetch = async () => new Response(ARTICLE_HTML, { status: 200 });
    await createFetchLinkHandler({ db: t.db, fetchImpl })(job);

    const after = getItem(t.db, item.id)!;
    expect(after.title).toMatch(/Test Article/);
    expect(after.extractedText).toMatch(/second brain keeps/);
    expect(after.status).toBe("processing");
    expect(parseMeta<{ fetched_at: string }>(after).fetched_at).toBeTruthy();
    expect(getItemChunks(t.db, item.id).length).toBeGreaterThan(0);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["fetch_link", "embed"]);
  });

  it("keeps a user-provided title", async () => {
    const item = createItem(t.db, { type: "link", title: "My title", sourceUrl: "https://example.test/post" });
    const job = enqueueJob(t.db, "fetch_link", { itemId: item.id }, item.id);
    const fetchImpl: typeof fetch = async () => new Response(ARTICLE_HTML, { status: 200 });
    await createFetchLinkHandler({ db: t.db, fetchImpl })(job);
    expect(getItem(t.db, item.id)?.title).toBe("My title");
  });

  it("throws when the item has no url", async () => {
    const item = createItem(t.db, { type: "note", title: "n" });
    const job = enqueueJob(t.db, "fetch_link", { itemId: item.id }, item.id);
    await expect(createFetchLinkHandler({ db: t.db })(job)).rejects.toThrow(/no source url/i);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/jobs/handlers/fetch-link.test.ts`
Expected: FAIL, cannot resolve `./fetch-link`.

- [ ] **Step 7: Implement the handler**

Create `src/jobs/handlers/fetch-link.ts`:

```ts
import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { enqueueJob } from "@/jobs/queue";
import { getItem, parseMeta, rechunkItem, updateItem } from "@/domain/items";
import { fetchPage, type FetchLike } from "@/domain/items/links";
import { nowIso } from "@/lib/time";

export function createFetchLinkHandler(deps: { db: DB; fetchImpl?: FetchLike }): JobHandler {
  return async (job) => {
    const { itemId } = jobPayload<{ itemId: number }>(job);
    const item = getItem(deps.db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    if (!item.sourceUrl) throw new Error(`Item ${itemId} has no source url`);

    updateItem(deps.db, itemId, { status: "processing" });
    const page = await fetchPage(item.sourceUrl, deps.fetchImpl);
    const keepTitle = item.title.trim() !== "" && item.title !== item.sourceUrl;
    updateItem(deps.db, itemId, {
      title: keepTitle ? item.title : page.title,
      extractedText: page.text,
      meta: { ...parseMeta(item), site_name: page.siteName, byline: page.byline, fetched_at: nowIso() },
    });
    rechunkItem(deps.db, itemId);
    enqueueJob(deps.db, "embed", { itemId }, itemId);
  };
}
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: fetch and extract web links as a background job

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 9: File storage, PDF extraction, and OCR jobs

**Files:**
- Create: `src/lib/files.ts`, `src/domain/items/extract.ts`, `src/jobs/handlers/extract-pdf.ts`, `src/jobs/handlers/ocr-image.ts`
- Modify: `src/test/fixtures.ts`
- Test: `src/lib/files.test.ts`, `src/domain/items/extract.test.ts`, `src/jobs/handlers/extract-pdf.test.ts`, `src/jobs/handlers/ocr-image.test.ts`

**Interfaces:**
- Consumes: `filesDir`, `modelsDir` from `@/lib/paths`; items domain functions; `enqueueJob`.
- Produces:
  - `saveFile(bytes: Buffer, originalName: string, now?: Date): { relativePath: string; absolutePath: string }`, `absoluteFilePath(relativePath: string): string`
  - `type FileKind = "pdf" | "image" | "audio" | "other"`, `kindForMime(mime: string, name: string): FileKind`
  - `extractPdfText(bytes: Buffer): Promise<{ text: string; pageCount: number }>`, `type PdfExtractFn`, `ocrImageText(absolutePath: string): Promise<string>`, `type OcrFn`
  - `createExtractPdfHandler(deps: { db: DB; extract?: PdfExtractFn }): JobHandler`, `createOcrImageHandler(deps: { db: DB; ocr?: OcrFn }): JobHandler`
  - `MINIMAL_PDF: Buffer` from `@/test/fixtures` (a one-page PDF containing the text "Hello Brain")

- [ ] **Step 1: Write the failing file storage test**

Create `src/lib/files.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { useTempDataDir } from "@/test/db";
import { saveFile, absoluteFilePath, kindForMime } from "./files";

describe("files", () => {
  let dir: string;
  beforeEach(() => {
    dir = useTempDataDir();
  });

  it("saves under files/YYYY/MM with a uuid prefix and a safe name", () => {
    const saved = saveFile(Buffer.from("hello"), "My Report (final).pdf", new Date("2026-09-12T10:00:00Z"));
    expect(saved.relativePath).toMatch(/^2026\/09\/[0-9a-f-]{36}-My_Report_final_.pdf$/);
    expect(saved.absolutePath).toBe(path.join(dir, "files", saved.relativePath));
    expect(fs.readFileSync(saved.absolutePath, "utf8")).toBe("hello");
    expect(absoluteFilePath(saved.relativePath)).toBe(saved.absolutePath);
  });

  it("classifies files by mime type with extension fallback", () => {
    expect(kindForMime("application/pdf", "x.bin")).toBe("pdf");
    expect(kindForMime("application/octet-stream", "x.PDF")).toBe("pdf");
    expect(kindForMime("image/png", "a.png")).toBe("image");
    expect(kindForMime("audio/mpeg", "a.mp3")).toBe("audio");
    expect(kindForMime("application/octet-stream", "call.m4a")).toBe("audio");
    expect(kindForMime("text/plain", "notes.txt")).toBe("other");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/files.test.ts`
Expected: FAIL, cannot resolve `./files`.

- [ ] **Step 3: Implement file storage**

Create `src/lib/files.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { filesDir } from "./paths";

export interface SavedFile {
  relativePath: string;
  absolutePath: string;
}

export type FileKind = "pdf" | "image" | "audio" | "other";

const AUDIO_EXT = new Set([".m4a", ".mp3", ".wav", ".webm", ".aac", ".ogg", ".flac"]);

export function saveFile(bytes: Buffer, originalName: string, now: Date = new Date()): SavedFile {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const safe = originalName.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";
  const relativePath = path.join(yyyy, mm, `${randomUUID()}-${safe}`);
  const absolutePath = path.join(filesDir(), relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return { relativePath, absolutePath };
}

export function absoluteFilePath(relativePath: string): string {
  return path.join(filesDir(), relativePath);
}

export function kindForMime(mime: string, name: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  const m = mime.toLowerCase();
  if (m === "application/pdf" || ext === ".pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/") || AUDIO_EXT.has(ext)) return "audio";
  return "other";
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/files.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Write the fixture and the failing extraction test**

Replace `src/test/fixtures.ts` with the following. pdf.js reconstructs the missing cross-reference table, and this exact PDF was verified to parse with pdf-parse 2.4.

```ts
const para =
  "The second brain keeps every note, link, and meeting in one place so that nothing gets lost and everything can be found again later. ";

/** An article page with enough text for Readability to extract it. */
export const ARTICLE_HTML = `<html><head><title>Test Article | Site</title><meta name="author" content="Ada"></head>
<body><nav>Home About</nav><article><h1>Test Article</h1>
<p>${para.repeat(3)}</p><p>${para.repeat(3)}</p><p>${para.repeat(3)}</p></article><footer>copyright</footer></body></html>`;

/** A one-page PDF whose only text is "Hello Brain". */
export const MINIMAL_PDF: Buffer = Buffer.from(
  `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 42 >> stream
BT /F1 18 Tf 20 40 Td (Hello Brain) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`,
  "latin1",
);
```

Create `src/domain/items/extract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MINIMAL_PDF } from "@/test/fixtures";
import { extractPdfText } from "./extract";

describe("extractPdfText", () => {
  it("returns the page text without page markers", async () => {
    const result = await extractPdfText(MINIMAL_PDF);
    expect(result.pageCount).toBe(1);
    expect(result.text).toBe("Hello Brain");
  });

  it("rejects non-PDF bytes", async () => {
    await expect(extractPdfText(Buffer.from("not a pdf"))).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/domain/items/extract.test.ts`
Expected: FAIL, cannot resolve `./extract`.

- [ ] **Step 7: Implement extraction**

Create `src/domain/items/extract.ts`:

```ts
import fs from "node:fs";
import { modelsDir } from "@/lib/paths";

export type PdfExtractFn = (bytes: Buffer) => Promise<{ text: string; pageCount: number }>;
export type OcrFn = (absolutePath: string) => Promise<string>;

/** Text of every page, joined, with pdf-parse's "-- n of m --" separators removed. */
export const extractPdfText: PdfExtractFn = async (bytes) => {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const result = await parser.getText();
    const text = result.text
      .replace(/^-- \d+ of \d+ --$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, pageCount: result.total };
  } finally {
    await parser.destroy();
  }
};

/** OCR with tesseract.js. Language data is cached under the models directory on first use. */
export const ocrImageText: OcrFn = async (absolutePath) => {
  const { createWorker } = await import("tesseract.js");
  fs.mkdirSync(modelsDir(), { recursive: true });
  const worker = await createWorker("eng", undefined, { cachePath: modelsDir() });
  try {
    const { data } = await worker.recognize(absolutePath);
    return data.text.trim();
  } finally {
    await worker.terminate();
  }
};
```

- [ ] **Step 8: Run it to verify it passes**

Run: `npx vitest run src/domain/items/extract.test.ts`
Expected: 2 passed.

- [ ] **Step 9: Write the failing handler tests**

Create `src/jobs/handlers/extract-pdf.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { MINIMAL_PDF } from "@/test/fixtures";
import { saveFile } from "@/lib/files";
import { createItem, getItem, getItemChunks, parseMeta } from "@/domain/items";
import { enqueueJob, listJobs } from "@/jobs/queue";
import { createExtractPdfHandler } from "./extract-pdf";

describe("extract_pdf handler", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("extracts text, records page count, chunks, and queues embedding", async () => {
    const saved = saveFile(MINIMAL_PDF, "hello.pdf");
    const item = createItem(t.db, { type: "file", title: "hello.pdf", filePath: saved.relativePath, mimeType: "application/pdf" });
    const job = enqueueJob(t.db, "extract_pdf", { itemId: item.id }, item.id);
    await createExtractPdfHandler({ db: t.db })(job);
    const after = getItem(t.db, item.id)!;
    expect(after.extractedText).toBe("Hello Brain");
    expect(parseMeta<{ page_count: number }>(after).page_count).toBe(1);
    expect(getItemChunks(t.db, item.id)).toHaveLength(1);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["extract_pdf", "embed"]);
  });

  it("throws when the item has no file", async () => {
    const item = createItem(t.db, { type: "file", title: "x" });
    const job = enqueueJob(t.db, "extract_pdf", { itemId: item.id }, item.id);
    await expect(createExtractPdfHandler({ db: t.db })(job)).rejects.toThrow(/no file/i);
  });
});
```

Create `src/jobs/handlers/ocr-image.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { saveFile } from "@/lib/files";
import { createItem, getItem, getItemChunks } from "@/domain/items";
import { enqueueJob, listJobs } from "@/jobs/queue";
import { createOcrImageHandler } from "./ocr-image";

describe("ocr_image handler", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("stores recognized text, chunks it, and queues embedding", async () => {
    const saved = saveFile(Buffer.from("fake png"), "shot.png");
    const item = createItem(t.db, { type: "file", title: "shot.png", filePath: saved.relativePath, mimeType: "image/png" });
    const job = enqueueJob(t.db, "ocr_image", { itemId: item.id }, item.id);
    const seen: string[] = [];
    const ocr = async (p: string) => {
      seen.push(p);
      return "Whiteboard: ship v1 by Friday";
    };
    await createOcrImageHandler({ db: t.db, ocr })(job);
    expect(seen).toEqual([saved.absolutePath]);
    expect(getItem(t.db, item.id)?.extractedText).toBe("Whiteboard: ship v1 by Friday");
    expect(getItemChunks(t.db, item.id)).toHaveLength(1);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["ocr_image", "embed"]);
  });
});
```

- [ ] **Step 10: Run them to verify they fail**

Run: `npx vitest run src/jobs/handlers/extract-pdf.test.ts src/jobs/handlers/ocr-image.test.ts`
Expected: FAIL, cannot resolve `./extract-pdf` and `./ocr-image`.

- [ ] **Step 11: Implement both handlers**

Create `src/jobs/handlers/extract-pdf.ts`:

```ts
import fs from "node:fs";
import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { enqueueJob } from "@/jobs/queue";
import { getItem, parseMeta, rechunkItem, updateItem } from "@/domain/items";
import { extractPdfText, type PdfExtractFn } from "@/domain/items/extract";
import { absoluteFilePath } from "@/lib/files";

export function createExtractPdfHandler(deps: { db: DB; extract?: PdfExtractFn }): JobHandler {
  const extract = deps.extract ?? extractPdfText;
  return async (job) => {
    const { itemId } = jobPayload<{ itemId: number }>(job);
    const item = getItem(deps.db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    if (!item.filePath) throw new Error(`Item ${itemId} has no file`);

    updateItem(deps.db, itemId, { status: "processing" });
    const bytes = fs.readFileSync(absoluteFilePath(item.filePath));
    const { text, pageCount } = await extract(bytes);
    updateItem(deps.db, itemId, { extractedText: text, meta: { ...parseMeta(item), page_count: pageCount } });
    rechunkItem(deps.db, itemId);
    enqueueJob(deps.db, "embed", { itemId }, itemId);
  };
}
```

Create `src/jobs/handlers/ocr-image.ts`:

```ts
import type { DB } from "@/db/client";
import type { JobHandler } from "@/jobs/worker";
import { jobPayload } from "@/jobs/payload";
import { enqueueJob } from "@/jobs/queue";
import { getItem, rechunkItem, updateItem } from "@/domain/items";
import { ocrImageText, type OcrFn } from "@/domain/items/extract";
import { absoluteFilePath } from "@/lib/files";

export function createOcrImageHandler(deps: { db: DB; ocr?: OcrFn }): JobHandler {
  const ocr = deps.ocr ?? ocrImageText;
  return async (job) => {
    const { itemId } = jobPayload<{ itemId: number }>(job);
    const item = getItem(deps.db, itemId);
    if (!item) throw new Error(`Item ${itemId} not found`);
    if (!item.filePath) throw new Error(`Item ${itemId} has no file`);

    updateItem(deps.db, itemId, { status: "processing" });
    const text = await ocr(absoluteFilePath(item.filePath));
    updateItem(deps.db, itemId, { extractedText: text });
    rechunkItem(deps.db, itemId);
    enqueueJob(deps.db, "embed", { itemId }, itemId);
  };
}
```

- [ ] **Step 12: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: file storage with PDF text extraction and image OCR jobs

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 10: Capture functions and the full handler registry

**Files:**
- Create: `src/lib/text.ts`, `src/domain/items/capture.ts`
- Modify: `src/jobs/handlers/index.ts`
- Test: `src/domain/items/capture.test.ts`, `src/jobs/handlers/index.test.ts`

**Interfaces:**
- Consumes: items domain, `saveFile`, `kindForMime`, `enqueueJob`, all four handler factories.
- Produces:
  - `class CaptureError extends Error { status: number }`
  - `deriveTitle(body: string): string`, `isProbablyUrl(text: string): boolean` in `@/lib/text` (pure, safe for client components) and re-exported from `@/domain/items/capture`
  - `captureNote(db, input: { title?: string; body: string; tags?: string[] }): Item`
  - `captureLink(db, input: { url: string; title?: string; tags?: string[] }): Item`
  - `captureFile(db, input: { bytes: Buffer; name: string; mime: string; tags?: string[] }): Item`
  - `updateItemContent(db, id: number, patch: { title?: string; body?: string; tags?: string[] }): Item`
  - `HandlerDeps = { db: DB; embed: EmbedProvider | null; fetchImpl?: FetchLike; extractPdf?: PdfExtractFn; ocr?: OcrFn }` and `createJobHandlers` returning all four handlers.

- [ ] **Step 1: Write the failing capture tests**

Create `src/domain/items/capture.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { makeTestDb, type TestDb } from "@/test/db";
import { MINIMAL_PDF } from "@/test/fixtures";
import { listJobs } from "@/jobs/queue";
import { getItemChunks, getItemTags } from "./index";
import { absoluteFilePath } from "@/lib/files";
import { captureNote, captureLink, captureFile, updateItemContent, deriveTitle, isProbablyUrl, CaptureError } from "./capture";

describe("capture", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("derives titles from the first line", () => {
    expect(deriveTitle("# Meeting notes\n\nstuff")).toBe("Meeting notes");
    expect(deriveTitle("\n\n  plain first line here\nmore")).toBe("plain first line here");
    expect(deriveTitle("x".repeat(100))).toHaveLength(80);
    expect(deriveTitle("   ")).toBe("Untitled note");
  });

  it("detects a lone url", () => {
    expect(isProbablyUrl("https://example.com/a?b=1")).toBe(true);
    expect(isProbablyUrl("  http://x.io  ")).toBe(true);
    expect(isProbablyUrl("see https://example.com")).toBe(false);
    expect(isProbablyUrl("https://a.com\nhttps://b.com")).toBe(false);
  });

  it("captures a note with chunks, tags, and an embed job", () => {
    const item = captureNote(t.db, { body: "Buy tomato seeds\n\nAnd basil.", tags: ["Garden"] });
    expect(item.type).toBe("note");
    expect(item.title).toBe("Buy tomato seeds");
    expect(item.status).toBe("pending");
    expect(getItemTags(t.db, item.id)).toEqual(["garden"]);
    expect(getItemChunks(t.db, item.id)).toHaveLength(1);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["embed"]);
  });

  it("captures a link and queues fetch_link, rejecting bad urls", () => {
    const item = captureLink(t.db, { url: "https://example.test/x" });
    expect(item.type).toBe("link");
    expect(item.title).toBe("https://example.test/x");
    expect(item.sourceUrl).toBe("https://example.test/x");
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["fetch_link"]);
    expect(() => captureLink(t.db, { url: "notaurl" })).toThrow(CaptureError);
    expect(() => captureLink(t.db, { url: "ftp://x.test/a" })).toThrow(/http/);
  });

  it("captures a pdf, an image, an unknown file, and rejects audio", () => {
    const pdf = captureFile(t.db, { bytes: MINIMAL_PDF, name: "hello.pdf", mime: "application/pdf" });
    expect(pdf.type).toBe("file");
    expect(fs.existsSync(absoluteFilePath(pdf.filePath!))).toBe(true);
    expect(listJobs(t.db, { itemId: pdf.id }).map((j) => j.type)).toEqual(["extract_pdf"]);

    const img = captureFile(t.db, { bytes: Buffer.from("png"), name: "a.png", mime: "image/png" });
    expect(listJobs(t.db, { itemId: img.id }).map((j) => j.type)).toEqual(["ocr_image"]);

    const other = captureFile(t.db, { bytes: Buffer.from("txt"), name: "notes.txt", mime: "text/plain" });
    expect(listJobs(t.db, { itemId: other.id }).map((j) => j.type)).toEqual(["embed"]);
    expect(getItemChunks(t.db, other.id)).toHaveLength(1);

    expect(() => captureFile(t.db, { bytes: Buffer.from("aud"), name: "call.m4a", mime: "audio/mp4" })).toThrow(/meetings/);
    try {
      captureFile(t.db, { bytes: Buffer.from("aud"), name: "call.m4a", mime: "audio/mp4" });
    } catch (e) {
      expect((e as CaptureError).status).toBe(415);
    }
  });

  it("updates content, rechunks, retags, and requeues embedding", () => {
    const item = captureNote(t.db, { body: "first version" });
    const updated = updateItemContent(t.db, item.id, { title: "Renamed", body: "second version", tags: ["b", "a"] });
    expect(updated.title).toBe("Renamed");
    expect(getItemChunks(t.db, item.id)[0].text).toBe("Renamed second version");
    expect(getItemTags(t.db, item.id)).toEqual(["a", "b"]);
    expect(listJobs(t.db, { itemId: item.id }).map((j) => j.type)).toEqual(["embed", "embed"]);
    expect(() => updateItemContent(t.db, 999, { body: "x" })).toThrow(CaptureError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/domain/items/capture.test.ts`
Expected: FAIL, cannot resolve `./capture`.

- [ ] **Step 3: Implement the text helpers and capture**

Create `src/lib/text.ts` (no server imports, so client components can use it):

```ts
export function deriveTitle(body: string): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "Untitled note";
  return line.replace(/^#+\s*/, "").slice(0, 80);
}

export function isProbablyUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}
```

Create `src/domain/items/capture.ts`:

```ts
import type { DB } from "@/db/client";
import type { Item } from "@/db/schema";
import { enqueueJob } from "@/jobs/queue";
import { saveFile, kindForMime } from "@/lib/files";
import { deriveTitle } from "@/lib/text";
import { createItem, getItem, rechunkItem, setItemTags, updateItem } from "./index";

export { deriveTitle, isProbablyUrl } from "@/lib/text";

export class CaptureError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "CaptureError";
  }
}

function queueEmbedding(db: DB, itemId: number): void {
  rechunkItem(db, itemId);
  enqueueJob(db, "embed", { itemId }, itemId);
}

export function captureNote(db: DB, input: { title?: string; body: string; tags?: string[] }): Item {
  const title = input.title?.trim() || deriveTitle(input.body);
  const item = createItem(db, { type: "note", title, body: input.body });
  if (input.tags) setItemTags(db, item.id, input.tags);
  queueEmbedding(db, item.id);
  return getItem(db, item.id)!;
}

export function captureLink(db: DB, input: { url: string; title?: string; tags?: string[] }): Item {
  const raw = input.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CaptureError(`Not a valid url: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CaptureError("Only http and https links can be captured");
  }
  const item = createItem(db, { type: "link", title: input.title?.trim() || raw, sourceUrl: raw });
  if (input.tags) setItemTags(db, item.id, input.tags);
  enqueueJob(db, "fetch_link", { itemId: item.id }, item.id);
  return getItem(db, item.id)!;
}

export function captureFile(db: DB, input: { bytes: Buffer; name: string; mime: string; tags?: string[] }): Item {
  const kind = kindForMime(input.mime, input.name);
  if (kind === "audio") {
    throw new CaptureError("Audio files are captured as meetings, which arrive with the meetings slice", 415);
  }
  const saved = saveFile(input.bytes, input.name);
  const item = createItem(db, {
    type: "file",
    title: input.name,
    filePath: saved.relativePath,
    mimeType: input.mime,
    meta: { kind, size: input.bytes.length },
  });
  if (input.tags) setItemTags(db, item.id, input.tags);
  if (kind === "pdf") enqueueJob(db, "extract_pdf", { itemId: item.id }, item.id);
  else if (kind === "image") enqueueJob(db, "ocr_image", { itemId: item.id }, item.id);
  else queueEmbedding(db, item.id);
  return getItem(db, item.id)!;
}

export function updateItemContent(db: DB, id: number, patch: { title?: string; body?: string; tags?: string[] }): Item {
  if (!getItem(db, id)) throw new CaptureError(`Item ${id} not found`, 404);
  updateItem(db, id, { title: patch.title, body: patch.body });
  if (patch.tags) setItemTags(db, id, patch.tags);
  queueEmbedding(db, id);
  return getItem(db, id)!;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/domain/items/capture.test.ts`
Expected: 6 passed.

- [ ] **Step 5: Write the failing registry test**

Create `src/jobs/handlers/index.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTestDb, type TestDb } from "@/test/db";
import { MINIMAL_PDF } from "@/test/fixtures";
import { captureNote, captureLink, captureFile } from "@/domain/items/capture";
import { getItem } from "@/domain/items";
import { ARTICLE_HTML } from "@/test/fixtures";
import { createFakeEmbedProvider } from "@/providers/embed/fake";
import { countChunkVectors } from "@/domain/search/vectors";
import { JobWorker } from "@/jobs/worker";
import { createJobHandlers } from "./index";

describe("createJobHandlers", () => {
  let t: TestDb;
  beforeEach(() => {
    t = makeTestDb();
  });
  afterEach(() => t.cleanup());

  it("drives every capture type to ready through the worker", async () => {
    const worker = new JobWorker(
      t.db,
      createJobHandlers({
        db: t.db,
        embed: createFakeEmbedProvider(),
        fetchImpl: async () => new Response(ARTICLE_HTML, { status: 200 }),
        ocr: async () => "ocr text",
      }),
    );
    const note = captureNote(t.db, { body: "a note" });
    const link = captureLink(t.db, { url: "https://example.test/p" });
    const pdf = captureFile(t.db, { bytes: MINIMAL_PDF, name: "h.pdf", mime: "application/pdf" });
    const img = captureFile(t.db, { bytes: Buffer.from("x"), name: "i.png", mime: "image/png" });

    while (await worker.runOnce()) {
      /* drain */
    }

    for (const item of [note, link, pdf, img]) {
      expect(getItem(t.db, item.id)?.status).toBe("ready");
    }
    expect(getItem(t.db, link.id)?.title).toMatch(/Test Article/);
    expect(getItem(t.db, pdf.id)?.extractedText).toBe("Hello Brain");
    expect(getItem(t.db, img.id)?.extractedText).toBe("ocr text");
    expect(countChunkVectors(t.db)).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/jobs/handlers/index.test.ts`
Expected: FAIL, type error on `fetchImpl` and items never reach ready.

- [ ] **Step 7: Register every handler**

Replace `src/jobs/handlers/index.ts`:

```ts
import type { DB } from "@/db/client";
import type { JobHandlers } from "@/jobs/worker";
import type { EmbedProvider } from "@/providers/embed/types";
import type { FetchLike } from "@/domain/items/links";
import type { PdfExtractFn, OcrFn } from "@/domain/items/extract";
import { createEmbedHandler } from "./embed";
import { createFetchLinkHandler } from "./fetch-link";
import { createExtractPdfHandler } from "./extract-pdf";
import { createOcrImageHandler } from "./ocr-image";

export interface HandlerDeps {
  db: DB;
  embed: EmbedProvider | null;
  fetchImpl?: FetchLike;
  extractPdf?: PdfExtractFn;
  ocr?: OcrFn;
}

export function createJobHandlers(deps: HandlerDeps): JobHandlers {
  return {
    embed: createEmbedHandler({ db: deps.db, embed: deps.embed }),
    fetch_link: createFetchLinkHandler({ db: deps.db, fetchImpl: deps.fetchImpl }),
    extract_pdf: createExtractPdfHandler({ db: deps.db, extract: deps.extractPdf }),
    ocr_image: createOcrImageHandler({ db: deps.db, ocr: deps.ocr }),
  };
}
```

- [ ] **Step 8: Run all tests**

Run: `npm test`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: capture functions for notes, links, and files with full job registry

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 11: API routes

**Files:**
- Create: `src/lib/dto.ts`, `src/lib/api.ts`, `src/app/api/items/route.ts`, `src/app/api/items/[id]/route.ts`, `src/app/api/items/[id]/retry/route.ts`, `src/app/api/items/[id]/file/route.ts`, `src/app/api/upload/route.ts`, `src/app/api/search/route.ts`, `src/app/api/tags/route.ts`
- Test: `src/app/api/api.test.ts`

**Interfaces:**
- Consumes: capture functions, items domain, `search`, `retryFailedJobsForItem`, `getDb`, `getEmbedProvider`.
- Produces (HTTP, all JSON unless noted):
  - `POST /api/items` body `{ type: "note", title?, body, tags? }` or `{ type: "link", url, title?, tags? }` → 201 `ItemDTO`
  - `GET /api/items?type=&status=&tag=&limit=&offset=` → `ItemDTO[]`
  - `GET /api/items/:id` → `ItemDTO`; `PATCH /api/items/:id` body `{ title?, body?, tags? }` → `ItemDTO`; `DELETE /api/items/:id` → 204
  - `POST /api/items/:id/retry` → `{ retried: number }`
  - `GET /api/items/:id/file` → the stored file bytes with its mime type
  - `POST /api/upload` multipart `file`, optional `tags` (comma separated) → 201 `ItemDTO`; audio → 415
  - `GET /api/search?q=&type=&tag=&from=&to=&limit=` → `SearchResultDTO[]`
  - `GET /api/tags` → `string[]`
  - Types `ItemDTO`, `SearchResultDTO` in `@/lib/dto`; `serializeItem(db, item): ItemDTO`, `errorResponse(err): Response`, `parseId(raw): number` in `@/lib/api`.

- [ ] **Step 1: Write the failing API test**

Create `src/app/api/api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { useTempDataDir } from "@/test/db";
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
  dir = useTempDataDir();
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
  const worker = new JobWorker(getDb(), createJobHandlers({ db: getDb(), embed: createFakeEmbedProvider() }));
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

    expect((await routes.item.DELETE(json("DELETE", `/api/items/${dto.id}`), params(dto.id))).status).toBe(204);
    expect((await routes.item.GET(json("GET", `/api/items/${dto.id}`), params(dto.id))).status).toBe(404);
  });

  it("rejects invalid bodies", async () => {
    expect((await routes.items.POST(json("POST", "/api/items", { type: "note" }))).status).toBe(400);
    expect((await routes.items.POST(json("POST", "/api/items", { type: "link", url: "nope" }))).status).toBe(400);
  });

  it("uploads a pdf, serves it back, and rejects audio", async () => {
    const form = new FormData();
    form.append("file", new File([MINIMAL_PDF], "hello.pdf", { type: "application/pdf" }));
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

    const audio = new FormData();
    audio.append("file", new File([Buffer.from("x")], "call.m4a", { type: "audio/mp4" }));
    expect((await routes.upload.POST(new Request("http://localhost/api/upload", { method: "POST", body: audio }))).status).toBe(415);
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
    expect((await (await routes.tags.GET()).json()) as string[]).toContain("docs");
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/app/api/api.test.ts`
Expected: FAIL, cannot resolve `./items/route`.

- [ ] **Step 3: Write the DTO and API helpers**

Create `src/lib/dto.ts`:

```ts
import type { ItemStatus, ItemType } from "@/db/schema";

export interface ItemDTO {
  id: number;
  type: ItemType;
  title: string;
  body: string;
  status: ItemStatus;
  error: string | null;
  sourceUrl: string | null;
  filePath: string | null;
  mimeType: string | null;
  extractedText: string;
  meta: Record<string, unknown>;
  tags: string[];
  journalDate: string | null;
  reviewWeek: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResultDTO {
  item: ItemDTO;
  snippet: string;
  score: number;
  chunkId: number;
}
```

Create `src/lib/api.ts`:

```ts
import { NextResponse } from "next/server";
import type { DB } from "@/db/client";
import type { Item } from "@/db/schema";
import { getItemTags, parseMeta } from "@/domain/items";
import { CaptureError } from "@/domain/items/capture";
import type { ItemDTO } from "./dto";

export function serializeItem(db: DB, item: Item): ItemDTO {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    body: item.body,
    status: item.status,
    error: item.error,
    sourceUrl: item.sourceUrl,
    filePath: item.filePath,
    mimeType: item.mimeType,
    extractedText: item.extractedText,
    meta: parseMeta(item),
    tags: getItemTags(db, item.id),
    journalDate: item.journalDate,
    reviewWeek: item.reviewWeek,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof CaptureError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[api]", message);
  return NextResponse.json({ error: message }, { status: 500 });
}

/** Parse a positive integer route param. Throws CaptureError(400) otherwise. */
export function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new CaptureError(`Invalid id: ${raw}`, 400);
  return id;
}
```

- [ ] **Step 4: Write the routes**

Create `src/app/api/items/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ITEM_STATUSES, ITEM_TYPES } from "@/db/schema";
import { listItems } from "@/domain/items";
import { captureNote, captureLink } from "@/domain/items/capture";
import { errorResponse, serializeItem } from "@/lib/api";

export const dynamic = "force-dynamic";

const NoteBody = z.object({
  type: z.literal("note"),
  title: z.string().optional(),
  body: z.string().min(1),
  tags: z.array(z.string()).optional(),
});
const LinkBody = z.object({
  type: z.literal("link"),
  url: z.url(),
  title: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const CreateBody = z.discriminatedUnion("type", [NoteBody, LinkBody]);

export async function POST(req: Request): Promise<Response> {
  try {
    const parsed = CreateBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    const item = parsed.data.type === "note" ? captureNote(db, parsed.data) : captureLink(db, parsed.data);
    return NextResponse.json(serializeItem(db, item), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

const TypeParam = z.enum(ITEM_TYPES).optional();
const StatusParam = z.enum(ITEM_STATUSES).optional();

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const type = TypeParam.parse(url.searchParams.get("type") ?? undefined);
    const status = StatusParam.parse(url.searchParams.get("status") ?? undefined);
    const tag = url.searchParams.get("tag") ?? undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const db = getDb();
    return NextResponse.json(listItems(db, { type, status, tag, limit, offset }).map((i) => serializeItem(db, i)));
  } catch (err) {
    return errorResponse(err);
  }
}
```

Create `src/app/api/items/[id]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { deleteItem, getItem } from "@/domain/items";
import { updateItemContent } from "@/domain/items/capture";
import { errorResponse, parseId, serializeItem } from "@/lib/api";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const db = getDb();
    const item = getItem(db, id);
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(serializeItem(db, item));
  } catch (err) {
    return errorResponse(err);
  }
}

const PatchBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const parsed = PatchBody.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const db = getDb();
    const item = updateItemContent(db, id, parsed.data);
    return NextResponse.json(serializeItem(db, item));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const db = getDb();
    if (!getItem(db, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    deleteItem(db, id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Create `src/app/api/items/[id]/retry/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getItem } from "@/domain/items";
import { retryFailedJobsForItem } from "@/jobs/queue";
import { errorResponse, parseId } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const db = getDb();
    if (!getItem(db, id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ retried: retryFailedJobsForItem(db, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Create `src/app/api/items/[id]/file/route.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { getItem } from "@/domain/items";
import { absoluteFilePath } from "@/lib/files";
import { errorResponse, parseId } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const id = parseId((await ctx.params).id);
    const item = getItem(getDb(), id);
    if (!item || !item.filePath) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const abs = absoluteFilePath(item.filePath);
    if (!fs.existsSync(abs)) return NextResponse.json({ error: "File missing on disk" }, { status: 404 });
    const bytes = fs.readFileSync(abs);
    return new Response(bytes, {
      headers: {
        "content-type": item.mimeType ?? "application/octet-stream",
        "content-disposition": `inline; filename="${path.basename(item.filePath).replace(/"/g, "")}"`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Create `src/app/api/upload/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { captureFile } from "@/domain/items/capture";
import { errorResponse, serializeItem } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Missing file field" }, { status: 400 });
    const tagsRaw = form.get("tags");
    const tags = typeof tagsRaw === "string" ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    const bytes = Buffer.from(await file.arrayBuffer());
    const db = getDb();
    const item = captureFile(db, { bytes, name: file.name || "upload", mime: file.type || "application/octet-stream", tags });
    return NextResponse.json(serializeItem(db, item), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
```

Create `src/app/api/search/route.ts`:

```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/db/client";
import { ITEM_TYPES } from "@/db/schema";
import { search } from "@/domain/search";
import { getEmbedProvider } from "@/server/providers";
import { errorResponse, serializeItem } from "@/lib/api";
import type { SearchResultDTO } from "@/lib/dto";

export const dynamic = "force-dynamic";

const Query = z.object({
  q: z.string().default(""),
  type: z.enum(ITEM_TYPES).optional(),
  tag: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw = Object.fromEntries([...url.searchParams.entries()].filter(([, v]) => v !== ""));
    const parsed = Query.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const { q, limit, ...filter } = parsed.data;
    const db = getDb();
    const results = await search(db, getEmbedProvider(), q, filter, limit);
    const body: SearchResultDTO[] = results.map((r) => ({
      item: serializeItem(db, r.item),
      snippet: r.snippet,
      score: r.score,
      chunkId: r.chunkId,
    }));
    return NextResponse.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
```

Create `src/app/api/tags/route.ts`:

```ts
import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { listTagNames } from "@/domain/items";
import { errorResponse } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    return NextResponse.json(listTagNames(getDb()));
  } catch (err) {
    return errorResponse(err);
  }
}
```

- [ ] **Step 5: Run the API test and the full suite**

Run: `npx vitest run src/app/api/api.test.ts`
Expected: 5 passed.

Run: `npm test` then `npm run build`
Expected: all tests pass, build succeeds.

- [ ] **Step 6: Smoke the routes against the dev server**

```bash
npm run dev &
sleep 8
curl -s -X POST localhost:3141/api/items -H 'content-type: application/json' -d '{"type":"note","body":"Dev smoke note about lemon trees","tags":["smoke"]}'
sleep 3
curl -s 'localhost:3141/api/search?q=lemon' | head -c 400
kill %1
```

Expected: the first call returns a 201 JSON item; after the worker embeds it (the dev log shows `job 1 embed done`), the search returns it with a snippet. The first embed on a fresh data directory downloads the model and can take a minute; wait for `job 1 embed done` before searching.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: items, upload, search, tags, retry, and file api routes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 12: Capture screen

**Files:**
- Create: `src/lib/format.ts`, `src/components/badges.tsx`, `src/components/capture-box.tsx`, `src/components/recent-captures.tsx`, `src/components/capture-screen.tsx`
- Modify: `src/app/capture/page.tsx`
- Test: `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `ItemDTO`, `isProbablyUrl` from `@/lib/text`, `POST /api/items`, `POST /api/upload`, `GET /api/items`.
- Produces: `formatDate(iso)`, `formatDateTime(iso)`, `relativeTime(iso, now?)` in `@/lib/format`; `TypeBadge`, `StatusBadge` in `@/components/badges`; `CaptureBox({ onCaptured })`, `RecentCaptures({ refreshKey })`, `CaptureScreen()`.

- [ ] **Step 1: Write the failing format test**

Create `src/lib/format.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { relativeTime, formatDate } from "./format";

describe("format", () => {
  const now = new Date("2026-09-12T12:00:00Z").getTime();
  it("renders relative times in compact form", () => {
    expect(relativeTime("2026-09-12T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-12T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-09-12T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-09-10T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-01-05T12:00:00Z", now)).toBe(formatDate("2026-01-05T12:00:00Z"));
  });
  it("formats dates as dd Mon yyyy", () => {
    expect(formatDate("2026-01-05T12:00:00Z")).toMatch(/^0?5 Jan 2026$/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/format.test.ts`
Expected: FAIL, cannot resolve `./format`.

- [ ] **Step 3: Implement format helpers**

Create `src/lib/format.ts`:

```ts
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return `${formatDate(iso)} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatDate(iso);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/format.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Write the badges**

Create `src/components/badges.tsx`:

```tsx
import type { ItemStatus, ItemType } from "@/db/enums";

const TYPE_LABEL: Record<ItemType, string> = {
  note: "NOTE",
  link: "LINK",
  file: "FILE",
  meeting: "MTG",
  journal: "JRNL",
  review: "REVW",
};

export function TypeBadge({ type }: { type: ItemType }) {
  return (
    <span className="font-mono text-[10px] tracking-wider text-fg-muted border border-line rounded-sm px-1.5 py-0.5 leading-none">
      {TYPE_LABEL[type]}
    </span>
  );
}

const STATUS: Record<ItemStatus, { dot: string; label: string; text: string }> = {
  pending: { dot: "bg-fg-faint", label: "queued", text: "text-fg-muted" },
  processing: { dot: "bg-accent live-dot", label: "processing", text: "text-accent" },
  ready: { dot: "bg-success", label: "ready", text: "text-fg-muted" },
  failed: { dot: "bg-danger", label: "failed", text: "text-danger" },
};

export function StatusBadge({ status, error }: { status: ItemStatus; error?: string | null }) {
  const s = STATUS[status];
  return (
    <span title={error ?? undefined} className={`inline-flex items-center gap-1.5 font-mono text-[10px] ${s.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
```

- [ ] **Step 6: Write the capture box**

Create `src/components/capture-box.tsx`:

```tsx
"use client";

import { useCallback, useRef, useState } from "react";
import { isProbablyUrl } from "@/lib/text";
import type { ItemDTO } from "@/lib/dto";

interface Props {
  onCaptured: (item: ItemDTO) => void;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

export function CaptureBox({ onCaptured }: Props) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const mode: "note" | "link" | "file" = files.length ? "file" : isProbablyUrl(text) ? "link" : "note";
  const canSubmit = !busy && (text.trim().length > 0 || files.length > 0);

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    setBusy(true);
    setError(null);
    try {
      const created: ItemDTO[] = [];
      for (const file of files) {
        const form = new FormData();
        form.append("file", file);
        form.append("tags", tagList.join(","));
        const res = await fetch("/api/upload", { method: "POST", body: form });
        if (!res.ok) throw new Error(await readError(res));
        created.push((await res.json()) as ItemDTO);
      }
      if (text.trim()) {
        const body = isProbablyUrl(text)
          ? { type: "link", url: text.trim(), tags: tagList }
          : { type: "note", body: text, tags: tagList };
        const res = await fetch("/api/items", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(await readError(res));
        created.push((await res.json()) as ItemDTO);
      }
      setText("");
      setFiles([]);
      created.forEach(onCaptured);
      textareaRef.current?.focus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [canSubmit, files, text, tags, onCaptured]);

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        setFiles((f) => [...f, ...Array.from(e.dataTransfer.files)]);
      }}
      className={`rounded-lg border bg-surface-1 transition-colors duration-150 ${dragging ? "border-accent" : "border-line"}`}
    >
      <div className="flex items-center justify-between px-4 h-9 border-b border-line">
        <span className="font-mono text-[10px] tracking-wider text-fg-muted uppercase">
          {mode === "file" ? `${files.length} file${files.length > 1 ? "s" : ""}` : mode}
        </span>
        <span className="font-mono text-[10px] text-fg-faint">⌘↵ to capture</span>
      </div>
      <textarea
        ref={textareaRef}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            setFiles((f) => [...f, ...pasted]);
          }
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder="Type a thought, paste a link, or drop a file"
        rows={6}
        className="w-full resize-y bg-transparent px-4 py-3 outline-none leading-relaxed"
      />
      {files.length > 0 && (
        <ul className="px-4 pb-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="font-mono text-[11px] bg-surface-3 border border-line rounded-sm px-2 py-1 flex items-center gap-2">
              {f.name}
              <button type="button" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))} className="text-fg-faint hover:text-danger">
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3 px-4 h-11 border-t border-line">
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="tags, comma separated"
          className="flex-1 bg-transparent outline-none text-[13px]"
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => setFiles((f) => [...f, ...Array.from(e.target.files ?? [])])}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="text-[12px] text-fg-muted hover:text-fg transition-colors duration-150"
        >
          Attach
        </button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => void submit()}
          className="h-7 px-3 rounded-md text-[12px] font-medium bg-accent text-bg disabled:opacity-40 transition-opacity duration-150"
        >
          {busy ? "Capturing" : "Capture"}
        </button>
      </div>
      {error && <div className="px-4 py-2 text-[12px] text-danger border-t border-line">{error}</div>}
    </section>
  );
}
```

- [ ] **Step 7: Write the recent captures list and the screen**

Create `src/components/recent-captures.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ItemDTO } from "@/lib/dto";
import { relativeTime } from "@/lib/format";
import { StatusBadge, TypeBadge } from "./badges";

export function RecentCaptures({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<ItemDTO[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const res = await fetch("/api/items?limit=10", { cache: "no-store" });
        if (!res.ok) throw new Error(res.statusText);
        const data = (await res.json()) as ItemDTO[];
        if (cancelled) return;
        setItems(data);
        const active = data.some((i) => i.status === "pending" || i.status === "processing");
        timer = setTimeout(load, active ? 1500 : 8000);
      } catch {
        if (!cancelled) timer = setTimeout(load, 8000);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshKey]);

  if (items.length === 0) return null;

  return (
    <section>
      <h2 className="font-mono text-[10px] tracking-wider uppercase text-fg-faint mb-2">Recent</h2>
      <ul className="border border-line rounded-lg divide-y divide-line bg-surface-1">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 h-9 hover:bg-surface-2 transition-colors duration-150">
            <TypeBadge type={item.type} />
            <Link href={`/items/${item.id}`} className="flex-1 truncate text-[13px] hover:text-accent">
              {item.title}
            </Link>
            <StatusBadge status={item.status} error={item.error} />
            <span className="font-mono text-[10px] text-fg-faint w-16 text-right">{relativeTime(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Create `src/components/capture-screen.tsx`:

```tsx
"use client";

import { useState } from "react";
import { CaptureBox } from "./capture-box";
import { RecentCaptures } from "./recent-captures";

export function CaptureScreen() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="w-full max-w-3xl mx-auto p-6 flex flex-col gap-6">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-medium tracking-tight">Capture</h1>
        <span className="font-mono text-[10px] text-fg-faint">notes · links · pdf · images</span>
      </header>
      <CaptureBox onCaptured={() => setRefreshKey((k) => k + 1)} />
      <RecentCaptures refreshKey={refreshKey} />
    </div>
  );
}
```

Replace `src/app/capture/page.tsx`:

```tsx
import { CaptureScreen } from "@/components/capture-screen";

export default function CapturePage() {
  return <CaptureScreen />;
}
```

- [ ] **Step 8: Build, run, and verify in the browser**

Run: `npm test && npm run build`
Expected: tests pass, build succeeds with no type errors.

Run `npm run dev &`, `sleep 8`, then:

```bash
curl -s http://localhost:3141/capture | grep -o "Type a thought" | head -1
```

Expected: `Type a thought`. Then open `http://localhost:3141/capture` in a browser, type a note, press ⌘↵, and confirm it appears under Recent and moves from queued to ready within a few seconds. Paste `https://en.wikipedia.org/wiki/Zettelkasten` and capture it; the title should change from the url to the article title once processed. Kill the dev server.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: capture screen with unified note, link, and file input

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 13: Library and item pages

**Files:**
- Create: `src/components/item-editor.tsx`, `src/app/items/[id]/page.tsx`
- Modify: `src/app/library/page.tsx`, `src/app/globals.css`, `package.json` (adds `react-markdown`)

**Interfaces:**
- Consumes: `getDb`, `listItems`, `listTagNames`, `getItem`, `serializeItem`, `ItemDTO`, badges, format helpers, `PATCH /api/items/:id`, `POST /api/items/:id/retry`, `DELETE /api/items/:id`, `GET /api/items/:id/file`.
- Produces: `ItemEditor({ initial: ItemDTO })`, the `/library` page with `?type=&status=&tag=` filters, and the `/items/[id]` page.

- [ ] **Step 1: Install the markdown renderer and add markdown styles**

Run: `npm install react-markdown`

Append to `src/app/globals.css`:

```css
.md {
  line-height: 1.65;
}
.md h1,
.md h2,
.md h3 {
  font-weight: 500;
  letter-spacing: -0.01em;
  margin: 1.2em 0 0.4em;
}
.md h1 {
  font-size: 1.35rem;
}
.md h2 {
  font-size: 1.15rem;
}
.md h3 {
  font-size: 1rem;
}
.md p,
.md ul,
.md ol,
.md pre,
.md blockquote {
  margin: 0.6em 0;
}
.md ul,
.md ol {
  padding-left: 1.4em;
}
.md ul {
  list-style: disc;
}
.md ol {
  list-style: decimal;
}
.md a {
  color: var(--color-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background: var(--color-surface-3);
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.md pre {
  background: var(--color-surface-2);
  border: 1px solid var(--color-line);
  border-radius: 6px;
  padding: 0.75em 1em;
  overflow-x: auto;
}
.md pre code {
  background: none;
  padding: 0;
}
.md blockquote {
  border-left: 2px solid var(--color-line-strong);
  padding-left: 0.9em;
  color: var(--color-fg-muted);
}
.md hr {
  border: 0;
  border-top: 1px solid var(--color-line);
  margin: 1.2em 0;
}
```

- [ ] **Step 2: Write the library page**

Replace `src/app/library/page.tsx`:

```tsx
import Link from "next/link";
import { getDb } from "@/db/client";
import { ITEM_STATUSES, ITEM_TYPES, type ItemStatus, type ItemType } from "@/db/enums";
import { listItems, listTagNames } from "@/domain/items";
import { StatusBadge, TypeBadge } from "@/components/badges";
import { relativeTime } from "@/lib/format";

export const dynamic = "force-dynamic";

type SP = { type?: string; status?: string; tag?: string };

function isType(v: string | undefined): v is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(v ?? "");
}
function isStatus(v: string | undefined): v is ItemStatus {
  return (ITEM_STATUSES as readonly string[]).includes(v ?? "");
}

export default async function LibraryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const type = isType(sp.type) ? sp.type : undefined;
  const status = isStatus(sp.status) ? sp.status : undefined;
  const tag = sp.tag || undefined;
  const db = getDb();
  const items = listItems(db, { type, status, tag, limit: 200 });
  const tags = listTagNames(db);

  const href = (patch: Partial<SP>) => {
    const merged: SP = { ...sp, ...patch };
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/library${s ? `?${s}` : ""}`;
  };
  const chip = (active: boolean) =>
    `h-6 px-2 rounded-sm font-mono text-[10px] tracking-wider uppercase border transition-colors duration-150 ${
      active ? "border-accent text-accent bg-accent-dim" : "border-line text-fg-muted hover:text-fg"
    }`;

  return (
    <div className="w-full max-w-5xl mx-auto p-6 flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-medium tracking-tight">Library</h1>
        <span className="font-mono text-[10px] text-fg-faint">{items.length} shown</span>
      </header>

      <div className="flex flex-wrap gap-2 items-center">
        <Link href={href({ type: undefined })} className={chip(!type)}>
          all
        </Link>
        {ITEM_TYPES.map((t) => (
          <Link key={t} href={href({ type: t })} className={chip(type === t)}>
            {t}
          </Link>
        ))}
        <span className="w-px h-4 bg-line mx-1" />
        {ITEM_STATUSES.map((s) => (
          <Link key={s} href={href({ status: status === s ? undefined : s })} className={chip(status === s)}>
            {s}
          </Link>
        ))}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2 items-center">
          {tags.map((t) => (
            <Link key={t} href={href({ tag: tag === t ? undefined : t })} className={chip(tag === t)}>
              #{t}
            </Link>
          ))}
        </div>
      )}

      <ul className="border border-line rounded-lg divide-y divide-line bg-surface-1">
        {items.length === 0 && <li className="px-3 h-12 flex items-center text-fg-faint text-[13px]">Nothing here yet.</li>}
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 px-3 h-10 hover:bg-surface-2 transition-colors duration-150">
            <span className="font-mono text-[10px] text-fg-faint w-8">#{item.id}</span>
            <TypeBadge type={item.type} />
            <Link href={`/items/${item.id}`} className="flex-1 truncate text-[13px] hover:text-accent">
              {item.title}
            </Link>
            <StatusBadge status={item.status} error={item.error} />
            <span className="font-mono text-[10px] text-fg-faint w-16 text-right">{relativeTime(item.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Write the item editor**

Create `src/components/item-editor.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Markdown from "react-markdown";
import type { ItemDTO } from "@/lib/dto";
import { formatDateTime } from "@/lib/format";
import { StatusBadge, TypeBadge } from "./badges";

const SAVE_DEBOUNCE_MS = 5000;

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function ItemEditor({ initial }: { initial: ItemDTO }) {
  const router = useRouter();
  const [item, setItem] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [save, setSave] = useState<SaveState>("idle");
  const [preview, setPreview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ title, body, tags });
  const userEdited = useRef(false);

  useEffect(() => {
    latest.current = { title, body, tags };
  }, [title, body, tags]);

  const persist = useCallback(
    async (keepalive = false) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      const { title, body, tags } = latest.current;
      setSave("saving");
      try {
        const res = await fetch(`/api/items/${initial.id}`, {
          method: "PATCH",
          keepalive,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, body, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) }),
        });
        if (!res.ok) throw new Error(res.statusText);
        setItem((await res.json()) as ItemDTO);
        setSave("saved");
      } catch {
        setSave("error");
      }
    },
    [initial.id],
  );

  function markDirty() {
    userEdited.current = true;
    setSave("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), SAVE_DEBOUNCE_MS);
  }

  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void persist(true);
      }
    };
  }, [persist]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void persist();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [persist]);

  useEffect(() => {
    if (item.status !== "pending" && item.status !== "processing") return;
    const id = setInterval(async () => {
      const res = await fetch(`/api/items/${initial.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const dto = (await res.json()) as ItemDTO;
      setItem(dto);
      if (!userEdited.current) setTitle(dto.title);
    }, 2000);
    return () => clearInterval(id);
  }, [item.status, initial.id]);

  async function retry() {
    await fetch(`/api/items/${initial.id}/retry`, { method: "POST" });
    setItem((it) => ({ ...it, status: "pending", error: null }));
  }

  async function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await fetch(`/api/items/${initial.id}`, { method: "DELETE" });
    router.push("/library");
  }

  const meta = item.meta as { site_name?: string; byline?: string; page_count?: number; kind?: string };
  const isImage = item.type === "file" && item.mimeType?.startsWith("image/");
  const isPdf = item.type === "file" && item.mimeType === "application/pdf";
  const saveLabel: Record<SaveState, string> = {
    idle: "",
    dirty: "unsaved · autosaves in 5s",
    saving: "saving",
    saved: "saved",
    error: "save failed",
  };

  return (
    <div className="w-full max-w-4xl mx-auto p-6 flex flex-col gap-4">
      <header className="flex items-center gap-3 h-8">
        <Link href="/library" className="font-mono text-[11px] text-fg-muted hover:text-fg">
          ← library
        </Link>
        <span className="font-mono text-[10px] text-fg-faint">#{item.id}</span>
        <TypeBadge type={item.type} />
        <StatusBadge status={item.status} error={item.error} />
        <span className={`font-mono text-[10px] ${save === "error" ? "text-danger" : "text-fg-faint"}`}>{saveLabel[save]}</span>
        <span className="flex-1" />
        {item.status === "failed" && (
          <button onClick={() => void retry()} className="h-7 px-2 rounded-md text-[12px] border border-line hover:border-line-strong">
            Retry
          </button>
        )}
        <button
          onClick={() => setPreview((p) => !p)}
          className={`h-7 px-2 rounded-md text-[12px] border ${preview ? "border-accent text-accent" : "border-line hover:border-line-strong"}`}
        >
          {preview ? "Edit" : "Preview"}
        </button>
        <button
          onClick={() => void remove()}
          onBlur={() => setConfirmDelete(false)}
          className={`h-7 px-2 rounded-md text-[12px] border ${confirmDelete ? "border-danger text-danger" : "border-line hover:border-line-strong"}`}
        >
          {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </header>

      {item.error && <div className="text-[12px] text-danger border border-danger/40 rounded-md px-3 py-2">{item.error}</div>}

      <input
        value={title}
        onChange={(e) => {
          setTitle(e.target.value);
          markDirty();
        }}
        onBlur={() => {
          if (save === "dirty") void persist();
        }}
        className="w-full bg-transparent outline-none text-2xl font-medium tracking-tight"
        placeholder="Untitled"
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-fg-muted">
        <span>created {formatDateTime(item.createdAt)}</span>
        {item.sourceUrl && (
          <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline truncate max-w-md">
            {item.sourceUrl}
          </a>
        )}
        {meta.site_name && <span>{meta.site_name}</span>}
        {meta.byline && <span>by {meta.byline}</span>}
        {meta.page_count !== undefined && <span>{meta.page_count} pages</span>}
        {item.filePath && (
          <a href={`/api/items/${item.id}/file`} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            open file
          </a>
        )}
      </div>

      <input
        value={tags}
        onChange={(e) => {
          setTags(e.target.value);
          markDirty();
        }}
        onBlur={() => {
          if (save === "dirty") void persist();
        }}
        placeholder="tags, comma separated"
        className="w-full bg-transparent outline-none text-[12px] text-fg-muted border-b border-line pb-2"
      />

      {isImage && (
        <img src={`/api/items/${item.id}/file`} alt={item.title} className="max-h-96 rounded-md border border-line object-contain self-start" />
      )}
      {isPdf && (
        <iframe src={`/api/items/${item.id}/file`} title={item.title} className="w-full h-[480px] rounded-md border border-line bg-surface-2" />
      )}

      {preview ? (
        <div className="md min-h-[240px]">
          <Markdown>{body || "*Nothing written yet.*"}</Markdown>
        </div>
      ) : (
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            markDirty();
          }}
          onBlur={() => {
            if (save === "dirty") void persist();
          }}
          placeholder={item.type === "note" ? "Write in markdown" : "Your notes about this item"}
          className="w-full min-h-[240px] resize-y bg-surface-1 border border-line rounded-lg px-4 py-3 outline-none leading-relaxed font-sans"
        />
      )}

      {item.extractedText && (
        <details className="border border-line rounded-lg bg-surface-1">
          <summary className="px-4 h-9 flex items-center cursor-pointer font-mono text-[10px] tracking-wider uppercase text-fg-muted select-none">
            Extracted text · {item.extractedText.length.toLocaleString()} chars
          </summary>
          <pre className="px-4 py-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-fg-muted font-sans max-h-[480px] overflow-y-auto border-t border-line">
            {item.extractedText}
          </pre>
        </details>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the item page**

Create `src/app/items/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getItem } from "@/domain/items";
import { serializeItem } from "@/lib/api";
import { ItemEditor } from "@/components/item-editor";

export const dynamic = "force-dynamic";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) notFound();
  const db = getDb();
  const item = getItem(db, n);
  if (!item) notFound();
  return <ItemEditor key={item.id} initial={serializeItem(db, item)} />;
}
```

- [ ] **Step 5: Build, run, and verify**

Run: `npm test && npm run build`
Expected: pass and success. If the build complains about `<img>` from the Next.js lint rule, keep the plain `<img>` (the source is a same-origin API route) and add `// eslint-disable-next-line @next/next/no-img-element` above it.

Run `npm run dev &`, `sleep 8`, then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3141/library
ID=$(curl -s 'http://localhost:3141/api/items?limit=1' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0]?.id ?? ''))")
[ -n "$ID" ] && curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3141/items/$ID"
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3141/items/999999
```

Expected: `200`, `200` (if an item exists from Task 12), `404`. In the browser: open Library, filter by type, open an item, edit the body, wait five seconds or press ⌘S, reload and confirm the edit persisted, toggle Preview, and delete with the two-click confirm. Kill the dev server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: library with filters and item editor with autosave, preview, retry, and delete

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 14: Search screen and keyboard shortcuts

**Files:**
- Create: `src/components/search-panel.tsx`, `src/components/shortcuts.tsx`
- Modify: `src/app/search/page.tsx`, `src/app/layout.tsx`

**Interfaces:**
- Consumes: `GET /api/search`, `GET /api/tags`, `SearchResultDTO`, badges, format helpers, `NAV_ITEMS`.
- Produces: `SearchPanel()`, `Shortcuts()` (global `g` + letter navigation and `/` to focus search).

- [ ] **Step 1: Write the search panel**

Create `src/components/search-panel.tsx`:

```tsx
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { SearchResultDTO } from "@/lib/dto";
import { ITEM_TYPES } from "@/db/enums";
import { relativeTime } from "@/lib/format";
import { StatusBadge, TypeBadge } from "./badges";

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length > 1);
  if (terms.length === 0) return <>{text}</>;
  const pattern = `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
  const splitter = new RegExp(pattern, "gi");
  const matcher = new RegExp(pattern, "i");
  return (
    <>
      {text.split(splitter).map((part, i) =>
        matcher.test(part) ? (
          <mark key={i} className="bg-accent-dim text-fg rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function SearchPanel() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResultDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/tags")
      .then((r) => (r.ok ? r.json() : []))
      .then((t: string[]) => setTags(t))
      .catch(() => setTags([]));
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const p = new URLSearchParams({ q });
        if (type) p.set("type", type);
        if (tag) p.set("tag", tag);
        if (from) p.set("from", from);
        if (to) p.set("to", to);
        const res = await fetch(`/api/search?${p.toString()}`, { signal: ctrl.signal });
        if (res.ok) setResults((await res.json()) as SearchResultDTO[]);
      } catch {
        /* aborted or offline */
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, type, tag, from, to]);

  const select = "h-7 bg-surface-2 border border-line rounded-sm px-2 font-mono text-[11px] text-fg-muted outline-none";
  const status = useMemo(() => {
    if (loading) return "searching";
    if (!q.trim()) return "type to search";
    return `${results.length} result${results.length === 1 ? "" : "s"}`;
  }, [loading, q, results.length]);

  return (
    <div className="w-full max-w-4xl mx-auto p-6 flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-lg font-medium tracking-tight">Search</h1>
        <span className="font-mono text-[10px] text-fg-faint">{status}</span>
      </header>

      <div className="flex items-center gap-2 h-11 px-4 rounded-lg border border-line bg-surface-1 focus-within:border-accent transition-colors duration-150">
        <span className="font-mono text-fg-faint">/</span>
        <input
          ref={inputRef}
          id="search-input"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search everything, by keyword or meaning"
          className="flex-1 bg-transparent outline-none"
        />
        {loading && <span className="w-1.5 h-1.5 rounded-full bg-accent live-dot" />}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className={select}>
          <option value="">any type</option>
          {ITEM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} className={select}>
          <option value="">any tag</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={select} />
        <span className="font-mono text-[10px] text-fg-faint">to</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={select} />
      </div>

      <ul className="flex flex-col gap-2">
        {results.map((r) => (
          <li key={r.item.id} className="rounded-lg border border-line bg-surface-1 px-4 py-3 hover:border-line-strong transition-colors duration-150">
            <div className="flex items-center gap-3">
              <TypeBadge type={r.item.type} />
              <Link href={`/items/${r.item.id}`} className="flex-1 truncate text-[13.5px] font-medium hover:text-accent">
                {r.item.title}
              </Link>
              <StatusBadge status={r.item.status} />
              <span className="font-mono text-[10px] text-fg-faint">{relativeTime(r.item.createdAt)}</span>
            </div>
            <p className="mt-1.5 text-[12.5px] text-fg-muted leading-relaxed">
              <Highlight text={r.snippet} query={q} />
            </p>
            {r.item.tags.length > 0 && (
              <div className="mt-1.5 flex gap-2">
                {r.item.tags.map((t) => (
                  <span key={t} className="font-mono text-[10px] text-fg-faint">
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Write the shortcuts component and wire it up**

Create `src/components/shortcuts.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { NAV_ITEMS } from "./sidebar";

const SEQUENCE_WINDOW_MS = 900;

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** `g` then a letter jumps between views; `/` focuses the search box when present. */
export function Shortcuts() {
  const router = useRouter();
  useEffect(() => {
    let pendingG = 0;
    const byLetter = new Map(NAV_ITEMS.filter((n) => n.enabled).map((n) => [n.shortcut.split(" ")[1], n.href]));
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === "/") {
        const input = document.getElementById("search-input") as HTMLInputElement | null;
        if (input) {
          e.preventDefault();
          input.focus();
        } else {
          router.push("/search");
        }
        return;
      }
      const now = Date.now();
      if (e.key === "g") {
        pendingG = now;
        return;
      }
      if (pendingG && now - pendingG < SEQUENCE_WINDOW_MS) {
        const href = byLetter.get(e.key);
        pendingG = 0;
        if (href) {
          e.preventDefault();
          router.push(href);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
```

In `src/app/layout.tsx`, add `import { Shortcuts } from "@/components/shortcuts";` and render `<Shortcuts />` next to `<CommandPalette />`.

Replace `src/app/search/page.tsx`:

```tsx
import { SearchPanel } from "@/components/search-panel";

export default function SearchPage() {
  return <SearchPanel />;
}
```

- [ ] **Step 3: Build, run, and verify**

Run: `npm test && npm run build`
Expected: pass and success.

Run `npm run dev &`, `sleep 8`, `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3141/search` → `200`. In the browser: press `g l` on any page and confirm navigation to Library, press `/` and confirm the search box focuses, search for a word from a note captured in Task 12 and confirm a highlighted snippet appears, then filter by type. Kill the dev server.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: search screen with filters and highlighted snippets, global shortcuts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```

---

### Task 15: End-to-end smoke, lint, and README

**Files:**
- Create: `README.md`
- Modify: anything lint reports

- [ ] **Step 1: Lint and fix**

Run: `npm run lint`
Expected: no errors. Fix any reported issue in place (unused imports, the `<img>` rule handled as described in Task 13).

- [ ] **Step 2: Full end-to-end run against a fresh data directory**

```bash
export SB_DATA_DIR=$(mktemp -d)
npm run build && npm start &
sleep 6
curl -s -X POST localhost:3141/api/items -H 'content-type: application/json' -d '{"type":"note","body":"# Sourdough\n\nFeed the starter twice daily.","tags":["kitchen"]}'
curl -s -X POST localhost:3141/api/items -H 'content-type: application/json' -d '{"type":"link","url":"https://en.wikipedia.org/wiki/Zettelkasten"}'
```

Create the PDF fixture on disk and upload it:

```bash
printf '%%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n4 0 obj << /Length 42 >> stream\nBT /F1 18 Tf 20 40 Td (Hello Brain) Tj ET\nendstream endobj\n5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\ntrailer << /Root 1 0 R >>\n%%%%EOF' > /tmp/sb-smoke.pdf
curl -s -F file=@/tmp/sb-smoke.pdf -F tags=docs localhost:3141/api/upload
sleep 90
curl -s 'localhost:3141/api/items' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const i of JSON.parse(s))console.log(i.id,i.type,i.status,'|',i.title)})"
curl -s 'localhost:3141/api/search?q=starter+feeding' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const r of JSON.parse(s))console.log(r.item.type,'|',r.item.title,'|',r.snippet.slice(0,80))})"
curl -s 'localhost:3141/api/search?q=hello+brain' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)[0]?.item.title))"
kill %1
```

Expected: all three items report `ready` (the first run downloads the embedding model, hence the 90 second wait; extend it if the machine is slow), the sourdough note is the first search result with "Feed the starter" in the snippet, and the PDF search returns the PDF's title. The Wikipedia link should show the article title rather than the url.

- [ ] **Step 3: Write the README**

Create `README.md`:

```markdown
# Second Brain

A personal capture, search, task, and meeting system that runs locally on a Mac. Stage one covers capture (notes, links, PDFs, images), background processing, and hybrid keyword plus semantic search.

## Run in development

    npm install
    npm run dev

Open http://localhost:3141. Data lives in `~/Library/Application Support/second-brain/` (override with `SB_DATA_DIR`). The first capture downloads the embedding model (about 35 MB) into the `models/` folder there.

## Run tests

    npm test

The transformers embedding test downloads the model into `~/.cache/second-brain-test-models` on first run.

## Environment

| Variable | Purpose |
|---|---|
| `SB_DATA_DIR` | Data directory. Defaults to Application Support. |
| `SB_EMBED` | Set to `off` to disable semantic search and run keyword-only. |

## Keyboard

| Keys | Action |
|---|---|
| `⌘K` | Command palette |
| `g c`, `g l`, `g s` | Go to Capture, Library, Search |
| `/` | Focus search |
| `⌘↵` | Capture |
| `⌘S` | Save item |

## Design docs

- Spec: `docs/superpowers/specs/2026-09-12-second-brain-design.md`
- Plans: `docs/superpowers/plans/`
```

- [ ] **Step 4: Final test run and commit**

Run: `npm test && npm run build`
Expected: all pass, build succeeds.

```bash
git add -A
git commit -m "docs: readme for running and testing the foundation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QYJrz3x3KjYd5nuXomA55j"
```
