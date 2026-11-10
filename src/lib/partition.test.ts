import { describe, it, expect } from "vitest";
import { partitionDue } from "./partition";

const t = (id: number, dueDate: string | null) => ({
  id,
  title: `t${id}`,
  notes: "",
  status: "open" as const,
  priority: "normal" as const,
  dueDate,
  containerId: null,
  sourceItemId: null, requester: null, askedOn: null,
  estimateMinutes: null,
  sessionMinutes: null, blocks: [],
  goals: [],
  spentMinutes: 0,
  likeThisMinutes: null,
  completedAt: null,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
});

describe("partitionDue", () => {
  it("splits overdue and today, ignores future and undated", () => {
    const r = partitionDue([t(1, "2026-09-20"), t(2, "2026-09-22"), t(3, "2026-09-23"), t(4, null)], "2026-09-22");
    expect(r.overdue.map((x) => x.id)).toEqual([1]);
    expect(r.today.map((x) => x.id)).toEqual([2]);
  });
});
