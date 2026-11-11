import ExcelJS from "exceljs";

/** One sheet of a workbook, flattened to text: the header row in the file's own order, and one
 * record per row keyed by header. Everything is a string because a spreadsheet column is not a
 * type -- the same "ETA" column holds a date, "W47" and "mid Nov" in three different rows. */
export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: Record<string, string>[];
}

/**
 * What a cell says, as the person who typed it would read it back.
 *
 * Every branch here is a shape a colleague's real file contains: a formula cell carries its
 * cached `result`, a styled cell carries `richText` runs, a link carries `text` and `hyperlink`,
 * and a date arrives as a `Date` because Excel stores it as a serial number that exceljs has
 * already converted. Returning `[object Object]` for any of them would silently corrupt a column.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // The local calendar day, not the UTC one: a date-only cell is midnight, and west of UTC
    // `toISOString().slice(0, 10)` would hand back the day before.
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  if (typeof value === "object") {
    const v = value as { result?: unknown; richText?: { text?: string }[]; text?: unknown; error?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text ?? "").join("");
    if (v.error !== undefined) return "";
    if (v.result !== undefined) return cellText(v.result);
    if (v.text !== undefined) return cellText(v.text);
    return "";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value).trim();
}

/** A header that is blank, or a duplicate, still has to name a column: an export writes these
 * back, so every column needs a key that is both stable and unique. */
function headerNames(row: unknown[]): string[] {
  const out: string[] = [];
  row.forEach((cell, i) => {
    const base = cellText(cell) || `Column ${i + 1}`;
    let name = base;
    for (let n = 2; out.includes(name); n++) name = `${base} (${n})`;
    out.push(name);
  });
  return out;
}

/**
 * Every sheet of an xlsx file, header row first.
 *
 * The first row that has any text in it is the header: real trackers start with a title row, a
 * blank row, or a frozen banner, and taking row 1 on faith reads a report title as the only
 * column name. Rows above it are dropped, and a row with nothing in any cell is skipped rather
 * than imported as an empty task.
 */
export async function readWorkbook(data: ArrayBuffer): Promise<ParsedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const sheets: ParsedSheet[] = [];
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values = row.values as unknown[];
      // exceljs indexes `values` from 1, so the leading hole is dropped rather than read as a cell.
      rows.push(values.slice(1));
    });
    // A header row is one with at least two named columns: a one-cell row is a title, not a header.
    const headerIndex = rows.findIndex((r) => r.filter((c) => cellText(c) !== "").length >= 2);
    if (headerIndex === -1) {
      sheets.push({ name: ws.name, headers: [], rows: [] });
      return;
    }
    const headers = headerNames(rows[headerIndex]);
    const body = rows.slice(headerIndex + 1).map((r) => {
      const record: Record<string, string> = {};
      headers.forEach((h, i) => {
        record[h] = cellText(r[i]);
      });
      return record;
    });
    sheets.push({ name: ws.name, headers, rows: body.filter((r) => Object.values(r).some((v) => v !== "")) });
  });
  return sheets;
}

/** Write a sheet back out, headers in the given order. One sheet, because that is what an export
 * of one tracker is; the file it came from may have had others, and they are not ours to rewrite. */
export async function writeWorkbook(sheet: { name: string; headers: string[]; rows: Record<string, string>[] }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.name.slice(0, 31) || "Sheet1");
  ws.addRow(sheet.headers);
  ws.getRow(1).font = { bold: true };
  for (const row of sheet.rows) ws.addRow(sheet.headers.map((h) => row[h] ?? ""));
  // Enough width to read without being asked to widen every column by hand.
  sheet.headers.forEach((h, i) => {
    const longest = Math.max(h.length, ...sheet.rows.map((r) => (r[h] ?? "").length));
    ws.getColumn(i + 1).width = Math.min(60, Math.max(10, longest + 2));
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
