import { describe, expect, it } from "vitest";
import type {
  JobFinderRendererWorkspaceSnapshot,
  JobListRow,
} from "@nestor/contracts";

import { isDiscoveryDecidedJob } from "../screens/discovery/discovery-result-groups";
import {
  countDiscoveryVisibleJobs,
  countDiscoveryWeakerJobs,
} from "./destination-counts";

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
  it("counts only jobs still waiting on a decision", () => {
    const workspace = {
      campaigns: [],
      activeCampaignId: null,
      discoveryJobs: [
        row("open", "discovered"),
        row("taken-off-shortlist", "shortlisted"),
        row("in-shortlist", "discovered"),
        row("drafting", "drafting"),
        row("applied", "submitted"),
        { ...row("hidden", "discovered"), discoveryFeedback: { reasons: [] } },
      ],
      reviewQueue: [{ jobId: "in-shortlist" }],
    } as unknown as JobFinderRendererWorkspaceSnapshot;

    // Taking a job off Shortlisted writes "shortlisted"; it waits again.
    expect(countDiscoveryVisibleJobs(workspace)).toBe(2);
    expect(countDiscoveryWeakerJobs(workspace)).toBe(0);
  });

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
