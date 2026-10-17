import { describe, expect, test } from "vitest";
import type { JobSearchPreferences } from "@nestor/contracts";
import type { ProfileCopilotPatchGroup } from "@nestor/contracts";

import { createDeterministicJobFinderAiClient } from "./index";
import { createPreferences, createProfile } from "./test-fixtures";
import { detectSalaryInterval } from "./deterministic/profile-copilot-salary";
import type { ReviseCandidateProfileInput } from "./shared";

/**
 * Focused regression tests for compound ("mixed family") profile copilot
 * requests and salary parser edge cases found by independent review:
 *
 * - descriptor+salary and currentLocation/targetRoles+salary requests must
 *   never absorb a later command clause into the earlier field's value;
 * - no-op salary clears must never claim a mutation;
 * - the pay-period parser must not read "3-month contract/6-month notice" as
 *   monthly pay and must recognize per annum plus /hr /yr;
 * - short employer names match on word boundaries (Meta vs metadata).
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

type RevisionInput = Omit<
  ReviseCandidateProfileInput,
  "request" | "searchPreferences"
> & {
  searchPreferences?: JobSearchPreferences;
};

const baseInput: RevisionInput = {
  profile: createProfile(),
  context: { surface: "profile" as const, section: "preferences" as const },
  relevantReviewItems: [],
};

type ReplacementOperation = Extract<
  ProfileCopilotPatchGroup["operations"][number],
  { value: unknown }
>;

function findFieldOperation(
  groups: readonly ProfileCopilotPatchGroup[],
  field: string,
): ReplacementOperation | null {
  for (const group of groups) {
    for (const operation of group.operations) {
      if (
        "value" in operation &&
        typeof operation.value === "object" &&
        operation.value &&
        field in operation.value
      ) {
        return operation;
      }
    }
  }

  return null;
}

function findCompensationOperation(
  groups: readonly ProfileCopilotPatchGroup[],
): { value: Record<string, unknown> } | null {
  for (const group of groups) {
    for (const operation of group.operations) {
      if (operation.operation === "replace_compensation_preferences_fields") {
        return { value: operation.value as Record<string, unknown> };
      }
    }
  }

  return null;
}

async function revise(request: string, input: RevisionInput = baseInput) {
  const client = createDeterministicJobFinderAiClient();
  return client.reviseCandidateProfile({
    ...input,
    request,
    searchPreferences: input.searchPreferences ?? createPreferences(),
  });
}

describe("compound profile copilot requests never absorb later clauses", () => {
  test("stages a conversational monthly minimum, target, and written-word experience correction together", async () => {
    const reply = await revise(
      "I want to correct my experience from six years to seven and update expected salary: minimum 2,000 euro per month but really want 3,000.",
      {
        ...baseInput,
        profile: { ...createProfile(), yearsExperience: 6 },
        searchPreferences: preferencesWith({
          minimum: null,
          maximum: null,
          interval: "year",
          currency: "EUR",
          currencyStatus: "explicit",
        }),
      },
    );

    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      minimum: 2000,
      maximum: 3000,
      interval: "month",
      currency: "EUR",
      currencyStatus: "explicit",
    });
    expect(findFieldOperation(reply.patchGroups, "yearsExperience")?.value).toEqual({
      yearsExperience: 7,
    });
  });

  test("descriptor + salary keeps the descriptor value clean when salary follows", async () => {
    const reply = await revise(
      "set my email to alex@example.com and my expected salary to 180000",
    );

    expect(findFieldOperation(reply.patchGroups, "email")?.value).toEqual({
      email: "alex@example.com",
    });
    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      maximum: 180000,
    });
  });

  test("salary + descriptor keeps the salary value clean when the descriptor follows", async () => {
    const reply = await revise(
      "set my expected salary to 180000 and my phone to +1 555 010 2030",
    );

    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      maximum: 180000,
    });
    expect(findFieldOperation(reply.patchGroups, "phone")?.value).toEqual({
      phone: "+1 555 010 2030",
    });
  });

  test("descriptor value never absorbs a salary clause that has no connector", async () => {
    const reply = await revise(
      "set my email to alex@example.com my expected salary is 180000",
    );

    expect(findFieldOperation(reply.patchGroups, "email")?.value).toEqual({
      email: "alex@example.com",
    });
    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      maximum: 180000,
    });
  });

  test("displayed location + salary stages both without cross-contamination", async () => {
    const reply = await revise(
      "set my displayed location to Prishtina, Kosovo and my expected salary to 180000",
    );

    expect(
      findFieldOperation(reply.patchGroups, "currentLocation")?.value,
    ).toEqual({
      currentLocation: "Prishtina, Kosovo",
    });
    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      maximum: 180000,
    });
  });

  test("bare location + salary stages both without cross-contamination", async () => {
    const reply = await revise(
      "set my location to Tirana and my expected salary to 180000",
    );

    expect(
      findFieldOperation(reply.patchGroups, "currentLocation")?.value,
    ).toEqual({
      currentLocation: "Tirana",
    });
    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      maximum: 180000,
    });
  });

  test("target roles + salary stages both without cross-contamination", async () => {
    const reply = await revise(
      "set my target roles to Senior Engineer and my expected salary to 180000",
    );

    expect(findFieldOperation(reply.patchGroups, "targetRoles")?.value).toEqual(
      {
        targetRoles: ["Senior Engineer"],
      },
    );
    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      maximum: 180000,
    });
  });

  test("salary range alone is not polluted by a following phone number", async () => {
    const reply = await revise(
      "my expected salary range is 120000 to 150000 and my phone to +1 555 010 2030",
    );

    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      minimum: 120000,
      maximum: 150000,
    });
    expect(findFieldOperation(reply.patchGroups, "phone")?.value).toEqual({
      phone: "+1 555 010 2030",
    });
  });
});

describe("salary parser edge cases from independent review", () => {
  test("no-op minimum clear never claims a mutation", async () => {
    const reply = await revise("clear my minimum salary", {
      ...baseInput,
      searchPreferences: preferencesWith(
        freshCurrencyCompensation({ minimum: null, maximum: 160000 }),
      ),
    });

    expect(reply.patchGroups).toEqual([]);
    expect(findCompensationOperation(reply.patchGroups)).toBeNull();
  });

  test("no-op maximum clear never claims a mutation", async () => {
    const reply = await revise("clear my expected salary", {
      ...baseInput,
      searchPreferences: preferencesWith(
        freshCurrencyCompensation({ minimum: 150000, maximum: null }),
      ),
    });

    expect(reply.patchGroups).toEqual([]);
    expect(findCompensationOperation(reply.patchGroups)).toBeNull();
  });

  test("a bound clear with a real value still stages the typed patch", async () => {
    const reply = await revise("clear my minimum salary", {
      ...baseInput,
      searchPreferences: preferencesWith(
        freshCurrencyCompensation({ minimum: 150000, maximum: 160000 }),
      ),
    });

    expect(findCompensationOperation(reply.patchGroups)?.value).toEqual({
      minimum: null,
      interval: "year",
    });
  });

  test("duration phrases are never pay periods", () => {
    expect(detectSalaryInterval("a 3-month contract")).toBeNull();
    expect(detectSalaryInterval("working under a 6-month notice")).toBeNull();
    expect(detectSalaryInterval("6 month notice period")).toBeNull();
    expect(detectSalaryInterval("12-month engagement")).toBeNull();
  });

  test("stated pay periods still parse, including per annum and slash forms", () => {
    expect(detectSalaryInterval("7500 per month")).toBe("month");
    expect(detectSalaryInterval("a monthly retainer")).toBe("month");
    expect(detectSalaryInterval("250000 per annum")).toBe("year");
    expect(detectSalaryInterval("120k/yr")).toBe("year");
    expect(detectSalaryInterval("$150/hr")).toBe("hour");
    expect(detectSalaryInterval("per hour consulting")).toBe("hour");
    expect(detectSalaryInterval("pure day rate")).toBe("day");
  });

  test("a salary clause with a 3-month contract is ambiguous, not monthly", async () => {
    const reply = await revise(
      "my expected salary is 7000 for a 3-month contract",
      {
        ...baseInput,
        searchPreferences: preferencesWith(freshCurrencyCompensation()),
      },
    );

    expect(reply.patchGroups).toEqual([]);
    expect(reply.content).toContain("pay period");
    expect(reply.content).toContain("I have not changed");
  });
});

describe("short employer names match on word boundaries", () => {
  function experienceWith(
    id: string,
    companyName: string,
    title: string,
  ): NonNullable<
    ReviseCandidateProfileInput["profile"]["experiences"]
  >[number] {
    return {
      id,
      companyName,
      companyUrl: null,
      title,
      employmentType: null,
      location: "Prishtina, Kosovo",
      workMode: [],
      startDate: "2023-07",
      endDate: null,
      isCurrent: true,
      isDraft: false,
      summary: null,
      achievements: [],
      skills: [],
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    };
  }

  test("Meta matches a real Meta mention", async () => {
    const client = createDeterministicJobFinderAiClient();
    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        experiences: [experienceWith("meta_1", "Meta", "Software Engineer")],
      },
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "experience" },
      relevantReviewItems: [],
      request: "mark my Meta experience as remote",
    });

    const upsert = reply.patchGroups
      .flatMap((group) => group.operations)
      .find((operation) => operation.operation === "upsert_experience_record");

    expect(upsert).toMatchObject({
      record: { id: "meta_1", workMode: ["remote"] },
    });
  });

  test("Meta does not match metadata", async () => {
    const client = createDeterministicJobFinderAiClient();
    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        experiences: [experienceWith("meta_1", "Meta", "Software Engineer")],
      },
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "experience" },
      relevantReviewItems: [],
      request: "mark my metadata experience as remote",
    });

    const upserts = reply.patchGroups
      .flatMap((group) => group.operations)
      .filter(
        (operation) => operation.operation === "upsert_experience_record",
      );

    expect(upserts).toEqual([]);
  });

  test("glued names still match when the user splits them with spaces", async () => {
    const client = createDeterministicJobFinderAiClient();
    const reply = await client.reviseCandidateProfile({
      profile: {
        ...createProfile(),
        experiences: [experienceWith("auto_1", "NORTHLANE", "Senior Engineer")],
      },
      searchPreferences: createPreferences(),
      context: { surface: "profile", section: "experience" },
      relevantReviewItems: [],
      request:
        "for north lane i actually worked remote can you fix that for me",
    });

    const upsert = reply.patchGroups
      .flatMap((group) => group.operations)
      .find((operation) => operation.operation === "upsert_experience_record");

    expect(upsert).toMatchObject({
      record: { id: "auto_1", workMode: ["remote"] },
    });
  });
});
