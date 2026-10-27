import { expect, test } from "vitest";
import { ApplicationReviewCardSchema } from "./apply";
import { NeedsYouTaskSchema } from "./applications";

test("old handover JSON remains readable without a blocked-site link", () => {
  const task = {
    id: 1,
    kind: "sign_in",
    key: "access",
    scope: {},
    prompt: "Sign in to continue",
    input: "text",
    options: [],
    openedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(NeedsYouTaskSchema.parse(task).blockedUrl).toBeNull();
  const url = "https://employer.example.test/jobs/1";
  expect(
    NeedsYouTaskSchema.parse({ ...task, blockedUrl: url }).blockedUrl,
  ).toBe(url);
});

test("a stored review card from before intermediate saves reads with a safe default", () => {
  const oldCard = {
    siteLabel: "Replica",
    pageUrl: "https://replica.test/form",
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(ApplicationReviewCardSchema.parse(oldCard).intermediateSaved).toBe(
    false,
  );
  expect(
    ApplicationReviewCardSchema.parse({ ...oldCard, intermediateSaved: true })
      .intermediateSaved,
  ).toBe(true);
});
