import { describe, expect, it } from "vitest";
import type {
  JobListRow,
} from "@nestor/contracts";

import { isDiscoveryDecidedJob } from "../screens/discovery/discovery-result-groups";

function row(id: string, status: JobListRow["status"], score = 80) {
  return {
    id,
    status,
    matchAssessment: {
      score,
      judgment: { source: "full", judgedAt: "2026-10-01T00:00:00.000Z" },
    },
  } as unknown as JobListRow;
}

describe("Find jobs counts", () => {

  it("treats the review queue and application statuses as decided", () => {
    const queue = new Set(["queued"]);
    expect(isDiscoveryDecidedJob(row("queued", "discovered"), queue)).toBe(
      true,
    );
    expect(isDiscoveryDecidedJob(row("x", "ready_for_review"), queue)).toBe(
      true,
    );
    expect(isDiscoveryDecidedJob(row("x", "interview"), queue)).toBe(true);
    expect(isDiscoveryDecidedJob(row("x", "discovered"), queue)).toBe(false);
    expect(isDiscoveryDecidedJob(row("x", "shortlisted"), queue)).toBe(false);
  });
});
