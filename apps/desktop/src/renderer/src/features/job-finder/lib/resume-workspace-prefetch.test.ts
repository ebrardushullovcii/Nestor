import { afterEach, expect, it, vi } from "vitest";
import type { JobFinderResumeWorkspace } from "@nestor/contracts";
import {
  clearPrefetchedResumeWorkspaces,
  prefetchResumeWorkspace,
  takePrefetchedResumeWorkspace,
} from "./resume-workspace-prefetch";

afterEach(() => clearPrefetchedResumeWorkspaces());

function workspaceFor(jobId: string): JobFinderResumeWorkspace {
  return { job: { id: jobId } } as unknown as JobFinderResumeWorkspace;
}

it("hands over a read-ahead resume once, and only while it is fresh", async () => {
  const load = vi.fn((jobId: string) => Promise.resolve(workspaceFor(jobId)));
  prefetchResumeWorkspace("job_1", load, 1_000);
  prefetchResumeWorkspace("job_1", load, 2_000);
  expect(load).toHaveBeenCalledTimes(1);
  await Promise.resolve();

  expect(takePrefetchedResumeWorkspace("job_1", 3_000)?.job.id).toBe("job_1");
  expect(takePrefetchedResumeWorkspace("job_1", 3_000)).toBeNull();

  prefetchResumeWorkspace("job_2", load, 1_000);
  await Promise.resolve();
  expect(takePrefetchedResumeWorkspace("job_2", 120_000)).toBeNull();
});

it("forgets a read that failed so the next try reads again", async () => {
  const load = vi.fn(() => Promise.reject(new Error("offline")));
  prefetchResumeWorkspace("job_1", load, 1_000);
  await Promise.resolve();
  await Promise.resolve();
  expect(takePrefetchedResumeWorkspace("job_1", 1_500)).toBeNull();
  prefetchResumeWorkspace("job_1", load, 1_600);
  expect(load).toHaveBeenCalledTimes(2);
});
