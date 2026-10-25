import { describe, expect, test } from "vitest";
import {
  evaluateCompensationFit,
  extractSalaryRangeFromListingBody,
  parseNormalizedCompensation,
  parseSalaryFloor,
  reconcileSalaryTextWithListingBody,
  reconcileSalaryTextWithPreparedBody,
} from "./matching-compensation";

describe("compensation normalization and fit truth", () => {
  test.each([
    [null, "No pay range was provided."],
    [null, "We offer EUR 96,000 per year for this role."],
    ["EUR 96,000 per year", "We offer EUR 96,000 per year for this role."],
    ["$200000 - 500000", "Salary: $100k-$500k USD yearly for this role."],
  ] as const)(
    "prepared body evidence preserves the same salary reconciliation (%s)",
    (salary, description) => {
      const stated = extractSalaryRangeFromListingBody(description);
      expect(
        reconcileSalaryTextWithPreparedBody(salary, stated, () => description),
      ).toBe(reconcileSalaryTextWithListingBody(salary, description));
    },
  );
  test("known empty or newly captured salary needs no body read", () => {
    const read = () => {
      throw new Error("Unused body was opened");
    };
    expect(
      reconcileSalaryTextWithPreparedBody(
        "Existing supplied range",
        null,
        read,
      ),
    ).toBe("Existing supplied range");
    expect(
      reconcileSalaryTextWithPreparedBody(null, "EUR 96,000 per year", read),
    ).toBe("EUR 96,000 per year");
    expect(
      reconcileSalaryTextWithPreparedBody("EUR 96,000 per year", "EUR 96,000 per year", read),
    ).toBe("EUR 96,000 per year");
  });
  test.each(["EUR 96,000 per year", "USD 99,000 per year"])(
    "reads an explicit amount and period without a salary label: %s",
    (salary) => {
      expect(
        reconcileSalaryTextWithListingBody(
          null,
          `We offer ${salary} for this role.`,
        ),
      ).toBe(salary);
    },
  );
  test("does not treat a budget or revenue amount as annual salary", () => {
    expect(
      extractSalaryRangeFromListingBody("Manage a EUR 96,000 project budget."),
    ).toBeNull();
  });

  test("normalizes explicit USD hourly and yearly ranges", () => {
    expect(parseNormalizedCompensation("USD $50-$60/hr")).toMatchObject({
      currency: "USD",
      interval: "hour",
      minAmount: 50,
      maxAmount: 60,
      minAnnualUsd: 104_000,
      maxAnnualUsd: 124_800,
    });
    expect(parseNormalizedCompensation("$120k-$140k/year")).toMatchObject({
      currency: "USD",
      interval: "year",
      minAnnualUsd: 120_000,
      maxAnnualUsd: 140_000,
    });
  });

  test("reads a single labelled hourly pay amount from the listing body", () => {
    const stated = extractSalaryRangeFromListingBody(
      "Pay: $22.00 per hour for this role.",
    );
    expect(stated).toBe("$22.00 per hour");
    expect(parseNormalizedCompensation(stated)).toMatchObject({
      currency: "USD",
      interval: "hour",
      minAmount: 22,
      minAnnualUsd: 45_760,
    });
  });

  test("repairs a doubled extracted floor from the listing's exact salary sentence", () => {
    const body =
      "Highly Competitive Salary:\n- $100k-$500k USD yearly\nEquity is available.";
    expect(extractSalaryRangeFromListingBody(body)).toBe(
      "$100k-$500k USD yearly",
    );
    const reconciled = reconcileSalaryTextWithListingBody(
      "$200000 - 500000",
      body,
    );
    expect(reconciled).toBe("$100k-$500k USD yearly");
    expect(parseNormalizedCompensation(reconciled)).toMatchObject({
      minAnnualUsd: 100_000,
      maxAnnualUsd: 500_000,
    });
  });

  test("does not extract an experience range after a competitive salary label", () => {
    expect(
      extractSalaryRangeFromListingBody(
        "Salary: competitive; requirements: 3-5 years of experience",
      ),
    ).toBeNull();
  });

  test("extracts a salary range with explicit monetary evidence", () => {
    expect(
      extractSalaryRangeFromListingBody("Salary: $85,000 - $95,000 per year"),
    ).toBe("$85,000 - $95,000 per year");
  });

  test("keeps a stated currency instead of relabelling it USD", () => {
    // "$170-250K CAD" reached a screen as "USD 170,000 - USD 250,000".
    expect(parseNormalizedCompensation("$170-250K CAD")).toMatchObject({
      currency: "CAD",
      minAmount: 170_000,
      maxAmount: 250_000,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    });
    expect(parseNormalizedCompensation("CA$95,000 - CA$120,000")).toMatchObject(
      { currency: "CAD" },
    );
    expect(parseNormalizedCompensation("A$140k/year")).toMatchObject({
      currency: "AUD",
    });
    // A bare dollar sign with nothing else stated still reads as USD.
    expect(parseNormalizedCompensation("$120,000 - $150,000")).toMatchObject({
      currency: "USD",
    });
  });

  test("does not label foreign-currency values as annual USD", () => {
    expect(parseNormalizedCompensation("EUR 90k-110k/year")).toMatchObject({
      currency: "EUR",
      minAmount: 90_000,
      maxAmount: 110_000,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    });
    expect(parseNormalizedCompensation("GBP 8k/month")).toMatchObject({
      currency: "GBP",
      interval: "month",
      minAnnualUsd: null,
      maxAnnualUsd: null,
    });
  });

  test("compares monthly and yearly amounts when explicit currencies match", () => {
    const eurMonthlyPreference = {
      minimum: 2_000,
      maximum: 4_000,
      interval: "month" as const,
      currency: "EUR",
      currencyStatus: "explicit" as const,
    };

    expect(
      evaluateCompensationFit("EUR 30k/year", eurMonthlyPreference),
    ).toMatchObject({
      state: "meets_minimum",
      listingCurrency: "EUR",
      minimumSalaryUsd: null,
      listingMinimumAnnualUsd: null,
    });
    expect(
      evaluateCompensationFit("EUR 18k/year", eurMonthlyPreference),
    ).toMatchObject({ state: "below_minimum", listingCurrency: "EUR" });
    expect(
      evaluateCompensationFit("€2,500 per month", eurMonthlyPreference),
    ).toMatchObject({ state: "meets_minimum", listingCurrency: "EUR" });
    expect(
      evaluateCompensationFit("€1,500 monthly", eurMonthlyPreference),
    ).toMatchObject({ state: "below_minimum", listingCurrency: "EUR" });
  });

  test("keeps cross-currency evidence neutral without guessing an exchange rate", () => {
    expect(
      evaluateCompensationFit("USD $100k/year", {
        minimum: 2_000,
        maximum: null,
        interval: "month",
        currency: "EUR",
        currencyStatus: "explicit",
      }),
    ).toMatchObject({
      state: "currency_incomparable",
      listingCurrency: "USD",
    });
  });

  test("keeps missing, malformed, and secondary compensation neutral", () => {
    expect(evaluateCompensationFit(null, 120_000).state).toBe("unknown");
    expect(evaluateCompensationFit("Competitive", 120_000).state).toBe(
      "unknown",
    );
    expect(parseSalaryFloor("10% bonus plus equity")).toBeNull();
  });

  test("classifies only comparable USD evidence against the saved minimum", () => {
    expect(evaluateCompensationFit("$130k/year", 120_000)).toMatchObject({
      state: "meets_minimum",
      confidence: "high",
      listingMinimumAnnualUsd: 130_000,
    });
    expect(evaluateCompensationFit("$95k/year", 120_000)).toMatchObject({
      state: "below_minimum",
      confidence: "high",
      listingMinimumAnnualUsd: 95_000,
    });
    expect(evaluateCompensationFit("EUR 130k/year", 120_000)).toMatchObject({
      state: "currency_incomparable",
      confidence: "high",
      listingMinimumAnnualUsd: null,
      listingCurrency: "EUR",
    });
    expect(evaluateCompensationFit("130k/year", 120_000)).toMatchObject({
      state: "currency_incomparable",
      listingCurrency: null,
    });
  });

  test("does not create a compensation preference when no minimum is saved", () => {
    expect(evaluateCompensationFit("$95k/year", null)).toMatchObject({
      state: "not_requested",
      minimumSalaryUsd: null,
    });
  });
});

test("R3-138 leaves OTE comparison to the model instead of treating base as total pay", () => {
  const result = evaluateCompensationFit(
    "$80,000 base; $160,000 OTE per year",
    {
      minimum: 160000,
      maximum: null,
      interval: "year",
      currency: "USD",
      currencyStatus: "explicit",
      basis: "total_ote",
    },
  );
  expect(result.state).toBe("unknown");
  expect(result.explanation).toContain("total pay including commission");
  expect(result.listingMinimumAnnualUsd).toBeNull();
});
