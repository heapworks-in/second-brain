import { describe, it, expect } from "vitest";
import { PROPOSAL_KINDS } from "@/db/enums";
import { PRIMARY_LABELS, SECTIONS, groupIntoSections } from "./answers";

describe("the board's sections", () => {
  it("has a home for every kind that exists", () => {
    // Without this, adding a generator would file proposals that render nowhere -- open in the
    // database, counted in the total, and absent from the page. Silently.
    const placed = SECTIONS.flatMap((s) => s.kinds as readonly string[]);
    expect([...placed].sort()).toEqual([...PROPOSAL_KINDS].sort());
  });

  it("files each kind under exactly one heading", () => {
    const placed = SECTIONS.flatMap((s) => s.kinds as readonly string[]);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("drops headings with nothing under them", () => {
    const sections = groupIntoSections([{ kind: "commitment_owed" as const }]);
    expect(sections.map((s) => s.title)).toEqual(["Someone is waiting on you"]);
  });

  it("keeps the ranker's order within a heading", () => {
    const cards = [
      { kind: "task_overdue" as const, id: 1 },
      { kind: "prediction_due" as const, id: 2 },
      { kind: "task_overdue" as const, id: 3 },
    ];
    expect(groupIntoSections(cards)[0].cards.map((c) => c.id)).toEqual([1, 2, 3]);
  });
});

describe("what the button promises", () => {
  it("names the number it is about to act on", () => {
    expect(PRIMARY_LABELS.task_overdue(1)).toBe("Plan it for today");
    expect(PRIMARY_LABELS.task_overdue(6)).toBe("Plan all 6 for today");
  });

  it("never says Accept", () => {
    for (const kind of PROPOSAL_KINDS) {
      expect(PRIMARY_LABELS[kind](1).toLowerCase()).not.toContain("accept");
    }
  });
});
