import {
  ApplicationListPageSchema,
  ApplicationListQuerySchema,
  ApplyJobsInputSchema,
  ApplyJobsResultSchema,
  ApplicationStoreDemoInputSchema,
  ApplicationStoreDemoResultSchema,
  DEFAULT_APPLICATION_APPLY_MODE,
  ApplicationTargetSchema,
  ApplicationRowSchema,
  ApplicationsForJobsInputSchema,
  ApplicationDetailsSchema,
  NeedsYouListQuerySchema,
  NeedsYouPageSchema,
  AnswerNeedsYouInputSchema,
  AnswerNeedsYouResultSchema,
  type ApplicationAutomationMode,
} from "@nestor/contracts";
import { seedTrackerDemo } from "@nestor/db/job-store";
import type { IpcMain } from "electron";

import { getApplicationStore } from "../services/job-finder/application-store";
import { getJobStore } from "../services/job-store";
import { isDesktopTestApiEnabled } from "../services/job-finder/test-api";
import { getJobFinderRepositoryForWorkspaceService } from "../services/job-finder/create-workspace-service";
import { getApplicationService } from "../services/applications";
import { getEmbeddedBrowser } from "../services/browser/embedded-browser";
import { getJobFinderWorkspaceService } from "../services/job-finder/workspace-service";

/** The registered Assistant actions and preload bridge execute the same commands. */
export async function executeApplicationStoreCommand(
  actionId: string,
  input: unknown,
  instruction?: { conversationId: string; mode: ApplicationAutomationMode },
): Promise<unknown> {
  await getJobFinderWorkspaceService();
  const store = getApplicationStore();
  switch (actionId) {
    case "apply-jobs": {
      const value = ApplyJobsInputSchema.parse(input);
      const service = await getJobFinderWorkspaceService();
      const repository = getJobFinderRepositoryForWorkspaceService(service);
      if (!repository)
        throw new Error("Job Finder could not read the Apply setting.");
      const settings = await repository.getSettings();
      if ((await repository.getActivityControl()).paused)
        throw new Error(
          "The person paused background work. Resume it before applying.",
        );
      return ApplyJobsResultSchema.parse(
        store.applyJobs(
          value,
          instruction
            ? instruction.mode === "autonomous_submit"
              ? instruction.mode
              : "confirm_before_submit"
            : (settings.applicationAutomationMode ??
                DEFAULT_APPLICATION_APPLY_MODE),
          instruction,
        ),
      );
    }
    case "list-applications":
      return ApplicationListPageSchema.parse(
        store.listApplications(ApplicationListQuerySchema.parse(input ?? {})),
      );
    case "applications-for-jobs":
      return ApplicationRowSchema.array().parse(
        store.forJobs(ApplicationsForJobsInputSchema.parse(input).jobIds),
      );
    case "get-application-details": {
      const { id } = ApplicationTargetSchema.parse(input);
      const application = store.getApplication(id);
      if (!application) return null;
      const work = store.getWork(id);
      return ApplicationDetailsSchema.parse({
        application,
        summary: work?.execution.summary ?? null,
        detail: work?.execution.detail ?? null,
        resumeFileName: store.getResumeArtifact(id)?.fileName ?? null,
        reviewCard: work?.reviewCard ?? null,
        receipt: store.getSubmissionReceipt(id),
      });
    }
    case "stop-application":
      return (await getApplicationService()).stopApplication(
        ApplicationTargetSchema.parse(input).id,
      );
    case "send-application":
      return (await getApplicationService()).sendPrepared(
        ApplicationTargetSchema.parse(input).id,
      );
    case "open-application": {
      const opened = await (
        await getApplicationService()
      ).open(ApplicationTargetSchema.parse(input).id);
      if (opened) await getEmbeddedBrowser().command({ type: "open" });
      return opened;
    }
    case "list-needs-you":
      return NeedsYouPageSchema.parse(
        store.needsYou.list(NeedsYouListQuerySchema.parse(input ?? {})),
      );
    case "answer-needs-you":
      return AnswerNeedsYouResultSchema.parse(
        store.needsYou.answer(AnswerNeedsYouInputSchema.parse(input)),
      );
    default:
      throw new Error("Unknown application command.");
  }
}

export function registerApplicationStoreRoutes(ipcMain: IpcMain): void {
  for (const action of [
    "apply-jobs",
    "list-applications",
    "applications-for-jobs",
    "get-application-details",
    "stop-application",
    "open-application",
    "list-needs-you",
    "answer-needs-you",
  ]) {
    ipcMain.handle(`job-finder:${action}`, (_event, input: unknown) =>
      executeApplicationStoreCommand(action, input),
    );
  }
  ipcMain.handle(
    "job-finder:test-load-applications-store-demo",
    (_event, input: unknown) => {
      if (!isDesktopTestApiEnabled())
        throw new Error("Desktop test API is disabled.");
      const { sourceUrl, trackApplications } =
        ApplicationStoreDemoInputSchema.parse(input);
      const origin = new URL(sourceUrl).origin;
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)
      ) {
        throw new Error("The applications demo requires a local replica site.");
      }
      const store = getJobStore();
      return store.transaction(() => {
        const { added } = store.saveFoundJobs({
          searchId: "applications-demo",
          jobs: [1, 2, 3].map((n) => ({
            title: `Application demo ${n}`,
            company: `Replica ${n}`,
            location: "Remote",
            workModes: ["remote"],
            url: `${origin}/store-demo/${n}`,
            applyUrl: null,
            sourceId: "applications-demo",
            sourceLabel: "Local replica",
            sourceJobId: String(n),
            postedAt: null,
            salaryText: null,
            salaryMin: null,
            salaryMax: null,
            salaryCurrency: null,
            seniority: null,
            employmentType: null,
            summary: null,
            description: "Synthetic listing for the applications store check.",
          })),
        });
        if (added.length !== 3)
          throw new Error("Load the applications demo in an empty instance.");
        const approvedIds = added.slice(0, 2);
        store.setStage(approvedIds, "resume");
        if (trackApplications) seedTrackerDemo(store, approvedIds);
        return ApplicationStoreDemoResultSchema.parse({
          approvedIds,
          unapprovedId: added[2],
        });
      });
    },
  );
}
