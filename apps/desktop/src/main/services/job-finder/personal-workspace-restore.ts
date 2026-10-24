import {
  PersonalWorkspaceExportSchema,
  JobFinderRepositoryStateSchema,
  type PersonalWorkspaceExport,
  type JobFinderRepositoryState,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function parsePersonalWorkspaceExport(
  content: string,
): PersonalWorkspaceExport {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error("This file is not a Nestor workspace export.");
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    !("schemaVersion" in raw) ||
    raw.schemaVersion !== 1
  )
    throw new Error(
      "This export uses a version Nestor cannot restore. Your workspace was kept.",
    );
  if (!("repositoryState" in raw))
    throw new Error(
      "This older export does not contain the full workspace needed to restore it. Make a new export from the original workspace. Your current workspace was kept.",
    );
  const parsed = PersonalWorkspaceExportSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      "This export is incomplete or damaged. Your workspace was kept.",
    );
  const backup = parsed.data;
  const seen = new Set<string>();
  for (const file of backup.files) {
    const parts = file.path.split("/");
    if (
      parts.length < 2 ||
      !["resumes", "attachments", "application-documents"].includes(
        parts[0]!,
      ) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.includes("\\") ||
          part.includes("\0"),
      ) ||
      seen.has(file.path) ||
      Buffer.from(file.content, "base64").toString("base64") !== file.content
    )
      throw new Error(
        "This export contains an unsafe or damaged document. Your workspace was kept.",
      );
    seen.add(file.path);
  }
  if (
    new Set(backup.fileRoots.map((root) => root.name)).size !==
    backup.fileRoots.length
  )
    throw new Error(
      "This export contains conflicting document folders. Your workspace was kept.",
    );
  const conversationIds = new Set(
    backup.assistantHistory.map((entry) => entry.conversation.id),
  );
  const messageIds = new Set<string>();
  if (conversationIds.size !== backup.assistantHistory.length)
    throw new Error(
      "This export contains conflicting chats. Your workspace was kept.",
    );
  for (const entry of backup.assistantHistory)
    for (const message of entry.messages) {
      if (
        message.conversationId !== entry.conversation.id ||
        messageIds.has(message.id)
      )
        throw new Error(
          "This export contains conflicting chats. Your workspace was kept.",
        );
      messageIds.add(message.id);
    }
  return backup;
}

/** Rebase only stored document references, never text the person wrote. */
export function restoredRepositoryState(
  backup: PersonalWorkspaceExport,
  roots: ReadonlyMap<string, string>,
): JobFinderRepositoryState {
  const filePaths = new Map<string, string>();
  for (const file of backup.files) {
    const [name, ...relative] = file.path.split("/");
    const source = backup.fileRoots.find((root) => root.name === name);
    const target = roots.get(name!);
    if (!source || !target)
      throw new Error(
        "This export is missing a document folder. Your workspace was kept.",
      );
    filePaths.set(
      path.join(source.directory, ...relative),
      path.join(target, ...relative),
    );
  }
  const rebase = (value: unknown, key?: string): unknown => {
    if (
      typeof value === "string" &&
      ["storagePath", "filePath"].includes(key ?? "")
    )
      return filePaths.get(value) ?? value;
    if (Array.isArray(value)) return value.map((item) => rebase(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, rebase(item, name)]),
      );
    return value;
  };
  const state = JobFinderRepositoryStateSchema.parse(
    rebase(backup.repositoryState),
  );
  // Imported authority is history, never a fresh permission to send.
  const now = new Date().toISOString();
  state.activityControl = {
    paused: true,
    pausedAt: now,
    reason: "Workspace restored. Resume activity when you are ready.",
  };
  state.applicationAuthorityEnvelopes = state.applicationAuthorityEnvelopes.map(
    (entry) =>
      entry.status === "active"
        ? { ...entry, status: "revoked", revokedAt: now }
        : entry,
  );
  state.submissionExecutionGrants = [];
  state.submissionArmedMarkers = [];
  return JobFinderRepositoryStateSchema.parse(state);
}

export async function restorePersonalWorkspace(input: {
  backup: PersonalWorkspaceExport;
  repository: Pick<
    JobFinderRepository,
    "exportState" | "reset" | "getApplyQueue" | "saveApplyQueue"
  >;
  roots: ReadonlyMap<string, string>;
  safetyExportPath: string;
  buildSafetyExport: () => Promise<string>;
  beforeReplace?: () => Promise<void>;
  readChats: () => Promise<PersonalWorkspaceExport["assistantHistory"]>;
  restoreChats: (
    history: PersonalWorkspaceExport["assistantHistory"],
  ) => Promise<void>;
}): Promise<void> {
  const next = restoredRepositoryState(input.backup, input.roots);
  // Refuse to replace anything unless the current workspace has a complete,
  // durable personal export. Exclusive creation prevents replacing an older backup.
  await writeFile(input.safetyExportPath, await input.buildSafetyExport(), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const current = await input.repository.exportState();
  const currentQueue = await input.repository.getApplyQueue();
  const chats = await input.readChats();
  await input.beforeReplace?.();
  const swaps: {
    target: string;
    previous: string | null;
    installed: boolean;
    stage: string;
  }[] = [];
  try {
    for (const [name, target] of input.roots) {
      await mkdir(path.dirname(target), { recursive: true });
      const stage = await mkdtemp(`${target}.restore-`);
      const swap = {
        target,
        stage,
        previous: null as string | null,
        installed: false,
      };
      swaps.push(swap);
      for (const file of input.backup.files.filter((entry) =>
        entry.path.startsWith(`${name}/`),
      )) {
        const destination = path.join(stage, ...file.path.split("/").slice(1));
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, Buffer.from(file.content, "base64"), {
          mode: 0o600,
          flag: "wx",
        });
      }
    }
    for (const swap of swaps) {
      const previous = `${swap.target}.before-restore-${randomUUID()}`;
      try {
        await rename(swap.target, previous);
        swap.previous = previous;
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      await rename(swap.stage, swap.target);
      swap.installed = true;
    }
    await input.repository.reset(next);
    // Reset clears the old queue. Keep the imported choice under next's global
    // pause; it does not restore any submission authority.
    await input.repository.saveApplyQueue(
      input.backup.workspace?.applyQueue ?? null,
    );
    await input.restoreChats(input.backup.assistantHistory);
  } catch (error) {
    // Roll back all three stores; retain safety export and old directories if
    // rollback itself fails, so recovery remains possible.
    const failures: unknown[] = [];
    for (const rollback of [
      async () => {
        await input.repository.reset(current);
        await input.repository.saveApplyQueue(currentQueue);
      },
      () => input.restoreChats(chats),
    ]) {
      try {
        await rollback();
      } catch (failure) {
        failures.push(failure);
      }
    }
    for (const swap of [...swaps].reverse()) {
      try {
        if (swap.installed)
          await rm(swap.target, { recursive: true, force: true });
        if (swap.previous) await rename(swap.previous, swap.target);
        await rm(swap.stage, { recursive: true, force: true });
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new Error(
        `Restore stopped and could not fully undo the changes. Restore the safety export at ${input.safetyExportPath}.`,
        { cause: error },
      );
    throw error;
  }
  for (const swap of swaps)
    if (swap.previous)
      await rm(swap.previous, { recursive: true, force: true }).catch(
        () => undefined,
      );
}
