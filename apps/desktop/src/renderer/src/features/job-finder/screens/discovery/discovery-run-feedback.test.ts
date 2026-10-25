import {
  DiscoveryRunRecordSchema,
  buildDiscoveryCardOnlyEvidenceWarning,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import {
  createDiscoveryRunCancelledFeedback,
  createDiscoveryRunFailedFeedback,
  createDiscoveryRunInterruptedFeedback,
  createDiscoveryRunRefreshIncompleteFeedback,
  createDiscoveryRunRepeatedFeedback,
  createDiscoveryRunSafeguardPausedFeedback,
  createDiscoveryRunStartedFeedback,
  createDiscoveryRunSucceededFeedback,
  getDiscoveryCancelledSavedJobCount,
  getDiscoveryLatestRunNotices,
  getDiscoveryLatestRunVerdict,
  getDiscoveryRunFailureRecovery,
  isDiscoveryFailureSuperseded,
  shouldPresentRepeatedDiscoveryFeedback,
} from "./discovery-run-feedback";

describe("discovery run failure recovery classification", () => {
  it("points a human-verification wall at the in-app browser", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "Agent discovery stopped after 45 steps. Found 0 jobs. Discovery encountered an error: This site showed a human-verification check instead of its job listings, so nothing could be read. Verification checks cannot be passed automatically; try another job site or a company careers page.",
    );

    expect(recovery.kind).toBe("browser_session");
    expect(recovery.headline).toContain("human verification check");
    expect(recovery.actionLabel).toBe("Open the Job Finder browser");
    expect(recovery.nextStep).toBe(
      "Open the site in the browser, get past the check, then search again.",
    );
  });

  it("classifies the bot-check notice before its mention of the browser", () => {
    const detail =
      "jobs.example.test is showing a bot check. Open it in the browser, get past the check, then search again.";
    expect(getDiscoveryRunFailureRecovery(detail).kind).toBe("browser_session");
    expect(createDiscoveryRunFailedFeedback({ detail }).detail).toBe(detail);
    expect(
      getDiscoveryLatestRunNotices([
        {
          state: "failed",
          startedAt: "2026-10-01T10:00:00.000Z",
          summary: { warnings: [detail] },
        },
      ]),
    ).toEqual([detail]);
  });

  it("sends a source address that returned 404 to job sources instead of saying wait and retry", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "Agent discovery failed: Starting page returned HTTP 404: http://127.0.0.1:47954/nope/",
    );

    expect(recovery.kind).toBe("source_setup");
    expect(recovery.headline).toBe(
      "A job source's address leads to a page that does not exist.",
    );
    expect(recovery.actionLabel).toBe("Review job sources");
    // A provider 404 that names no page stays with the generic retry.
    expect(
      getDiscoveryRunFailureRecovery("Provider answered HTTP 404").kind,
    ).toBe("retry");
  });

  it("names a sign-in wall and offers the browser", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "This site asks you to sign in before it shows job listings, so nothing could be read automatically. Open it in the Job Finder browser, sign in there, then search again.",
    );

    expect(recovery.kind).toBe("browser_session");
    expect(recovery.headline).toContain("sign in");
    expect(recovery.actionLabel).toBe("Open the Job Finder browser");
  });

  it("explains a no-progress stop instead of calling it unexpected", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "Discovery stopped because repeated actions produced no new jobs, page evidence, or useful state changes.",
    );

    expect(recovery.kind).toBe("retry");
    expect(recovery.headline).toBe(
      "This source did not show any readable job listings.",
    );
  });

  it("maps a closed or unavailable browser runtime to opening the browser", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "The dedicated browser profile could not start because Chrome is not installed or is closed.",
    );

    expect(recovery.kind).toBe("browser_session");
    expect(recovery.actionLabel).toBe("Open the Job Finder browser");
  });

  it("maps a disabled browser agent runtime to opening the browser", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "Targeted sign-in is unavailable because the browser agent runtime is disabled.",
    );

    expect(recovery.kind).toBe("browser_session");
  });

  it("maps missing or disabled sources to the exact source setup owner", () => {
    const singleTarget = getDiscoveryRunFailureRecovery(
      "single_target: target not found or unavailable",
    );
    const noSources = getDiscoveryRunFailureRecovery(
      "Add or enable at least one valid public job-source URL before searching.",
    );

    expect(singleTarget.kind).toBe("source_setup");
    expect(noSources.kind).toBe("source_setup");
    expect(noSources.actionLabel).toBe("Review job sources");
  });

  it("maps provider and network transport failures to connection guidance", () => {
    for (const detail of [
      "fetch failed",
      "getaddrinfo ENOTFOUND jobs.example.com",
      "request to https://api.example.com timed out",
      "The dedicated browser could not open https://jobs.example.com: page.goto: net::ERR_CONNECTION_REFUSED",
    ]) {
      expect(getDiscoveryRunFailureRecovery(detail).kind).toBe("connection");
    }
  });

  it("maps missing AI tool calling to a distinct retry recovery", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "AI client does not support tool calling. Cannot run agent discovery.",
    );

    expect(recovery.kind).toBe("retry");
    expect(recovery.headline).toContain("Live search needs AI");
    expect(recovery.nextStep).not.toMatch(/provider|test mode/i);
    expect(recovery.headline).not.toBe(
      "The search stopped before it could finish.",
    );
  });

  it("keeps unknown failures retryable without inventing a cause", () => {
    const recovery = getDiscoveryRunFailureRecovery(
      "Discovery failed for Example Board: unexpected extraction shape",
    );

    expect(recovery.kind).toBe("retry");
    expect(recovery.actionLabel).toBeNull();
    expect(recovery.headline).toBe("Something unexpected stopped this search.");
  });
});

describe("discovery run interrupted feedback", () => {
  it("reports a started run that stopped before completion", () => {
    const feedback = createDiscoveryRunInterruptedFeedback({
      detail: "fetch failed",
      targetLabel: null,
    });

    expect(feedback.status).toBe("failed");
    expect(feedback.headline).toBe(
      "The search stopped before it could finish.",
    );
    expect(feedback.detail).toBe("fetch failed");
    expect(feedback.recovery?.kind).toBe("connection");
  });

  it("names a single-source run that stopped before completion", () => {
    const feedback = createDiscoveryRunInterruptedFeedback({
      detail: null,
      targetLabel: "Stripe Careers",
    });

    expect(feedback.headline).toBe(
      "The search for Stripe Careers stopped before it could finish.",
    );
    expect(feedback.recovery).toBeNull();
  });

  it("never duplicates the stopped headline inside recovery copy", () => {
    const feedback = createDiscoveryRunInterruptedFeedback({
      detail: "Discovery failed for Example Board: unexpected extraction shape",
      targetLabel: null,
    });

    expect(feedback.headline).toBe(
      "The search stopped before it could finish.",
    );
    expect(feedback.recovery?.headline).not.toBe(feedback.headline);
  });

  it("names tool-calling gaps without the generic stopped recovery line", () => {
    const feedback = createDiscoveryRunInterruptedFeedback({
      detail:
        "AI client does not support tool calling. Cannot run agent discovery.",
      targetLabel: null,
    });

    expect(feedback.recovery?.headline).toContain("Live search needs AI");
    expect(feedback.recovery?.headline).not.toBe(feedback.headline);
  });
});

describe("discovery run feedback factories", () => {
  it("reports an all-source start immediately with pending guidance", () => {
    const feedback = createDiscoveryRunStartedFeedback();

    expect(feedback.status).toBe("started");
    expect(feedback.recovery).toBeNull();
    expect(feedback.headline).toContain("Search started");
  });

  it("names a single-source run while it starts", () => {
    const feedback = createDiscoveryRunStartedFeedback("Stripe Careers");

    expect(feedback.targetLabel).toBe("Stripe Careers");
    expect(feedback.headline).toContain("Stripe Careers");
  });

  it("keeps the truthful finished wording for success", () => {
    const allSources = createDiscoveryRunSucceededFeedback();
    const singleSource = createDiscoveryRunSucceededFeedback("Circle");

    expect(allSources.headline).toBe(
      "Search finished and results were saved on this device.",
    );
    expect(singleSource.headline).toBe(
      "Search finished for Circle and results were saved on this device.",
    );
  });

  it("reports a safeguard pause as paused with the Safeguards route", () => {
    const feedback = createDiscoveryRunSafeguardPausedFeedback(
      "/job-finder/safeguards",
    );

    expect(feedback.status).toBe("paused");
    expect(feedback.headline).toBe("Search paused by a safety limit");
    expect(feedback.safeguardAction).toEqual({
      label: "Open Safeguards",
      route: "/job-finder/safeguards",
    });
  });

  it("explains when every reviewed listing was already saved", () => {
    const feedback = createDiscoveryRunRepeatedFeedback({
      duplicatesMerged: 15,
      targetLabel: "Wellfound",
    });

    expect(feedback.status).toBe("succeeded");
    expect(feedback.headline).toContain("Wellfound");
    expect(feedback.headline).toContain("15 listings were already saved");
    expect(feedback.headline).toContain("unchanged");
  });

  it("only treats zero-new duplicate merges as repeated-search feedback", () => {
    expect(
      shouldPresentRepeatedDiscoveryFeedback({
        duplicatesMerged: 9,
        validJobsFound: 0,
      }),
    ).toBe(true);
    expect(
      shouldPresentRepeatedDiscoveryFeedback({
        duplicatesMerged: 9,
        validJobsFound: 2,
      }),
    ).toBe(false);
    expect(
      shouldPresentRepeatedDiscoveryFeedback({
        duplicatesMerged: 0,
        validJobsFound: 0,
      }),
    ).toBe(false);
  });

  it("keeps the classified service detail verbatim on failure", () => {
    const detail =
      "Error invoking remote method 'job-finder:run-agent-discovery': Error: fetch failed";
    const feedback = createDiscoveryRunFailedFeedback({
      detail,
      targetLabel: null,
    });

    expect(feedback.status).toBe("failed");
    expect(feedback.detail).toBe(detail);
    expect(feedback.recovery?.kind).toBe("connection");
  });

  it("reports a finished search whose view refresh failed without inventing a recovery", () => {
    const allSources = createDiscoveryRunRefreshIncompleteFeedback();
    const singleSource = createDiscoveryRunRefreshIncompleteFeedback("Circle");

    expect(allSources.status).toBe("succeeded");
    expect(allSources.headline).toBe(
      "Search finished, but this view could not refresh automatically.",
    );
    expect(singleSource.headline).toBe(
      "Search finished for Circle, but this view could not refresh automatically.",
    );
    expect(allSources.recovery).toBeNull();
    expect(allSources.detail).toBeNull();
  });

  it("offers no invented recovery when no detail survives", () => {
    const feedback = createDiscoveryRunFailedFeedback({ detail: null });

    expect(feedback.recovery).toBeNull();
  });
});

describe("discovery run cancelled feedback", () => {
  it("acknowledges kept jobs when the stopped run had committed results", () => {
    const allSources = createDiscoveryRunCancelledFeedback({
      savedJobCount: 3,
    });
    const singleSource = createDiscoveryRunCancelledFeedback({
      savedJobCount: 1,
      targetLabel: "Stripe Careers",
    });

    expect(allSources.status).toBe("cancelled");
    expect(allSources.headline).toBe(
      "Search stopped. Jobs found so far were kept on this device.",
    );
    expect(singleSource.headline).toBe(
      "Search stopped for Stripe Careers. Jobs found so far were kept on this device.",
    );
    expect(allSources.detail).toBeNull();
  });

  it("never claims kept jobs or success for an empty cancellation", () => {
    for (const savedJobCount of [0, null]) {
      const feedback = createDiscoveryRunCancelledFeedback({
        savedJobCount,
        targetLabel: null,
      });

      expect(feedback.status).toBe("cancelled");
      expect(feedback.headline).toBe(
        "The search stopped before it could finish.",
      );
      expect(feedback.headline).not.toContain("saved");
      expect(feedback.recovery).toBeNull();
    }
  });

  it("never invents a failure recovery for a deliberate stop", () => {
    const feedback = createDiscoveryRunCancelledFeedback({
      savedJobCount: 5,
      targetLabel: "Circle",
    });

    expect(feedback.status).not.toBe("succeeded");
    expect(feedback.status).not.toBe("failed");
    expect(feedback.recovery).toBeNull();
  });
});

describe("getDiscoveryCancelledSavedJobCount", () => {
  const runWithSummary = (
    state: "completed" | "cancelled",
    validJobsFound: number,
  ) => ({
    state,
    summary: { validJobsFound },
  });

  it("counts only when the newest run is itself the cancelled run", () => {
    expect(
      getDiscoveryCancelledSavedJobCount([runWithSummary("cancelled", 4)]),
    ).toBe(4);
    expect(
      getDiscoveryCancelledSavedJobCount([
        runWithSummary("completed", 9),
        runWithSummary("cancelled", 4),
      ]),
    ).toBeNull();
  });

  it("reports unknown for empty history instead of fabricating zero", () => {
    expect(getDiscoveryCancelledSavedJobCount([])).toBeNull();
  });
});

describe("getDiscoveryLatestRunVerdict", () => {
  const run = (
    id: string,
    state: "completed" | "failed" | "cancelled" | "running" | "idle",
    startedAt: string,
  ) => ({ id, state, startedAt });
  const olderCompleted = run(
    "run_old",
    "completed",
    "2026-08-20T10:00:00.000Z",
  );
  const newerFailed = run("run_new", "failed", "2026-08-25T10:00:00.000Z");

  it("reports none for empty or idle-only history", () => {
    expect(getDiscoveryLatestRunVerdict([])).toEqual({ kind: "none" });
    expect(
      getDiscoveryLatestRunVerdict([run("a", "idle", "2026-08-01")]),
    ).toEqual({ kind: "none" });
  });

  it("reports running when the newest attempt is still in flight", () => {
    expect(
      getDiscoveryLatestRunVerdict([
        olderCompleted,
        run("run_live", "running", "2026-08-25T12:00:00.000Z"),
      ]),
    ).toEqual({ kind: "running" });
  });

  it("reports completed when the newest finished search wins over older failures", () => {
    const completedNewest = [
      olderCompleted,
      run("run_fail_old", "failed", "2026-08-22T10:00:00.000Z"),
      run("run_done", "completed", "2026-08-24T10:00:00.000Z"),
    ];
    expect(getDiscoveryLatestRunVerdict(completedNewest)).toEqual({
      kind: "completed",
    });
    expect(
      getDiscoveryLatestRunVerdict([...completedNewest].reverse()),
    ).toEqual({ kind: "completed" });
  });

  it("marks a newest failed run as interrupted with no earlier completed search", () => {
    const verdict = getDiscoveryLatestRunVerdict([
      run("run_a", "cancelled", "2026-08-21T10:00:00.000Z"),
      newerFailed,
    ]);

    expect(verdict).toEqual({
      hasEarlierCompleted: false,
      interruptState: "failed",
      kind: "interrupted",
    });
  });

  it("preserves the partial-completed signal behind an interrupted newest run", () => {
    const verdict = getDiscoveryLatestRunVerdict([
      newerFailed,
      run("run_cancelled_mid", "cancelled", "2026-08-22T10:00:00.000Z"),
      olderCompleted,
    ]);

    expect(verdict).toEqual({
      hasEarlierCompleted: true,
      interruptState: "failed",
      kind: "interrupted",
    });
  });

  it("marks a cancelled newest run as interrupted and keeps the state name", () => {
    const verdict = getDiscoveryLatestRunVerdict([
      newerFailed,
      run("run_cancel", "cancelled", "2026-08-26T10:00:00.000Z"),
    ]);

    expect(verdict).toEqual({
      hasEarlierCompleted: false,
      interruptState: "cancelled",
      kind: "interrupted",
    });
  });

  it("is independent of history array order for every terminal mixture", () => {
    const histories = [
      [olderCompleted, newerFailed],
      [newerFailed, olderCompleted],
    ];

    for (const history of histories) {
      expect(getDiscoveryLatestRunVerdict(history)).toEqual({
        hasEarlierCompleted: true,
        interruptState: "failed",
        kind: "interrupted",
      });
    }

    const mixed = [
      run("run_c", "cancelled", "2026-08-23T10:00:00.000Z"),
      run("run_d", "completed", "2026-08-19T10:00:00.000Z"),
      run("run_e", "failed", "2026-08-24T10:00:00.000Z"),
    ];
    expect(getDiscoveryLatestRunVerdict(mixed)).toEqual(
      getDiscoveryLatestRunVerdict([...mixed].reverse()),
    );
  });

  it("keeps the first-listed run authoritative when start times tie", () => {
    const tied = [
      run("run_first", "completed", "2026-08-25T10:00:00.000Z"),
      run("run_second", "failed", "2026-08-25T10:00:00.000Z"),
    ];

    expect(getDiscoveryLatestRunVerdict(tied)).toEqual({ kind: "completed" });
  });

  describe("completed runs with source-failure evidence", () => {
    const sourceHealthEntry = (
      targetId: string,
      health: "healthy" | "warning" | "failed",
    ) => ({ durationMs: 0, health, targetId, warnings: [] });
    const completedRun = (
      startedAt: string,
      summary: {
        duplicatesMerged?: number;
        validJobsFound: number;
        sourceHealth: ReturnType<typeof sourceHealthEntry>[];
      },
    ): {
      id: string;
      state: "completed";
      startedAt: string;
      summary: {
        duplicatesMerged: number;
        validJobsFound: number;
        sourceHealth: ReturnType<typeof sourceHealthEntry>[];
      };
    } => ({
      id: `run_${startedAt}`,
      state: "completed" as const,
      startedAt,
      summary: {
        duplicatesMerged: 0,
        ...summary,
      },
    });
    const mixedZeroResultSummary = {
      duplicatesMerged: 0,
      validJobsFound: 0,
      sourceHealth: [
        sourceHealthEntry("target_healthy", "healthy"),
        sourceHealthEntry("target_failed", "failed"),
      ],
    };

    it("marks a mixed success-and-failure zero-result completed run as interrupted", () => {
      const degradedRun = completedRun(
        "2026-08-25T10:00:00.000Z",
        mixedZeroResultSummary,
      );

      expect(getDiscoveryLatestRunVerdict([degradedRun])).toEqual({
        hasEarlierCompleted: false,
        interruptState: "sources_failed",
        kind: "interrupted",
      });
      expect(getDiscoveryLatestRunVerdict([degradedRun].reverse())).toEqual({
        hasEarlierCompleted: false,
        interruptState: "sources_failed",
        kind: "interrupted",
      });
    });

    it("acknowledges an earlier completed search behind a degraded newest run", () => {
      expect(
        getDiscoveryLatestRunVerdict([
          olderCompleted,
          completedRun("2026-08-25T10:00:00.000Z", mixedZeroResultSummary),
        ]),
      ).toEqual({
        hasEarlierCompleted: true,
        interruptState: "sources_failed",
        kind: "interrupted",
      });
    });

    it("keeps the completed verdict when a failed-source run still found results", () => {
      expect(
        getDiscoveryLatestRunVerdict([
          completedRun("2026-08-25T10:00:00.000Z", {
            ...mixedZeroResultSummary,
            validJobsFound: 3,
          }),
        ]),
      ).toEqual({ kind: "completed" });
    });

    it("keeps the completed verdict when zero new jobs were all already-saved duplicates", () => {
      expect(
        getDiscoveryLatestRunVerdict([
          completedRun("2026-08-25T10:00:00.000Z", {
            ...mixedZeroResultSummary,
            duplicatesMerged: 12,
          }),
        ]),
      ).toEqual({ kind: "completed" });
    });

    it("keeps the completed verdict for zero results when every execution succeeded", () => {
      expect(
        getDiscoveryLatestRunVerdict([
          completedRun("2026-08-25T10:00:00.000Z", {
            validJobsFound: 0,
            sourceHealth: [
              sourceHealthEntry("target_a", "healthy"),
              sourceHealthEntry("target_b", "healthy"),
              sourceHealthEntry("target_c", "warning"),
            ],
          }),
        ]),
      ).toEqual({ kind: "completed" });
    });

    it("never downgrades a completed run without summary evidence", () => {
      expect(getDiscoveryLatestRunVerdict([olderCompleted])).toEqual({
        kind: "completed",
      });
    });
  });
});

describe("latest discovery run notices", () => {
  const cardOnlyWarning =
    buildDiscoveryCardOnlyEvidenceWarning("Example Board");

  function runWithWarnings(
    startedAt: string,
    warnings: readonly string[],
    state: "completed" | "failed" | "idle" | "running" = "completed",
  ) {
    return { startedAt, state, summary: { warnings } } as const;
  }

  it("returns the newest settled run's warnings verbatim", () => {
    expect(
      getDiscoveryLatestRunNotices([
        runWithWarnings("2026-08-25T09:00:00.000Z", ["An older warning."]),
        runWithWarnings("2026-08-25T11:00:00.000Z", [cardOnlyWarning]),
      ]),
    ).toEqual([cardOnlyWarning]);
  });

  it("reports nothing when the newest run recorded no warning", () => {
    expect(
      getDiscoveryLatestRunNotices([
        runWithWarnings("2026-08-25T09:00:00.000Z", [cardOnlyWarning]),
        runWithWarnings("2026-08-25T11:00:00.000Z", []),
      ]),
    ).toEqual([]);
    expect(getDiscoveryLatestRunNotices([])).toEqual([]);
    expect(
      getDiscoveryLatestRunNotices([
        { startedAt: "2026-08-25T11:00:00.000Z", state: "completed" },
      ]),
    ).toEqual([]);
  });

  it("ignores idle placeholder rows and blank or repeated entries", () => {
    expect(
      getDiscoveryLatestRunNotices([
        runWithWarnings("2026-08-25T12:00:00.000Z", ["   "], "idle"),
        runWithWarnings("2026-08-25T11:00:00.000Z", [
          cardOnlyWarning,
          "   ",
          cardOnlyWarning,
        ]),
      ]),
    ).toEqual([cardOnlyWarning]);
  });

  it("never offers to open the listing elsewhere", () => {
    for (const notice of getDiscoveryLatestRunNotices([
      runWithWarnings("2026-08-25T11:00:00.000Z", [cardOnlyWarning]),
    ])) {
      expect(notice).not.toMatch(/open|browser|link/i);
    }
  });
});

describe("source errors after later searches", () => {
  const feedback = {
    ...createDiscoveryRunFailedFeedback({
      detail: "Source unavailable",
      targetId: "source_a",
      targetLabel: "Source A",
    }),
    recordedAtMs: Date.parse("2026-10-01T10:00:00.000Z"),
  };
  function completedSource(
    targetId: string,
    state: "completed" | "failed" = "completed",
    completedAt = "2026-10-01T10:02:00.000Z",
  ) {
    return DiscoveryRunRecordSchema.parse({
      id: "run_later",
      state: "completed",
      startedAt: "2026-10-01T10:01:00.000Z",
      completedAt,
      targetExecutions: [{ targetId, adapterKind: "auto", state, completedAt }],
    });
  }
  it("clears only after the same source completed later, including a partial run", () => {
    const run = completedSource("source_a");
    run.state = "failed";
    expect(
      isDiscoveryFailureSuperseded({
        feedback,
        targetId: "source_a",
        runs: [run],
      }),
    ).toBe(true);
    for (const run of [
      completedSource("source_b"),
      completedSource("source_a", "failed"),
      completedSource("source_a", "completed", "2026-10-01T09:59:00.000Z"),
    ]) {
      expect(
        isDiscoveryFailureSuperseded({
          feedback,
          targetId: "source_a",
          runs: [run],
        }),
      ).toBe(false);
    }
  });
});

describe("AI timeout recovery", () => {
  it.each([
    "Model request timed out after 240s",
    "The AI provider timeout ended the search",
    "Model request timed out after 120s of silence from the AI service",
    "The AI service stopped responding",
  ])("keeps the service cause and saved-job recovery: %s", (detail) => {
    const recovery = getDiscoveryRunFailureRecovery(detail);
    expect(recovery).toMatchObject({
      kind: "retry",
      headline: "The AI service stopped responding.",
      nextStep: "Jobs found so far are saved. Search again to continue.",
    });
    expect(JSON.stringify(recovery)).not.toMatch(/internet|connection/i);
  });

  it("does not call a job board's API timeout an AI outage", () => {
    // Job-board adapters are also "providers" in this codebase.
    const recovery = getDiscoveryRunFailureRecovery(
      "Public provider API collection failed: Greenhouse API request timed out.",
    );
    expect(recovery?.headline).not.toBe("The AI service stopped responding.");
  });
});

it("says a completed run is partial in both its headline and toast", () => {
  const feedback = createDiscoveryRunSucceededFeedback(
    null,
    "12 seen · 8 unique · 6 new · 8 kept",
    6,
    2,
  );
  expect(feedback.headline).toContain("Search finished, 2 sources failed");
  expect(feedback.toast?.title).toBe("Search finished, 2 sources failed");
  expect(feedback.partial).toBe(true);
});

it("describes new jobs as saved rather than promising all are visible matches", () => {
  const feedback = createDiscoveryRunSucceededFeedback(null, null, 3);
  expect(feedback.toast?.description).toBe("3 new jobs saved.");
});
