import type { JobFinderWorkspaceSnapshot } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import { applyToJobsTool, openApplicationFor } from "./application-tools";
import { RESOLVE_SETTLE_WAIT_MS, resolveNeedsYouTool } from "./workspace-tools";

const run = (id: string, state: string) => ({ id, state });
const result = (
  runId: string,
  jobId: string,
  state: string,
  updatedAt: string,
) => ({
  runId,
  jobId,
  state,
  updatedAt,
});

function snapshotWith(input: {
  runs: ReturnType<typeof run>[];
  results: ReturnType<typeof result>[];
  requests?: unknown[];
}) {
  return {
    applyRuns: input.runs,
    applyJobResults: input.results,
    applicationRecords: [],
    discoveryJobs: [],
    companyJobs: [],
    dismissedDiscoveryJobs: [],
    searchPreferences: { companyBlacklist: [] },
    settings: { applicationAutomationMode: "prepare_only" },
    userActionRequests: input.requests ?? [],
  } as unknown as JobFinderWorkspaceSnapshot;
}

describe("one application per job", () => {
  it("finds the application already open for a job", () => {
    const snapshot = snapshotWith({
      runs: [
        run("run_old", "completed"),
        run("run_paused", "paused_for_user_review"),
      ],
      results: [
        result("run_old", "job_1", "failed", "2026-09-27T10:00:00.000Z"),
        result(
          "run_paused",
          "job_1",
          "awaiting_review",
          "2026-09-27T10:05:00.000Z",
        ),
      ],
    });
    expect(openApplicationFor(snapshot, "job_1")).toEqual({
      runId: "run_paused",
      runState: "paused_for_user_review",
      jobState: "awaiting_review",
    });
    expect(openApplicationFor(snapshot, "job_2")).toBeNull();
  });

  it("does not start a second run for a job whose application is waiting", async () => {
    const snapshot = snapshotWith({
      runs: [run("run_paused", "paused_for_user_review")],
      results: [
        result(
          "run_paused",
          "job_1",
          "awaiting_review",
          "2026-09-27T10:05:00.000Z",
        ),
      ],
    });
    const startApplications = vi.fn();
    const error = await applyToJobsTool
      .execute(
        { jobIds: ["job_1"], evenIfExcludedOrApplied: true },
        {
          service: {
            getWorkspaceSnapshot: () => Promise.resolve(snapshot),
          } as never,
          session: {
            grants: { list: () => Promise.resolve([]) },
          } as unknown as AssistantTurnSession,
          ports: { startApplications } as unknown as AssistantHostPorts,
        },
      )
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(error?.message).toContain("already prepared and waiting");
    expect(startApplications).not.toHaveBeenCalled();
  });

  it("keeps the retained application while its answered step is verifying", async () => {
    const snapshot = snapshotWith({
      runs: [run("run_finished", "completed")],
      results: [
        result(
          "run_finished",
          "job_1",
          "awaiting_review",
          "2026-09-30T01:00:00.000Z",
        ),
      ],
      requests: [
        {
          state: "verifying",
          scope: { type: "application", runId: "run_finished", jobId: "job_1" },
        },
      ],
    });
    expect(openApplicationFor(snapshot, "job_1")?.runId).toBe("run_finished");
    const startApplications = vi.fn();
    await expect(
      applyToJobsTool.execute(
        { jobIds: ["job_1"], evenIfExcludedOrApplied: true },
        {
          service: {
            getWorkspaceSnapshot: () => Promise.resolve(snapshot),
          } as never,
          session: {
            grants: { list: () => Promise.resolve([]) },
          } as unknown as AssistantTurnSession,
          ports: { startApplications } as unknown as AssistantHostPorts,
        },
      ),
    ).rejects.toThrow("already prepared and waiting");
    expect(startApplications).not.toHaveBeenCalled();
    snapshot.userActionRequests[0]!.state = "resolved";
    expect(openApplicationFor(snapshot, "job_1")).toBeNull();
  });
});

describe("answering an application's step", () => {
  it("returns with the real run state instead of hanging on the check", async () => {
    vi.useFakeTimers();
    const request = {
      id: "request_1",
      title: "Answer the required question",
      revision: 1,
      state: "pending",
      scope: { type: "application", runId: "run_paused", jobId: "job_1" },
    };
    const watchRun = vi.fn(() => Promise.resolve());
    const pending = resolveNeedsYouTool.execute(
      {
        requestId: "request_1",
        action: "answer",
        answer: "Yes",
        saveForLater: false,
      },
      {
        service: {
          getWorkspaceSnapshot: () =>
            Promise.resolve(
              snapshotWith({
                runs: [run("run_paused", "running")],
                results: [
                  result(
                    "run_paused",
                    "job_1",
                    "planned",
                    "2026-09-27T10:05:00.000Z",
                  ),
                ],
                requests: [request],
              }),
            ),
          getApplyRunDetails: () => Promise.resolve({ questionRecords: [] }),
          // The check waits on the site and does not come back.
          performUserAction: () => new Promise(() => undefined),
        } as never,
        session: {
          assertCurrent: () => undefined,
          createId: () => "id_1",
          watchRun,
          assertPersonAnswerAuthority: () => Promise.resolve(),
        } as unknown as AssistantTurnSession,
        ports: {} as AssistantHostPorts,
      },
    );
    await vi.advanceTimersByTimeAsync(RESOLVE_SETTLE_WAIT_MS + 500);
    const outcome = await pending;
    vi.useRealTimers();
    expect(outcome.summary).toContain(
      "checking it is still going on in the background",
    );
    expect(outcome.summary).toContain("not started yet");
    expect(watchRun).toHaveBeenCalled();
    // Answers in one reply wait one after another; keep each wait short.
    expect(RESOLVE_SETTLE_WAIT_MS).toBeLessThanOrEqual(8_000);
  });
});

it("treats a cancelled item as ended while its batch sibling remains open", () => {
  const snapshot = snapshotWith({
    runs: [run("run_paused", "paused_for_user_review")],
    results: [
      result("run_paused", "job_1", "cancelled", "2026-10-01T10:00:00.000Z"),
      result(
        "run_paused",
        "job_2",
        "awaiting_review",
        "2026-10-01T10:00:00.000Z",
      ),
    ],
  });
  expect(openApplicationFor(snapshot, "job_1")).toBeNull();
  expect(openApplicationFor(snapshot, "job_2")).toMatchObject({
    jobState: "awaiting_review",
  });
});
