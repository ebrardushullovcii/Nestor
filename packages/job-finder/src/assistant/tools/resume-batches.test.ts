import { randomUUID } from "node:crypto";

import type {
  AssistantRunRef,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createSeed,
  createWorkspaceServiceHarness,
} from "../../workspace-service.test-support";
import { readRunStatus } from "../run-watch";
import type { AssistantHostPorts } from "../ports";
import type { AssistantTurnSession } from "../tool-kit";
import {
  cancelBackgroundBatch,
  cancelResumesTool,
  generateResumesTool,
  readBackgroundBatch,
} from "./resume-tools";

async function world(count = 5) {
  const seed = createSeed();
  const base = seed.savedJobs[0]!;
  seed.savedJobs = Array.from({ length: count }, (_, index) => ({
    ...base,
    id: `resume_batch_job_${index + 1}`,
    sourceJobId: `resume_batch_source_${index + 1}`,
    canonicalUrl: `https://jobs.example.test/resume-batch/${index + 1}`,
    applicationUrl: `https://jobs.example.test/resume-batch/${index + 1}/apply`,
    status: "shortlisted" as const,
    resumeApplicationMode: "tailored_per_job" as const,
    resumeTailoringMode:
      index === 0 ? ("aggressive" as const) : ("balanced" as const),
  }));
  seed.resumeDrafts = [];
  seed.tailoredAssets = [];
  seed.applicationRecords = [];
  const { workspaceService: service } = createWorkspaceServiceHarness({ seed });
  const snapshot = await service.getWorkspaceSnapshot();
  const controller = new AbortController();
  const runs: AssistantRunRef[] = [];
  const session = {
    conversationId: randomUUID(),
    signal: controller.signal,
    assertCurrent: () => undefined,
    now: () => new Date().toISOString(),
    createId: () => randomUUID(),
    watchRun: (run: AssistantRunRef) => {
      runs.push(run);
      return Promise.resolve();
    },
  } as unknown as AssistantTurnSession;
  const ports = {
    publishWorkspaceUpdate: vi.fn(),
    stopResumeBatch: () => null,
  } as unknown as AssistantHostPorts;
  const written = (jobId: string) => ({
    ...snapshot,
    resumeDrafts: [
      {
        jobId,
        generationMethod: "ai",
      } as JobFinderWorkspaceSnapshot["resumeDrafts"][number],
    ],
  });
  const generate = vi
    .spyOn(service, "generateResume")
    .mockImplementation((jobId) => Promise.resolve(written(jobId)));
  const regenerate = vi
    .spyOn(service, "regenerateResumeDraft")
    .mockImplementation((jobId) => Promise.resolve(written(jobId)));
  return {
    service,
    session,
    ports,
    controller,
    runs,
    generate,
    regenerate,
    snapshot,
    written,
    ids: seed.savedJobs.map((job) => job.id),
  };
}

function hold() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function finished(run: AssistantRunRef) {
  await vi.waitFor(() => expect(readBackgroundBatch(run.id)?.done).toBe(true));
  return readBackgroundBatch(run.id)!;
}

describe("sidebar resume batches", () => {
  it("R3-038 waits for a UI writer, then rewrites every requested job at the requested level", async () => {
    const ctx = await world(2);
    let uiRunning = true;
    ctx.ports.readResumeBatch = () =>
      uiRunning
        ? {
            id: "ui",
            jobIds: ctx.ids,
            activeJobIds: [ctx.ids[0]!],
            completedJobIds: [],
            stopRequested: false,
            done: false,
          }
        : null;
    const setLevel = vi
      .spyOn(ctx.service, "setJobResumeApplicationMode")
      .mockResolvedValue(ctx.snapshot);
    await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: false, level: "aggressive" },
      ctx,
    );
    expect(ctx.regenerate).not.toHaveBeenCalled();
    expect(setLevel).not.toHaveBeenCalled();
    uiRunning = false;
    const final = await finished(ctx.runs[0]!);
    expect(setLevel).toHaveBeenCalledTimes(2);
    expect(setLevel).toHaveBeenCalledWith(
      ctx.ids[0],
      "tailored_per_job",
      "aggressive",
    );
    // Parallel writers finish in either order.
    expect(ctx.regenerate.mock.calls.map(([id]) => id).sort()).toEqual(
      [...ctx.ids].sort(),
    );
    expect([...final.completedJobIds].sort()).toEqual([...ctx.ids].sort());
    expect(final.failures).toEqual([]);
  });

  it("R3-038 retries an initial deterministic draft and does not count a fallback as an AI rewrite", async () => {
    const ctx = await world(1);
    const initial = {
      ...ctx.snapshot,
      resumeDrafts: [
        {
          jobId: ctx.ids[0]!,
          generationMethod: "deterministic",
        } as JobFinderWorkspaceSnapshot["resumeDrafts"][number],
      ],
    };
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(initial);
    ctx.regenerate.mockResolvedValue(initial);
    await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: false },
      ctx,
    );
    const final = await finished(ctx.runs[0]!);
    expect(ctx.regenerate).toHaveBeenCalledWith(ctx.ids[0]);
    expect(final.completedJobIds).toEqual([]);
    expect(final.failures[0]).toContain("AI rewrite did not complete");
  });
  it("writes only the requested eligible jobs and reports Original, existing and application skips", async () => {
    const ctx = await world();
    const current = structuredClone(ctx.snapshot);
    current.discoveryJobs[0]!.resumeApplicationMode = "original_resume";
    current.resumeDrafts = [
      {
        jobId: ctx.ids[1]!,
        generationMethod: "ai",
      } as (typeof current.resumeDrafts)[number],
    ];
    current.applicationRecords = [
      { jobId: ctx.ids[2]! } as (typeof current.applicationRecords)[number],
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(current);
    const result = await generateResumesTool.execute(
      { jobIds: ctx.ids.slice(0, 4), regenerate: false },
      ctx,
    );
    await finished(ctx.runs[0]!);
    expect(ctx.generate.mock.calls.map(([id]) => id)).toEqual([ctx.ids[3]]);
    expect(ctx.regenerate).not.toHaveBeenCalled();
    expect(ctx.runs[0]?.jobIds).toEqual(ctx.ids.slice(0, 4));
    expect(readRunStatus(current, ctx.runs[0]!).summary).toContain(
      "1 rewritten, 0 failed, 3 skipped, 0 not started",
    );
    expect(result.data).toMatchObject({
      jobIds: [ctx.ids[3]],
      skipped: [
        { jobId: ctx.ids[0], reason: "Original resume is unchanged" },
        { jobId: ctx.ids[1], reason: "resume already exists" },
        { jobId: ctx.ids[2], reason: "already in Applications" },
      ],
    });
    expect(result.summary).toContain("Started writing 1 resume");
    expect(result.summary).toContain("Skipped 3 jobs");
  });

  it("follows the saved Original default, but preserves a per-job tailored override", async () => {
    const ctx = await world(2);
    const current = structuredClone(ctx.snapshot);
    current.settings.resumeApplicationMode = "original_resume";
    current.discoveryJobs[0]!.resumeApplicationMode = null;
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(current);
    await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: false },
      ctx,
    );
    await finished(ctx.runs[0]!);
    expect(ctx.generate.mock.calls.map(([id]) => id)).toEqual([ctx.ids[1]]);
    expect(current.discoveryJobs[1]?.resumeTailoringMode).toBe("balanced");
  });

  it("rewrites an existing draft only when asked, without changing its saved level", async () => {
    const ctx = await world(1);
    const current = structuredClone(ctx.snapshot);
    current.resumeDrafts = [
      {
        jobId: ctx.ids[0]!,
        generationMethod: "ai",
      } as (typeof current.resumeDrafts)[number],
    ];
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockResolvedValue(current);
    const skipped = await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: false },
      ctx,
    );
    expect(skipped.summary).toContain("No resumes started");
    expect(ctx.runs).toEqual([]);
    await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: true },
      ctx,
    );
    await finished(ctx.runs[0]!);
    expect(ctx.generate).not.toHaveBeenCalled();
    expect(ctx.regenerate).toHaveBeenCalledWith(ctx.ids[0]);
    expect(current.discoveryJobs[0]?.resumeTailoringMode).toBe("aggressive");
  });

  it("bounds workers, queues overlapping rewrites, and Stop after the turn ends lets only active drafts finish", async () => {
    const ctx = await world();
    const gate = hold();
    ctx.generate.mockImplementation(async (jobId) => {
      await gate.promise;
      return ctx.written(jobId);
    });
    await generateResumesTool.execute(
      { jobIds: [...ctx.ids, ctx.ids[0]!], regenerate: false },
      ctx,
    );
    await vi.waitFor(() => expect(ctx.generate).toHaveBeenCalledTimes(2));
    const duplicate = await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: true },
      ctx,
    );
    expect(duplicate.summary).toContain("Started writing 5 resumes");
    expect(ctx.runs).toHaveLength(2);
    expect(ctx.regenerate).not.toHaveBeenCalled();
    cancelBackgroundBatch(ctx.runs[1]!.id);
    cancelBackgroundBatch(ctx.runs[0]!.id);
    const active = readBackgroundBatch(ctx.runs[0]!.id)!;
    expect(active.cancelled).toBe(true);
    expect(active.done).toBe(false);
    expect(active.activeJobIds).toHaveLength(2);
    gate.resolve();
    const final = await finished(ctx.runs[0]!);
    expect(ctx.generate).toHaveBeenCalledTimes(2);
    expect([...final.completedJobIds].sort()).toEqual(
      ctx.ids.slice(0, 2).sort(),
    );
    expect(final.failures).toEqual([]);
    await finished(ctx.runs[1]!);
    expect(ctx.regenerate).not.toHaveBeenCalled();
  });

  it("rechecks the queued jobs' newest settings and continues after one job fails", async () => {
    const ctx = await world(4);
    const gate = hold();
    const current = structuredClone(ctx.snapshot);
    vi.spyOn(ctx.service, "getWorkspaceSnapshot").mockImplementation(() =>
      Promise.resolve(structuredClone(current)),
    );
    ctx.generate.mockImplementation(async (jobId) => {
      if (jobId === ctx.ids[0] || jobId === ctx.ids[1]) await gate.promise;
      if (jobId === ctx.ids[0]) throw new Error("temporary provider failure");
      return ctx.written(jobId);
    });
    await generateResumesTool.execute(
      { jobIds: ctx.ids, regenerate: false },
      ctx,
    );
    await vi.waitFor(() => expect(ctx.generate).toHaveBeenCalledTimes(2));
    current.discoveryJobs[2]!.resumeApplicationMode = "original_resume";
    gate.resolve();
    const final = await finished(ctx.runs[0]!);
    expect(ctx.generate.mock.calls.map(([id]) => id)).toEqual([
      ctx.ids[0],
      ctx.ids[1],
      ctx.ids[3],
    ]);
    expect(final.failures).toEqual([
      `${ctx.ids[0]}: temporary provider failure`,
    ]);
    expect(final.skipped).toEqual([
      { jobId: ctx.ids[2], reason: "Original resume is unchanged" },
    ]);
    expect(final.completedJobIds).toEqual([ctx.ids[1], ctx.ids[3]]);
  });

  it("the cancellation tool names active drafts and stops all conversations and the UI queue", async () => {
    const ctx = await world(4);
    const gate = hold();
    ctx.generate.mockImplementation(async (jobId) => {
      await gate.promise;
      return ctx.written(jobId);
    });
    await generateResumesTool.execute(
      { jobIds: ctx.ids.slice(0, 2), regenerate: false },
      ctx,
    );
    const other = {
      ...ctx,
      session: { ...ctx.session, conversationId: randomUUID() },
    };
    await generateResumesTool.execute(
      { jobIds: ctx.ids.slice(2), regenerate: false },
      other,
    );
    await vi.waitFor(() => expect(ctx.generate).toHaveBeenCalledTimes(4));
    ctx.ports.stopResumeBatch = () => ({
      id: "ui_batch",
      jobIds: ["ui_1", "ui_2", "ui_3"],
      activeJobIds: ["ui_1", "ui_2"],
      completedJobIds: [],
      stopRequested: true,
      done: false,
    });
    const result = await cancelResumesTool.execute({}, ctx);
    expect(result.data).toEqual({
      stoppedBatches: 3,
      activeDrafts: 6,
      uncheckedWork: [],
    });
    expect(result.summary).toContain("6 active drafts will finish");
    expect(readBackgroundBatch(ctx.runs[0]!.id)?.cancelled).toBe(true);
    expect(readBackgroundBatch(ctx.runs[1]!.id)?.cancelled).toBe(true);
    gate.resolve();
    await Promise.all(ctx.runs.map(finished));
  });
});

it("passes a language to the writer for a missing resume without translating or changing its level", async () => {
  const ctx = await world(1);
  const save = vi
    .spyOn(ctx.service, "saveResumeDraft")
    .mockResolvedValue(ctx.snapshot);
  const setLevel = vi.spyOn(ctx.service, "setJobResumeApplicationMode");
  await generateResumesTool.execute(
    { jobIds: ctx.ids, regenerate: false, language: "German" },
    ctx,
  );
  await finished(ctx.runs[0]!);
  expect(save).not.toHaveBeenCalled();
  expect(ctx.generate).toHaveBeenCalledWith(ctx.ids[0], { language: "German" });
  expect(ctx.regenerate).not.toHaveBeenCalled();
  expect(setLevel).not.toHaveBeenCalled();
});

it("language-only assistant action saves a translated existing draft without regenerating", async () => {
  const ctx = await world(1);
  const workspace = await ctx.service.getResumeWorkspace(ctx.ids[0]!);
  const save = vi
    .spyOn(ctx.service, "saveResumeDraft")
    .mockResolvedValue(ctx.written(ctx.ids[0]!));
  const setLevel = vi.spyOn(ctx.service, "setJobResumeApplicationMode");
  await generateResumesTool.execute(
    { jobIds: ctx.ids, regenerate: false, language: "German" },
    ctx,
  );
  await finished(ctx.runs[0]!);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ id: workspace.draft.id, language: "German" }),
  );
  expect(ctx.generate).not.toHaveBeenCalled();
  expect(ctx.regenerate).not.toHaveBeenCalled();
  expect(setLevel).not.toHaveBeenCalled();
});

it("R3-183 persists assistant requests before dispatch and keeps cancelled unfinished jobs recoverable", async () => {
  const ctx = await world(3);
  const gate = hold();
  const save = vi.spyOn(ctx.service, "saveResumeBatchCheckpoint");
  ctx.regenerate.mockImplementation(async (id) => {
    await gate.promise;
    return ctx.written(id);
  });
  await generateResumesTool.execute(
    { jobIds: ctx.ids, regenerate: true, level: "light", language: "German" },
    ctx,
  );
  await vi.waitFor(() => expect(ctx.regenerate).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[0]![0]).toMatchObject({
    done: false,
    requests: ctx.ids.map((jobId) => ({
      jobId,
      level: "light",
      language: "German",
      regenerate: true,
    })),
  });
  cancelBackgroundBatch(ctx.runs[0]!.id);
  gate.resolve();
  await finished(ctx.runs[0]!);
  await vi.waitFor(() =>
    expect(save.mock.calls.at(-1)![0]).toMatchObject({
      done: false,
      stopRequested: true,
      completedJobIds: expect.arrayContaining(ctx.ids.slice(0, 2)) as unknown,
    }),
  );
  expect(save.mock.calls.at(-1)![0].durationsMs).toHaveLength(2);
});
