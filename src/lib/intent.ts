import { isProbablyUrl } from "./text";
import { quickParse } from "@/domain/tasks/quick-parse";

export type Intent =
  | { kind: "note"; body: string }
  | { kind: "link"; url: string }
  | { kind: "task"; title: string; priority: "high" | "normal"; dueDate: string | null; estimateMinutes: number | null; sessionMinutes: number | null; requesterHandle: string | null }
  | { kind: "search"; query: string };

/** `/word` on its own means the same as `/word ` with nothing after it: the kind is chosen,
 * the payload is still empty. */
function rest(text: string, word: string): string | null {
  if (text === word) return "";
  return text.startsWith(`${word} `) ? text.slice(word.length).trim() : null;
}

/** What a line typed into the prompt bar means. Pure; `now` is injectable for the date words. */
export function detectIntent(raw: string, now: Date = new Date()): Intent {
  const text = raw.trim();
  const note = rest(text, "/note");
  if (note !== null) return { kind: "note", body: note };
  const search = rest(text, "/search");
  if (search !== null) return { kind: "search", query: search };
  if (text.startsWith("?")) return { kind: "search", query: text.slice(1).trim() };
  const link = rest(text, "/link");
  if (link !== null) return { kind: "link", url: link };
  const task = rest(text, "/task");
  if (task !== null || text.startsWith("+")) {
    const parsed = quickParse(task ?? text.replace(/^\+\s*/, ""), now);
    return { kind: "task", title: parsed.title, priority: parsed.priority, dueDate: parsed.dueDate, estimateMinutes: parsed.estimateMinutes, sessionMinutes: parsed.sessionMinutes, requesterHandle: parsed.requesterHandle };
  }
  if (isProbablyUrl(text)) return { kind: "link", url: text };
  return { kind: "note", body: text };
}
