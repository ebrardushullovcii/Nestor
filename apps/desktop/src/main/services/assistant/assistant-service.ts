import type { ApplicationAutomationMode, AssistantMessage } from "@nestor/contracts";
import { existsSync } from "node:fs";
import path from "node:path";

import { BrowserWindow } from "electron";
import { resolveAssistantModelRouteFromEnvironment } from "@nestor/ai-providers";
import type { AssistantEvent } from "@nestor/contracts";
import {
  createAssistantRepository,
  type AssistantRepository,
} from "@nestor/db";
import {
  AssistantSessionHost,
  createAssistantModelHandle,
  createScriptedAssistantModelHandle,
  decideUnderGrants,
  type AssistantModelResolution,
} from "@nestor/job-finder";

import { getJobFinderUserDataDirectory } from "../job-finder/paths";
import { isDesktopTestApiEnabled } from "../job-finder/test-api";
import { onJobFinderWorkspaceUpdate } from "../job-finder/workspace-updates";
import { getJobFinderWorkspaceService } from "../job-finder/workspace-service";
import { createAssistantHostPorts } from "./assistant-ports";

/**
 * The assistant session host lives in the main process for the life of the
 * app (ADR 0037), with its own store beside the workspace database.
 */

export const ASSISTANT_EVENT_CHANNEL = "job-finder:assistant:event";

let hostPromise: Promise<AssistantSessionHost> | null = null;
let repository: AssistantRepository | null = null;
let unsubscribeWorkspaceUpdates: (() => void) | null = null;

/** A stored application can only narrow the person's current sidebar instruction. */
export async function assistantApplicationMode(input: {
  conversationId: string; jobId: number; mode: ApplicationAutomationMode;
}): Promise<ApplicationAutomationMode | null> {
  repository ??= createAssistantRepository({ filePath: path.join(getJobFinderUserDataDirectory(), "assistant.sqlite") });
  const [decision] = decideUnderGrants({ grants: await repository.listGrants(input.conversationId),
    jobIds: [String(input.jobId)], action: "prepare", savedMode: input.mode });
  if (!decision?.allowed || !decision.mode) return null;
  const strength = { prepare_only: 0, confirm_before_submit: 1, autonomous_submit: 2 } as const;
  return strength[decision.mode] < strength[input.mode] ? decision.mode : input.mode;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

export function resolveAssistantModel(
  env: NodeJS.ProcessEnv = process.env,
): AssistantModelResolution {
  // Test builds without live AI get the deterministic stand-in, the same
  // rule the rest of Job Finder follows (see create-workspace-service).
  if (
    isDesktopTestApiEnabled(env) &&
    !isEnabled(env.NESTOR_TEST_API_USE_LIVE_AI)
  ) {
    const delay = Number.parseInt(
      env.NESTOR_TEST_ASSISTANT_DELAY_MS ?? "",
      10,
    );
    return {
      kind: "ready",
      handle: createScriptedAssistantModelHandle(
        Number.isFinite(delay) && delay > 0 ? { delayMs: delay } : {},
      ),
    };
  }
  const resolution = resolveAssistantModelRouteFromEnvironment(env);
  if (!resolution.available) {
    return { kind: "unavailable", detail: resolution.detail };
  }
  return {
    kind: "ready",
    handle: createAssistantModelHandle(resolution.route, resolution.fallback),
  };
}

function publish(event: AssistantEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(ASSISTANT_EVENT_CHANNEL, event);
    }
  }
}

function browserHost(env: NodeJS.ProcessEnv): "embedded" | "external" {
  const testApi = isDesktopTestApiEnabled(env);
  return env.NESTOR_BROWSER_HOST !== "external" &&
    (!testApi || env.NESTOR_BROWSER_HOST === "embedded")
    ? "embedded"
    : "external";
}

export function getAssistantHost(): Promise<AssistantSessionHost> {
  hostPromise ??= (async () => {
    const service = await getJobFinderWorkspaceService();
    repository ??= createAssistantRepository({
      filePath: path.join(getJobFinderUserDataDirectory(), "assistant.sqlite"),
    });
    const host = new AssistantSessionHost({
      repository,
      service,
      ports: createAssistantHostPorts({
        browserHost: browserHost(process.env),
      }),
      resolveModel: () => resolveAssistantModel(process.env),
      publish,
      stallAfterMs: 25_000,
    });
    unsubscribeWorkspaceUpdates?.();
    unsubscribeWorkspaceUpdates = onJobFinderWorkspaceUpdate(() =>
      host.notifyWorkspaceChanged(),
    );
    await host.recover().catch((error: unknown) => {
      console.warn("[assistant] Recovery after restart failed", error);
    });
    return host;
  })();
  const created = hostPromise;
  void created.catch(() => {
    if (hostPromise === created) hostPromise = null;
  });
  return created;
}

export async function shutdownAssistantHost(): Promise<void> {
  const current = hostPromise;
  hostPromise = null;
  unsubscribeWorkspaceUpdates?.();
  unsubscribeWorkspaceUpdates = null;
  if (current) {
    const host = await current.catch(() => null);
    await host?.shutdown().catch(() => undefined);
  }
  await repository?.close().catch(() => undefined);
  repository = null;
}

/** Workspace reset clears the assistant's store too. */
export async function resetAssistantStore(): Promise<void> {
  const current = hostPromise;
  hostPromise = null;
  if (current) {
    const host = await current.catch(() => null);
    await host?.shutdown().catch(() => undefined);
  }
  if (!repository) {
    const filePath = path.join(
      getJobFinderUserDataDirectory(),
      "assistant.sqlite",
    );
    // Nothing was ever stored: nothing to clear.
    if (!existsSync(filePath)) return;
    repository = createAssistantRepository({ filePath });
  }
  const conversations = await repository.listConversations();
  await repository.reset();
  const at = new Date().toISOString();
  for (const conversation of conversations) {
    publish({
      conversationId: conversation.id,
      turnId: null,
      sequence: 0,
      at,
      payload: { type: "conversation_deleted" },
    });
  }
}

/** Reads saved chats for a personal workspace export without starting a turn. */
export async function exportAssistantHistory() {
  const filePath = path.join(
    getJobFinderUserDataDirectory(),
    "assistant.sqlite",
  );
  if (!repository && !existsSync(filePath)) return [];
  const store = repository ?? createAssistantRepository({ filePath });
  const ownsStore = store !== repository;
  try {
    const conversations = await store.listConversations();
    const history = [];
    for (const conversation of conversations) {
      const messages: AssistantMessage[] = [];
      let beforeMessageId: string | null = null;
      for (;;) {
        const page = await store.listMessages(conversation.id, {
          beforeMessageId,
          limit: 400,
        });
        messages.unshift(...page.messages);
        if (!page.hasOlder || !page.messages.length) break;
        beforeMessageId = page.messages[0]!.id;
      }
      history.push({ conversation, messages });
    }
    return history;
  } finally {
    if (ownsStore) await store.close();
  }
}

/** Stop the current turn before replacing saved chat history. */
export async function restoreAssistantHistory(
  history: Awaited<ReturnType<typeof exportAssistantHistory>>,
): Promise<void> {
  const current = hostPromise;
  hostPromise = null;
  if (current) await (await current).shutdown();
  repository ??= createAssistantRepository({
    filePath: path.join(getJobFinderUserDataDirectory(), "assistant.sqlite"),
  });
  await repository.restoreHistory(history);
}

export async function stopAssistantForWorkspaceRestore(): Promise<void> {
  const current = hostPromise;
  hostPromise = null;
  if (current) await (await current).shutdown();
}
