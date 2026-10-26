import { createNeedsYouCommandRunner } from "@nestor/job-finder/needs-you";
import {
  NEEDS_YOU_RUN_CHANNEL,
  type NeedsYouCommandName,
  type NeedsYouCommandOutput,
} from "@nestor/contracts";
import type { IpcMain } from "electron";
import { getApplicationStore } from "../services/job-finder/application-store";
import { loadEmbeddedBrowser } from "../services/browser/load-embedded-browser";
import { runJobCommand } from "../services/job-commands";

/**
 * Apply's service starts with the Job Finder runtime; both load on first
 * use rather than with main.
 */
async function applicationService() {
  const [{ startJobFinderRuntime }, { getApplicationService }] =
    await Promise.all([
      import("../services/job-finder/workspace-service"),
      import("../services/applications"),
    ]);
  await startJobFinderRuntime();
  return getApplicationService();
}

const run = createNeedsYouCommandRunner(getApplicationStore, {
  retry: async (id) => {
    await runJobCommand("retry_source", { id });
  },
  open: async (id) => {
    const task = getApplicationStore().needsYou.list({
      after: id - 1,
      limit: 1,
    }).rows[0];
    if (task?.id === id && task.source) {
      await (
        await loadEmbeddedBrowser()
      ).command({
        type: "open",
        url: task.source.url,
      });
      return true;
    }
    const service = await applicationService();
    for (const application of getApplicationStore().needsYou.details(id)
      ?.applications ?? []) {
      if (await service.open(application.id)) {
        await (await loadEmbeddedBrowser()).command({ type: "open" });
        return true;
      }
    }
    return false;
  },
  check: async (id) => {
    return (await applicationService()).checkAccess(id);
  },
});

/** The screen and registered Assistant tools share this typed command runner. */
export async function runNeedsYouCommand<K extends NeedsYouCommandName>(
  name: K,
  input: unknown,
): Promise<NeedsYouCommandOutput<K>> {
  const result = await run(name, input);
  if (
    [
      "answer_need",
      "save_form_answer",
      "create_form_answer",
      "upsert_form_answer",
    ].includes(name) &&
    getApplicationStore().listApplications({ state: "queued", limit: 1 }).rows
      .length
  )
    await applicationService();
  return result;
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
