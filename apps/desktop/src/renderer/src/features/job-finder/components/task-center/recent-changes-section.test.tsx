// @vitest-environment jsdom

import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  recordRecentChange,
  resetRecentChangesForTest,
} from "../../lib/recent-changes";
import { RecentChangesSection } from "./recent-changes-section";

const workspace = {
  discoveryJobs: [],
  dismissedDiscoveryJobs: [],
  reviewQueue: [{ jobId: "job_a", resumeReview: { status: "draft" } }],
  applicationRecords: [],
} as unknown as JobFinderRendererWorkspaceSnapshot;

beforeEach(() => resetRecentChangesForTest());
afterEach(() => cleanup());

describe("RecentChangesSection", () => {
  test("offers Undo while a move can be put back and says why not otherwise", () => {
    const shortlist = recordRecentChange({
      kind: "shortlisted",
      jobIds: ["job_a"],
      label: "Engineer at Acme",
    });
    recordRecentChange({
      kind: "taken_out_of_queue",
      jobIds: ["job_b"],
      label: "Designer at Beta",
    });
    const onUndo = vi.fn(() => Promise.resolve(true));
    render(<RecentChangesSection onUndo={onUndo} workspace={workspace} />);

    expect(screen.getByText("Shortlisted Engineer at Acme")).toBeTruthy();
    expect(
      screen.getByText(/Press Apply on the job to queue it again\./u),
    ).toBeTruthy();
    const undoButtons = screen.getAllByRole("button", { name: "Undo" });
    expect(undoButtons).toHaveLength(1);
    fireEvent.click(undoButtons[0]!);
    expect(onUndo).toHaveBeenCalledWith(shortlist);
  });

  test("shows nothing before the first move", () => {
    const { container } = render(
      <RecentChangesSection
        onUndo={() => Promise.resolve(true)}
        workspace={workspace}
      />,
    );
    expect(container.textContent).toBe("");
  });
});
