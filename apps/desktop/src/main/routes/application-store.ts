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
  ApplicationCommandResultSchema,
  NeedsYouListQuerySchema,
  NeedsYouPageSchema,
  AnswerNeedsYouInputSchema,
  AnswerNeedsYouResultSchema,
  ResolveUncertainSendInputSchema,
  type ApplicationAutomationMode,
} from "@nestor/contracts";
import {
  approveOriginalResumesForTests,
  seedTrackerDemo,
} from "@nestor/db/job-store";
import type { IpcMain } from "electron";

import { getApplicationStore } from "../services/job-finder/application-store";
import { getJobStore } from "../services/job-store";
import { isDesktopTestApiEnabled } from "../services/job-finder/test-api";
import { getApplicationService } from "../services/applications";
import { startJobFinderRuntime } from "../services/job-finder/runtime";

/** The registered Assistant actions and preload bridge execute the same commands. */
export async function executeApplicationStoreCommand(
  actionId: string,
  input: unknown,
  instruction?: { conversationId: string; mode: ApplicationAutomationMode },
): Promise<unknown> {
  const store = getApplicationStore();
  switch (actionId) {
    case "apply-jobs": {
      const value = ApplyJobsInputSchema.parse(input);
      const { repository } = await startJobFinderRuntime();
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
      await startJobFinderRuntime();
      return ApplicationCommandResultSchema.parse(
        await (
          await getApplicationService()
        ).stopApplication(ApplicationTargetSchema.parse(input).id),
      );
    case "send-application":
      await startJobFinderRuntime();
      return (await getApplicationService()).sendPrepared(
        ApplicationTargetSchema.parse(input).id,
      );
    case "resolve-uncertain-send": {
      const { id, sent } = ResolveUncertainSendInputSchema.parse(input);
      // A send the app made keeps an authority record, settled with the row.
      // The person's own press, or a send the app closed during, has none.
      const receipt = store.getSubmissionReceipt(id);
      if (receipt?.outcome === "outcome_uncertain") {
        const { getJobFinderApplicationAuthorityService } =
          await import("../services/job-finder");
        const { status } =
          await getJobFinderApplicationAuthorityService().resolveSubmissionOutcome(
            {
              uncertainOutcomeId: receipt.id,
              resolution: sent ? "submitted" : "not_submitted",
              confirmedOnEmployerSite: true,
            },
          );
        if (status !== "missing")
          return status === "recorded" || status === "duplicate";
      }
      await startJobFinderRuntime();
      return ApplicationCommandResultSchema.parse(
        await (await getApplicationService()).resolveUncertainByPerson(id, sent),
      );
    }
    case "open-application": {
      await startJobFinderRuntime();
      const opened = await (
        await getApplicationService()
      ).open(ApplicationTargetSchema.parse(input).id);
      // open() focuses the exact retained binding. A true result can also
      // mean a lost page was queued for refill: never expose the active tab
      // of some other application while that work runs in the background.
      return ApplicationCommandResultSchema.parse(opened);
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
    "resolve-uncertain-send",
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
        approveOriginalResumesForTests(store, approvedIds);
        if (trackApplications) seedTrackerDemo(store, approvedIds);
        return ApplicationStoreDemoResultSchema.parse({
          approvedIds,
          unapprovedId: added[2],
        });
      });
    },
  );
}
