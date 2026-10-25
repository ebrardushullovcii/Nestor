// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type {
  JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import {
  selectCampaignApplicationsScope,
} from "./job-finder-page-routes";

function workspace(): JobFinderRendererWorkspaceSnapshot {
  return {
    activeCampaignId: "campaign_1",
    campaigns: [
      {
        id: "campaign_1",
        name: "Campaign One",
        jobIds: ["job_a", "job_b"],
      },
      {
        id: "campaign_2",
        name: "Campaign Two",
        jobIds: ["job_c"],
      },
    ],
    discoveryJobs: [
      { id: "job_a", title: "Job A" },
      { id: "job_b", title: "Job B" },
      { id: "job_c", title: "Job C" },
      { id: "job_d", title: "Job D" },
    ],
    intelligence: {
      rapidReviewLogs: [
        {
          campaignId: "campaign_1",
          entries: [{ id: "decision_1", jobId: "job_a" }],
        },
        {
          campaignId: "campaign_2",
          entries: [{ id: "decision_2", jobId: "job_c" }],
        },
      ],
    },
  } as unknown as JobFinderRendererWorkspaceSnapshot;
}

describe("selectCampaignApplicationsScope", () => {
  it("shows saved applications across plans when all plans are requested", () => {
    const saved = applicationWorkspace("campaign_2");
    expect(
      selectCampaignApplicationsScope(saved, true).applicationRecords,
    ).toEqual(saved.applicationRecords);
    expect(selectCampaignApplicationsScope(saved, true).applyRuns).toEqual(
      saved.applyRuns,
    );
  });
  function applicationWorkspace(activeCampaignId: string) {
    return {
      activeCampaignId,
      campaigns: [
        { id: "campaign_1", jobIds: ["job_shared", "job_unique"] },
        { id: "campaign_2", jobIds: ["job_shared"] },
      ],
      discoveryJobs: [{ id: "job_shared" }, { id: "job_unique" }],
      applicationRecords: [
        { id: "record_a", jobId: "job_shared" },
        { id: "record_b", jobId: "job_shared" },
        { id: "record_legacy_unique", jobId: "job_unique" },
        { id: "record_legacy_ambiguous", jobId: "job_shared" },
      ],
      applyRuns: [
        { id: "run_1", campaignId: "campaign_1", jobIds: ["job_shared"] },
        { id: "run_2", campaignId: "campaign_2", jobIds: ["job_shared"] },
        { id: "run_legacy_unique", campaignId: null, jobIds: ["job_unique"] },
        {
          id: "run_legacy_ambiguous",
          campaignId: null,
          jobIds: ["job_shared"],
        },
      ],
      applyJobResults: [
        {
          id: "result_1",
          runId: "run_1",
          jobId: "job_shared",
          applicationRecordId: "record_a",
        },
        {
          id: "result_2",
          runId: "run_2",
          jobId: "job_shared",
          applicationRecordId: "record_b",
        },
        {
          id: "result_legacy_unique",
          runId: "run_legacy_unique",
          jobId: "job_unique",
          applicationRecordId: "record_legacy_unique",
        },
        {
          id: "result_legacy_ambiguous",
          runId: "run_legacy_ambiguous",
          jobId: "job_shared",
          applicationRecordId: "record_legacy_ambiguous",
        },
      ],
      applicationAttempts: [
        {
          id: "attempt_a",
          jobId: "job_shared",
          applicationRecordId: "record_a",
        },
        {
          id: "attempt_b",
          jobId: "job_shared",
          applicationRecordId: "record_b",
        },
        {
          id: "attempt_legacy_unique",
          jobId: "job_unique",
          applicationRecordId: "record_legacy_unique",
        },
      ],
      selectedApplyRunId: "run_1",
    } as unknown as JobFinderRendererWorkspaceSnapshot;
  }

  // F57. Campaign membership is resolved through a per-campaign Set index
  // instead of a linear `jobIds.includes` inside a nested loop. The rule it
  // encodes is unchanged: a legacy run/record belongs to a campaign only when
  // exactly one campaign contains every one of its jobs.
  it("keeps legacy campaign resolution unique-owner-only across multi-job runs", () => {
    const base = {
      activeCampaignId: "campaign_1",
      campaigns: [
        { id: "campaign_1", jobIds: ["job_1", "job_2", "job_3"] },
        { id: "campaign_2", jobIds: ["job_2"] },
        { id: "campaign_3", jobIds: ["job_1", "job_2", "job_3"] },
      ],
      discoveryJobs: [{ id: "job_1" }, { id: "job_2" }, { id: "job_3" }],
      applicationRecords: [],
      applyJobResults: [],
      applicationAttempts: [],
      selectedApplyRunId: null,
    };

    // campaign_1 is the only campaign containing both jobs, so the legacy run
    // resolves to it.
    const uniqueOwner = selectCampaignApplicationsScope({
      ...base,
      applyRuns: [
        { id: "run_span", campaignId: null, jobIds: ["job_1", "job_3"] },
      ],
      campaigns: [base.campaigns[0], base.campaigns[1]],
    } as unknown as JobFinderRendererWorkspaceSnapshot);
    expect(uniqueOwner.applyRuns.map((run) => run.id)).toEqual(["run_span"]);

    // campaign_1 and campaign_3 both contain every job, so ownership is
    // ambiguous and the run belongs to neither.
    const ambiguousOwner = selectCampaignApplicationsScope({
      ...base,
      applyRuns: [
        { id: "run_span", campaignId: null, jobIds: ["job_1", "job_3"] },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot);
    expect(ambiguousOwner.applyRuns).toEqual([]);

    // A job outside every campaign resolves to no campaign at all.
    const unowned = selectCampaignApplicationsScope({
      ...base,
      applyRuns: [
        { id: "run_outside", campaignId: null, jobIds: ["job_unknown"] },
      ],
    } as unknown as JobFinderRendererWorkspaceSnapshot);
    expect(unowned.applyRuns).toEqual([]);
  });

  it("switches exact shared-job application lineage with the active campaign", () => {
    const campaignOne = selectCampaignApplicationsScope(
      applicationWorkspace("campaign_1"),
    );
    expect(campaignOne.applicationRecords.map((record) => record.id)).toEqual([
      "record_a",
      "record_legacy_unique",
    ]);
    expect(campaignOne.applyRuns.map((run) => run.id)).toEqual([
      "run_1",
      "run_legacy_unique",
    ]);
    expect(campaignOne.applyJobResults.map((result) => result.id)).toEqual([
      "result_1",
      "result_legacy_unique",
    ]);
    expect(
      campaignOne.applicationAttempts.map((attempt) => attempt.id),
    ).toEqual(["attempt_a", "attempt_legacy_unique"]);
    expect(campaignOne.selectedApplyRunId).toBe("run_1");

    const campaignTwo = selectCampaignApplicationsScope(
      applicationWorkspace("campaign_2"),
    );
    expect(campaignTwo.applicationRecords.map((record) => record.id)).toEqual([
      "record_b",
    ]);
    expect(campaignTwo.applyRuns.map((run) => run.id)).toEqual(["run_2"]);
    expect(campaignTwo.applyJobResults.map((result) => result.id)).toEqual([
      "result_2",
    ]);
    expect(
      campaignTwo.applicationAttempts.map((attempt) => attempt.id),
    ).toEqual(["attempt_b"]);
    expect(campaignTwo.selectedApplyRunId).toBeNull();
  });
});

/**
 * "Check whether this step is done" is gated on the pending browser-step
 * request for the selected application, and the same request supplies the
 * in-place "Checking…" / "still blocked" text. The command it sends used to
 * run a second, run-scoped lookup and `return` silently when that matched
 * nothing, so a request left over from an earlier run for the same job left
 * the control enabled while pressing it did nothing at all. Gate, status, and
 * command now read one request.
 */

