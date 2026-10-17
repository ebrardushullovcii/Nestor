import { describe, expect, it } from "vitest";
import type { SavedJob } from "@nestor/contracts";
import {
  formatNormalizedCompensation,
  formatStatedNormalizedCompensation,
} from "./normalized-compensation";

function job(
  salaryText: string | null,
  normalizedCompensation: Partial<SavedJob["normalizedCompensation"]> = {},
): Pick<SavedJob, "salaryText" | "normalizedCompensation"> {
  return {
    salaryText,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
      ...normalizedCompensation,
    },
  };
}

describe("formatStatedNormalizedCompensation", () => {
  it("shows nothing for a listing that stated no salary", () => {
    // An identical band appeared on several jobs whose pages publish no
    // salary at all. Nothing stated means nothing to show.
    expect(
      formatStatedNormalizedCompensation(
        job(null, { currency: "USD", minAmount: 80_000, maxAmount: 150_000 }),
      ),
    ).toBeNull();
  });

  it("shows the band a listing did state", () => {
    expect(
      formatStatedNormalizedCompensation(
        job("$120,000 - $150,000", {
          currency: "USD",
          minAmount: 120_000,
          maxAmount: 150_000,
        }),
      ),
    ).toBe("USD 120,000 – USD 150,000");
  });

  it("keeps the stated currency in the band it prints", () => {
    expect(
      formatNormalizedCompensation({
        currency: "CAD",
        interval: "year",
        minAmount: 170_000,
        maxAmount: 250_000,
        minAnnualUsd: null,
        maxAnnualUsd: null,
      }),
    ).toBe("CAD 170,000 – CAD 250,000 / year");
  });
});
