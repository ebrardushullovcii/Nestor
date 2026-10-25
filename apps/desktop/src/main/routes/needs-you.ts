import { createNeedsYouCommandRunner } from "@nestor/job-finder/applications";
import {
  NEEDS_YOU_RUN_CHANNEL,
  type NeedsYouCommandName,
  type NeedsYouCommandOutput,
} from "@nestor/contracts";
import type { IpcMain } from "electron";
import { getApplicationStore } from "../services/job-finder/application-store";
import { getApplicationService } from "../services/applications";
import { getJobFinderWorkspaceService } from "../services/job-finder/workspace-service";
import { getEmbeddedBrowser } from "../services/browser/embedded-browser";

const run = createNeedsYouCommandRunner(getApplicationStore, {
  open: async (id) => {
    const task = getApplicationStore().needsYou.list({
      after: id - 1,
      limit: 1,
    }).rows[0];
    if (task?.id === id && task.source) {
      await getEmbeddedBrowser().command({
        type: "open",
        url: task.source.url,
      });
      return true;
    }
    await getJobFinderWorkspaceService();
    const application =
      getApplicationStore().needsYou.details(id)?.applications[0];
    if (!application) return false;
    const opened = await (await getApplicationService()).open(application.id);
    if (opened) await getEmbeddedBrowser().command({ type: "open" });
    return opened;
  },
  check: async (id) => {
    await getJobFinderWorkspaceService();
    return (await getApplicationService()).checkAccess(id);
  },
});

/** The screen and registered Assistant tools share this typed command runner. */
export async function runNeedsYouCommand<K extends NeedsYouCommandName>(
  name: K,
  input: unknown,
): Promise<NeedsYouCommandOutput<K>> {
  return run(name, input);
}
export function registerNeedsYouRoutes(ipcMain: IpcMain): void {
  ipcMain.handle(NEEDS_YOU_RUN_CHANNEL, (event, request: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error("Not allowed.");
    if (
      !request ||
      typeof request !== "object" ||
      !("name" in request) ||
      typeof request.name !== "string" ||
      !("input" in request)
    )
      throw new Error("Invalid Needs you command.");
    return runNeedsYouCommand(
      request.name as NeedsYouCommandName,
      request.input,
    );
  });
}
