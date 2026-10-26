import { expect, test } from "vitest";
import { ApplicationReviewCardSchema } from "./apply";

test("a stored review card from before intermediate saves reads with a safe default", () => {
  const oldCard = {
    siteLabel: "Replica",
    pageUrl: "https://replica.test/form",
    preparedAt: "2026-01-01T00:00:00.000Z",
  };
  expect(ApplicationReviewCardSchema.parse(oldCard).intermediateSaved).toBe(false);
  expect(
    ApplicationReviewCardSchema.parse({ ...oldCard, intermediateSaved: true })
      .intermediateSaved,
  ).toBe(true);
});
