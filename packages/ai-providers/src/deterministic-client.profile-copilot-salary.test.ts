import { describe, expect, test } from "vitest";
import {
  JobSearchPreferencesSchema,
  ProfileCopilotPatchGroupSchema,
} from "@nestor/contracts";

import { createDeterministicJobFinderAiClient } from "./index";
import { createPreferences, createProfile } from "./test-fixtures";
import { SALARY_PERIOD_AMBIGUITY_FLOOR } from "./deterministic/profile-copilot-salary";
import type { JobSearchPreferences } from "@nestor/contracts";

/**
 * Focused acceptance tests for deterministic Profile Copilot salary commands
 * (audit findings A1–A12). Each case pins one audited behavior: typed staging,
 * currency/period fidelity, ambiguity questions without mutation, refusal of
 * silent bound destruction, and answer-bank routing.
 */

function preferencesWith(
  overrides: Partial<JobSearchPreferences["compensation"]>,
): JobSearchPreferences {
  const preferences = createPreferences();

  return {
    ...preferences,
    compensation: {
      ...preferences.compensation,
      ...overrides,
    },
  };
}

function freshCurrencyCompensation(
  overrides: Partial<JobSearchPreferences["compensation"]> = {},
): Partial<JobSearchPreferences["compensation"]> {
  return {
    minimum: 150000,
    maximum: null,
    interval: "year",
    currency: null,
    currencyStatus: "needs_clarification",
    ...overrides,
  };
}

const baseInput = {
  profile: createProfile(),
  context: { surface: "profile" as const, section: "preferences" as const },
  relevantReviewItems: [],
};

function compensationOperation(reply: {
  patchGroups: Array<{
    operations: Array<{ operation: string; value?: unknown }>;
  }>;
}): { operation: string; value: Record<string, unknown> } | undefined {
  for (const group of reply.patchGroups) {
    for (const operation of group.operations) {
      if (operation.operation === "replace_compensation_preferences_fields") {
        return {
          operation: operation.operation,
          value: operation.value as Record<string, unknown>,
        };
      }
    }
  }

  return undefined;
}

describe("deterministic ai client profile copilot salary commands", () => {
  test("A1 stages an unambiguous target amount as a typed maximum-only patch", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: createPreferences(),
      request: "set my expected salary to 180000",
    });

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update expected salary",
        applyMode: "applied",
      }),
    );
    expect(compensationOperation(reply)).toEqual({
      operation: "replace_compensation_preferences_fields",
      value: { maximum: 180000 },
    });
    expect(
      ProfileCopilotPatchGroupSchema.parse(reply.patchGroups[0]),
    ).toBeTruthy();
  });

  test("A2 keeps an explicitly stated currency symbol on a single value", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: createPreferences(),
      request: "set my expected salary to £195k",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({ summary: "Update expected salary" }),
    );
    expect(compensationOperation(reply)?.value).toEqual({
      maximum: 195000,
      currency: "GBP",
      currencyStatus: "explicit",
    });
  });

  test("A3 asks instead of mixing pay periods when one bound switches interval", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: createPreferences(),
      request: "set my expected salary to 7500 per month",
    });

    expect(reply.patchGroups).toEqual([]);
    expect(reply.content).toContain("mix periods");
    expect(reply.content).toContain("monthly");
  });

  test("A4 keeps an explicit EUR monthly range and location from one natural request", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: preferencesWith(freshCurrencyCompensation()),
      request: "look for jobs paying EUR 3000-3500 a month around Berlin",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({ applyMode: "needs_review" }),
    );
    expect(reply.patchGroups[0]?.operations).toEqual([
      {
        operation: "replace_search_preferences_fields",
        value: { locations: ["Berlin"] },
      },
      {
        operation: "replace_compensation_preferences_fields",
        value: {
          minimum: 3000,
          maximum: 3500,
          interval: "month",
          currency: "EUR",
          currencyStatus: "explicit",
        },
      },
    ]);
    expect(reply.content).not.toContain("currency is not explicit");
  });

  test("A5 stages both bounds of a bare range instead of collapsing to the maximum", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: preferencesWith({ minimum: 100000 }),
      request: "my salary range is 120000 to 150000",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update minimum and expected salary",
        applyMode: "applied",
      }),
    );
    expect(compensationOperation(reply)?.value).toEqual({
      minimum: 120000,
      maximum: 150000,
    });
  });

  test("A6 asks for the pay period of an ambiguous low value and mutates nothing", async () => {
    const client = createDeterministicJobFinderAiClient();
    const savedPreferences = createPreferences();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: savedPreferences,
      request: "make my expected salary to be 2k",
    });

    expect(reply.patchGroups).toEqual([]);
    expect(reply.content).toContain("pay period");
    expect(reply.content).toContain("USD or EUR");
    expect(reply.content).toContain("I have not changed");

    // The ambiguity floor is the exact policy knob: one below asks, one at or
    // above stages as a plausible annual figure.
    const belowFloor = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: savedPreferences,
      request: `make my expected salary to be ${SALARY_PERIOD_AMBIGUITY_FLOOR - 1}`,
    });

    expect(belowFloor.patchGroups).toEqual([]);

    const atFloor = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: preferencesWith({ minimum: null }),
      request: `make my expected salary to be ${SALARY_PERIOD_AMBIGUITY_FLOOR}`,
    });

    expect(compensationOperation(atFloor)?.value).toEqual({
      maximum: SALARY_PERIOD_AMBIGUITY_FLOOR,
    });
  });

  test("A7 refuses a maximum below the saved minimum instead of clearing it", async () => {
    const client = createDeterministicJobFinderAiClient();
    const savedPreferences = preferencesWith({ minimum: 150000 });

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: savedPreferences,
      request: "set my expected salary to 90000",
    });

    expect(reply.patchGroups).toEqual([]);
    expect(reply.content).toContain("150,000");
    expect(reply.content).toContain("not changed");
  });

  test("A8 refuses a minimum above the saved maximum instead of clearing it", async () => {
    const client = createDeterministicJobFinderAiClient();
    const savedPreferences = preferencesWith({
      minimum: 100000,
      maximum: 150000,
    });

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: savedPreferences,
      request: "set my minimum salary to 200000",
    });

    expect(reply.patchGroups).toEqual([]);
    expect(reply.content).toContain("150,000");
    expect(reply.content).toContain("not changed");
  });

  test("A10 keeps bare salary-expectations phrasing structured with one group", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: createPreferences(),
      request: "set my salary expectations to 165000",
    });

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({ summary: "Update expected salary" }),
    );
    expect(compensationOperation(reply)?.value).toEqual({ maximum: 165000 });
  });

  test("A11 clears an expressed bound explicitly without touching the other", async () => {
    const client = createDeterministicJobFinderAiClient();

    const clearMaximumReply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: preferencesWith({ maximum: 160000 }),
      request: "clear my expected salary",
    });

    expect(clearMaximumReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Clear expected salary",
        applyMode: "applied",
      }),
    );
    expect(compensationOperation(clearMaximumReply)?.value).toEqual({
      maximum: null,
      interval: "year",
    });

    const clearMinimumReply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: preferencesWith({ maximum: 160000 }),
      request: "clear my minimum salary",
    });

    expect(clearMinimumReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Clear minimum salary",
        applyMode: "applied",
      }),
    );
    expect(compensationOperation(clearMinimumReply)?.value).toEqual({
      minimum: null,
      interval: "year",
    });
  });

  test("A12 lets an ambiguous salary question ride along without swallowing combined intents", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), yearsExperience: 6 },
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request:
        "make my experience 7 years and make my expected salary to be 2k",
    });

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update years of experience",
        applyMode: "applied",
      }),
    );
    expect(reply.content).toContain("pay period");
  });

  test("staged compensation patches merge into valid search preferences at apply time", async () => {
    const client = createDeterministicJobFinderAiClient();
    const savedPreferences = preferencesWith({ minimum: 100000 });

    const reply = await client.reviseCandidateProfile({
      ...baseInput,
      searchPreferences: savedPreferences,
      request: "my salary range is 120000 to 150000",
    });

    const group = reply.patchGroups[0];
    expect(group).toBeTruthy();
    const parsedGroup = ProfileCopilotPatchGroupSchema.parse(group);
    const operation = parsedGroup.operations[0];

    if (
      !operation ||
      operation.operation !== "replace_compensation_preferences_fields"
    ) {
      throw new Error("Expected a compensation operation");
    }

    // Mirror the workspace apply merge for compensation preference fields.
    const appliedSearchPreferences = JobSearchPreferencesSchema.parse({
      ...savedPreferences,
      compensation: {
        ...savedPreferences.compensation,
        ...operation.value,
      },
    });

    expect(appliedSearchPreferences.compensation).toEqual({
      minimum: 120000,
      maximum: 150000,
      interval: "year",
      currency: "USD",
      currencyStatus: "explicit",
    });
  });
});
