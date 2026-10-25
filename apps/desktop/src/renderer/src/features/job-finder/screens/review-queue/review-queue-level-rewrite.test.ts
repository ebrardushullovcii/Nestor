import { describe, expect, it } from "vitest";

import {
  describeInterruptedResumeRewrite,
  describeQueueItemResumeLevel,
  shouldRewriteResumeAfterLevelChange,
} from "./review-queue-status";

const writtenLight = {
  assetStatus: "ready" as const,
  resumeApplicationMode: "tailored_per_job" as const,
  resumeTailoringMode: "conservative" as const,
};

describe("shouldRewriteResumeAfterLevelChange", () => {
  it("rewrites a written resume when another written level is picked", () => {
    // Built app: Light switched to Tailored kept the Light text "ready", and
    // Apply would have approved and sent it.
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: writtenLight,
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "balanced",
      }),
    ).toBe(true);
  });

  it("rewrites the draft kept from Original when a written level is picked", () => {
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: { ...writtenLight, resumeApplicationMode: "original_resume" },
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "conservative",
      }),
    ).toBe(true);
  });

  it("rewrites nothing for Original, the same level, or a job with no resume yet", () => {
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: writtenLight,
        defaultTailoringMode: "balanced",
        nextApplicationMode: "original_resume",
      }),
    ).toBe(false);
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: writtenLight,
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "conservative",
      }),
    ).toBe(false);
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: { ...writtenLight, assetStatus: "not_started" },
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "balanced",
      }),
    ).toBe(false);
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: { ...writtenLight, assetStatus: "generating" },
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "balanced",
      }),
    ).toBe(false);
  });

  it("reads a job without its own strength at the saved default", () => {
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: { ...writtenLight, resumeTailoringMode: null },
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "balanced",
      }),
    ).toBe(false);
  });
});

describe("a level rewrite the app closed during (STAB-010)", () => {
  // Aggressive was picked and saved, then the app closed before the rewrite
  // finished: the resume is still the Light one.
  const interrupted = {
    ...writtenLight,
    resumeTailoringMode: "aggressive" as const,
    resumeWrittenTailoringMode: "conservative" as const,
  };

  it("names the level the resume was written at, not the saved one", () => {
    expect(describeQueueItemResumeLevel(interrupted)).toBe("Light");
    expect(
      describeQueueItemResumeLevel({
        ...interrupted,
        resumeWrittenTailoringMode: null,
      }),
    ).toBe("Aggressive");
  });

  it("says the rewrite did not finish, and picking the level again rewrites", () => {
    expect(describeInterruptedResumeRewrite(interrupted)).toEqual({
      chosen: "aggressive",
      chosenLabel: "Aggressive",
      writtenLabel: "Light",
    });
    expect(
      shouldRewriteResumeAfterLevelChange({
        item: interrupted,
        defaultTailoringMode: "balanced",
        nextApplicationMode: "tailored_per_job",
        nextTailoringMode: "aggressive",
      }),
    ).toBe(true);
  });

  it("says nothing when the resume matches its level or is being written", () => {
    expect(
      describeInterruptedResumeRewrite({
        ...interrupted,
        resumeWrittenTailoringMode: "aggressive",
      }),
    ).toBeNull();
    expect(
      describeInterruptedResumeRewrite({
        ...interrupted,
        assetStatus: "generating",
      }),
    ).toBeNull();
    // Written before the asset recorded its level.
    expect(
      describeInterruptedResumeRewrite({
        ...interrupted,
        resumeWrittenTailoringMode: undefined,
      }),
    ).toBeNull();
  });
});
