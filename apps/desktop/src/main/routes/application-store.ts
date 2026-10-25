import {
  ApplicationListPageSchema,
  ApplicationListQuerySchema,
  ApplyJobsInputSchema,
  ApplyJobsResultSchema,
  ApplicationStoreDemoInputSchema,
  ApplicationStoreDemoResultSchema,
  DEFAULT_APPLICATION_APPLY_MODE,
} from "@nestor/contracts";
import type { IpcMain } from "electron";

import { getApplicationStore } from "../services/job-finder/application-store";
import { getJobStore } from "../services/job-store";
import { isDesktopTestApiEnabled } from "../services/job-finder/test-api";
import { getJobFinderRepositoryForWorkspaceService } from "../services/job-finder/create-workspace-service";
import { getJobFinderWorkspaceService } from "../services/job-finder/workspace-service";

export function registerApplicationStoreRoutes(ipcMain: IpcMain): void {
  ipcMain.handle("job-finder:apply-jobs", async (_event, input: unknown) => {
    const value = ApplyJobsInputSchema.parse(input);
    const service = await getJobFinderWorkspaceService();
    const repository = getJobFinderRepositoryForWorkspaceService(service);
    if (!repository)
      throw new Error("Job Finder could not read the Apply setting.");
    const settings = await repository.getSettings();
    return ApplyJobsResultSchema.parse(
      getApplicationStore().applyJobs(
        value,
        settings.applicationAutomationMode ?? DEFAULT_APPLICATION_APPLY_MODE,
      ),
    );
  });
  ipcMain.handle("job-finder:list-applications", (_event, input: unknown) =>
    ApplicationListPageSchema.parse(
      getApplicationStore().listApplications(
        ApplicationListQuerySchema.parse(input ?? {}),
      ),
    ),
  );
  ipcMain.handle(
    "job-finder:test-load-applications-store-demo",
    (_event, input: unknown) => {
      if (!isDesktopTestApiEnabled())
        throw new Error("Desktop test API is disabled.");
      const { sourceUrl } = ApplicationStoreDemoInputSchema.parse(input);
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
        return ApplicationStoreDemoResultSchema.parse({
          approvedIds,
          unapprovedId: added[2],
        });
      });
    },
  );
}
