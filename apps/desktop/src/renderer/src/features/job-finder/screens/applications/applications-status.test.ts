import { FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP } from "../../lib/job-finder-browser-handoff-copy";
import { describe, expect, it } from "vitest";
import {
  ApplicationRecordSchema,
  ApplyJobResultSchema,
  type ApplicationRecord,
} from "@nestor/contracts";
import {
  getApplicationLatestActivityLabel,
  listPendingApplicationQuestions,
  getApplicationNextStepLabel,
  getApplicationReadableNextStepLabel,
  getApplicationStagePresentation,
  getApplicationSubmissionAnswer,
  applicationRecordAwaitsUser,
} from "./applications-status";
import { applicationRecordNeedsUser } from "./applications-screen-helpers";

function createRecord(
  overrides: Partial<ReturnType<typeof ApplicationRecordSchema.parse>> = {},
) {
  return ApplicationRecordSchema.parse({
    id: "application_1",
    jobId: "job_1",
    title: "Principal Designer",
    company: "Acme",
    status: "ready_for_review",
    lastActionLabel: "Ready for review.",
    nextActionLabel: "Review the prepared application.",
    lastUpdatedAt: "2026-03-20T10:00:00.000Z",
    ...overrides,
  });
}

describe("applications status helpers", () => {
  it("derives an unfinished preparation summary from the same write receipt as the field facts", () => {
    const result = ApplyJobResultSchema.parse({
      id: "result_1",
      runId: "run_1",
      jobId: "job_1",
      state: "blocked",
      summary: "Preparation stopped at sign-in.",
      detail: "The site requires sign-in.",
      startedAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-20T10:01:00.000Z",
      privacyReceipt: {
        generatedAt: "2026-03-20T10:01:00.000Z",
        lineage: {
          runId: "run_1",
          jobId: "job_1",
          resultId: "result_1",
          applicationRecordId: "application_1",
        },
        destination: { origin: "https://jobs.example", safePath: "/apply" },
        resume: {
          source: "original_upload",
          sourceDocumentId: "resume_1",
          exportArtifactId: null,
          fileName: "Resume.pdf",
          sha256: null,
        },
        externalWrites: [
          {
            category: "profile_field",
            fieldLabel: "Location",
            occurredAt: "2026-03-20T10:00:30.000Z",
            verified: true,
          },
        ],
      },
    });

    const answer = getApplicationSubmissionAnswer(
      createRecord({ lastAttemptState: "paused" }),
      "Acme",
      result,
    );

    expect(answer.headline).toBe("Preparation did not finish.");
    expect(answer.detail).toContain(
      "1 prepared field or file was recorded as written to the site",
    );
    expect(answer.detail).not.toContain("Nothing was recorded as written");
  });

  it("does not claim a resume was attached when preparation paused before filling", () => {
    const answer = getApplicationSubmissionAnswer(
      createRecord({ lastAttemptState: "paused" }),
    );
    expect(answer.headline).toBe("Not submitted.");
    expect(answer.detail).toContain("has not been sent to Acme");
    expect(answer.detail).not.toMatch(/attached|prepared this application/);
    expect(answer.submitted).toBe(false);
  });
  it("keeps the consent-declined stage while showing the paused next action as latest activity", () => {
    const record = createRecord({
      consentSummary: { status: "declined", pendingCount: 0 },
      lastAttemptState: "paused",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Consent declined",
      tone: "critical",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Review the prepared application.",
    );
    expect(getApplicationNextStepLabel(record)).toBe(
      "Review the prepared application.",
    );
  });

  it("shows that a consented but paused application still needs action", () => {
    const record = createRecord({
      consentSummary: { status: "approved", pendingCount: 0 },
      lastAttemptState: "paused",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Needs you",
      tone: "active",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Review the prepared application.",
    );
  });

  it("shows that a paused application needs action even when no consent was required", () => {
    const record = createRecord({
      status: "approved",
      consentSummary: { status: "none", pendingCount: 0 },
      lastAttemptState: "paused",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Needs you",
      tone: "active",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Review the prepared application.",
    );
  });

  it("rewrites site-blocked inspect-manually pauses onto the Safeguards finish path", () => {
    const record = createRecord({
      status: "approved",
      consentSummary: { status: "none", pendingCount: 0 },
      lastAttemptState: "paused",
      lastActionLabel: "Inspect the application page manually.",
      nextActionLabel: "Inspect the application page manually",
      latestBlocker: {
        code: "requires_manual_review",
        summary:
          "A service worker blocked automated preparation on this job site.",
      },
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Needs you",
      tone: "warning",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Automatic prep paused",
    );
    expect(getApplicationNextStepLabel(record)).toMatch(
      /Open Safeguards to reset the Job Finder browser/i,
    );
    expect(
      getApplicationReadableNextStepLabel(
        "Inspect the application page manually",
      ),
    ).toMatch(/Open Safeguards to reset the Job Finder browser/i);
  });

  it("reads an autosave pause with the same truthful step as the detail panel", () => {
    const record = createRecord({
      lastAttemptState: "paused",
      lastActionLabel:
        "The application page could not safely save a prepared field",
      nextActionLabel:
        "Complete the affected step manually in the open application, or cancel",
    });

    // List rows carry the compact one-line hand-off; the detail pane carries
    // the full instruction naming the window and the confirm action.
    expect(
      getApplicationReadableNextStepLabel(getApplicationNextStepLabel(record)),
    ).toBe(FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP);
    expect(
      getApplicationReadableNextStepLabel(
        "Complete the resume step manually in the open application, or cancel",
      ),
    ).toBe(FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP);
    expect(FINISH_IN_JOB_FINDER_BROWSER_LIST_NEXT_STEP).toMatch(
      /the Job Finder browser/,
    );
  });

  it("names the user's own gate when a paused run saved what to do next", () => {
    const record = createRecord({
      consentSummary: { status: "requested", pendingCount: 1 },
      nextActionLabel: "Sign in manually, then retry preparation",
      lastAttemptState: "paused",
    });

    // The site is waiting on the user, not asking for consent.
    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Needs you",
      tone: "active",
    });
    expect(getApplicationNextStepLabel(record)).toBe(
      "Sign in manually, then retry preparation",
    );
    expect(
      getApplicationReadableNextStepLabel(getApplicationNextStepLabel(record)),
    ).toBe(
      "Sign in on the site in the Job Finder browser, then run preparation again",
    );
  });

  it("keeps waiting-on-consent stage while paused activity falls back to a follow-up label", () => {
    const record = createRecord({
      consentSummary: { status: "requested", pendingCount: 2 },
      nextActionLabel: null,
      lastAttemptState: "paused",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Waiting on consent",
      tone: "active",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe("Needs follow-up");
    expect(getApplicationNextStepLabel(record)).toBe(
      "Choose continue or skip in Consent requests below.",
    );
  });

  it("prefers progressed status and latest action once the record has moved beyond consent states", () => {
    const record = createRecord({
      status: "interview",
      lastActionLabel: "Interview scheduled for Tuesday.",
      nextActionLabel: "Prepare portfolio walkthrough.",
      consentSummary: { status: "approved", pendingCount: 0 },
      lastAttemptState: "paused",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Interview",
      tone: "positive",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Interview scheduled for Tuesday.",
    );
    expect(getApplicationNextStepLabel(record)).toBe(
      "Prepare portfolio walkthrough.",
    );
  });

  it("does not keep showing consent declined after the record is later archived", () => {
    const record = createRecord({
      status: "archived",
      lastActionLabel: "Archived after final decision.",
      nextActionLabel: null,
      consentSummary: { status: "declined", pendingCount: 0 },
      lastAttemptState: "paused",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Archived",
      tone: "muted",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Archived after final decision.",
    );
    expect(getApplicationNextStepLabel(record)).toBe("No next step saved");
  });

  it("shows submitted activity and next step ahead of consent-approved copy", () => {
    const record = createRecord({
      status: "approved",
      lastActionLabel: "Submitted via apply copilot.",
      nextActionLabel: "Wait for a recruiter response.",
      consentSummary: { status: "approved", pendingCount: 0 },
      lastAttemptState: "submitted",
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Submitted",
      tone: "neutral",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Submitted via apply copilot.",
    );
    expect(getApplicationNextStepLabel(record)).toBe(
      "View application",
    );
  });

  it("uses terminal unsupported copy ahead of consent-approved fallback copy", () => {
    const record = createRecord({
      consentSummary: { status: "approved", pendingCount: 0 },
      lastAttemptState: "unsupported",
      nextActionLabel: null,
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Needs you on the site",
      tone: "warning",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe(
      "Needs you on the site",
    );
    expect(getApplicationNextStepLabel(record)).toBe("Needs you on the site");
    expect(
      getApplicationReadableNextStepLabel(getApplicationNextStepLabel(record)),
    ).toBe("Needs you on the site");
  });

  it("uses terminal failed copy ahead of consent-approved fallback copy", () => {
    const record = createRecord({
      consentSummary: { status: "approved", pendingCount: 0 },
      lastAttemptState: "failed",
      nextActionLabel: null,
    });

    expect(getApplicationStagePresentation(record)).toEqual({
      label: "Needs recovery",
      tone: "critical",
    });
    expect(getApplicationLatestActivityLabel(record)).toBe("Attempt failed");
    expect(getApplicationNextStepLabel(record)).toBe("Needs recovery");
    expect(
      getApplicationReadableNextStepLabel(getApplicationNextStepLabel(record)),
    ).toBe("Needs recovery");
  });

  it("shortens long manual-submit guidance for tighter card layouts", () => {
    expect(
      getApplicationReadableNextStepLabel(
        "Review the prepared application and submit manually when ready",
      ),
    ).toBe("Submit the prepared application manually");
  });

  it("maps persisted submit-approval wording onto preparation vocabulary", () => {
    expect(
      getApplicationReadableNextStepLabel(
        "Review the pending submit approval in applications",
      ),
    ).toBe("Review the pending safe preparation approval");
  });

  it("keeps stage and next-step copy free of legacy operation names", () => {
    const record = createRecord({
      consentSummary: { status: "requested", pendingCount: 1 },
      lastAttemptState: "paused",
    });
    const combined = [
      getApplicationStagePresentation(record).label,
      getApplicationLatestActivityLabel(record),
      getApplicationNextStepLabel(record),
    ].join(" ");

    expect(combined).not.toMatch(/submit approval|apply copilot|restage/i);
  });
});

describe("applicationRecordAwaitsUser", () => {
  it("is the same population the Applications row badges Needs you", () => {
    // "Needs you: 0 unresolved" sat beside an application badged NEEDS YOU.
    const paused = createRecord({
      lastAttemptState: "paused",
      consentSummary: { status: "requested", pendingCount: 1 },
      nextActionLabel: "Finish the sign-in step on the job site.",
    });
    expect(getApplicationStagePresentation(paused).label).toBe("Needs you");
    expect(applicationRecordAwaitsUser(paused)).toBe(true);

    const ready = createRecord();
    expect(getApplicationStagePresentation(ready).label).not.toBe("Needs you");
    expect(applicationRecordAwaitsUser(ready)).toBe(false);
  });

  it("agrees with the row badge across every stage combination", () => {
    // The two must not drift: whatever makes a row say "Needs you" is
    // exactly what the global Needs-you count counts.
    const statuses = [
      "discovered",
      "drafting",
      "ready_for_review",
      "approved",
      "submitted",
    ] as const;
    const attemptStates = [
      "paused",
      "failed",
      "submitted",
      "unsupported",
      "in_progress",
    ] as const;
    const consentStates = [
      "none",
      "requested",
      "approved",
      "declined",
    ] as const;

    for (const status of statuses) {
      for (const lastAttemptState of attemptStates) {
        for (const consent of consentStates) {
          for (const nextActionLabel of ["Finish on the job site.", null]) {
            const record = createRecord({
              status,
              lastAttemptState,
              consentSummary: { status: consent, pendingCount: 0 },
              nextActionLabel,
            });
            expect(applicationRecordAwaitsUser(record)).toBe(
              getApplicationStagePresentation(record).label === "Needs you",
            );
          }
        }
      }
    }
  });
});

describe("an application waiting for the person to send it", () => {
  function readyToSendRecord(
    overrides: Partial<ApplicationRecord> = {},
  ): ApplicationRecord {
    return {
      id: "application_ready",
      jobId: "job_ready",
      title: "Platform Engineer",
      company: "Northwind Tools",
      status: "approved",
      lastActionLabel: "Filled in and waiting",
      nextActionLabel: "Review it and send it",
      lastUpdatedAt: "2026-09-14T10:00:00.000Z",
      lastAttemptState: "awaiting_review",
      questionSummary: {},
      latestBlocker: null,
      consentSummary: {},
      replaySummary: {},
      events: [],
      crm: null,
      automationMode: "confirm_before_submit",
      ...overrides,
    } as unknown as ApplicationRecord;
  }

  it("counts as waiting on the person, so Needs you lists it", () => {
    expect(applicationRecordAwaitsUser(readyToSendRecord())).toBe(true);
  });

  it("says ready to send rather than borrowing the Needs you chip", () => {
    expect(getApplicationStagePresentation(readyToSendRecord())).toEqual({
      label: "Ready to send",
      tone: "active",
    });
  });

  it("stops waiting once it has been sent", () => {
    expect(
      applicationRecordAwaitsUser(
        readyToSendRecord({ lastAttemptState: "submitted" }),
      ),
    ).toBe(false);
  });

  it("an application set to fill in only is not waiting on anyone", () => {
    expect(
      applicationRecordAwaitsUser(
        readyToSendRecord({ automationMode: "prepare_only" }),
      ),
    ).toBe(false);
  });
});

describe("sign-in walls in the list row", () => {
  it("says sign in on the employer instead of open the application", () => {
    const record = createRecord({
      company: "Built In Chicago",
      lastAttemptState: "failed",
      lastActionLabel: "Job Finder could not finish this application",
      nextActionLabel: "Open the application and finish it",
      latestBlocker: {
        code: "site_login_required",
        summary:
          "Job Finder got stuck: Blocked by a Built In sign-in wall requiring login before applying.",
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: "https://www.builtinchicago.org/auth/login",
        checkpointCount: 1,
        evidenceCount: 0,
      },
    });

    // The site the sign-in actually happens on, not the employer name.
    const label = getApplicationNextStepLabel(record);
    expect(label).toBe("Sign in on builtinchicago.org");
    expect(getApplicationReadableNextStepLabel(label)).toBe(
      "Sign in on builtinchicago.org",
    );
  });

  it("leaves an ordinary next step alone", () => {
    const record = createRecord({
      company: "Acme",
      lastAttemptState: "paused",
      nextActionLabel: "Apply",
    });

    expect(getApplicationNextStepLabel(record)).not.toMatch(/sign in on/i);
  });
});

describe("account walls in the list row", () => {
  it("says create an account on the employer", () => {
    const record = createRecord({
      company: "Built In Chicago",
      lastAttemptState: "failed",
      nextActionLabel: "Create the account yourself",
      latestBlocker: {
        code: "requires_manual_review",
        summary:
          "The site wants an account before you can apply. Job Finder never creates accounts for you.",
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: "https://www.builtinchicago.org/jobs/apply",
        checkpointCount: 1,
        evidenceCount: 0,
      },
    });

    expect(getApplicationNextStepLabel(record)).toBe(
      "Create an account on builtinchicago.org",
    );
  });
});

describe("row next step and detail button stay one state", () => {
  it("never sends the row to a question that does not exist", () => {
    const record = createRecord({
      company: "Caterpillar",
      lastAttemptState: "failed",
      lastActionLabel:
        'The site tried to save your answer to "First Name" straight away.',
      nextActionLabel: "Answer the question in Needs you",
      latestBlocker: null,
      questionSummary: {
        total: 0,
        required: 0,
        answered: 0,
        unansweredRequired: 0,
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: "https://boards.example.com/apply/123",
        checkpointCount: 1,
        evidenceCount: 0,
      },
    });

    expect(getApplicationNextStepLabel(record)).toBe(
      "Allow saving on boards.example.com",
    );
  });

  it("names the sign-in site, never the employer", () => {
    const record = createRecord({
      company: "Caterpillar",
      lastAttemptState: "failed",
      nextActionLabel: "Sign in",
      latestBlocker: {
        code: "site_login_required",
        summary: "The site wants you signed in first.",
      },
      replaySummary: {
        sourceInstructionArtifactId: null,
        lastUrl: "https://accounts.builtin.com/login?next=/apply",
        checkpointCount: 1,
        evidenceCount: 0,
      },
    });

    const label = getApplicationNextStepLabel(record);
    expect(label).toBe("Sign in on accounts.builtin.com");
    expect(label).not.toContain("Caterpillar");
  });

  it("keeps the question label while a question is actually open", () => {
    const record = createRecord({
      lastAttemptState: "paused",
      nextActionLabel: "Answer the question in Needs you",
      latestBlocker: {
        code: "missing_candidate_answer",
        summary: "The form asks something you have not answered yet",
      },
    });

    expect(getApplicationNextStepLabel(record)).toBe(
      "Answer the question in Needs you",
    );
  });
});

describe("one pending-question list for both screens", () => {
  it("counts the rendered question records, not the run summary's tally", () => {
    const attempts = [
      {
        id: "attempt_old",
        jobId: "job_1",
        updatedAt: "2026-09-01T09:00:00.000Z",
        blocker: { code: "missing_candidate_answer" },
        questions: [
          { id: "q_old", status: "detected" },
          { id: "q_old_2", status: "detected" },
        ],
      },
      {
        id: "attempt_new",
        jobId: "job_1",
        updatedAt: "2026-09-01T10:00:00.000Z",
        blocker: { code: "missing_candidate_answer" },
        questions: [
          { id: "q_a", status: "detected" },
          { id: "q_b", status: "detected" },
          { id: "q_c", status: "detected" },
          { id: "q_d", status: "detected" },
          // Already answered, so neither screen shows it.
          { id: "q_done", status: "answered" },
          { id: "q_done_2", status: "answered" },
        ],
      },
      {
        id: "attempt_other_job",
        jobId: "job_2",
        updatedAt: "2026-09-01T11:00:00.000Z",
        blocker: { code: "missing_candidate_answer" },
        questions: [{ id: "q_other", status: "detected" }],
      },
    ] as unknown as Parameters<
      typeof listPendingApplicationQuestions
    >[0]["applicationAttempts"];

    // The record's own tally says six; the list both screens render is four.
    const record = createRecord({
      questionSummary: {
        total: 6,
        required: 6,
        answered: 0,
        unansweredRequired: 6,
      },
    });
    expect(record.questionSummary.unansweredRequired).toBe(6);

    const pending = listPendingApplicationQuestions({
      applicationAttempts: attempts,
      jobId: "job_1",
    });
    expect(pending.map((question) => question.id)).toEqual([
      "q_a",
      "q_b",
      "q_c",
      "q_d",
    ]);
  });

  it("is empty when no attempt paused on a question", () => {
    expect(
      listPendingApplicationQuestions({
        applicationAttempts: [],
        jobId: "job_1",
      }),
    ).toEqual([]);
  });

  it("does not reuse questions from another application record for the same job", () => {
    const attempts = [
      {
        id: "attempt_old",
        jobId: "job_1",
        applicationRecordId: "record_old",
        updatedAt: "2026-09-01T11:00:00.000Z",
        blocker: { code: "missing_candidate_answer" },
        questions: [{ id: "q_old", status: "detected" }],
      },
      {
        id: "attempt_current",
        jobId: "job_1",
        applicationRecordId: "record_current",
        updatedAt: "2026-09-01T10:00:00.000Z",
        blocker: null,
        questions: [],
      },
    ] as unknown as Parameters<
      typeof listPendingApplicationQuestions
    >[0]["applicationAttempts"];

    expect(
      listPendingApplicationQuestions({
        applicationAttempts: attempts,
        applicationRecordId: "record_current",
        jobId: "job_1",
      }),
    ).toEqual([]);
  });

  it("does not reuse an older missing answer after a newer attempt reached a different outcome", () => {
    const attempts = [
      {
        id: "attempt_question",
        jobId: "job_1",
        applicationRecordId: "record_current",
        updatedAt: "2026-09-01T10:00:00.000Z",
        blocker: { code: "missing_candidate_answer" },
        questions: [{ id: "q_old", status: "detected" }],
      },
      {
        id: "attempt_captcha",
        jobId: "job_1",
        applicationRecordId: "record_current",
        updatedAt: "2026-09-01T11:00:00.000Z",
        blocker: { code: "requires_manual_review" },
        questions: [],
      },
    ] as unknown as Parameters<
      typeof listPendingApplicationQuestions
    >[0]["applicationAttempts"];

    expect(
      listPendingApplicationQuestions({
        applicationAttempts: attempts,
        applicationRecordId: "record_current",
        jobId: "job_1",
      }),
    ).toEqual([]);

    const laterAttempts = [
      ...attempts,
      {
        id: "attempt_new_question",
        jobId: "job_1",
        applicationRecordId: "record_current",
        updatedAt: "2026-09-01T12:00:00.000Z",
        blocker: { code: "missing_candidate_answer" },
        questions: [{ id: "q_current", status: "detected" }],
      },
    ] as unknown as Parameters<
      typeof listPendingApplicationQuestions
    >[0]["applicationAttempts"];
    expect(
      listPendingApplicationQuestions({
        applicationAttempts: laterAttempts,
        applicationRecordId: "record_current",
        jobId: "job_1",
      }).map((question) => question.id),
    ).toEqual(["q_current"]);
  });

it("reads View application on a sent application with no saved next step", () => {
  // Sent during a batch run, the record carries no label of its own.
  const record = createRecord({
    status: "submitted",
    lastAttemptState: "submitted",
    nextActionLabel: null,
  });
  expect(getApplicationNextStepLabel(record)).toBe("View application");
});
});

describe("an application the person cancelled", () => {
  it("is not waiting on them", () => {
    const cancelled = createRecord({
      status: "drafting",
      lastAttemptState: "cancelled",
      lastActionLabel: "Cancelled by you",
      nextActionLabel: "Try again, or finish it yourself on the job site.",
    });
    expect(applicationRecordNeedsUser(cancelled)).toBe(false);
    expect(
      applicationRecordNeedsUser({ ...cancelled, lastAttemptState: "failed" }),
    ).toBe(true);
  });
});


it("ignores legacy Prepare again next steps after the application was sent", () => {
  expect(
    getApplicationNextStepLabel(
      createRecord({
        status: "submitted",
        lastAttemptState: "submitted",
        nextActionLabel: "Prepare again",
      }),
    ),
  ).toBe("View application");
});
