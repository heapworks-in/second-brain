import type { DB } from "@/db/client";
import { getSetting, setSetting } from "@/domain/settings";

const KEY = "identity.names";

/**
 * The spellings of my own name that appear in other people's spreadsheets.
 *
 * The app has never had a notion of who I am, and until an import arrives it never needed one:
 * my own work is a null owner, which cannot be mistyped. A file is different -- it names me in
 * an Owner column, in whatever form the person who built it used ("Avinash", "Avinash V", "AV")
 * -- so this is asked once, at the first import, and reused by every one after it.
 *
 * Stored as one comma-separated setting rather than a table: it is a handful of strings about
 * one person, and a table would need a page to manage it.
 */
export function identityNames(db: DB): string[] {
  return getSetting(db, KEY, "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

export function setIdentityNames(db: DB, names: string[]): string[] {
  const clean = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  setSetting(db, KEY, clean.join(", "));
  return clean;
}
