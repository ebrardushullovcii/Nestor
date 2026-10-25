import { afterEach, expect, it } from "vitest";
import type { ReviewQueueItem } from "@nestor/contracts";
import {
  describeResumeReviewProgress,
  enqueueResumeApproval,
  getResumeReviewSession,
  listResumesToReview,
  markResumeReviewApproved,
  markResumeReviewApproving,
  markResumeReviewFailed,
  resetResumeReviewSession,
} from "./resume-review-session";

function item(
  jobId: string,
  overrides: Partial<ReviewQueueItem> = {},
): ReviewQueueItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: "Acme",
    location: "Remote",
    matchScore: 80,
    applicationStatus: "shortlisted",
    assetStatus: "ready",
    progressPercent: null,
    resumeAssetId: `resume_${jobId}`,
    resumeApplicationMode: "tailored_per_job",
    resumeTailoringMode: "aggressive",
    resumeReview: { status: "needs_review" },
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => resetResumeReviewSession());

const queue = [
  item("a"),
  item("b", {
    resumeTailoringMode: "balanced",
    resumeReview: { status: "draft" },
  }),
  item("c"),
  item("d", {
    resumeReview: { status: "approved", approvedAt: "2026-08-20T00:00:00Z" },
  } as Partial<ReviewQueueItem>),
  item("e"),
];

it("lists the resumes waiting for review in list order, leaving out approvals in flight", () => {
  const session = getResumeReviewSession();
  expect(
    listResumesToReview({
      queue,
      tailoredAssets: [],
      applicationRecords: [],
      session,
    }).map((entry) => entry.jobId),
  ).toEqual(["a", "c", "e"]);

  markResumeReviewApproving("a");
  expect(
    listResumesToReview({
      queue,
      tailoredAssets: [],
      applicationRecords: [],
      session: getResumeReviewSession(),
    }).map((entry) => entry.jobId),
  ).toEqual(["c", "e"]);
});

it("counts what was reviewed, names the next one and wraps to the top", () => {
  markResumeReviewApproving("a");
  const session = getResumeReviewSession();
  const toReview = listResumesToReview({
    queue,
    tailoredAssets: [],
    applicationRecords: [],
    session,
  });
  const atC = describeResumeReviewProgress({
    currentJobId: "c",
    toReview,
    queue,
    session,
  });
  expect(atC).toMatchObject({ reviewed: 1, total: 3 });
  expect(atC.next?.jobId).toBe("e");
  // From the last one the next is the first still waiting.
  expect(
    describeResumeReviewProgress({
      currentJobId: "e",
      toReview,
      queue,
      session,
    }).next?.jobId,
  ).toBe("c");
});

it("puts a failed approval back in the list and names it", () => {
  markResumeReviewApproving("a");
  markResumeReviewFailed("a", "The PDF could not be built.");
  const session = getResumeReviewSession();
  const toReview = listResumesToReview({
    queue,
    tailoredAssets: [],
    applicationRecords: [],
    session,
  });
  expect(toReview.map((entry) => entry.jobId)).toEqual(["a", "c", "e"]);
  const progress = describeResumeReviewProgress({
    currentJobId: "c",
    toReview,
    queue,
    session,
  });
  expect(progress.reviewed).toBe(0);
  expect(progress.failures).toEqual([
    { item: queue[0], reason: "The PDF could not be built." },
  ]);
  markResumeReviewApproving("a");
  markResumeReviewApproved("a");
  expect(getResumeReviewSession().failed.size).toBe(0);
});

it("runs queued approvals one at a time, in order", async () => {
  const order: string[] = [];
  let releaseFirst: () => void = () => undefined;
  enqueueResumeApproval(
    () =>
      new Promise<void>((resolve) => {
        order.push("first:start");
        releaseFirst = () => {
          order.push("first:end");
          resolve();
        };
      }),
  );
  enqueueResumeApproval(() => {
    order.push("second");
    return Promise.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["first:start"]);
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(order).toEqual(["first:start", "first:end", "second"]);
});
