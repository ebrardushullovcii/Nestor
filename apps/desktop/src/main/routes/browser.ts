import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  AddBrowserJobInputSchema,
  AddBrowserJobResultSchema,
  DesktopBrowserCommandSchema,
  DesktopBrowserImportInputSchema,
  DesktopBrowserImportResultSchema,
  DesktopBrowserImportSourcesSchema,
  DesktopBrowserSnapshotSchema,
  DesktopBrowserViewportSchema,
} from "@nestor/contracts";
import { loadEmbeddedBrowser } from "../services/browser/load-embedded-browser";
import { getJobStore } from "../services/job-store";
import { scoreUnscoredJobs } from "../services/job-commands";

export function registerBrowserRoutes(ipc: IpcMain): void {
  // The browser loads after the first window; each call waits for it here.
  const owner = async (event: IpcMainInvokeEvent) => {
    const host = await loadEmbeddedBrowser();
    if (
      !host.ownsRenderer(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Browser controls are available only in the app window.");
    }
    return host;
  };
  ipc.handle("browser:add-job", async (event, input: unknown) => {
    const host = await owner(event);
    const { tabId } = AddBrowserJobInputSchema.parse(input);
    const page = await host.readTab<string>(
      tabId,
      "document.documentElement.outerHTML",
    );
    if (!page)
      throw new Error("Wait for this page to finish loading, then try again.");
    // Job Finder's AI loads on first use, not with main.
    const [
      { readJobFromBrowserPage },
      { savePageJobs },
      { startJobFinderRuntime },
    ] = await Promise.all([
      import("@nestor/job-finder"),
      import("@nestor/job-finder/job-commands"),
      import("../services/job-finder/runtime"),
    ]);
    const { aiClient } = await startJobFinderRuntime();
    const posting = await readJobFromBrowserPage(aiClient, {
      html: page.value,
      pageUrl: page.url,
    });
    const [jobId] = savePageJobs(getJobStore(), {
      postings: [posting],
      pageUrl: page.url,
    }).ids;
    if (jobId === undefined)
      throw new Error("This job could not be saved. Try again.");
    // The job is saved now; its fit is judged in the background.
    scoreUnscoredJobs();
    return AddBrowserJobResultSchema.parse({
      jobId: String(jobId),
      title: posting.title,
      company: posting.company,
      planName: null,
    });
  });
  ipc.handle("browser:get-state", async (event) =>
    (await owner(event)).getState(),
  );
  ipc.handle("browser:command", async (event, input: unknown) =>
    (await owner(event)).command(DesktopBrowserCommandSchema.parse(input)),
  );
  ipc.handle("browser:set-viewport", async (event, input: unknown) => {
    (await owner(event)).setViewport(DesktopBrowserViewportSchema.parse(input));
  });
  ipc.handle("browser:capture-page", async (event) =>
    DesktopBrowserSnapshotSchema.parse(
      await (await owner(event)).captureActivePage(),
    ),
  );
  ipc.handle("browser:list-import-sources", async (event) => {
    await owner(event);
    const { listBrowserImportSources } =
      await import("../services/browser/browser-profile-import");
    return DesktopBrowserImportSourcesSchema.parse(
      await listBrowserImportSources(),
    );
  });
  ipc.handle("browser:import-from-browser", async (event, input: unknown) => {
    const host = await owner(event);
    const { importSignInsFromBrowser } =
      await import("../services/browser/browser-profile-import");
    return DesktopBrowserImportResultSchema.parse(
      await importSignInsFromBrowser(
        host,
        DesktopBrowserImportInputSchema.parse(input),
      ),
    );
  });
}
