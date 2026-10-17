// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  ApplicationAttempt,
  ApplicationRecord,
  ApplyJobResultSummary,
  ApplyRunSummary,
} from "@nestor/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationsDetailFactStrip } from "./applications-detail-fact-strip";
import { ApplicationsDetailPanel } from "./applications-detail-panel";
import { ApplicationsDetailPanelAttemptSection } from "./applications-detail-panel-attempt-section";
import { ApplicationsDetailPanelRunHistorySection } from "./applications-detail-panel-run-history-section";

afterEach(cleanup);

const baseRecord: ApplicationRecord = {
  id: "application_1",
  jobId: "job_1",
  title: "Senior Product Designer",
  company: "Signal Systems",
  status: "ready_for_review",
  lastActionLabel: "Resume approved",
  nextActionLabel:
    "Review the prepared application and submit manually when ready",
  lastUpdatedAt: "2026-08-09T08:00:00.000Z",
  lastAttemptState: "paused",
  questionSummary: {
    total: 6,
    required: 4,
    answered: 2,
    unansweredRequired: 1,
  },
  latestBlocker: {
    code: "requires_manual_review",
    summary: "Needed manual follow-up",
  },
  consentSummary: { status: "requested", pendingCount: 2 },
  replaySummary: {
    sourceInstructionArtifactId: null,
    lastUrl: "https://jobs.example.com/apply",
    checkpointCount: 3,
    evidenceCount: 2,
  },
  events: [],
  crm: null,
  automationMode: "prepare_only" as const,
};

const baseApplyResult: ApplyJobResultSummary = {
  id: "apply_result_1",
  runId: "run_abcdefgh",
  jobId: "job_1",
  applicationRecordId: baseRecord.id,
  queuePosition: 0,
  state: "submitted",
  summary: "Prepared and submitted the application form.",
  detail: "Application detail",
  startedAt: "2026-08-09T07:00:00.000Z",
  updatedAt: "2026-08-09T08:00:00.000Z",
  completedAt: "2026-08-09T08:00:00.000Z",
  blockerReason: null,
  blockerSummary: null,
  listingSignalEvidence: null,
  visualObservationSets: [],
  visualCheckpoints: [],
  latestQuestionCount: 3,
  latestAnswerCount: 2,
  pendingConsentRequestCount: 0,
  artifactCount: 4,
  latestCheckpointId: null,
  privacyReceipt: null,
  reviewCard: null,
};

function renderStrip(
  overrides: Partial<{
    selectedAttempt: ApplicationAttempt | null;
    record: ApplicationRecord;
    visibleApplyResult: ApplyJobResultSummary | null;
    visibleApplyRunId: string | null;
    plannedStanding: "waiting_turn" | "paused" | "not_started" | null;
  }> = {},
) {
  const props = {
    plannedStanding: overrides.plannedStanding ?? null,
    selectedAttempt: overrides.selectedAttempt ?? null,
    selectedRecord: overrides.record ?? baseRecord,
    visibleApplyResult:
      overrides.visibleApplyResult === undefined
        ? baseApplyResult
        : overrides.visibleApplyResult,
    visibleApplyRunId: overrides.visibleApplyRunId ?? null,
  };

  const { container } = render(<ApplicationsDetailFactStrip {...props} />);

  return { container };
}

describe("ApplicationsDetailFactStrip", () => {
  it("says Not started, not In progress, for a job a stopped batch never reached", () => {
    renderStrip({
      record: {
        ...baseRecord,
        lastAttemptState: "in_progress",
        lastActionLabel:
          "This job is in the approved batch. Job Finder follows the application mode chosen in Settings when its turn starts.",
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "planned",
        completedAt: null,
        detail:
          "This job is in the approved batch. Job Finder follows the application mode chosen in Settings when its turn starts.",
      },
      plannedStanding: "not_started",
    });
    expect(screen.getByText("Not started")).toBeTruthy();
    expect(screen.queryByText("In progress")).toBeNull();
    expect(screen.queryByText(/when its turn starts/)).toBeNull();
  });

  it("uses Needs you for the current sign-in handoff instead of an older ready attempt", () => {
    renderStrip({
      selectedAttempt: {
        id: "attempt_old",
        state: "ready",
      } as ApplicationAttempt,
      visibleApplyResult: {
        ...baseApplyResult,
        state: "awaiting_review",
        blockerReason: "auth_required",
      },
    });
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.queryByText("Needs follow-up")).toBeNull();
    expect(screen.queryByText("Ready to send")).toBeNull();
  });

  it("keeps a completed form ready when its saved questions already have answers", () => {
    renderStrip({
      visibleApplyResult: {
        ...baseApplyResult,
        state: "awaiting_review",
        blockerReason: null,
        latestQuestionCount: 3,
        latestAnswerCount: 3,
      },
    });
    expect(screen.getByText("Ready to send")).toBeTruthy();
    expect(screen.queryByText("Needs follow-up")).toBeNull();
  });

  it("shows one ready state after a resolved prepare-only pause", () => {
    renderStrip({
      record: {
        ...baseRecord,
        lastActionLabel: "The CAPTCHA still needs to be completed.",
        latestBlocker: null,
        questionSummary: {
          total: 10,
          required: 10,
          answered: 10,
          unansweredRequired: 0,
        },
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "awaiting_review",
        latestQuestionCount: 0,
        blockerReason: null,
        blockerSummary: null,
      },
    });

    expect(screen.getByText("Ready to send")).toBeTruthy();
    expect(screen.queryByText("Needs follow-up")).toBeNull();
    expect(
      screen.queryByText("The CAPTCHA still needs to be completed."),
    ).toBeNull();
  });

  it("lets a newer durable record failure replace an older paused attempt", () => {
    renderStrip({
      selectedAttempt: {
        id: "attempt_old",
        jobId: baseRecord.jobId,
        applicationRecordId: baseRecord.id,
        state: "paused",
      } as ApplicationAttempt,
      record: {
        ...baseRecord,
        lastAttemptState: "failed",
        lastActionLabel: "The prepared application page is no longer open.",
        latestBlocker: null,
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "failed",
        blockerReason: "unexpected_navigation",
      },
    });

    expect(screen.getByText("Could not apply")).toBeTruthy();
    expect(screen.queryByText("Needs follow-up")).toBeNull();
  });

  it("shows a verified submission instead of an older ready preparation", () => {
    renderStrip({
      selectedAttempt: {
        id: "attempt_1",
        jobId: baseRecord.jobId,
        state: "ready",
      } as ApplicationAttempt,
      visibleApplyResult: {
        ...baseApplyResult,
        privacyReceipt: {
          schemaVersion: 1,
          generatedAt: "2026-08-28T10:01:00.000Z",
          lineage: {
            runId: baseApplyResult.runId,
            jobId: baseApplyResult.jobId,
            resultId: baseApplyResult.id,
            applicationRecordId: baseRecord.id,
          },
          destination: { origin: "https://jobs.example", safePath: "/apply" },
          resume: {
            source: "tailored_export",
            sourceDocumentId: null,
            exportArtifactId: "export_1",
            fileName: "Resume.pdf",
            sha256: null,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: true,
          finalSubmitOccurred: true,
          submissionOutcome: {
            id: "outcome_submitted",
            preflightId: "preflight_1",
            idempotencyKey: "idempotency_1",
            authorityEnvelopeId: "authority_1",
            authorityRevision: 1,
            runId: baseApplyResult.runId,
            jobId: baseApplyResult.jobId,
            resultId: baseApplyResult.id,
            applicationRecordId: baseRecord.id,
            outcome: "submitted",
            attemptedAt: "2026-08-28T10:00:00.000Z",
            verifiedAt: "2026-08-28T10:00:01.000Z",
            evidence: [],
            retry: { eligible: false, blockReason: "submission_confirmed" },
          },
        },
      },
    });

    expect(screen.getAllByText("Submitted (verified)")).toHaveLength(2);
    expect(screen.queryByText("Ready to send")).toBeNull();
  });

  it("prefers a durable tri-state outcome over the legacy run state", () => {
    renderStrip({
      visibleApplyResult: {
        ...baseApplyResult,
        state: "submitting",
        privacyReceipt: {
          schemaVersion: 1,
          generatedAt: "2026-08-28T10:01:00.000Z",
          lineage: {
            runId: baseApplyResult.runId,
            jobId: baseApplyResult.jobId,
            resultId: baseApplyResult.id,
            applicationRecordId: baseRecord.id,
          },
          destination: { origin: "https://jobs.example", safePath: "/apply" },
          resume: {
            source: "tailored_export",
            sourceDocumentId: null,
            exportArtifactId: "export_1",
            fileName: "Resume.pdf",
            sha256: null,
          },
          stayedLocal: [],
          modelUse: [],
          externalWrites: [],
          accountCreationAuthorized: false,
          finalSubmitAuthorized: true,
          finalSubmitOccurred: false,
          submissionOutcome: {
            id: "outcome_1",
            preflightId: "preflight_1",
            idempotencyKey: "idempotency_1",
            authorityEnvelopeId: "authority_1",
            authorityRevision: 1,
            runId: baseApplyResult.runId,
            jobId: baseApplyResult.jobId,
            resultId: baseApplyResult.id,
            applicationRecordId: baseRecord.id,
            outcome: "not_submitted",
            attemptedAt: "2026-08-28T10:00:00.000Z",
            verifiedAt: null,
            evidence: [],
            retry: { eligible: true, blockReason: null },
          },
        },
      },
    });

    expect(screen.getByText("Final action not submitted")).toBeTruthy();
    expect(screen.queryByText("Submitting")).toBeNull();
  });

  it("renders primary status facts upfront and tucks technical details behind More details", () => {
    const { container } = renderStrip();
    expect(container.firstElementChild?.getAttribute("aria-label")).toBe(
      "Application status",
    );

    const primaryDl = container.querySelector("dl");
    if (!(primaryDl instanceof HTMLElement)) {
      throw new Error("Expected primary fact list");
    }

    const primaryLabels = within(primaryDl)
      .getAllByRole("term")
      .map((term) => term.textContent);
    expect(primaryLabels).toEqual(["Preparation status"]);

    fireEvent.click(screen.getByText("More about this application"));

    const detailDl = container.querySelector("details dl");
    if (!(detailDl instanceof HTMLElement)) {
      throw new Error("Expected detail fact list");
    }

    const detailLabels = within(detailDl)
      .getAllByRole("term")
      .map((term) => term.textContent);
    expect(detailLabels).toEqual([
      "Last updated",
      "Form questions",
      "Consent decisions",
      "Saved progress",
      "Latest preparation run",
    ]);
  });

  it("uses a pane-width container contract of two columns with three only where fitting", () => {
    const { container } = renderStrip();
    const section = container.firstElementChild;
    const dl = container.querySelector("dl");

    expect(section?.className).toContain("border-(--border-strong)");
    expect(dl?.className).toContain("grid-cols-1");
    expect(dl?.className).toContain("sm:grid-cols-2");
    expect(dl?.className).toContain("@[32rem]/detail:grid-cols-3");
    expect(dl?.className).toContain("gap-y-3");
  });

  it("lets fact values wrap so site-block and blocker copy stay readable", () => {
    const { container } = renderStrip();
    const dl = container.querySelector("dl");

    const valueCells = Array.from((dl as HTMLElement).querySelectorAll("dd"));
    for (const valueCell of valueCells) {
      expect(valueCell.className).toContain("break-words");
      expect(valueCell.className).not.toContain("truncate");
    }
  });

  it("collapses empty facts to muted lines instead of bordered cards", () => {
    const emptyRecord: ApplicationRecord = {
      ...baseRecord,
      lastActionLabel: "",
      lastAttemptState: null,
      latestBlocker: null,
      consentSummary: { status: "none", pendingCount: 0 },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointCount: 0,
        evidenceCount: 0,
      },
    };
    const { container } = renderStrip({
      record: emptyRecord,
      visibleApplyResult: null,
    });
    const dl = container.querySelector("dl");

    const mutedValues = Array.from((dl as HTMLElement).querySelectorAll("dd"))
      .filter((value) => value.className.includes("text-foreground-muted"))
      .map((value) => value.textContent);

    // The stop sentence lives in the status block at the top of the panel;
    // this strip no longer carries a "What stopped progress" cell at all.
    expect(mutedValues).toEqual(["Not started"]);
    expect(screen.queryByText("What stopped progress")).toBeNull();
    expect(screen.queryByText("Nothing blocking")).toBeNull();
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
  });

  it("shows an active run as in progress when no attempt row exists yet", () => {
    renderStrip({
      record: {
        ...baseRecord,
        lastAttemptState: null,
        lastActionLabel: "Application preparation started.",
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "filling",
        completedAt: null,
        privacyReceipt: null,
      },
    });

    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.queryByText("Not started")).toBeNull();
  });

  it("shows live retry activity instead of the previous page-loss failure", () => {
    renderStrip({
      record: {
        ...baseRecord,
        lastAttemptState: "failed",
        lastActionLabel: "The prepared application page is no longer open.",
        latestBlocker: null,
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "filling",
        detail: "Attaching an approved document",
        completedAt: null,
        privacyReceipt: null,
      },
    });

    expect(screen.getByText("Attaching an approved document")).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(
      screen.queryByText("The prepared application page is no longer open."),
    ).toBeNull();
  });

  it("shows a new active run ahead of an older selected attempt", () => {
    const olderAttempt: ApplicationAttempt = {
      id: "attempt_older",
      jobId: "job_1",
      applicationRecordId: baseRecord.id,
      state: "failed",
      summary: "An earlier preparation failed.",
      detail: "Earlier run detail.",
      startedAt: "2026-08-08T07:00:00.000Z",
      updatedAt: "2026-08-08T08:00:00.000Z",
      completedAt: "2026-08-08T08:00:00.000Z",
      outcome: null,
      checkpoints: [],
      questions: [],
      blocker: null,
      listingSignalEvidence: null,
      consentDecisions: [],
      replay: {
        sourceDebugEvidenceRefIds: [],
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointUrls: [],
      },
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
      nextActionLabel: null,
      executionTimings: [],
    };
    renderStrip({
      selectedAttempt: olderAttempt,
      visibleApplyResult: {
        ...baseApplyResult,
        state: "filling",
        completedAt: null,
        privacyReceipt: null,
      },
    });

    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.queryByText("Attempt failed")).toBeNull();
  });

  it("does not reuse a queued-run activity sentence after failure", () => {
    renderStrip({
      record: {
        ...baseRecord,
        lastAttemptState: "failed",
        lastActionLabel: "Applying to the remaining 5 jobs.",
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "failed",
        summary: "Could not apply",
        detail: "Profile changed",
      },
    });
    expect(screen.queryByText("Applying to the remaining 5 jobs.")).toBeNull();
    expect(screen.getByText("Could not apply")).toBeTruthy();
  });
  it("never repeats company, stage, or the full run id inside the fact region", () => {
    const { container } = renderStrip();

    expect(screen.queryByText("Signal Systems")).toBeNull();
    expect(screen.queryByText("Needs action")).toBeNull();

    const runCell = screen
      .getByText("Latest preparation run")
      .parentElement?.querySelector("dd");
    expect(runCell?.textContent).toContain("Submitted");
    expect(container.textContent).not.toContain("run_");
  });

  it("projects an interrupted preparation as failed instead of in progress or filling", () => {
    const failedRecord: ApplicationRecord = {
      ...baseRecord,
      lastActionLabel: "Preparation stopped when the app closed.",
      nextActionLabel: "Retry preparation when you are ready.",
      lastAttemptState: "failed",
    };
    const failedResult: ApplyJobResultSummary = {
      ...baseApplyResult,
      state: "failed",
      summary: "Application preparation stopped when the app closed.",
      completedAt: "2026-08-09T09:00:00.000Z",
    };

    const { container } = renderStrip({
      record: failedRecord,
      visibleApplyResult: failedResult,
    });
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/In progress/);
    expect(text).not.toMatch(/Filling/);
    expect(screen.getByText("Could not apply")).not.toBeNull();
    const runCell = screen
      .getByText("Latest preparation run")
      .parentElement?.querySelector("dd");
    expect(runCell?.textContent).toContain("Failed");
  });

  it("treats LinkedIn service-worker apply results as site-blocked even when the blocker code is generic", () => {
    const swRecord: ApplicationRecord = {
      ...baseRecord,
      lastActionLabel: "Application preparation stopped safely",
      latestBlocker: {
        code: "requires_manual_review",
        summary: "The live application page needs manual review.",
      },
    };
    const swResult: ApplyJobResultSummary = {
      ...baseApplyResult,
      state: "blocked",
      summary: "A LinkedIn service worker blocked automated preparation.",
      blockerReason: "site_protection",
      blockerSummary: "Service worker interference on this job site.",
    };

    renderStrip({
      record: swRecord,
      visibleApplyResult: swResult,
    });

    // The Next step callout directly above owns this event in full, so the
    // strip no longer relabels its two halves as "Latest activity" and
    // "What stopped progress" beside it.
    expect(screen.queryByText("Latest activity")).toBeNull();
    expect(screen.queryByText("What stopped progress")).toBeNull();
    expect(screen.getByText("Preparation status")).toBeTruthy();
    expect(screen.queryByText(/Requires Manual Review/i)).toBeNull();
    expect(screen.queryByText(/service worker/i)).toBeNull();
  });

  it("lets Next step own the autosave pause instead of relabelling its halves", () => {
    const pauseSentence =
      "The application page could not safely save a prepared field";
    renderStrip({
      record: {
        ...baseRecord,
        lastActionLabel: pauseSentence,
        latestBlocker: {
          code: "requires_manual_review",
          summary: `${pauseSentence}.`,
        },
      },
      visibleApplyResult: {
        ...baseApplyResult,
        state: "blocked",
        summary: pauseSentence,
        blockerReason: null,
        blockerSummary: `${pauseSentence}.`,
      },
    });

    // One event, one place. Next step already prints "the job site tried to
    // save a field automatically … finish in the open browser", so the strip
    // keeps only the fact that callout does not carry.
    expect(
      screen.queryByText("The job site tried to save a field automatically"),
    ).toBeNull();
    expect(
      screen.queryByText("Job Finder stopped before that save"),
    ).toBeNull();
    expect(screen.queryByText("Latest activity")).toBeNull();
    expect(screen.queryByText("What stopped progress")).toBeNull();
    expect(screen.getByText("Preparation status")).toBeTruthy();
    expect(screen.queryByText(/could not safely save/i)).toBeNull();
    expect(screen.queryByText(/requires manual review/i)).toBeNull();
  });
});

describe("ApplicationsDetailPanelOverviewSections dedupe", () => {
  it("keeps summary and detail but no longer repeats the attempt state or next step", () => {
    const attempt: ApplicationAttempt = {
      id: "attempt_1",
      jobId: "job_1",
      applicationRecordId: baseRecord.id,
      state: "paused",
      summary: "Paused before final review.",
      detail: "The form is saved for review.",
      startedAt: "2026-08-09T07:00:00.000Z",
      updatedAt: "2026-08-09T08:00:00.000Z",
      completedAt: null,
      outcome: null,
      checkpoints: [],
      questions: [],
      blocker: null,
      listingSignalEvidence: null,
      consentDecisions: [],
      replay: {
        sourceDebugEvidenceRefIds: [],
        sourceInstructionArtifactId: null,
        lastUrl: null,
        checkpointUrls: [],
      },
      visualEvidence: [],
      visualObservationSets: [],
      visualCheckpoints: [],
      nextActionLabel: "Review the conflicting fields manually",
      executionTimings: [],
    };

    const { container } = render(
      <ApplicationsDetailPanelAttemptSection selectedAttempt={attempt} />,
    );

    expect(screen.getByText("Preparation details")).toBeTruthy();
    expect(screen.getByText("Paused before final review.")).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="badge"]')).toHaveLength(0);
    expect(screen.queryByText(/Next step:/)).toBeNull();
    expect(screen.queryByText("Needs follow-up")).toBeNull();
  });
});

describe("ApplicationsDetailPanelRunHistorySection", () => {
  const runs: ApplyRunSummary[] = [
    {
      id: "run_latest01",
      campaignId: null,
      mode: "copilot",
      state: "completed",
      jobIds: ["job_1"],
      currentJobId: null,
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: "2026-08-09T07:00:00.000Z",
      updatedAt: "2026-08-09T08:00:00.000Z",
      completedAt: "2026-08-09T08:00:00.000Z",
      summary: "Latest run",
      detail: "Finished.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 1,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    },
    {
      id: "run_older0202",
      campaignId: null,
      mode: "queue_auto",
      state: "cancelled",
      jobIds: ["job_1"],
      currentJobId: null,
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: "2026-08-08T07:00:00.000Z",
      updatedAt: "2026-08-08T08:00:00.000Z",
      completedAt: "2026-08-08T08:00:00.000Z",
      summary: "Older run",
      detail: "Cancelled.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 0,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    },
  ];

  function buildHistory() {
    return runs.map((run) => ({
      result: {
        ...baseApplyResult,
        id: `result_${run.id}`,
        runId: run.id,
        state: run.id === "run_latest01" ? "submitted" : "blocked",
        blockerSummary: run.id === "run_latest01" ? null : "Needed input",
      } satisfies ApplyJobResultSummary,
      run,
    }));
  }

  it("syncs selection through aria-pressed without repeating run ids in the header", () => {
    const onSelectApplyRun = vi.fn();
    render(
      <ApplicationsDetailPanelRunHistorySection
        applyRunHistory={buildHistory()}
        onSelectApplyRun={onSelectApplyRun}
        selectedApplyRunId="run_latest01"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Current preparation run" }),
    ).toBeTruthy();
    expect(screen.getByTitle("run_latest01").getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(screen.getByText("1 earlier preparation run"));

    expect(
      screen.getByTitle("run_older0202").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByRole("heading").textContent).not.toContain("run_");

    fireEvent.click(screen.getByTitle("run_older0202"));
    expect(onSelectApplyRun).toHaveBeenCalledWith("run_older0202");
  });

  it("compacts each row to a meta line so rows stay under the height budget", () => {
    render(
      <ApplicationsDetailPanelRunHistorySection
        applyRunHistory={buildHistory()}
        onSelectApplyRun={vi.fn()}
        selectedApplyRunId="run_latest01"
      />,
    );

    fireEvent.click(screen.getByText("1 earlier preparation run"));

    const row = screen.getByTitle("run_older0202");
    expect(row.className).toContain("py-2.5");

    const rowLines = Array.from(row.children).map((child) => child.textContent);
    expect(rowLines).toHaveLength(3);
    expect(rowLines[2]).toContain("• Cancelled");
    expect(rowLines[2]).toContain("• Needed input");
    // Internal run ids stay on the title attribute only; people never read
    // "Run lder0202" in the row copy.
    expect(rowLines[2]).not.toContain("Run lder0202");
    expect(rowLines[2]).not.toMatch(/• Run /);
    expect(rowLines[0]).toContain("Automatic preparation (several jobs)");
  });

  it("writes run states for people instead of title-cased status codes", () => {
    const history = buildHistory().map((entry) => ({
      ...entry,
      run: { ...entry.run, state: "paused_for_user_review" as const },
    }));
    render(
      <ApplicationsDetailPanelRunHistorySection
        applyRunHistory={history}
        onSelectApplyRun={vi.fn()}
        selectedApplyRunId="run_latest01"
      />,
    );

    const row = screen.getByTitle("run_latest01");
    expect(row.textContent).toContain("Paused for your review");
    expect(row.textContent).not.toContain("Paused For User Review");
  });
});

describe("ApplicationsDetailPanel container contract", () => {
  it("keeps the submitted detail pane bounded without offering recovery actions", () => {
    const run: ApplyRunSummary = {
      id: "run_latest01",
      campaignId: null,
      mode: "copilot",
      state: "completed",
      jobIds: ["job_1"],
      currentJobId: null,
      submitApprovalId: null,
      visualCheckpointsEnabled: false,
      createdAt: "2026-08-09T07:00:00.000Z",
      updatedAt: "2026-08-09T08:00:00.000Z",
      completedAt: "2026-08-09T08:00:00.000Z",
      summary: "Latest run",
      detail: "Finished.",
      totalJobs: 1,
      pendingJobs: 0,
      submittedJobs: 1,
      skippedJobs: 0,
      blockedJobs: 0,
      failedJobs: 0,
    };

    const { container } = render(
      <ApplicationsDetailPanel
        dailyPreparationCapacity={null}
        activeFilter="all"
        applyRunDetails={null}
        applyRunDetailsTarget={null}
        applyRunDetailsError={null}
        applyRunDetailsStatus="idle"
        applicationRecords={[baseRecord]}
        applyJobResults={[baseApplyResult]}
        discoveryJobs={[]}
        applyRunHistory={[
          { result: { ...baseApplyResult, runId: run.id }, run },
        ]}
        effectiveSelectedApplyResult={baseApplyResult}
        hasAnyApplications
        hasVisibleApplications
        isApplyPending={false}
        isApplyRequestPending={() => false}
        isApplyRunPending={() => false}
        onApproveApplyRun={vi.fn()}
        onCancelApplyRun={vi.fn()}
        onOpenCompany={vi.fn()}
        onExportApplicationPacket={vi.fn(() => Promise.resolve())}
        onSaveApplicationAnswer={vi.fn(() => Promise.resolve())}
        onClearApplicationAnswer={vi.fn(() => Promise.resolve())}
        onResolveApplyConsentRequest={vi.fn()}
        onRevokeApplyRunApproval={vi.fn()}
        onSelectApplyRun={vi.fn()}
        onStartApplyCopilot={vi.fn()}
        onStartAutoApplyQueue={vi.fn()}
        selectedApplyRunId="run_latest01"
        selectedAttempt={null}
        selectedRecord={baseRecord}
        selectedRecordCompanyId="company_1"
      />,
    );

    const panel = container.firstElementChild;
    expect(panel?.className).toContain("@container/detail");
    // The reference links flow inline as text links now; no two-column grid.
    expect(container.querySelector('div[class*="34rem"]')).toBeNull();
    expect(
      screen.getByRole("region", { name: "Application status" }),
    ).toBeTruthy();
    // The newest run result says submitted, and a recorded submission
    // outranks the record's paused attempt state (ADR 0022).
    expect(screen.getAllByText("Applied")).toHaveLength(1);

    // The selected-record body is the pane's single bounded primary scroll
    // region, so the locked layout routes wheel and keyboard scrolling to it.
    const detailRegion = container.querySelector<HTMLElement>(
      "[data-locked-pane-scroll-region]",
    );
    expect(
      container.querySelectorAll("[data-locked-pane-scroll-region]"),
    ).toHaveLength(1);
    if (!detailRegion) {
      throw new Error("Expected the selected-record detail scroll region");
    }

    // A scroller that names only one axis resolves the other to `auto`, which
    // at 1920 drew a horizontal track beside the vertical one and clipped
    // run-history content into two-direction scrolling.
    expect(detailRegion.className).toContain("overflow-y-auto");
    expect(detailRegion.className).toContain("overflow-x-hidden");

    // The status block owns the next step now; there is no separate
    // "Next step" heading restating it above the buttons.
    expect(
      within(detailRegion).queryByRole("heading", { name: "Next step" }),
    ).toBeNull();
    // A confirmed submission has no primary recovery action. The older
    // paused record must not bring preparation controls back into this pane.
    expect(
      within(detailRegion).queryByTestId("applications-recovery-actions"),
    ).toBeNull();
    expect(detailRegion?.className).toContain("overflow-y-auto");

    // Diagnostics collapse into one closed "Run details and history" block that
    // owns the run history, review data, and preparation details.
    const technicalDetails = within(detailRegion).getByTestId(
      "applications-technical-details",
    );
    expect(technicalDetails.tagName).toBe("DETAILS");
    expect(technicalDetails.hasAttribute("open")).toBe(false);
    expect(
      within(technicalDetails).getByText("Run details and history"),
    ).toBeTruthy();
    expect(
      within(technicalDetails).getByRole("heading", {
        name: "Current preparation run",
      }),
    ).toBeTruthy();
    expect(
      within(technicalDetails).getByText("What Job Finder filled in"),
    ).toBeTruthy();
    expect(
      within(technicalDetails).getByText("Preparation details"),
    ).toBeTruthy();
    // The stacked (below-xl) pane sizes to its content instead of holding a
    // fixed minimum height; only the xl two-pane layout is full height.
    expect(panel?.className).not.toContain("min-h-124");
    expect(panel?.className).toContain("xl:h-full");
  });
});

describe("Applications detail heading weight", () => {
  it("never dresses a heading in the 700-weight label class", () => {
    // The published scale puts every heading at weight 600. `.label-mono-xs`
    // is a 700-weight *label* class, correct on a `<p>`, `<dt>` or `<span>`
    // but not on an `<h3>`: two Applications section eyebrows rendered at 700
    // beside neighbouring 600-weight eyebrows saying the same kind of thing.
    // They now share `APPLICATION_DETAIL_FACT_LABEL_CLASS` with those
    // neighbours.
    const directory = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];

    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith(".tsx") || entry.includes(".test.")) {
        continue;
      }

      const source = readFileSync(join(directory, entry), "utf8");
      for (const match of source.matchAll(/<h[1-6][^>]*label-mono-xs[^>]*>/g)) {
        offenders.push(`${entry}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

it("shows cancellation by the person in application facts", () => {
  renderStrip({
    record: {
      ...baseRecord,
      lastAttemptState: "cancelled",
      lastActionLabel: "Cancelled by you",
      latestBlocker: null,
    },
    visibleApplyResult: {
      ...baseApplyResult,
      state: "cancelled",
      summary: "Cancelled by you",
      detail: "Nothing was sent.",
    },
  });
  expect(screen.getAllByText("Cancelled by you").length).toBeGreaterThan(0);
  expect(screen.queryByText("Could not apply")).toBeNull();
  expect(screen.queryByText("Needs you")).toBeNull();
});

it("labels a cancelled preparation history entry as cancelled by the person", () => {
  render(
    <ApplicationsDetailPanelRunHistorySection
      applyRunHistory={[
        {
          result: {
            ...baseApplyResult,
            state: "cancelled",
            summary: "Cancelled by you",
            detail: "Nothing was sent.",
          },
          run: null,
        },
      ]}
      onSelectApplyRun={vi.fn()}
      selectedApplyRunId={baseApplyResult.runId}
    />,
  );
  expect(screen.getAllByText("Cancelled by you")).toHaveLength(2);
  expect(screen.queryByText("Cancelled")).toBeNull();
});

it("counts answers from a Ready review card when legacy counters are zero", () => {
  renderStrip({
    record: {
      ...baseRecord,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
    },
    visibleApplyResult: {
      ...baseApplyResult,
      state: "awaiting_review",
      latestQuestionCount: 0,
      latestAnswerCount: 0,
      reviewCard: {
        siteLabel: "Synthetic",
        pageUrl: "https://example.test/apply",
        preparedAt: baseApplyResult.updatedAt,
        answers: [
          {
            question: "Name",
            answer: "Synthetic Person",
            source: "your profile",
            written: false,
            groundedIn: [],
          },
        ],
        attachments: [],
        letter: null,
        waitingOnYou: [],
      },
    },
  });
  fireEvent.click(screen.getByText("More about this application"));
  expect(screen.getByText(/1 question found.*1 answer filled/u)).toBeTruthy();
  expect(screen.queryByText(/0 questions found/u)).toBeNull();
  expect(screen.getByText("1 answered • 0 required left")).toBeTruthy();
  expect(
    screen.getByText("Form questions").nextElementSibling?.textContent,
  ).toContain("1");
});

it("labels a ready application's latest run Ready to send", () => {
  render(
    <ApplicationsDetailPanelRunHistorySection
      applyRunHistory={[
        {
          result: {
            id: "ready_result",
            runId: "ready_run",
            jobId: "job_1",
            applicationRecordId: "application_1",
            state: "awaiting_review",
            summary: "Ready to send",
            detail: "Filled in",
            startedAt: "2026-10-05T10:00:00Z",
            updatedAt: "2026-10-05T10:00:00Z",
          } as ApplyJobResultSummary,
          run: null,
        },
      ]}
      onSelectApplyRun={vi.fn()}
      selectedApplyRunId="ready_run"
    />,
  );
  expect(screen.getByText("Ready to send")).toBeTruthy();
  expect(screen.queryByText("Awaiting Review")).toBeNull();
});

it("leaves site confirmation to recovery and does not expose internal run IDs", () => {
  const result = {
    ...baseApplyResult,
    state: "submitted" as const,
    runId: "internal-run-secret",
    summary: "Submitted",
    detail: "The site confirmed receipt.",
  };
  renderStrip({
    record: {
      ...baseRecord,
      status: "submitted",
      lastActionLabel: "The site confirmed receipt.",
    },
    visibleApplyResult: result,
  });
  expect(screen.queryByText("The site confirmed receipt.")).toBeNull();
  expect(screen.queryByText(/Run internal/)).toBeNull();
  expect(document.body.innerHTML).not.toContain("internal-run-secret");
});
