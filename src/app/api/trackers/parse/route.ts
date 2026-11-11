import { NextResponse } from "next/server";
import { getDb } from "@/db/client";
import { readWorkbook } from "@/domain/trackers/sheet";
import { guessMapping, guessStatusMap, statusWords } from "@/domain/trackers/mapping";
import { identityNames } from "@/domain/trackers/identity";
import { previewImport } from "@/domain/trackers/import";
import { crossSite, errorResponse, forbidden } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Well above any tracker and well below anything that would hurt: a 10 MB spreadsheet is tens
 * of thousands of rows, and a file that size is not a plan, it is an export of a database. */
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Read a spreadsheet and say what importing it would do. Writes nothing.
 *
 * The parsed rows come back to the browser and are posted again to `POST /api/trackers` once
 * the mapping is confirmed. That costs one extra trip of the file's own contents and buys a
 * preview that cannot half-apply: there is no parked upload on the server to expire, resume
 * against a database that has moved, or leave behind when the tab is closed.
 */
export async function POST(req: Request): Promise<Response> {
  if (crossSite(req)) return forbidden();
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a .xlsx file to import" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "That file is larger than 10 MB" }, { status: 413 });
    if (!/\.xlsx$/i.test(file.name)) {
      return NextResponse.json({ error: "Only .xlsx files can be read. In Excel: File › Save As › Excel Workbook (.xlsx)." }, { status: 415 });
    }

    const sheets = await readWorkbook(await file.arrayBuffer());
    const usable = sheets.filter((s) => s.headers.length > 0 && s.rows.length > 0);
    if (usable.length === 0) return NextResponse.json({ error: "No sheet in that file has a header row and any rows under it" }, { status: 422 });

    const db = getDb();
    const names = identityNames(db);
    const chosen = usable[0];
    const columns = guessMapping(chosen.headers);
    const mapping = { columns, theme: "group" as const };
    const statusMap = guessStatusMap(statusWords(chosen.rows, columns.status));
    const plan = previewImport(db, {
      name: chosen.name,
      containerId: null,
      sourceName: file.name,
      sheetName: chosen.name,
      headers: chosen.headers,
      rows: chosen.rows,
      mapping,
      statusMap,
      identityNames: names,
    });

    return NextResponse.json({
      sourceName: file.name,
      // Every sheet is offered; the first usable one is filled in, because most files have one.
      sheets: usable.map((s) => ({ name: s.name, headers: s.headers, rows: s.rows })),
      sheetName: chosen.name,
      mapping,
      statusMap,
      identityNames: names,
      plan,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
