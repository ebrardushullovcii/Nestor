// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeTimelineRepairProposalSchema } from "@nestor/contracts";
import { ProfileTimelineRepairList } from "./profile-timeline-repair-list";

const experience = {
  id: "experience_1",
  companyName: "Acme",
  companyUrl: null,
  title: "Engineer",
  employmentType: null,
  location: "Remote",
  workMode: ["remote"],
  startDate: "2024-06",
  endDate: "2023-01",
  isCurrent: false,
  isDraft: false,
  summary: null,
  achievements: [],
  skills: [],
  domainTags: [],
  peopleManagementScope: null,
  ownershipScope: null,
};

const proposal = ResumeTimelineRepairProposalSchema.parse({
  id: "timeline_repair_reversed_experience_1",
  runId: "resume_import_run_1",
  issueKind: "reversed_dates",
  status: "pending",
  certainty: "deterministic_normalization",
  title: "Review reversed dates for Engineer",
  explanation: "The cited start date is later than the end date.",
  affectedExperienceIds: ["experience_1"],
  beforeExperiences: [experience],
  proposedExperiences: [
    { ...experience, startDate: "2023-01", endDate: "2024-06" },
  ],
  evidence: [
    {
      candidateId: "candidate_experience_1",
      sourceBlockIds: ["block_7"],
      excerpt: "Engineer, Acme | Jun 2024 - Jan 2023",
    },
  ],
  createdAt: "2026-07-31T10:00:00.000Z",
  resolvedAt: null,
  actionHistory: [],
});

describe("ProfileTimelineRepairList", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  function render(onAction = vi.fn().mockResolvedValue(undefined)) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileTimelineRepairList
          onAction={onAction}
          proposals={[proposal]}
        />,
      );
    });

    return onAction;
  }

  it("shows issue, certainty, before/proposed values, and cited evidence", () => {
    render();

    expect(container?.textContent).toContain("reversed dates");
    expect(container?.textContent).toContain("Evidence-preserving change");
    expect(container?.textContent).toContain(
      "Engineer at Acme · 2024-06 – 2023-01 · Remote",
    );
    expect(container?.textContent).toContain(
      "Engineer at Acme · 2023-01 – 2024-06 · Remote",
    );
    expect(container?.textContent).toContain(
      "Engineer, Acme | Jun 2024 - Jan 2023",
    );
    expect(container?.textContent).toContain("Source blocks: block_7");
    expect(container?.textContent).toContain("Accept proposed change");
    expect(container?.textContent).toContain("Reject");
  });

  it("sends an independent action and displays stale-edit errors", async () => {
    const onAction = render(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Experience 'experience_1' changed after this timeline proposal was created.",
          ),
        ),
    );
    const acceptButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((button) => button.textContent?.includes("Accept proposed change"));

    await act(async () => {
      acceptButton?.click();
      await Promise.resolve();
    });

    expect(onAction).toHaveBeenCalledWith(
      "timeline_repair_reversed_experience_1",
      "accept",
    );
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "changed after this timeline proposal was created",
    );
  });

  it("offers undo for a resolved proposal", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileTimelineRepairList
          onAction={vi.fn().mockResolvedValue(undefined)}
          proposals={[{ ...proposal, status: "accepted" }]}
        />,
      );
    });

    expect(container?.textContent).toContain("Undo accepted");
    expect(container?.textContent).not.toContain("Accept proposed change");
  });
});
