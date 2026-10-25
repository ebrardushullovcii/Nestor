// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ApplyRunDetails } from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApplicationsDetailPanelSubmitApprovalSection,
  isAwaitingPreparationApproval,
} from "./applications-detail-panel-submit-approval-section";

afterEach(cleanup);

function createAwaitingApprovalDetails(): ApplyRunDetails {
  return {
    run: {
      id: "run_1",
      campaignId: null,
      mode: "queue_auto",
      state: "awaiting_submit_approval",
      jobIds: ["job_1"],
      currentJobId: "job_1",
      submitApprovalId: "approval_1",
      visualCheckpointsEnabled: false,
      createdAt: "2026-08-09T08:00:00.000Z",
      updatedAt: "2026-08-09T08:01:00.000Z",
      completedAt: null,
      summary: "Ready for safe preparation approval.",
      detail: "Final submission remains disabled.",
      totalJobs: 1,
      pendingJobs: 1,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    },
    result: null,
    results: [],
    submitApproval: {
      id: "approval_1",
      runId: "run_1",
      mode: "queue_auto",
      jobIds: ["job_1"],
      status: "pending",
      createdAt: "2026-08-09T08:01:00.000Z",
      approvedAt: null,
      revokedAt: null,
      expiresAt: null,
      batchId: null,
      batchCampaignId: null,
      reusedFromApprovalId: null,
      detail: "Preparation only.",
    },
    questionRecords: [],
    answerRecords: [],
    artifactRefs: [],
    checkpoints: [],
    consentRequests: [],
    reviewCard: null,
  };
}

describe("ApplicationsDetailPanelSubmitApprovalSection", () => {
  it("asks in one sentence and offers one button, with nothing labelled approve", () => {
    const onApproveApplyRun = vi.fn();
    render(
      <ApplicationsDetailPanelSubmitApprovalSection
        approvalScopeEntries={[{ jobId: "job_1", label: "Engineer at Acme" }]}
        isApplyRunPending={() => false}
        onApproveApplyRun={onApproveApplyRun}
        selectedApplyRunDetails={createAwaitingApprovalDetails()}
        selectedApplicationTarget={{
          jobId: "job-1",
          applicationRecordId: "application-1",
        }}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(document.body.textContent ?? "").not.toMatch(
      /approve|revoke|submit approval|apply copilot|restage/i,
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply now" }));
    expect(onApproveApplyRun).toHaveBeenCalledWith({
      runId: "run_1",
      jobId: "job-1",
      applicationRecordId: "application-1",
    });
  });

  it("hands the control to the panel footer without repeating it", () => {
    const details = createAwaitingApprovalDetails();
    expect(isAwaitingPreparationApproval(details)).toBe(true);
    expect(
      isAwaitingPreparationApproval({
        ...details,
        run: { ...details.run, state: "running" },
      }),
    ).toBe(false);

    const { container } = render(
      <ApplicationsDetailPanelSubmitApprovalSection
        approvalScopeEntries={[{ jobId: "job_1", label: "Engineer at Acme" }]}
        isApplyRunPending={() => false}
        onApproveApplyRun={vi.fn()}
        selectedApplyRunDetails={details}
        selectedApplicationTarget={{
          jobId: "job-1",
          applicationRecordId: "application-1",
        }}
        showApproveAction={false}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  it("renders nothing at all when the run is not waiting on a decision", () => {
    const details = createAwaitingApprovalDetails();
    const { container } = render(
      <ApplicationsDetailPanelSubmitApprovalSection
        approvalScopeEntries={[]}
        isApplyRunPending={() => false}
        onApproveApplyRun={vi.fn()}
        selectedApplyRunDetails={{
          ...details,
          run: { ...details.run, state: "running" },
          submitApproval: { ...details.submitApproval!, status: "approved" },
        }}
        selectedApplicationTarget={{
          jobId: "job-1",
          applicationRecordId: "application-1",
        }}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});
