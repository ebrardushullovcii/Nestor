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
import { getEmbeddedBrowser } from "../services/browser/embedded-browser";
import {
  importSignInsFromBrowser,
  listBrowserImportSources,
} from "../services/browser/browser-profile-import";

import { publishJobFinderWorkspaceUpdate } from "../services/job-finder/workspace-updates";

export function registerBrowserRoutes(ipc: IpcMain): void {
  const host = getEmbeddedBrowser();
  const assertOwner = (event: IpcMainInvokeEvent) => {
    if (
      !host.ownsRenderer(event.sender.id) ||
      event.senderFrame !== event.sender.mainFrame
    ) {
      throw new Error("Browser controls are available only in the app window.");
    }
  };
  ipc.handle("browser:add-job", async (event, input: unknown) => {
    assertOwner(event);
    const { tabId } = AddBrowserJobInputSchema.parse(input);
    const page = await host.readTab<string>(
      tabId,
      "document.documentElement.outerHTML",
    );
    if (!page)
      throw new Error("Wait for this page to finish loading, then try again.");
    // The old workspace service loads on first use, not with main.
    const { getJobFinderWorkspaceService } =
      await import("../services/job-finder/workspace-service");
    const service = await getJobFinderWorkspaceService();
    const result = await service.addJobFromBrowserPage({
      html: page.value,
      pageUrl: page.url,
    });
    publishJobFinderWorkspaceUpdate(event.sender);
    return AddBrowserJobResultSchema.parse(result);
  });
  ipc.handle("browser:get-state", (event) => {
    assertOwner(event);
    return host.getState();
  });
  ipc.handle("browser:command", (event, input: unknown) => {
    assertOwner(event);
    return host.command(DesktopBrowserCommandSchema.parse(input));
  });
  ipc.handle("browser:set-viewport", (event, input: unknown) => {
    assertOwner(event);
    host.setViewport(DesktopBrowserViewportSchema.parse(input));
  });
  ipc.handle("browser:capture-page", async (event) => {
    assertOwner(event);
    return DesktopBrowserSnapshotSchema.parse(await host.captureActivePage());
  });
  ipc.handle("browser:list-import-sources", async (event) => {
    assertOwner(event);
    return DesktopBrowserImportSourcesSchema.parse(
      await listBrowserImportSources(),
    );
  });
  ipc.handle("browser:import-from-browser", async (event, input: unknown) => {
    assertOwner(event);
    return DesktopBrowserImportResultSchema.parse(
      await importSignInsFromBrowser(
        host,
        DesktopBrowserImportInputSchema.parse(input),
      ),
    );
  });
}
