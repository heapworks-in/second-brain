import { describe, it, expect } from "vitest";
import { verifyClaims } from "./verify";

/** What the model was shown. Wording a grounded answer would paraphrase rather than quote. */
const SOURCES = [
  {
    excerpt:
      "Migration plan. We froze schema changes until the security audit finishes, which is expected in week 48. " +
      "Priya owns the rollback plan and will sign it off before the freeze lifts.",
  },
  {
    excerpt:
      "Hiring loop. The onsite is four interviews and a debrief the same afternoon. Candidates get a decision within 3 days.",
  },
];

const only = (answer: string) => verifyClaims(answer, SOURCES);

describe("verifyClaims", () => {
  it("keeps a cited paraphrase, which is what a grounded answer actually looks like", () => {
    // Not a quotation: different verb, different order, two sources' worth of vocabulary dropped.
    const out = only("Schema changes are on hold until the security audit wraps up [1].");
    expect(out.dropped).toBe(0);
    expect(out.cited).toEqual([1]);
    expect(out.text).toContain("on hold");
  });

  it("drops a sentence that cites nothing", () => {
    const out = only("The freeze is nearly over.");
    expect(out.text).toBe("");
    expect(out.claims[0].reason).toBe("uncited");
  });

  it("drops a sentence citing a source that was never shown", () => {
    const out = only("The rollback is signed off [7].");
    expect(out.claims[0].reason).toBe("unknown-source");
  });

  /* The dangerous hallucination is not an invented topic -- retrieval mostly prevents that -- it
   * is a true-sounding sentence with one specific swapped. These two checks are the whole point. */
  it("drops a figure the cited source does not contain", () => {
    const out = only("The audit finishes in week 42 [1].");
    expect(out.claims[0].reason).toBe("figure-not-in-source");
    expect(only("The audit finishes in week 48 [1].").dropped).toBe(0);
  });

  it("drops a name the cited source never mentions", () => {
    const out = only("Dmitri owns the rollback plan [1].");
    expect(out.claims[0].reason).toBe("name-not-in-source");
    expect(only("Priya owns the rollback plan [1].").dropped).toBe(0);
  });

  it("drops a sentence that is not about the source it cites", () => {
    // Cites a real source, states something from entirely elsewhere, and carries no figure and no
    // name to catch it. The overlap floor is all that stands between this and the reader.
    const out = only("The limit needs a second approver before any reimbursement [2].");
    expect(out.claims[0].reason).toBe("not-in-source");
  });

  it("keeps the supported half of a mixed answer and credits only its sources", () => {
    const out = only(
      "The onsite is four interviews with a debrief afterwards [2]. Offers are approved by the VP of Engineering [2].",
    );
    expect(out.dropped).toBe(1);
    expect(out.text).toContain("four interviews");
    expect(out.text).not.toContain("VP");
    // The dropped sentence cited [2] as well -- but a source is credited for a sentence a reader
    // sees, never for one the check removed.
    expect(out.cited).toEqual([2]);
    expect(out.claims).toHaveLength(2);
  });

  it("refuses outright when nothing survives", () => {
    const out = only("The freeze lifts on 2026-12-01 [1]. Raj signed it off [1].");
    expect(out.text).toBe("");
    expect(out.cited).toEqual([]);
    expect(out.dropped).toBe(2);
  });

  it("does not read a citation marker as a figure", () => {
    // `[2]` is provenance, not a claim that the number two appears in the source.
    expect(only("The onsite ends with a debrief the same afternoon [2].").dropped).toBe(0);
  });

  it("matches a plural against its singular", () => {
    expect(only("Four interviews and a debrief make up the onsite [2].").dropped).toBe(0);
  });
});
