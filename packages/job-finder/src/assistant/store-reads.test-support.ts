import { afterEach } from "vitest";
import {
  openJobStore,
  createResumeStore,
  createTrackerStore,
} from "@nestor/db/job-store";
import { createApplicationStore } from "@nestor/db/applications";
import { createJobCommandRunner } from "../job-commands";
import { createNeedsYouCommandRunner } from "../applications/needs-you-commands";
import { workspaceHarnessInputs } from "../workspace-service.test-harness";
import type { AssistantHostPorts } from "./ports";

const fixtures = new Map<object, ReturnType<typeof makeReads>>();
afterEach(() => {
  for (const fixture of fixtures.values()) fixture.store.close();
  fixtures.clear();
});

function makeReads(service: object) {
  const inputs = workspaceHarnessInputs.get(service);
  if (!inputs)
    throw new Error("Use a workspace harness or supply explicit read ports.");
  const { repository, documentManager } = inputs;
  const store = openJobStore(":memory:");
  const jobs = createJobCommandRunner({ store });
  const resumes = createResumeStore(store);
  const tracker = createTrackerStore(store);
  const applications = createApplicationStore(store);
  const needs = createNeedsYouCommandRunner(() => applications, {
    open: () => Promise.resolve(false),
    check: () => Promise.resolve(false),
    retry: () => Promise.resolve(),
  });
  const readCommand: AssistantHostPorts["readCommand"] = async (
    name,
    input,
  ) => {
    if (name === "list_applications")
      return tracker.list(input as never) as never;
    if (name === "get_application")
      return tracker.getRow((input as { jobId: number }).jobId) as never;
    if (name === "list_shortlisted") {
      const page = store.listJobs(input as never);
      return {
        ...page,
        rows: page.rows.map((row) => ({ ...row, resume: resumes.get(row.id) })),
      } as never;
    }
    if (name === "get_resume") {
      const id = (input as { jobId: number }).jobId;
      return {
        job: store.getJob(id),
        resume: resumes.get(id),
        templates: [],
      } as never;
    }
    if (name === "get_application_details") {
      const application = applications.getApplication(
        (input as { id: number }).id,
      );
      return application
        ? ({
            application,
            summary: null,
            detail: null,
            reviewCard: null,
            receipt: null,
            resumeFileName: null,
          } as never)
        : (null as never);
    }
    if (name === "applications_for_jobs")
      return applications.forJobs(
        (input as { jobIds: number[] }).jobIds,
      ) as never;
    if (name === "get_need" || name === "needs_you_counts" || name === "application_needs")
      return (await needs(name, input)) as never;
    return (await jobs(name as Parameters<typeof jobs>[0], input)) as never;
  };
  return {
    store,
    applications,
    readCommand,
    savePageJobs: (input: Parameters<AssistantHostPorts["savePageJobs"]>[0]) =>
      jobs("import_page_jobs", input),
    async readPersonalState() {
      const [
        profile,
        searchPreferences,
        settings,
        profileSetupState,
        activityControl,
        latestResumeImportRun,
      ] = await Promise.all([
        repository.getProfile(),
        repository.getSearchPreferences(),
        repository.getSettings(),
        repository.getProfileSetupState(),
        repository.getActivityControl(),
        repository.getLatestResumeImportRun(),
      ]);
      return {
        profile,
        searchPreferences,
        settings,
        profileSetupState,
        activityControl,
        latestResumeImportRun,
        resumeImportActive: false,
        enabledSiteCount: searchPreferences.discovery.targets.filter(
          (site) => site.enabled,
        ).length,
        availableResumeTemplates: documentManager.listResumeTemplates(),
        generatedAt: new Date().toISOString(),
      };
    },
  };
}
export function assistantTestReads(service: object) {
  let fixture = fixtures.get(service);
  if (!fixture) {
    fixture = makeReads(service);
    fixtures.set(service, fixture);
  }
  return fixture;
}
