import type {
  ApplicationSalaryDisclosureRule,
  JobFinderSettings,
} from "@nestor/contracts";

/** Sending permission never changes the person's saved pay-disclosure choice. */
export async function readSalaryDisclosurePreference(repository: {
  getSettings: () => Promise<JobFinderSettings>;
}): Promise<ApplicationSalaryDisclosureRule> {
  return (await repository.getSettings()).salaryDisclosure ?? "pause_for_user";
}
