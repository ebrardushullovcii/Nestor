import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { ApplyJobResultSchema } from "@nestor/contracts";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { createEmptyJobFinderRepositoryState } from "../../adapters/job-finder-initial-state";
import {
  createApplicationPageAccess,
  createPreparedApplicationFormStore,
} from "./prepared-application-forms";

test("recovery verifies the original attachment bytes again, including same-length replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nestor-form-file-"));
  try {
    const bytes = Buffer.from("synthetic file");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const filePath = join(directory, "synthetic.txt");
    await writeFile(filePath, bytes);
    const seed = createEmptyJobFinderRepositoryState();
    seed.profile.baseResume = {
      ...seed.profile.baseResume,
      id: "source",
      storagePath: filePath,
      sha256,
    };
    const repository = createInMemoryJobFinderRepository(seed);
    const assets = { resolveForApplication: vi.fn() };
    const store = createPreparedApplicationFormStore(repository, assets);
    const identity = {
      kind: "resume_source" as const,
      id: "source",
      name: "synthetic.txt",
      sha256,
    };
    expect(await store.loadAttachment(identity)).toEqual(bytes);
    await writeFile(filePath, Buffer.alloc(bytes.length, 1));
    await expect(store.loadAttachment(identity)).rejects.toThrow(
      "Attachment changed",
    );
    await expect(
      store.loadAttachment({ ...identity, id: "other" }),
    ).rejects.toThrow("Resume unavailable");
    expect(assets.resolveForApplication).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a finished or uncertain application cannot reopen or trigger preparation/sending", async () => {
  const repository = createInMemoryJobFinderRepository(
    createEmptyJobFinderRepositoryState(),
  );
  const executeApplicationFlow = vi.fn();
  const executeExactlyOneFinalAction = vi.fn();
  const reopenApplicationPage = vi.fn();
  const runtime = {
    executeApplicationFlow,
    executeExactlyOneFinalAction,
    reopenApplicationPage,
  } as unknown as BrowserSessionRuntime;
  const access = createApplicationPageAccess(repository, runtime);
  for (const state of ["submitted", "failed", "submitting"] as const) {
    await repository.upsertApplyJobResult(
      ApplyJobResultSchema.parse({
        id: "result",
        runId: "run",
        jobId: "job",
        state,
        startedAt: "2026-10-23T10:00:00Z",
        updatedAt: "2026-10-23T10:00:00Z",
        summary: "Synthetic",
        detail: "Synthetic",
      }),
    );
    expect((await access.reopen("result", vi.fn())).state).toBe(
      "needs_preparing",
    );
  }
  expect(reopenApplicationPage).not.toHaveBeenCalled();
  expect(executeApplicationFlow).not.toHaveBeenCalled();
  expect(executeExactlyOneFinalAction).not.toHaveBeenCalled();
});
