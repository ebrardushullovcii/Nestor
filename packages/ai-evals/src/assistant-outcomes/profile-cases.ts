import {
  PatchProfileInputSchema,
  ProfileRecordSchemas,
  ProfileFieldsSchema,
  ProfileListsSchema,
  type DesktopJobsBridge,
  type ProfileRecordCollection,
} from "@nestor/contracts";
import { equalOutcome } from "./outcome";
import type { BuiltAppBatch } from "./built-app";

type AppWindow = { nestor: { jobs: DesktopJobsBridge } };

const profileEdit = PatchProfileInputSchema.parse({
  fields: {
    firstName: "Taylor",
    middleName: "Q",
    lastName: "Synthetic",
    fullName: "Taylor Q Synthetic",
    preferredDisplayName: "Taylor",
    headline: "Synthetic operations analyst",
    summary: "Synthetic field outcome evaluation.",
    currentLocation: "Budapest, Hungary",
    currentCity: "Budapest",
    currentRegion: "Budapest",
    currentCountry: "Hungary",
    timeZone: "Europe/Budapest",
    yearsExperience: 11,
    email: "taylor@example.test",
    secondaryEmail: "secondary@example.test",
    phone: "+3615550100",
    portfolioUrl: "https://example.test/portfolio",
    linkedinUrl: "https://example.test/linkedin",
    githubUrl: "https://example.test/github",
    personalWebsiteUrl: "https://example.test/about",
    "workEligibility.requiresVisaSponsorship": false,
    "workEligibility.willingToRelocate": true,
    "workEligibility.willingToTravel": true,
    "workEligibility.remoteEligible": true,
    "workEligibility.noticePeriodDays": 30,
    "workEligibility.availableStartDate": "2027-01-15",
    "workEligibility.securityClearance": "No clearance",
    "professionalSummary.shortValueProposition":
      "Synthetic practical analysis.",
    "professionalSummary.fullSummary": "Synthetic full professional summary.",
    "professionalSummary.leadershipSummary": "Synthetic mentoring experience.",
    "professionalSummary.domainFocusSummary": "Synthetic operations systems.",
    "narrative.professionalStory": "Synthetic professional story.",
    "narrative.nextChapterSummary": "Synthetic next chapter.",
    "narrative.careerTransitionSummary": "Synthetic transition explanation.",
    "applicationIdentity.preferredEmail": "applications@example.test",
    "applicationIdentity.preferredPhone": "+3615550101",
  },
  lists: {
    targetRoles: ["Operations Analyst"],
    locations: ["Budapest"],
    skills: ["SQL", "Workflow analysis"],
    "workEligibility.authorizedWorkCountries": ["Hungary"],
    "workEligibility.preferredRelocationRegions": ["European Union"],
    "professionalSummary.careerThemes": ["Practical analysis"],
    "professionalSummary.strengths": ["Evidence synthesis"],
    "narrative.differentiators": ["Operations experience"],
    "narrative.motivationThemes": ["Useful systems"],
    "applicationIdentity.preferredLinkIds": [],
    "skillGroups.coreSkills": ["SQL"],
    "skillGroups.tools": ["Spreadsheets"],
    "skillGroups.languagesAndFrameworks": ["TypeScript"],
    "skillGroups.softSkills": ["Clear writing"],
    "skillGroups.highlightedSkills": ["Workflow analysis"],
  },
});

function differentValue(
  key: string,
  value: unknown,
  accepts: (value: unknown) => boolean,
): unknown {
  const candidates: unknown[] =
    typeof value === "boolean"
      ? [!value]
      : typeof value === "number"
        ? [value + 1, value === 0 ? 1 : 0]
        : Array.isArray(value)
          ? [value.length ? [] : ["Before"]]
          : /email/i.test(key)
            ? ["before@example.test"]
            : /url/i.test(key)
              ? ["https://example.test/before"]
              : /phone/i.test(key)
                ? ["+442079460101"]
                : /timeZone/.test(key)
                  ? ["Europe/London"]
                  : /date/i.test(key)
                    ? ["2020-01-15", "2020-01", ""]
                    : [
                        "Initial synthetic value",
                        "other",
                        "basic",
                        "Native",
                        "part_time",
                        "",
                      ];
  const candidate = candidates.find(
    (item) => JSON.stringify(item) !== JSON.stringify(value) && accepts(item),
  );
  if (candidate === undefined)
    throw Error(`No different valid fixture for ${key}`);
  return candidate;
}

const initialProfile = PatchProfileInputSchema.parse({
  fields: Object.fromEntries(
    Object.entries(profileEdit.fields).map(([key, value]) => [
      key,
      differentValue(
        key,
        value,
        (candidate) =>
          ProfileFieldsSchema.shape[
            key as keyof typeof ProfileFieldsSchema.shape
          ].safeParse(candidate).success,
      ),
    ]),
  ),
  lists: Object.fromEntries(
    Object.entries(profileEdit.lists).map(([key, value]) => [
      key,
      differentValue(
        key,
        value,
        (candidate) =>
          ProfileListsSchema.shape[
            key as keyof typeof ProfileListsSchema.shape
          ].safeParse(candidate).success,
      ),
    ]),
  ),
});

/** Each requested field has its own stored-value assertion, even in one chat. */
export function profileFieldOutcomeCases(): BuiltAppBatch[] {
  return [
    {
      id: "profile-fields",
      prepare: async (page) => {
        await page.evaluate(
          (input) =>
            (window as unknown as AppWindow).nestor.jobs.run(
              "patch_profile",
              input,
            ),
          initialProfile,
        );
      },
      request: `This is the synthetic evaluation profile. Read the current Profile, then save these exact field and list changes, preserving everything else. Use the supplied facts without inferring anything: ${JSON.stringify(profileEdit)}`,
      actions: (["fields", "lists"] as const).flatMap((kind) =>
        Object.entries(profileEdit[kind]).map(([key, expected]) => ({
          actionId: `profile.${kind === "fields" ? "field" : "list"}.${key}`,
          observe: async (page) => {
            const current = await page.evaluate(
              async ({ kind, key }) => {
                const value = await (
                  window as unknown as AppWindow
                ).nestor.jobs.run("get_profile", {});
                return (value[kind] as Record<string, unknown>)[key] ?? null;
              },
              { kind, key },
            );
            return [
              equalOutcome(
                "data",
                `Saved ${key}`,
                `jobs.get_profile.${kind}.${key}`,
                current,
                expected,
              ),
            ];
          },
        })),
      ),
    },
  ];
}

const recordValues: Record<ProfileRecordCollection, Record<string, unknown>> = {
  experiences: {
    companyName: "Synthetic Lab",
    companyUrl: "https://example.test/lab",
    title: "Operations Analyst",
    employmentType: "Full-time",
    location: "Budapest",
    workMode: ["hybrid"],
    startDate: "2021-01",
    endDate: "2023-12",
    isCurrent: false,
    isDraft: false,
    summary: "Synthetic role summary.",
    achievements: ["Reduced synthetic handoff time by 20%."],
    skills: ["SQL"],
    domainTags: ["Operations"],
    peopleManagementScope: "Mentored two synthetic colleagues.",
    ownershipScope: "Owned synthetic workflow analysis.",
  },
  education: {
    schoolName: "Synthetic University",
    degree: "BSc",
    fieldOfStudy: "Information Systems",
    location: "Budapest",
    startDate: "2014-09",
    endDate: "2018-06",
    isDraft: false,
    summary: "Synthetic education summary.",
  },
  certifications: {
    name: "Synthetic Analysis Certificate",
    issuer: "Synthetic Institute",
    issueDate: "2022-01",
    expiryDate: "2028-01",
    credentialUrl: "https://example.test/certificate",
    isDraft: false,
  },
  projects: {
    name: "Synthetic Workflow",
    projectType: "Internal tool",
    summary: "Synthetic project summary.",
    role: "Analyst",
    skills: ["SQL"],
    outcome: "Improved synthetic workflow.",
    projectUrl: "https://example.test/project",
    repositoryUrl: "https://example.test/repository",
    caseStudyUrl: "https://example.test/case-study",
  },
  links: {
    label: "Synthetic portfolio",
    url: "https://example.test/portfolio",
    kind: "portfolio",
    isDraft: false,
  },
  spokenLanguages: {
    language: "Hungarian",
    proficiency: "Fluent",
    interviewPreference: true,
    notes: "Synthetic language note.",
  },
  proofBank: {
    title: "Synthetic workflow result",
    claim: "Reduced synthetic handoff time by 20%.",
    heroMetric: "20%",
    supportingContext: "Synthetic measurement context.",
    roleFamilies: ["Analysis"],
    projectIds: ["outcome-proof-project"],
    linkIds: ["Before"],
  },
};

export function profileRecordOutcomeCases(): BuiltAppBatch[] {
  return (
    Object.keys(ProfileRecordSchemas) as ProfileRecordCollection[]
  ).flatMap((collection) => {
    const id = `outcome-${collection}`;
    // The later edit must change existing values, including the editor toggles.
    const edited = ProfileRecordSchemas[collection].parse({
      ...recordValues[collection],
      id,
    });
    const shape = ProfileRecordSchemas[collection].shape;
    const initial = ProfileRecordSchemas[collection].parse(
      Object.fromEntries(
        Object.entries(edited).map(([key, value]) => [
          key,
          key === "id"
            ? id
            : differentValue(
                key,
                value,
                (candidate) =>
                  (
                    shape as Record<
                      string,
                      { safeParse(value: unknown): { success: boolean } }
                    >
                  )[key]!.safeParse(candidate).success,
              ),
        ]),
      ),
    );
    const readRecord = async (
      page: Parameters<BuiltAppBatch["actions"][number]["observe"]>[0],
    ) =>
      page.evaluate(
        (query) =>
          (window as unknown as AppWindow).nestor.jobs.run(
            "get_profile_record",
            query,
          ),
        { collection, id },
      );
    return [
      {
        id: `record-add-${collection}`,
        request: `Add this synthetic Profile record. Read get_profile_record for its id first, then save it: ${JSON.stringify({ collection, record: initial })}`,
        actions: [
          {
            actionId: `profile.record.${collection}.add`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Created record",
                `jobs.get_profile_record ${collection}/${id}`,
                await readRecord(page),
                { collection, record: initial },
              ),
            ],
          },
        ],
      },
      {
        id: `record-edit-${collection}`,
        requires: [`record-add-${collection}`],
        request: `Edit the existing synthetic Profile record ${id} in ${collection} to these exact values. Read its current record first and preserve every other record: ${JSON.stringify(edited)}`,
        actions: Object.entries(edited)
          .filter(([key]) => key !== "id")
          .map(([key, expected]) => ({
            actionId: `profile.record.${collection}.field.${key}`,
            observe: async (page) => [
              equalOutcome(
                "data",
                `Saved ${key}`,
                `jobs.get_profile_record ${collection}/${id}.${key}`,
                (
                  (await readRecord(page))?.record as
                    | Record<string, unknown>
                    | undefined
                )?.[key] ?? null,
                expected,
              ),
            ],
          })),
      },
      {
        id: `record-remove-${collection}`,
        requires: [`record-edit-${collection}`],
        request: `Remove only the synthetic ${collection} record ${id} from Profile.`,
        actions: [
          {
            actionId: `profile.record.${collection}.remove`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Record removed",
                `jobs.get_profile_record ${collection}/${id}`,
                await readRecord(page),
                null,
              ),
            ],
          },
        ],
      },
      {
        id: `record-undo-remove-${collection}`,
        requires: [`record-remove-${collection}`],
        request: `Undo the removal of the ${collection} record ${id}. Restore it exactly as it was.`,
        actions: [
          {
            actionId: `profile.record.${collection}.undo_remove`,
            observe: async (page) => [
              equalOutcome(
                "data",
                "Removed record restored exactly",
                `jobs.get_profile_record ${collection}/${id}`,
                await readRecord(page),
                { collection, record: edited },
              ),
            ],
          },
        ],
      },
    ];
  });
}
