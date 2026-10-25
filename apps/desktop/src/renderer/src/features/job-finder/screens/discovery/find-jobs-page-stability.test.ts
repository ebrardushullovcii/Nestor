import { describe, expect, it } from "vitest";
import type { WorkspaceJobListRow } from "@nestor/contracts";
import {
  stabilizeFindJobsPage,
  type PageStability,
} from "./find-jobs-page-stability";

const row = (id: string, score = 50) =>
  ({ id, score }) as unknown as WorkspaceJobListRow;
const ids = (page: PageStability) => page.rows.map((entry) => entry.id);

function step(
  previous: PageStability | null,
  rows: WorkspaceJobListRow[],
  options: {
    runId?: string | null;
    heldJobId?: string | null;
    list?: string[];
  } = {},
) {
  return stabilizeFindJobsPage({
    previous,
    rows,
    listIds: new Set(options.list ?? rows.map((entry) => entry.id)),
    runId: options.runId ?? null,
    requestKey: "page-1",
    heldJobId: options.heldJobId ?? null,
    pageSize: 3,
  });
}

describe("Find jobs page stability", () => {
  it("keeps rows where they were first shown during a search and appends new ones", () => {
    const first = step(null, [row("a", 80), row("b", 70)], { runId: "run" });
    // A new better job ranks first in the database; the page does not jump.
    const second = step(first, [row("n", 95), row("a", 80), row("b", 72)], {
      runId: "run",
    });
    expect(ids(second)).toEqual(["a", "b", "n"]);
    expect(second.rows[1]).toMatchObject({ score: 72 });
  });

  it("keeps a row that moved to another page but drops one that left the list", () => {
    const first = step(null, [row("a"), row("b"), row("c")], { runId: "run" });
    const second = step(first, [row("n"), row("a"), row("b")], {
      runId: "run",
      list: ["n", "a", "b", "c"],
    });
    expect(ids(second)).toEqual(["a", "b", "c"]);
    const third = step(second, [row("n"), row("a"), row("c")], {
      runId: "run",
      list: ["n", "a", "c"],
    });
    expect(ids(third)).toEqual(["a", "c", "n"]);
  });

  it("takes the ranked order once the search ends", () => {
    const during = step(null, [row("a"), row("b")], { runId: "run" });
    const after = step(during, [row("b"), row("a")]);
    expect(ids(after)).toEqual(["b", "a"]);
  });

  it("holds the decided open job in its place until another job opens", () => {
    const first = step(null, [row("a"), row("b"), row("c")]);
    const decided = step(first, [row("a"), row("c")], { heldJobId: "b" });
    expect(ids(decided)).toEqual(["a", "b", "c"]);
    const moved = step(decided, [row("a"), row("c")]);
    expect(ids(moved)).toEqual(["a", "c"]);
  });
});
