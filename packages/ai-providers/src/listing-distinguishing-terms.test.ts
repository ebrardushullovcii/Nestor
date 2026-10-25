import { describe, expect, test } from "vitest";

import {
  MINIMUM_DISTINGUISHING_LISTING_TERMS,
  countDistinguishingListingTerms,
} from "./openai-compatible";

/**
 * Unrelated jobs were producing byte-identical "tailored" drafts because the
 * listing bodies carried nothing but boilerplate. A draft the job did not
 * shape must not be called tailored.
 */
describe("countDistinguishingListingTerms", () => {
  test("counts a boilerplate-only body as having nothing to tailor toward", () => {
    const count = countDistinguishingListingTerms({
      description:
        "About the role. You will work with the team. Requirements: experience. We are an equal opportunity employer.",
      summary: null,
      keySkills: [],
    });

    expect(count).toBeLessThan(MINIMUM_DISTINGUISHING_LISTING_TERMS);
  });

  test("counts a real listing body as distinguishing", () => {
    const count = countDistinguishingListingTerms({
      description:
        "Build payment reconciliation pipelines in TypeScript and Postgres, own ledger correctness, partner with treasury operations, and run incident response for settlement outages.",
      summary: "Senior backend engineer on the ledger platform.",
      keySkills: ["TypeScript", "Postgres", "Kafka"],
    });

    expect(count).toBeGreaterThanOrEqual(
      MINIMUM_DISTINGUISHING_LISTING_TERMS,
    );
  });

  test("treats an empty posting as having nothing at all", () => {
    expect(
      countDistinguishingListingTerms({
        description: null,
        summary: null,
        keySkills: [],
      }),
    ).toBe(0);
  });
});
