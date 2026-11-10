/** `@handle` in free text. Lives in `lib` rather than `@/domain/people` because the add-task box
 * reads it in the browser, and that module pulls in drizzle and the schema with it. */
const MENTION = /(^|[^\w@.])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu;

/** Lowercased handles after `@`, excluding email addresses, in order of first appearance. */
export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const handle = m[2].toLowerCase().replace(/[.,;:!?]+$/, "");
    if (handle && !out.includes(handle)) out.push(handle);
  }
  return out;
}
