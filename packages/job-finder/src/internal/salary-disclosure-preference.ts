import type {
  ApplicationSalaryDisclosureRule,
  JobFinderSettings,
  ApplicationAuthorityEnvelope,
} from "@nestor/contracts";

/** Migrate the old pay choice once; sending permission never controls it. */
export async function readSalaryDisclosurePreference(repository: {
  getSettings: () => Promise<JobFinderSettings>;
  commitSettingsUpdate: (
    update: (current: JobFinderSettings) => JobFinderSettings,
  ) => Promise<unknown>;
  listApplicationAuthorityEnvelopes: (filter: {
    status?: "active";
  }) => Promise<readonly ApplicationAuthorityEnvelope[]>;
}): Promise<ApplicationSalaryDisclosureRule> {
  const settings = await repository.getSettings();
  if (settings.salaryDisclosure !== undefined) return settings.salaryDisclosure;
  const envelopes = await repository.listApplicationAuthorityEnvelopes({});
  const legacy = [...envelopes]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .find((envelope) => envelope.decisionPolicy)?.decisionPolicy
    ?.answerPolicy.salaryDisclosure;
  if (legacy === undefined) return "pause_for_user";
  let choice = legacy;
  await repository.commitSettingsUpdate((current) => {
    choice = current.salaryDisclosure ?? legacy;
    return { ...current, salaryDisclosure: choice };
  });
  return choice;
}
