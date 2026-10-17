import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  AddBrowserJobInputSchema,
  AddBrowserJobResultSchema,
  DesktopBrowserCommandSchema,
  DesktopBrowserImportInputSchema,
  DesktopBrowserViewportSchema,
} from "@nestor/contracts";
import { getEmbeddedBrowser } from "../services/browser/embedded-browser";
import {
  importSignInsFromBrowser,
  listBrowserImportSources,
} from "../services/browser/browser-profile-import";

import { getJobFinderWorkspaceService } from "../services/job-finder/workspace-service";
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
  ipc.handle("browser:capture-page", (event) => {
    assertOwner(event);
    return host.captureActivePage();
  });
  ipc.handle("browser:list-import-sources", (event) => {
    assertOwner(event);
    return listBrowserImportSources();
  });
  ipc.handle("browser:import-from-browser", async (event, input: unknown) => {
    assertOwner(event);
    return importSignInsFromBrowser(
      host,
      DesktopBrowserImportInputSchema.parse(input),
    );
  });
}
