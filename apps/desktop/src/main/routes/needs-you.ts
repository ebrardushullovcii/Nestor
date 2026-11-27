import { createNeedsYouCommandRunner } from "@nestor/job-finder/needs-you";
import {
  aiAccessBlocks,
  checkAiAccessAgain,
  onAiAccessChange,
} from "@nestor/ai-providers";
import {
  AiAccountNeedRequestSchema,
  AiAccountNeedSchema,
  NEEDS_YOU_AI_ACCOUNT_CHANNEL,
  NEEDS_YOU_RUN_CHANNEL,
  type AiAccountNeed,
  type NeedsYouCommandName,
  type NeedsYouCommandOutput,
  type NeedsYouTask,
} from "@nestor/contracts";
import type { IpcMain } from "electron";
import { shell } from "electron";
import { getApplicationStore } from "../services/job-finder/application-store";
import { loadEmbeddedBrowser } from "../services/browser/load-embedded-browser";
import { runJobCommand } from "../services/job-commands";
import { getJobStore } from "../services/job-store";
import { createSourceHandoffs } from "../services/job-finder/source-handoffs";
import { registerServiceStopper } from "../services/service-stoppers";

let sourceHandoffs: Promise<ReturnType<typeof createSourceHandoffs>> | null =
  null;
async function openSource(task: NeedsYouTask) {
  sourceHandoffs ??= (async () => {
    const handoffs = createSourceHandoffs({
      browser: await loadEmbeddedBrowser(),
      task: (id) => getApplicationStore().needsYou.details(id)?.task ?? null,
    });
    registerServiceStopper(getJobStore().onChange(handoffs.reconcile));
    return handoffs;
  })().catch((error) => {
    sourceHandoffs = null;
    throw error;
  });
  return (await sourceHandoffs).open(task);
}

/**
 * Apply's service starts with the Job Finder runtime; both load on first
 * use rather than with main.
 */
async function applicationService() {
  const [{ startJobFinderRuntime }, { getApplicationService }] =
    await Promise.all([
      import("../services/job-finder/runtime"),
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
    const blocked = getApplicationStore().needsYou.details(id)?.task.blockedUrl;
    if (blocked) {
      const url = new URL(blocked);
      if (!["https:", "http:"].includes(url.protocol))
        throw new Error("This job link cannot be opened.");
      await shell.openExternal(url.href);
      return true;
    }
    const task = getApplicationStore().needsYou.list({
      after: id - 1,
      limit: 1,
    }).rows[0];
    if (task?.id === id && task.source) {
      return openSource(task);
    }
    const service = await applicationService();
    for (const application of getApplicationStore().needsYou.details(id)
      ?.applications ?? []) {
      if ((await service.open(application.id)).opened) {
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
/** The AI accounts refusing Nestor's calls now, as Needs you shows them. */
export function aiAccountNeeds(): AiAccountNeed[] {
  return aiAccessBlocks().map((block) =>
    AiAccountNeedSchema.parse({
      id: block.id,
      provider: block.provider,
      reason: block.reason,
      owner: block.owner,
      providerMessage: block.providerMessage,
      actionUrl: block.actionUrl,
      since: block.since,
    }),
  );
}

async function runAiAccountNeed(request: unknown) {
  const parsed = AiAccountNeedRequestSchema.parse(request);
  if (parsed.action === "list") return aiAccountNeeds();
  if (parsed.action === "check") return checkAiAccessAgain();
  const link = aiAccessBlocks().find(
    (block) => block.id === parsed.id,
  )?.actionUrl;
  if (!link) return false;
  const url = new URL(link);
  if (!["https:", "http:"].includes(url.protocol)) return false;
  await shell.openExternal(url.href);
  return true;
}

/**
 * Needs you and its count read the AI account item with the store's tasks:
 * a change to it reaches them as an application change.
 */
let announcingAiAccess: (() => void) | null = null;
function announceAiAccessChanges(): void {
  announcingAiAccess ??= onAiAccessChange(() => {
    getJobStore().notify({
      cause: "application",
      stages: [],
      ids: [],
      searchId: null,
    });
  });
}

export function registerNeedsYouRoutes(ipcMain: IpcMain): void {
  announceAiAccessChanges();
  ipcMain.handle(NEEDS_YOU_AI_ACCOUNT_CHANNEL, (event, request: unknown) => {
    if (event.senderFrame !== event.sender.mainFrame)
      throw new Error("Not allowed.");
    return runAiAccountNeed(request);
  });
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
