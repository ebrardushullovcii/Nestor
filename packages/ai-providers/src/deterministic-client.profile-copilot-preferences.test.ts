import { describe, expect, test } from "vitest";
import { createDeterministicJobFinderAiClient } from "./index";
import { createPreferences, createProfile } from "./test-fixtures";

describe("deterministic ai client profile copilot preferences", () => {
  test("answers an advisory target-role question without pretending it must edit the profile", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "What target role or roles should I use for the job search?",
    });

    expect(reply.patchGroups).toEqual([]);
    expect(reply.content).toContain("Based on your saved profile");
    expect(reply.content).toContain("do not have to save a target title");
    expect(reply.content).not.toContain("could not turn it into");
  });

  test("can edit years of experience from a profile preferences request", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: { ...createProfile(), yearsExperience: 6 },
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "make my experience 7 years",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update years of experience",
        applyMode: "applied",
      }),
    );
  });

  test("can edit expected salary from a profile preferences request without touching the saved minimum", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: {
        ...createPreferences(),
        targetSalaryUsd: null,
      },
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "make my expected salary to be 180000",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update expected salary",
        applyMode: "applied",
      }),
    );
    // Only the expressed bound is staged: the saved minimum and the saved
    // interval and currency are preserved by the merge instead of restated.
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_compensation_preferences_fields",
      value: { maximum: 180000 },
    });
  });

  test("can interpret preferred work mode requests from profile preferences", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        workEligibility: {
          ...createProfile().workEligibility,
          remoteEligible: false,
        },
      },
      searchPreferences: { ...createPreferences(), workModes: ["hybrid"] },
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "my prefered work mode should be remote",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Prefer remote work mode",
        applyMode: "needs_review",
      }),
    );
    expect(reply.patchGroups[0]?.operations).toEqual(
      expect.arrayContaining([
        {
          operation: "replace_search_preferences_fields",
          value: { workModes: ["remote"] },
        },
        {
          operation: "replace_work_eligibility_fields",
          value: { remoteEligible: true },
        },
      ]),
    );
  });

  test("can update work-eligibility text and numeric fields from direct requests", async () => {
    const client = createDeterministicJobFinderAiClient();

    const startDateReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "set my available start date to 2026-05-01",
    });

    expect(startDateReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update available start date",
        applyMode: "applied",
      }),
    );
    expect(startDateReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_work_eligibility_fields",
      value: { availableStartDate: "2026-05-01" },
    });

    const noticeReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "set my notice period days to 30",
    });

    expect(noticeReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update notice period days",
        applyMode: "applied",
      }),
    );
    expect(noticeReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_work_eligibility_fields",
      value: { noticePeriodDays: 30 },
    });
  });

  test("can update list-heavy preference fields in review mode", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: { ...createPreferences(), workModes: [] },
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "set my preferred locations to Berlin, Prishtina, Remote",
    });

    const patchGroup = reply.patchGroups.find(
      (entry) => entry.summary === "Update preferred locations",
    );

    expect(patchGroup).toEqual(
      expect.objectContaining({
        summary: "Update preferred locations",
        applyMode: "needs_review",
      }),
    );
    expect(patchGroup?.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { locations: ["Berlin", "Prishtina", "Remote"] },
    });
  });

  test("can update scalar preference fields like salary currency and tailoring mode", async () => {
    const client = createDeterministicJobFinderAiClient();

    const currencyReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "set my salary currency to eur",
    });

    expect(currencyReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update salary currency",
        applyMode: "applied",
      }),
    );
    expect(currencyReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { salaryCurrency: "EUR" },
    });

    const tailoringReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "set my tailoring mode to aggressive",
    });

    expect(tailoringReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update default resume tailoring style",
        applyMode: "applied",
      }),
    );
    expect(tailoringReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { tailoringMode: "aggressive" },
    });

    const lightReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "Set my default resume approach to Light.",
    });

    expect(lightReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { tailoringMode: "conservative" },
    });
  });

  test("understands conversational currency and salary-range requests without copying prose", async () => {
    const client = createDeterministicJobFinderAiClient();

    const currencyReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "also my currency should be eur since im in kosovo",
    });

    expect(currencyReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { salaryCurrency: "EUR" },
    });

    const salaryReply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request:
        "set my expectation minimum to be 200000 so we can ignore all those but im actually expecting more like 300k or 400k",
    });

    expect(salaryReply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update minimum and expected salary",
        applyMode: "applied",
      }),
    );
    expect(salaryReply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_compensation_preferences_fields",
      value: {
        minimum: 200000,
        maximum: 400000,
      },
    });
  });

  test("parses a natural monthly range and location without assuming currency", async () => {
    const client = createDeterministicJobFinderAiClient();
    const preferences = createPreferences();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: {
        ...preferences,
        compensation: {
          ...preferences.compensation,
          currencyStatus: "inherited",
        },
      },
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "look for jobs around 3–4k a month around New York",
    });

    expect(reply.content).toContain("currency is not explicit");
    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({ applyMode: "needs_review" }),
    );
    expect(reply.patchGroups[0]?.operations).toEqual([
      {
        operation: "replace_search_preferences_fields",
        value: { locations: ["New York"] },
      },
      {
        operation: "replace_compensation_preferences_fields",
        value: {
          minimum: 3000,
          maximum: 4000,
          interval: "month",
          currency: null,
          currencyStatus: "needs_clarification",
        },
      },
    ]);
  });

  test("keeps an explicitly stated ISO currency on a natural monthly range", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "look for jobs paying USD 3-4k a month around New York",
    });

    expect(reply.patchGroups[0]?.operations[1]).toEqual({
      operation: "replace_compensation_preferences_fields",
      value: {
        minimum: 3000,
        maximum: 4000,
        interval: "month",
        currency: "USD",
        currencyStatus: "explicit",
      },
    });
  });

  test("keeps approval mode changes in review mode", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile({
      profile: createProfile(),
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "preferences" },
      relevantReviewItems: [],
      request: "set my approval mode to full auto",
    });

    expect(reply.patchGroups[0]).toEqual(
      expect.objectContaining({
        summary: "Update approval mode",
        applyMode: "needs_review",
      }),
    );
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_search_preferences_fields",
      value: { approvalMode: "full_auto" },
    });
  });
});
