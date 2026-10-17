import { describe, expect, test } from "vitest";
import type {
  ProfileCopilotPatchGroup,
  ProfileCopilotPatchOperation,
} from "@nestor/contracts";
import { ProfileCopilotPatchOperationSchema } from "@nestor/contracts";

import {
  getReplacementFieldOwnershipSnapshot,
  type ReplacementFieldOwnershipEntry,
} from "./profile-copilot-field-updates";
import { buildGenericExplicitFieldPatchGroups } from "./profile-copilot-field-updates";
import type { ReviseCandidateProfileInput } from "../shared";
import { createDeterministicJobFinderAiClient } from "../index";
import { createPreferences, createProfile } from "../test-fixtures";

type PatchOperation = ProfileCopilotPatchOperation;

interface FieldCommandRow {
  request: string;
  field: string;
  operation: PatchOperation["operation"];
  value: unknown;
  // Specialist builders legitimately co-fire on some phrasings; these extra
  // replacement keys are tolerated alongside the row's own field.
  allowedExtraKeys?: readonly string[];
}

function buildBaseInput(
  overrides?: Partial<ReviseCandidateProfileInput>,
): ReviseCandidateProfileInput {
  return {
    profile: createProfile(),
    searchPreferences: createPreferences(),
    context: { surface: "profile", section: "basics" },
    relevantReviewItems: [],
    request: "",
    ...overrides,
  };
}

function collectReplacementKeys(
  groups: readonly ProfileCopilotPatchGroup[],
): string[] {
  const keys: string[] = [];

  for (const group of groups) {
    for (const operation of group.operations) {
      // A resume level carries a plain value, not fields.
      if (!("value" in operation) || typeof operation.value !== "object") {
        continue;
      }

      keys.push(...Object.keys(operation.value));
    }
  }

  return keys;
}

type ReplacementPatchOperation = Extract<
  ProfileCopilotPatchOperation,
  { value: unknown }
>;

function findFieldOperation(
  groups: readonly ProfileCopilotPatchGroup[],
  field: string,
): { groupSummary: string; operation: ReplacementPatchOperation } | null {
  for (const group of groups) {
    for (const operation of group.operations) {
      if (
        "value" in operation &&
        typeof operation.value === "object" &&
        field in operation.value
      ) {
        return { groupSummary: group.summary, operation };
      }
    }
  }

  return null;
}

// One row per generic descriptor field. The harness cross-checks this table
// against the descriptor registry below, so adding a descriptor without a
// command row fails the suite.
const fieldCommandRows: FieldCommandRow[] = [
  // Identity basics
  {
    field: "firstName",
    operation: "replace_identity_fields",
    value: "Alexandra",
    request: "set my first name to Alexandra",
  },
  {
    field: "lastName",
    operation: "replace_identity_fields",
    value: "Vanguard-Reyes",
    request: "set my last name to Vanguard-Reyes",
  },
  {
    field: "fullName",
    operation: "replace_identity_fields",
    value: "Alexandra Vanguard-Reyes",
    request: "set my full name to Alexandra Vanguard-Reyes",
  },
  {
    field: "middleName",
    operation: "replace_identity_fields",
    value: "Ray",
    request: "set my middle name to Ray",
  },
  {
    field: "preferredDisplayName",
    operation: "replace_identity_fields",
    value: "Alex V",
    request: "set my preferred display name to Alex V",
  },
  {
    field: "headline",
    operation: "replace_identity_fields",
    value: "Workflow automation engineer",
    request: "set my headline to Workflow automation engineer",
  },
  {
    field: "summary",
    operation: "replace_identity_fields",
    value: "Builds dependable automation systems.",
    request: "set my summary to Builds dependable automation systems.",
  },
  {
    field: "email",
    operation: "replace_identity_fields",
    value: "alex@example.com",
    request: "set my email to alex@example.com",
  },
  {
    field: "secondaryEmail",
    operation: "replace_identity_fields",
    value: "backups@example.com",
    request: "set my secondary email to backups@example.com",
  },
  {
    field: "phone",
    operation: "replace_identity_fields",
    value: "+386 44 555 123",
    request: "set my phone to +386 44 555 123",
  },
  {
    field: "currentCity",
    operation: "replace_identity_fields",
    value: "Prishtina",
    request: "set my current city to Prishtina",
  },
  {
    field: "currentRegion",
    operation: "replace_identity_fields",
    value: "Kosovo District",
    request: "set my current region to Kosovo District",
  },
  {
    field: "currentCountry",
    operation: "replace_identity_fields",
    value: "Kosovo",
    request: "set my current country to Kosovo",
  },
  {
    field: "timeZone",
    operation: "replace_identity_fields",
    value: "Europe/Belgrade",
    request: "set my time zone to Europe/Belgrade",
  },
  {
    field: "currentLocation",
    operation: "replace_identity_fields",
    value: "Prishtina, Kosovo",
    request: "set my displayed location to Prishtina, Kosovo",
    // The dedicated displayed-location specialist owns this phrasing and
    // emits the same typed operation ahead of the generic builder.
    allowedExtraKeys: [],
  },
  // Work eligibility
  {
    field: "authorizedWorkCountries",
    operation: "replace_work_eligibility_fields",
    value: ["Germany", "Kosovo"],
    request: "set my work countries to Germany and Kosovo",
  },
  {
    field: "willingToRelocate",
    operation: "replace_work_eligibility_fields",
    value: true,
    request: "set my relocation preference to yes",
  },
  {
    field: "willingToTravel",
    operation: "replace_work_eligibility_fields",
    value: false,
    request: "set my travel preference to no",
  },
  {
    field: "preferredRelocationRegions",
    operation: "replace_work_eligibility_fields",
    value: ["EU", "Balkans"],
    request: "set my relocation regions to EU, Balkans",
  },
  {
    field: "availableStartDate",
    operation: "replace_work_eligibility_fields",
    value: "2026-06-01",
    request: "set my start date to 2026-06-01",
  },
  {
    field: "noticePeriodDays",
    operation: "replace_work_eligibility_fields",
    value: 30,
    request: "set my notice period days to 30",
  },
  {
    field: "securityClearance",
    operation: "replace_work_eligibility_fields",
    value: "NATO secret",
    request: "set my security clearance to NATO secret",
  },
  // Professional summary
  {
    field: "shortValueProposition",
    operation: "replace_professional_summary_fields",
    value: "Reliable delivery partner",
    request: "set my value proposition to Reliable delivery partner",
  },
  {
    field: "fullSummary",
    operation: "replace_professional_summary_fields",
    value: "Senior engineer focused on dependable automation.",
    request:
      "set my full summary to Senior engineer focused on dependable automation.",
  },
  {
    field: "careerThemes",
    operation: "replace_professional_summary_fields",
    value: ["platform work", "developer experience"],
    request: "set my career themes to platform work, developer experience",
  },
  {
    field: "leadershipSummary",
    operation: "replace_professional_summary_fields",
    value: "Mentors cross-team guilds.",
    request: "set my leadership summary to Mentors cross-team guilds.",
  },
  {
    field: "domainFocusSummary",
    operation: "replace_professional_summary_fields",
    value: "Workflow automation",
    request: "set my domain focus to Workflow automation",
  },
  {
    field: "strengths",
    operation: "replace_professional_summary_fields",
    value: ["systems thinking", "mentoring"],
    request: "set my strengths to systems thinking, mentoring",
  },
  // Narrative
  {
    field: "professionalStory",
    operation: "replace_narrative_fields",
    value: "I turn complex workflows into reliable systems.",
    request: "set my story to I turn complex workflows into reliable systems.",
  },
  {
    field: "nextChapterSummary",
    operation: "replace_narrative_fields",
    value: "Leading platform reliability efforts.",
    request: "set my next chapter to Leading platform reliability efforts.",
  },
  {
    field: "careerTransitionSummary",
    operation: "replace_narrative_fields",
    value: "Moved from support engineering to automation.",
    request:
      "set my career transition explanation to Moved from support engineering to automation.",
  },
  {
    field: "differentiators",
    operation: "replace_narrative_fields",
    value: ["strong product judgment", "fast iteration"],
    request:
      "set my differentiators to strong product judgment, fast iteration",
  },
  {
    field: "motivationThemes",
    operation: "replace_narrative_fields",
    value: ["craft", "impact"],
    request: "set my motivations to craft and impact",
  },
  // Answer bank
  {
    field: "workAuthorization",
    operation: "replace_answer_bank_fields",
    value: "Authorized to work in the EU.",
    request:
      "set my work authorization answer to Authorized to work in the EU.",
  },
  {
    field: "visaSponsorship",
    operation: "replace_answer_bank_fields",
    value: "I will need sponsorship starting next year.",
    request:
      "set my visa sponsorship answer to I will need sponsorship starting next year.",
  },
  {
    field: "relocation",
    operation: "replace_answer_bank_fields",
    value: "Open to EU relocation.",
    request: "set my relocation answer to Open to EU relocation.",
  },
  {
    field: "travel",
    operation: "replace_answer_bank_fields",
    value: "Up to ten percent.",
    request: "set my travel answer to Up to ten percent.",
  },
  {
    field: "noticePeriod",
    operation: "replace_answer_bank_fields",
    value: "Sixty days.",
    request: "set my notice period answer to Sixty days.",
  },
  {
    field: "availability",
    operation: "replace_answer_bank_fields",
    value: "Two weeks after signing.",
    request: "set my availability answer to Two weeks after signing.",
  },
  {
    field: "salaryExpectations",
    operation: "replace_answer_bank_fields",
    value: "One hundred ninety thousand plus equity.",
    request:
      "set my salary expectations answer to One hundred ninety thousand plus equity.",
  },
  {
    field: "selfIntroduction",
    operation: "replace_answer_bank_fields",
    value: "Senior full-stack engineer focused on AI workflows.",
    request:
      "set my short self introduction to Senior full-stack engineer focused on AI workflows.",
  },
  {
    field: "careerTransition",
    operation: "replace_answer_bank_fields",
    value: "Moved from support into platform automation.",
    request:
      "set my career transition answer to Moved from support into platform automation.",
  },
  // Application identity
  {
    field: "preferredEmail",
    operation: "replace_application_identity_fields",
    value: "jobs@example.com",
    request: "set my preferred application email to jobs@example.com",
  },
  {
    field: "preferredPhone",
    operation: "replace_application_identity_fields",
    value: "+386 44 555 999",
    request: "set my preferred application phone to +386 44 555 999",
  },
  {
    field: "preferredLinkIds",
    operation: "replace_application_identity_fields",
    value: ["link_github", "link_portfolio"],
    request: "set my preferred link ids to link_github, link_portfolio",
  },
  // Skill groups
  {
    field: "coreSkills",
    operation: "replace_skill_group_fields",
    value: ["React", "TypeScript"],
    request: "set my core skills to React, TypeScript",
  },
  {
    field: "tools",
    operation: "replace_skill_group_fields",
    value: ["Playwright", "Docker"],
    request: "set my tools to Playwright, Docker",
  },
  {
    field: "languagesAndFrameworks",
    operation: "replace_skill_group_fields",
    value: ["TypeScript", "Python"],
    request: "set my languages and frameworks to TypeScript, Python",
  },
  {
    field: "softSkills",
    operation: "replace_skill_group_fields",
    value: ["mentoring", "facilitation"],
    request: "set my soft skills to mentoring, facilitation",
  },
  {
    field: "highlightedSkills",
    operation: "replace_skill_group_fields",
    value: ["workflow automation"],
    request: "set my highlighted skills to workflow automation",
  },
  // Top-level profile lists
  {
    field: "skills",
    operation: "replace_profile_list_fields",
    value: ["React", "Electron"],
    request: "set my overall skills to React, Electron",
  },
  // Search preferences
  {
    field: "approvalMode",
    operation: "replace_search_preferences_fields",
    value: "draft_only",
    request: "set my approval mode to draft only",
  },
  {
    field: "companyBlacklist",
    operation: "replace_search_preferences_fields",
    value: ["Acme Corp", "Globex"],
    request: "set my company blacklist to Acme Corp, Globex",
  },
  {
    field: "companyWhitelist",
    operation: "replace_search_preferences_fields",
    value: ["Umbrella", "Initech"],
    request: "set my preferred companies to Umbrella, Initech",
  },
  {
    field: "employmentTypes",
    operation: "replace_search_preferences_fields",
    value: ["full time", "contract"],
    request: "set my employment types to full time, contract",
  },
  {
    field: "excludedLocations",
    operation: "replace_search_preferences_fields",
    value: ["Onsite-only cities"],
    request: "set my excluded locations to Onsite-only cities",
  },
  {
    field: "jobFamilies",
    operation: "replace_search_preferences_fields",
    value: ["platform engineering"],
    request: "set my job families to platform engineering",
  },
  {
    field: "locations",
    operation: "replace_search_preferences_fields",
    value: ["Berlin", "Remote"],
    request: "set my preferred locations to Berlin, Remote",
  },
  {
    field: "salaryCurrency",
    operation: "replace_search_preferences_fields",
    value: "EUR",
    request: "set my salary currency to eur",
  },
  {
    field: "seniorityLevels",
    operation: "replace_search_preferences_fields",
    value: ["mid", "senior"],
    request: "set my seniority levels to mid, senior",
  },
  {
    field: "tailoringMode",
    operation: "replace_search_preferences_fields",
    value: "conservative",
    request: "set my tailoring mode to conservative",
  },
  {
    field: "targetCompanyStages",
    operation: "replace_search_preferences_fields",
    value: ["series b", "growth"],
    request: "set my company stages to series b, growth",
  },
  {
    field: "targetIndustries",
    operation: "replace_search_preferences_fields",
    value: ["fintech", "devtools"],
    request: "set my industries to fintech, devtools",
  },
];

describe("profile copilot generic field-update descriptors", () => {
  test("every replacement contract field has exactly one documented owner", () => {
    const ownership = getReplacementFieldOwnershipSnapshot();
    const descriptorOwned = ownership.filter(
      (entry) => entry.owner === "descriptor",
    );
    const specialistOwned = ownership.filter(
      (entry) => entry.owner === "specialist",
    );

    expect(descriptorOwned).toHaveLength(63);
    expect(specialistOwned).toHaveLength(19);

    const familyTotals: Record<string, number> = {};
    const seenPairs = new Set<string>();

    for (const entry of ownership) {
      const pair = `${entry.operation}:${entry.field}`;

      expect(seenPairs.has(pair)).toBe(false);
      seenPairs.add(pair);
      familyTotals[entry.operation] = (familyTotals[entry.operation] ?? 0) + 1;
    }

    // Counts mirror the ten replacement patch schemas in
    // packages/contracts/src/profile-copilot.ts.
    expect(familyTotals).toEqual({
      replace_application_identity_fields: 3,
      replace_answer_bank_fields: 9,
      replace_compensation_preferences_fields: 6,
      replace_identity_fields: 20,
      replace_narrative_fields: 5,
      replace_profile_list_fields: 3,
      replace_professional_summary_fields: 6,
      replace_search_preferences_fields: 20,
      replace_skill_group_fields: 5,
      replace_work_eligibility_fields: 10,
    });
  });

  test("the command table covers every descriptor field exactly once", () => {
    const descriptorFields = new Set(
      getReplacementFieldOwnershipSnapshot()
        .filter(
          (entry: ReplacementFieldOwnershipEntry) =>
            entry.owner === "descriptor",
        )
        .map((entry) => entry.field),
    );
    const rowFields = new Set(fieldCommandRows.map((row) => row.field));

    expect(rowFields).toEqual(descriptorFields);
    expect(fieldCommandRows.length).toBe(descriptorFields.size);
  });

  test.each(fieldCommandRows)(
    "$field responds to an explicit command with a schema-valid operation",
    async (row) => {
      const client = createDeterministicJobFinderAiClient();
      const reply = await client.reviseCandidateProfile(
        buildBaseInput({ request: row.request }),
      );
      const found = findFieldOperation(reply.patchGroups, row.field);

      expect(found).not.toBeNull();
      expect(found?.operation.operation).toBe(row.operation);
      expect(found?.operation.value).toEqual({ [row.field]: row.value });
      expect(() =>
        ProfileCopilotPatchOperationSchema.parse(found?.operation),
      ).not.toThrow();

      const allowedKeys = new Set([row.field, ...(row.allowedExtraKeys ?? [])]);
      const touchedKeys = collectReplacementKeys(reply.patchGroups);

      for (const key of touchedKeys) {
        expect(allowedKeys.has(key)).toBe(true);
      }
    },
  );

  test("one utterance can update two scalar identity fields", async () => {
    const client = createDeterministicJobFinderAiClient();

    const groups = buildGenericExplicitFieldPatchGroups(
      buildBaseInput({
        request:
          "set my email to alex@example.com and my phone to +1 555 010 2030",
      }),
    );
    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        request:
          "set my email to alex@example.com and my phone to +1 555 010 2030",
      }),
    );

    expect(groups).toHaveLength(2);
    expect(reply.patchGroups).toHaveLength(2);
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_identity_fields",
      value: { email: "alex@example.com" },
    });
    expect(reply.patchGroups[1]?.operations[0]).toEqual({
      operation: "replace_identity_fields",
      value: { phone: "+1 555 010 2030" },
    });
  });

  test("one utterance can combine an identity edit with a preference list edit", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        context: { surface: "profile", section: "preferences" },
        request:
          "set my headline to Workflow automation engineer and my preferred locations to Berlin, Munich",
      }),
    );

    expect(reply.patchGroups).toHaveLength(2);
    expect(
      findFieldOperation(reply.patchGroups, "headline")?.operation,
    ).toEqual({
      operation: "replace_identity_fields",
      value: { headline: "Workflow automation engineer" },
    });
    expect(
      findFieldOperation(reply.patchGroups, "locations")?.operation,
    ).toEqual({
      operation: "replace_search_preferences_fields",
      value: { locations: ["Berlin", "Munich"] },
    });
  });

  test("nested alias mentions do not collapse distinct email fields", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        request:
          "set my secondary email to backup@example.com and my email to primary@example.com",
      }),
    );

    expect(reply.patchGroups).toHaveLength(2);
    expect(
      findFieldOperation(reply.patchGroups, "secondaryEmail")?.operation,
    ).toEqual({
      operation: "replace_identity_fields",
      value: { secondaryEmail: "backup@example.com" },
    });
    expect(findFieldOperation(reply.patchGroups, "email")?.operation).toEqual({
      operation: "replace_identity_fields",
      value: { email: "primary@example.com" },
    });
  });

  test("a no-op field is dropped while the real change in the same utterance still lands", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        profile: { ...createProfile(), email: "alex@example.com" },
        request:
          "set my email to alex@example.com and my phone to +1 555 010 2030",
      }),
    );

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_identity_fields",
      value: { phone: "+1 555 010 2030" },
    });
  });

  test("a clear verb in one clause does not leak into the other clause", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        profile: {
          ...createProfile(),
          secondaryEmail: "old-backup@example.com",
        },
        request:
          "delete my secondary email and set my phone to +386 44 111 2222",
      }),
    );

    expect(reply.patchGroups).toHaveLength(2);
    expect(
      findFieldOperation(reply.patchGroups, "secondaryEmail")?.operation,
    ).toEqual({
      operation: "replace_identity_fields",
      value: { secondaryEmail: null },
    });
    expect(findFieldOperation(reply.patchGroups, "phone")?.operation).toEqual({
      operation: "replace_identity_fields",
      value: { phone: "+386 44 111 2222" },
    });
  });

  test("a single explicit list clear produces a typed empty-list operation", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        profile: { ...createProfile(), skills: ["React", "TypeScript"] },
        request: "clear my overall skills",
      }),
    );

    expect(findFieldOperation(reply.patchGroups, "skills")?.operation).toEqual({
      operation: "replace_profile_list_fields",
      value: { skills: [] },
    });
  });

  test("mentions inside another field's value are treated as prose, not commands", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        request:
          "set my highlighted skills to developer tools and phone screening",
      }),
    );

    // The words "tools" and "phone" appear only as value prose, so neither may
    // steal the assignment; the full intended list value is preserved.
    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]?.operations[0]).toEqual({
      operation: "replace_skill_group_fields",
      value: { highlightedSkills: ["developer tools", "phone screening"] },
    });
  });

  test("excluded-location commands never land on the preferred-locations field", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        context: { surface: "profile", section: "preferences" },
        request: "set my excluded locations to Onsite-only cities",
      }),
    );

    expect(findFieldOperation(reply.patchGroups, "locations")).toBeNull();
    expect(findFieldOperation(reply.patchGroups, "excludedLocations")).toEqual({
      groupSummary: "Update excluded locations",
      operation: {
        operation: "replace_search_preferences_fields",
        value: { excludedLocations: ["Onsite-only cities"] },
      },
    });
  });

  test("single-field commands keep confirming pending review items", async () => {
    const client = createDeterministicJobFinderAiClient();

    const reply = await client.reviseCandidateProfile(
      buildBaseInput({
        relevantReviewItems: [
          {
            id: "review_email",
            step: "essentials",
            target: { domain: "identity", key: "email", recordId: null },
            label: "Email",
            reason: "Confirm the imported email.",
            severity: "recommended",
            status: "pending",
            proposedValue: "team@example.com",
            sourceSnippet: "team@example.com",
            sourceCandidateId: "candidate_email",
            sourceRunId: "run_1",
            createdAt: "2026-04-12T10:00:00.000Z",
            resolvedAt: null,
          },
        ],
        request: "set my email to team@example.com",
      }),
    );

    expect(reply.patchGroups).toHaveLength(1);
    expect(reply.patchGroups[0]?.operations).toEqual([
      {
        operation: "replace_identity_fields",
        value: { email: "team@example.com" },
      },
      {
        operation: "resolve_review_items",
        reviewItemIds: ["review_email"],
        resolutionStatus: "confirmed",
      },
    ]);
  });

  test("an unresolvable clause is omitted instead of borrowing another field's value", () => {
    const groups = buildGenericExplicitFieldPatchGroups(
      buildBaseInput({
        request: "set my tools to grep and my email",
      }),
    );

    // The email mention has no value of its own, so it must not receive the
    // tools value; the resolvable tools command still applies.
    const emailOperation = findFieldOperation(groups, "email");

    expect(emailOperation).toBeNull();
    expect(findFieldOperation(groups, "tools")?.operation).toEqual({
      operation: "replace_skill_group_fields",
      value: { tools: ["grep"] },
    });
  });

  test("a dangling boolean mention never triggers a parser fallback default", () => {
    const groups = buildGenericExplicitFieldPatchGroups(
      buildBaseInput({
        request: "set my tools to grep and my willing to travel",
      }),
    );

    // "willing" is a positive token for the boolean parser; without the
    // acceptance guard the dangling mention would stage willingToTravel=true.
    expect(findFieldOperation(groups, "willingToTravel")).toBeNull();
    expect(findFieldOperation(groups, "tools")?.operation).toEqual({
      operation: "replace_skill_group_fields",
      value: { tools: ["grep"] },
    });
  });
});

test("structured preference facts remain model-owned rather than guessed by fallback parsers", () => {
  expect(
    getReplacementFieldOwnershipSnapshot()
      .filter((entry) => entry.owner === "model")
      .map((entry) => entry.field)
      .sort(),
  ).toEqual([
    "basis",
    "limitedWorkPermissions",
    "searchSelectivity",
    "shiftPreference",
    "weeklyHours",
  ]);
});
