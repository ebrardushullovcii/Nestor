import type { IpcRenderer, IpcRendererEvent } from "electron";
import {
  PROFILE_WORKFLOW_CHANNEL,
  PROFILE_WORKFLOW_CHECK_SITE_CHANNEL,
  PROFILE_WORKFLOW_IMPORT_CHANNEL,
  type DesktopProfileWorkflowBridge,
  type ProfileWorkflowResult,
} from "@nestor/contracts";

type Ipc = Pick<IpcRenderer, "invoke" | "send" | "on" | "off">;

const newRequestId = (prefix: string) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * Profile and guided setup. Main checks every input against its schema; the
 * bridge passes values through and forwards progress for the one request it
 * started.
 */
export function createProfileWorkflowBridge(
  ipc: Ipc,
): DesktopProfileWorkflowBridge {
  let importRequestId: string | null = null;
  let siteCheckRequestId: string | null = null;

  async function withProgress<T>(
    channel: string,
    listener: (value: T) => void,
    run: () => Promise<unknown>,
  ): Promise<ProfileWorkflowResult> {
    const handler = (_event: IpcRendererEvent, value: T) => listener(value);
    ipc.on(channel, handler);
    try {
      return (await run()) as ProfileWorkflowResult;
    } finally {
      ipc.off(channel, handler);
    }
  }

  return {
    run: (command) =>
      ipc.invoke(
        PROFILE_WORKFLOW_CHANNEL,
        command,
      ) as Promise<ProfileWorkflowResult>,
    async importResume(onProgress, options) {
      if (importRequestId)
        throw new Error("A resume import is already running.");
      const requestId = newRequestId("resume_import");
      importRequestId = requestId;
      try {
        return await withProgress(
          `job-finder:resume-import-progress:${requestId}`,
          onProgress,
          () =>
            ipc.invoke(PROFILE_WORKFLOW_IMPORT_CHANNEL, {
              requestId,
              ...(options?.retryInterrupted ? { retryInterrupted: true } : {}),
            }),
        );
      } finally {
        if (importRequestId === requestId) importRequestId = null;
      }
    },
    cancelImportResume(stopProcessing = false) {
      const requestId = importRequestId;
      if (!requestId) return;
      // Main fences a late file choice by this id. The lock is released now;
      // the import's own finally can't clear a newer request.
      ipc.send("job-finder:cancel-import-resume", {
        requestId,
        ...(stopProcessing ? { stopProcessing: true } : {}),
      });
      importRequestId = null;
    },
    async checkSite(targetId, onProgress) {
      if (siteCheckRequestId)
        throw new Error("A site check is already running.");
      const requestId = newRequestId("site_check");
      siteCheckRequestId = requestId;
      try {
        return await withProgress(
          `job-finder:source-debug-progress:${requestId}`,
          onProgress,
          () =>
            ipc.invoke(PROFILE_WORKFLOW_CHECK_SITE_CHANNEL, {
              targetId,
              requestId,
            }),
        );
      } finally {
        if (siteCheckRequestId === requestId) siteCheckRequestId = null;
      }
    },
  };
}
