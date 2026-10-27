import type {
  DesktopJobsBridge,
  ResumeApproach,
  ApplicationAttestationKind,
  ResumeCommandName,
  ResumeCommandInput,
  ResumeCommandOutput,
  PatchSettingsInput,
  ProfileOverview,
  JobSearchPreferences,
} from "@nestor/contracts";
import type { Page } from "playwright";
import type { BuiltAppBatch } from "./built-app";
import { currentUndoReceipt } from "./built-app";
import { equalOutcome } from "./outcome";

interface ResumesBridge {
  run<K extends ResumeCommandName>(
    name: K,
    input: ResumeCommandInput<K>,
  ): Promise<ResumeCommandOutput<K>>;
}
type AppWindow = {
  nestor: { jobs: DesktopJobsBridge; resumes: ResumesBridge };
};
const existingResumes = (page: Page) =>
  page.evaluate(async () => {
    const { jobs, resumes } = (window as unknown as AppWindow).nestor;
    const tracked = await jobs.run("list_jobs", {
      stage: "applied",
      limit: 200,
    });
    return Promise.all(
      tracked.rows.map(async ({ id }) => ({
        id,
        resume: await resumes.run("get_resume", { jobId: id }),
      })),
    );
  });
const permission = [
  {
    country: "Hungary",
    conditions: "Synthetic permit: at most 20 hours per week.",
    requiresFutureSponsorship: false,
  },
];

export function profileOperationOutcomeCases(): BuiltAppBatch[] {
  let beforeResumes: unknown;
  let beforePermissions: ProfileOverview | undefined;
  let beforeBatch:
    | { profile: ProfileOverview; goals: JobSearchPreferences }
    | undefined;
  return [
    {
      id: "profile-work-permissions",
      prepare: async (page) => {
        beforePermissions = await page.evaluate(() =>
          (window as unknown as AppWindow).nestor.jobs.run(
            "set_work_permissions",
            {
              rows: [
                {
                  country: "Austria",
                  conditions: "Synthetic prior permit.",
                  requiresFutureSponsorship: true,
                },
              ],
            },
          ),
        );
      },
      request: `Replace my limited work permissions with these supplied synthetic facts, without changing general citizenship or work authorization: ${JSON.stringify(permission)}. Read my current Profile first.`,
      actions: [
        {
          actionId: "profile.work_permissions",
          observe: async (page, reply, evidence) => [
            equalOutcome(
              "unchanged",
              "Other Profile facts preserved",
              "jobs.get_profile before and after the permission edit",
              await page.evaluate(() =>
                (window as unknown as AppWindow).nestor.jobs.run(
                  "get_profile",
                  {},
                ),
              ),
              { ...beforePermissions, limitedWorkPermissions: permission },
            ),
            equalOutcome(
              "data",
              "Saved limited permissions and sponsorship condition",
              "jobs.get_profile.limitedWorkPermissions",
              await page.evaluate(
                async () =>
                  (
                    await (window as unknown as AppWindow).nestor.jobs.run(
                      "get_profile",
                      {},
                    )
                  ).limitedWorkPermissions,
              ),
              permission,
            ),
            equalOutcome(
              "data",
              "Work-permission write has its own Undo receipt",
              "Current persisted Assistant receipt",
              Boolean(currentUndoReceipt(reply, evidence, "profile")),
              true,
            ),
          ],
        },
      ],
    },
    {
      id: "profile-commit-edits",
      prepare: async (page) => {
        beforeBatch = await page.evaluate(() =>
          (window as unknown as AppWindow).nestor.jobs.run(
            "commit_profile_edits",
            {
              profile: { fields: { headline: "Before synthetic batch" } },
              goals: { lists: { locations: ["Vienna"] } },
              upsert: [
                {
                  collection: "projects",
                  record: {
                    id: "outcome-batch-project",
                    name: "Before synthetic project",
                  },
                },
              ],
              workPermissions: [],
            },
          ),
        );
      },
      request: `Save these as one atomic Profile edit batch. Read the current Profile, goals and the project record first. Preserve every other value. ${JSON.stringify({ profile: { fields: { headline: "Synthetic batch headline" } }, goals: { lists: { locations: ["Budapest"] } }, upsert: [{ collection: "projects", record: { id: "outcome-batch-project", name: "Synthetic batch project" } }], workPermissions: permission })}`,
      actions: [
        {
          actionId: "profile.commit_edits",
          observe: async (page, reply, evidence) => {
            if (!beforeBatch) throw Error("Missing atomic edit baseline");
            const saved = await page.evaluate(async () => {
              const jobs = (window as unknown as AppWindow).nestor.jobs;
              return {
                profile: await jobs.run("get_profile", {}),
                goals: await jobs.run("get_profile_goals", {}),
                project: await jobs.run("get_profile_record", {
                  collection: "projects",
                  id: "outcome-batch-project",
                }),
              };
            });
            return [
              equalOutcome(
                "unchanged",
                "Untouched Profile fields and records preserved",
                "jobs.get_profile versus the exact requested batch",
                saved.profile,
                {
                  ...beforeBatch.profile,
                  fields: {
                    ...beforeBatch.profile.fields,
                    headline: "Synthetic batch headline",
                  },
                  limitedWorkPermissions: permission,
                },
              ),
              equalOutcome(
                "unchanged",
                "Untouched goals preserved",
                "jobs.get_profile_goals versus the exact requested batch",
                saved.goals,
                { ...beforeBatch.goals, locations: ["Budapest"] },
              ),
              equalOutcome(
                "data",
                "Committed Profile headline",
                "jobs.get_profile.fields.headline",
                saved.profile.fields.headline,
                "Synthetic batch headline",
              ),
              equalOutcome(
                "data",
                "Committed goal locations",
                "jobs.get_profile_goals.locations",
                saved.goals.locations,
                ["Budapest"],
              ),
              equalOutcome(
                "data",
                "Committed project name",
                "jobs.get_profile_record",
                saved.project?.collection === "projects"
                  ? saved.project.record.name
                  : null,
                "Synthetic batch project",
              ),
              equalOutcome(
                "data",
                "Committed work permissions",
                "jobs.get_profile.limitedWorkPermissions",
                saved.profile.limitedWorkPermissions,
                permission,
              ),
              equalOutcome(
                "data",
                "Atomic command completed alongside the checked data",
                "Current-turn persisted operation",
                evidence.operations.some(
                  (operation) =>
                    operation.toolName === "commit_profile_edits" &&
                    operation.status === "committed",
                ),
                true,
              ),
              equalOutcome(
                "data",
                "Batch has an Undo receipt",
                "Current persisted Assistant receipt",
                Boolean(currentUndoReceipt(reply, evidence, "profile")),
                true,
              ),
            ];
          },
        },
      ],
    },
    ...(
      [
        ["original", "Original", "original_resume"],
        ["light", "Light", "conservative"],
        ["tailored", "Tailored", "balanced"],
        ["aggressive", "Aggressive", "aggressive"],
      ] as const
    ).map(
      ([id, label, approach]): BuiltAppBatch => ({
        id: `profile-default-${id}`,
        prepare: async (page) => {
          const before: { approach: ResumeApproach } = {
            approach:
              approach === "original_resume" ? "balanced" : "original_resume",
          };
          await page.evaluate(
            (input) =>
              (window as unknown as AppWindow).nestor.jobs.run(
                "set_resume_approach",
                input,
              ),
            before,
          );
          beforeResumes = await existingResumes(page);
        },
        request: `Set the default resume level in Profile Preferences to ${label}, for jobs I shortlist from now on. Leave existing jobs alone.`,
        actions: [
          {
            actionId: `profile.approach_${id}`,
            observe: async (page, reply, evidence) => {
              const saved = await page.evaluate(async () => {
                const jobs = (window as unknown as AppWindow).nestor.jobs;
                return {
                  settings: await jobs.run("get_settings", {}),
                  goals: await jobs.run("get_profile_goals", {}),
                };
              });
              return [
                equalOutcome(
                  "unchanged",
                  "Existing job resume choices preserved",
                  "resumes.get_resume for existing tracked jobs",
                  await existingResumes(page),
                  beforeResumes,
                ),
                equalOutcome(
                  "data",
                  "Saved original or tailored mode",
                  "jobs.get_settings.resumeApplicationMode",
                  saved.settings.resumeApplicationMode,
                  approach === "original_resume"
                    ? "original_resume"
                    : "tailored_per_job",
                ),
                equalOutcome(
                  "data",
                  "Saved tailoring strength",
                  "jobs.get_profile_goals.tailoringMode",
                  saved.goals.tailoringMode,
                  approach === "original_resume" ? "balanced" : approach,
                ),
                equalOutcome(
                  "data",
                  "Default change has its own Undo receipt",
                  "Current persisted Assistant receipt",
                  Boolean(
                    currentUndoReceipt(reply, evidence, "settings") ??
                    currentUndoReceipt(reply, evidence, "profile"),
                  ),
                  true,
                ),
              ];
            },
          },
        ],
      }),
    ),
  ];
}

export function declarationOutcomeCases(): BuiltAppBatch[] {
  return (
    [
      ["truth", "truthfulness_certification"],
      ["privacy", "privacy_notice_acknowledgement"],
      ["terms", "terms_acceptance"],
      ["background_check", "background_check_consent"],
      ["self_identification", "equal_opportunity_self_identification"],
      ["marketing", "marketing_contact_consent"],
    ] as const
  ).flatMap(([id, kind]) =>
    ([false, true] as const).map((enabled): BuiltAppBatch => {
      const other: ApplicationAttestationKind =
        kind === "privacy_notice_acknowledgement"
          ? "truthfulness_certification"
          : "privacy_notice_acknowledgement";
      return {
        id: `declaration-${id}-${enabled ? "on" : "off"}`,
        prepare: async (page) => {
          const before: PatchSettingsInput = {
            lists: {
              "aiBehavior.applying.preApprovedDeclarations": enabled
                ? [other]
                : [other, kind],
            },
          };
          await page.evaluate(
            (input) =>
              (window as unknown as AppWindow).nestor.jobs.run(
                "patch_settings",
                input,
              ),
            before,
          );
        },
        request: `In Settings Applying, turn ${enabled ? "on" : "off"} pre-approval for the ${kind} declaration. Preserve the other saved declaration choices.`,
        actions: [
          {
            actionId: `settings.declaration.${id}`,
            observe: async (page, reply, evidence) => [
              equalOutcome(
                "data",
                "Requested declaration and other choices",
                "jobs.get_settings.aiBehavior.applying.preApprovedDeclarations",
                await page.evaluate(async () =>
                  [
                    ...((
                      await (window as unknown as AppWindow).nestor.jobs.run(
                        "get_settings",
                        {},
                      )
                    ).aiBehavior?.applying.preApprovedDeclarations ?? []),
                  ].sort(),
                ),
                (enabled ? [other, kind] : [other]).sort(),
              ),
              equalOutcome(
                "data",
                "Declaration choice has its own Undo receipt",
                "Current persisted Assistant receipt",
                Boolean(currentUndoReceipt(reply, evidence, "settings")),
                true,
              ),
            ],
          },
        ],
      };
    }),
  );
}
