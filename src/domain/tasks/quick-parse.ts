import { extractMentions } from "@/lib/mentions";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dateFromToken(token: string, now: Date): string | null {
  const t = token.toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  if (t === "today") return localDay(now);
  if (t === "tomorrow") return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const idx = WEEKDAYS.findIndex((w) => w === t || w.slice(0, 3) === t);
  if (idx === -1) return null;
  const delta = (idx - now.getDay() + 7) % 7; // today counts when it is that weekday
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta));
}

/** `~25m`, `~1h`, `~1h30m`, and an optional `/45m|1h|1h30m` session length: one token, anywhere,
 * at most 8 hours. Priority marks (`!`) must already be stripped: the token has to end at a
 * space or the end of the text. A dangling `~2h/`, half-typed, is read as `~2h`: the slash
 * belongs to the token, so it goes with it rather than being left behind in the title. */
const ESTIMATE_RE = /(?:^|\s)~(?:(\d{1,2})h)?(?:(\d{1,3})m)?(?:\/(?:(\d{1,2})h)?(?:(\d{1,3})m)?)?(?=\s|$)/i;

/** Floor and ceiling for a session length; it must also come in strictly under the estimate. */
const SESSION_MIN = 15;
const SESSION_MAX = 480;

export function estimateFromToken(text: string): { title: string; estimateMinutes: number | null; sessionMinutes: number | null } {
  const m = text.match(ESTIMATE_RE);
  if (!m || (m[1] === undefined && m[2] === undefined)) return { title: text, estimateMinutes: null, sessionMinutes: null };
  const minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  if (minutes < 5 || minutes > 480) return { title: text, estimateMinutes: null, sessionMinutes: null };
  const title = (text.slice(0, m.index) + " " + text.slice(m.index! + m[0].length)).replace(/\s+/g, " ").trim();
  let sessionMinutes: number | null = null;
  if (m[3] !== undefined || m[4] !== undefined) {
    const session = Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
    if (session >= SESSION_MIN && session <= SESSION_MAX && session < minutes) sessionMinutes = session;
  }
  return { title, estimateMinutes: minutes, sessionMinutes };
}

/**
 * Parse "! Title fri" style shortcuts from an add-task input. Pure; `now` is injectable.
 *
 * `requesterHandle` is the first `@handle` in the text, and the handle stays in the title --
 * exactly what `autoLinkMentions` does to an item's body. A handle matching nobody is then still
 * readable text instead of something silently eaten, and a typo never creates a person.
 */
export function quickParse(
  input: string,
  now: Date = new Date(),
): { title: string; priority: "high" | "normal"; dueDate: string | null; estimateMinutes: number | null; sessionMinutes: number | null; requesterHandle: string | null } {
  let title = input.trim();
  let priority: "high" | "normal" = "normal";
  if (title.startsWith("!")) {
    priority = "high";
    title = title.slice(1).trim();
  } else if (title.endsWith("!")) {
    priority = "high";
    title = title.slice(0, -1).trim();
  }
  const est = estimateFromToken(title);
  title = est.title;
  let dueDate: string | null = null;
  const words = title.split(/\s+/);
  if (words.length > 1) {
    const last = words[words.length - 1];
    const parsed = dateFromToken(last, now);
    if (parsed) {
      dueDate = parsed;
      words.pop();
      title = words.join(" ");
      if (title.endsWith("!")) {
        priority = "high";
        title = title.slice(0, -1).trim();
      }
    }
  }
  return { title: title.trim(), priority, dueDate, estimateMinutes: est.estimateMinutes, sessionMinutes: est.sessionMinutes, requesterHandle: extractMentions(input)[0] ?? null };
}
