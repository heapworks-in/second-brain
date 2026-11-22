/**
 * Check an answer against the sources it claims to come from, sentence by sentence.
 *
 * The prompt already tells the model to use only the sources and to cite as it goes. This is the
 * part that does not take its word for it. A grounded prompt is a request; it fails quietly and it
 * fails most often on exactly the details that matter -- a date, an owner, a number -- because
 * those are the tokens a language model is most willing to supply from habit when the source is
 * nearly but not quite an answer.
 *
 * So nothing reaches a reader unless it can be traced back into their own documents. A sentence
 * that cites nothing, cites a source that was never shown, or states a figure or a name that
 * appears nowhere in what it cites is removed from the answer. What is left is prose whose every
 * sentence points at a span of text you wrote, and the count of what was removed is the only
 * honest measure of how often the model tried.
 *
 * This cannot make a generative model incapable of inventing. It makes an invention that carries a
 * fabricated specific -- which is the kind that does damage -- fail a check that costs nothing and
 * needs no second model. Paraphrase it allows, because a grounded answer is usually a paraphrase;
 * the overlap floor is a guard against a wholly unrelated sentence, not a demand for quotation.
 */

/** Content words below this length carry no evidence -- they are grammar, not claims. */
const MIN_WORD = 4;

/** Content words a sentence needs before its overlap with the source means anything. */
const MIN_WORDS_TO_JUDGE = 4;

/**
 * How much of a sentence's vocabulary must appear in the source it cites.
 *
 * Low on purpose, and it is doing a narrower job than it looks. A true sentence about your notes
 * is a paraphrase and will not reuse most of their words; a sentence about something else entirely
 * shares almost nothing but stopwords. A third is comfortably above the second case and
 * comfortably below the first. The figure and name checks below are what catch a plausible
 * sentence with one wrong detail -- this only catches a sentence that is not about the source.
 */
const MIN_OVERLAP = 0.3;

const STOPWORDS = new Set([
  "about", "after", "again", "also", "because", "been", "before", "being", "between", "both",
  "could", "does", "doing", "during", "each", "from", "further", "have", "having", "here", "into",
  "itself", "more", "most", "only", "other", "over", "same", "should", "some", "such", "than",
  "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under",
  "until", "very", "were", "what", "when", "where", "which", "while", "will", "with", "would",
  "your", "yours",
]);

export type Refusal =
  /** No citation at all, so there is nothing to check it against. */
  | "uncited"
  /** Cites a number that was never a source -- the model inventing its own provenance. */
  | "unknown-source"
  /** States a figure the cited source does not contain. */
  | "figure-not-in-source"
  /** Names somebody or something the cited source does not mention. */
  | "name-not-in-source"
  /** Not about the cited source at all. */
  | "not-in-source";

/** One sentence of an answer, and whether the sources it cites actually say it. */
export interface Claim {
  text: string;
  /** The 1-based source numbers it carried, in the order written. */
  cites: number[];
  supported: boolean;
  /** Which check refused it, when one did. */
  reason?: Refusal;
}

export interface Verification {
  /** The supported sentences, rejoined. Empty when nothing survived. */
  text: string;
  claims: Claim[];
  /** Sentences removed. The rate at which this is non-zero is the thing worth watching. */
  dropped: number;
  /** The 1-based source numbers cited by a sentence that survived, and no others. */
  cited: number[];
}

/** A citation marker, as the prompt asks for it: `[2]`, or `[2, 3]`. */
const CITATION = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;

/**
 * Sentences, with each one's citations still attached.
 *
 * A split on end punctuation followed by the start of something new. It mis-handles an
 * abbreviation mid-sentence, which costs a sentence its evidence and drops it -- the safe
 * direction, and rare in two or three sentences of prose about your own notes.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function citationsIn(sentence: string): number[] {
  const found: number[] = [];
  for (const m of sentence.matchAll(CITATION)) {
    for (const n of m[1].split(",")) {
      const num = Number.parseInt(n.trim(), 10);
      if (Number.isInteger(num)) found.push(num);
    }
  }
  return [...new Set(found)];
}

/** The sentence without its citation markers, so `[2]` is not read as the figure 2. */
const bare = (sentence: string) => sentence.replace(CITATION, " ");

/**
 * Figures: anything numeric, kept as its digits and separators.
 *
 * Compared whole and as written rather than parsed or searched for as a substring. The failure
 * being caught is a wrong *token* -- "week 42" for "week 48", "14 days" for "30 days" -- and both
 * a parse and a substring search blur exactly the difference that matters: "3" occurs inside
 * "2026-11-30", so a substring check would wave through almost any single digit.
 *
 * It is stricter than it needs to be where a source writes a figure one way and the answer
 * another. That is the right direction to be wrong in: the cost is a true sentence dropped, and a
 * reader who sees one fewer sentence still sees the sources underneath it.
 */
const figures = (text: string): string[] => bare(text).match(/\d+(?:[.,:/-]\d+)*%?/g) ?? [];

/**
 * Words that open a sentence without naming anything, so their capital letter means nothing.
 *
 * Small on purpose. Every other capitalised opener is treated as a name and checked, because
 * "Dmitri owns the rollback" is precisely the sentence this exists to catch, and skipping the
 * first word of every sentence -- which is where a model most often puts the owner it invented --
 * left a hole wide enough to walk through. A test found it.
 */
const OPENERS = new Set([
  "the", "this", "that", "these", "those", "it", "its", "they", "their", "we", "our", "he", "she",
  "his", "her", "there", "here", "a", "an", "and", "but", "if", "in", "on", "at", "for", "as",
  "no", "not", "both", "each", "all", "one", "two", "three", "every", "most", "some", "nothing",
  "you", "your", "i", "my", "when", "where", "while", "after", "before", "during", "since", "so",
]);

/**
 * Names: a capitalised word that is not a bare sentence opener.
 *
 * The cheapest reliable signal there is for a fabricated specific. A model that half-knows an
 * answer supplies a plausible owner, team or product, and the source it cites has never heard of
 * them.
 */
const names = (sentence: string): string[] =>
  bare(sentence)
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))
    .filter((w, i) => /^[A-Z][\p{L}'-]{2,}$/u.test(w) && !(i === 0 && OPENERS.has(w.toLowerCase())));

/** How much of a word has to match the source's for the two to count as the same word. */
const STEM = 4;

/**
 * Is this word in the source, allowing for the form it is written in?
 *
 * A name is checked against the source's words rather than searched for as a substring, and two
 * words count as the same when they open with the same four letters. That tolerance is not
 * laziness about matching -- it is the difference between a check and a nuisance. An answer
 * writes "frozen" where the note says "froze", "decisions" where it says "decision"; demanding
 * the exact form would drop true sentences all day, and a verifier that cries wolf gets the whole
 * answer path turned off. Four letters is still far more than an invented name shares with
 * anything: "Dmitri" matches nothing in a note that only ever mentioned Priya.
 */
function present(word: string, tokens: Set<string>, stems: Set<string>): boolean {
  const w = word.toLowerCase();
  return tokens.has(w) || (w.length >= STEM && stems.has(w.slice(0, STEM)));
}

function vocabulary(text: string): { tokens: Set<string>; stems: Set<string> } {
  const tokens = new Set<string>();
  const stems = new Set<string>();
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    tokens.add(w);
    if (w.length >= STEM) stems.add(w.slice(0, STEM));
  }
  return { tokens, stems };
}

/** Content words, lightly stemmed so a plural matches its singular. */
function contentWords(sentence: string): string[] {
  return bare(sentence)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= MIN_WORD && !STOPWORDS.has(w))
    .map((w) => (w.endsWith("s") && w.length > MIN_WORD ? w.slice(0, -1) : w));
}

function judge(sentence: string, sources: { excerpt: string }[]): Claim {
  const cites = citationsIn(sentence);
  if (cites.length === 0) return { text: sentence, cites, supported: false, reason: "uncited" };
  if (cites.some((n) => n < 1 || n > sources.length)) {
    return { text: sentence, cites, supported: false, reason: "unknown-source" };
  }

  // Exactly what the model was shown for those sources, so the check cannot pass on text the
  // model never saw and cannot fail on text that was cut off before it got there.
  const haystack = cites.map((n) => sources[n - 1].excerpt).join(" ");

  const known = new Set(figures(haystack));
  for (const figure of figures(sentence)) {
    if (!known.has(figure)) {
      return { text: sentence, cites, supported: false, reason: "figure-not-in-source" };
    }
  }
  const { tokens, stems } = vocabulary(haystack);
  for (const name of names(sentence)) {
    if (!present(name, tokens, stems)) {
      return { text: sentence, cites, supported: false, reason: "name-not-in-source" };
    }
  }

  const content = contentWords(sentence);
  if (content.length >= MIN_WORDS_TO_JUDGE) {
    const source = new Set(contentWords(haystack));
    const hits = content.filter((w) => source.has(w)).length;
    if (hits / content.length < MIN_OVERLAP) {
      return { text: sentence, cites, supported: false, reason: "not-in-source" };
    }
  }

  return { text: sentence, cites, supported: true };
}

/**
 * Keep only the sentences the cited sources support.
 *
 * Removing a sentence can leave prose that reads a little clipped -- a dropped "the two notes
 * disagree" leaves the two statements standing side by side. That is the right trade: a reader can
 * see two cited facts and judge them, and cannot see that the fluent sentence joining them was
 * invented.
 */
export function verifyClaims(answer: string, sources: { excerpt: string }[]): Verification {
  const claims = sentences(answer).map((s) => judge(s, sources));
  const kept = claims.filter((c) => c.supported);
  return {
    text: kept.map((c) => c.text).join(" "),
    claims,
    dropped: claims.length - kept.length,
    cited: [...new Set(kept.flatMap((c) => c.cites))].sort((a, b) => a - b),
  };
}
