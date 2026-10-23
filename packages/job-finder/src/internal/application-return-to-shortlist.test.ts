import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  APPLICATION_SENT_CANNOT_MOVE_BACK_MESSAGE,
  ApplicationRecordSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  createBrowserRuntime,
  createSeed,
  createWorkspaceServiceHarness,
} from "../workspace-service.test-support";

function createPreparedHarness() {
  const seed = createSeed();
  seed.settings.resumeApplicationMode = "original_resume";
  seed.profile.baseResume.storagePath = "C:/tmp/synthetic-resume.pdf";
  const baseRuntime = createBrowserRuntime();
  const releaseApplicationPageBinding = vi.fn<
    NonNullable<BrowserSessionRuntime["releaseApplicationPageBinding"]>
  >(() => Promise.resolve());
  const executeApplicationFlow = vi.fn(
    (...args: Parameters<typeof baseRuntime.executeApplicationFlow>) =>
      baseRuntime.executeApplicationFlow(...args),
  );
  const submitPreparedApplication = vi.fn(() =>
    Promise.reject(new Error("Nothing may be sent in this test.")),
  );
  const harness = createWorkspaceServiceHarness({
    seed,
    browserRuntime: {
      ...baseRuntime,
      executeApplicationFlow,
      releaseApplicationPageBinding,
      submitPreparedApplication,
    } as BrowserSessionRuntime,
  });
  return {
    ...harness,
    executeApplicationFlow,
    releaseApplicationPageBinding,
    submitPreparedApplication,
  };
}

describe("Applications -> Shortlisted for an unsent application", () => {
  test("closes the prepared form, keeps its history, and shows the job in Shortlisted", async () => {
    const harness = createPreparedHarness();
    const prepared =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const record = prepared.applicationRecords.find(
      (entry) => entry.jobId === "job_ready",
    );
    if (!record) throw new Error("Expected a prepared application.");
    const [preparedResult] = await harness.repository.listApplyJobResults({
      applicationRecordId: record.id,
    });
    expect(preparedResult?.state).toBe("awaiting_review");
    const flowsBefore = harness.executeApplicationFlow.mock.calls.length;
    const runsBefore = (await harness.repository.listApplyRuns()).length;

    const moved = await harness.workspaceService.returnApplicationToShortlist(
      record.id,
    );

    expect(moved.applicationRecords.map((entry) => entry.jobId)).not.toContain(
      "job_ready",
    );
    expect(moved.reviewQueue.map((item) => item.jobId)).toContain("job_ready");
    expect(harness.releaseApplicationPageBinding).toHaveBeenCalledWith(
      expect.any(String),
      preparedResult?.id,
    );
    // Nothing sent, nothing prepared again.
    expect(harness.submitPreparedApplication).not.toHaveBeenCalled();
    expect(harness.executeApplicationFlow.mock.calls.length).toBe(flowsBefore);
    expect((await harness.repository.listApplyRuns()).length).toBe(runsBefore);
    const stored = (await harness.repository.listApplicationRecords()).find(
      (entry) => entry.id === record.id,
    );
    expect(stored?.returnedToShortlistAt).toEqual(expect.any(String));
    expect(stored?.events.length).toBeGreaterThan(record.events.length);
    expect(stored?.events.slice(0, record.events.length)).toEqual(
      record.events,
    );
    const [closed] = await harness.repository.listApplyJobResults({
      applicationRecordId: record.id,
    });
    expect(closed).toMatchObject({ id: preparedResult?.id, state: "skipped" });
    // A restart has nothing left to recover for it, so it stays out.
    expect(
      (
        await harness.workspaceService.getWorkspaceSnapshot()
      ).applicationRecords.map((entry) => entry.jobId),
    ).not.toContain("job_ready");
  });

  test("Apply afterwards starts normally on the same record and brings it back", async () => {
    const harness = createPreparedHarness();
    const prepared =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const record = prepared.applicationRecords.find(
      (entry) => entry.jobId === "job_ready",
    )!;
    await harness.workspaceService.returnApplicationToShortlist(record.id);
    const flowsBefore = harness.executeApplicationFlow.mock.calls.length;

    const again =
      await harness.workspaceService.startApplyCopilotRun("job_ready");

    expect(harness.executeApplicationFlow.mock.calls.length).toBe(
      flowsBefore + 1,
    );
    const listed = again.applicationRecords.filter(
      (entry) => entry.jobId === "job_ready",
    );
    expect(listed.map((entry) => entry.id)).toEqual([record.id]);
    expect(harness.submitPreparedApplication).not.toHaveBeenCalled();
  });

  test("Undo lists it in Applications again without preparing anything", async () => {
    const harness = createPreparedHarness();
    const prepared =
      await harness.workspaceService.startApplyCopilotRun("job_ready");
    const record = prepared.applicationRecords.find(
      (entry) => entry.jobId === "job_ready",
    )!;
    await harness.workspaceService.returnApplicationToShortlist(record.id);
    const flowsBefore = harness.executeApplicationFlow.mock.calls.length;

    const undone =
      await harness.workspaceService.undoReturnApplicationToShortlist(
        "job_ready",
      );

    expect(undone.applicationRecords.map((entry) => entry.id)).toContain(
      record.id,
    );
    expect(harness.executeApplicationFlow.mock.calls.length).toBe(flowsBefore);
    await expect(
      harness.workspaceService.undoReturnApplicationToShortlist("job_ready"),
    ).rejects.toThrow(/Applications again already/);
  });

  test("a sent application cannot move back", async () => {
    const seed = createSeed();
    const now = "2026-10-03T10:00:00.000Z";
    seed.applicationRecords = [
      ApplicationRecordSchema.parse({
        id: "application_sent",
        jobId: "job_ready",
        title: "Synthetic job",
        company: "Synthetic company",
        status: "submitted",
        lastAttemptState: "submitted",
        lastActionLabel: "Sent",
        nextActionLabel: null,
        lastUpdatedAt: now,
      }),
    ];
    const harness = createWorkspaceServiceHarness({ seed });

    await expect(
      harness.workspaceService.returnApplicationToShortlist("application_sent"),
    ).rejects.toThrow(APPLICATION_SENT_CANNOT_MOVE_BACK_MESSAGE);
    expect(
      (await harness.repository.listApplicationRecords())[0]
        ?.returnedToShortlistAt,
    ).toBeUndefined();
  });
});
