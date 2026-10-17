import { open, stat } from "node:fs/promises";
import path from "node:path";
import { clipboard, dialog, type IpcMain } from "electron";
import {
  InterviewAudioTranscriptionInputSchema,
  InterviewCaptionFileReadInputSchema,
  InterviewClipboardWriteInputSchema,
  SendInterviewChatMessageInputSchema,
  InterviewExportSessionInputSchema,
  InterviewOverlayMoveInputSchema,
  JobFinderInterviewFollowUpInputSchema,
  InterviewPrepArtifactFromCueInputSchema,
  InterviewSessionActionInputSchema,
  InterviewSessionIdInputSchema,
  InterviewTranscriptAnnotationInputSchema,
  InterviewTranscriptSegmentInputSchema,
  SaveInterviewSetupInputSchema,
  UpdateInterviewOverlayPreferenceInputSchema,
} from "@nordri/contracts";
import { getJobFinderWorkspaceService } from "../services/job-finder";
import { getLiveAssistantService } from "../services/live-assistant";
import {
  moveInterviewOverlayWindow,
  syncInterviewOverlayWindows,
  verifyInterviewOverlayCaptureProtection,
} from "../setup/interview-overlay-windows";

const MAX_NATIVE_CAPTION_FILE_BYTES = 2 * 1024 * 1024;

async function withSyncedOverlays<
  T extends Awaited<
    ReturnType<
      Awaited<ReturnType<typeof getLiveAssistantService>>["getWorkspace"]
    >
  >,
>(operation: () => Promise<T>) {
  const workspace = await operation();
  syncInterviewOverlayWindows(workspace);
  return workspace;
}

async function readNativeCaptionFileText(filePath: string) {
  const fileStats = await stat(filePath);
  const bytesToRead = Math.min(fileStats.size, MAX_NATIVE_CAPTION_FILE_BYTES);
  const start = Math.max(0, fileStats.size - bytesToRead);
  const buffer = Buffer.alloc(bytesToRead);
  const file = await open(filePath, "r");

  try {
    await file.read(buffer, 0, bytesToRead, start);
  } finally {
    await file.close();
  }

  return {
    selected: true,
    filePath,
    displayName: path.basename(filePath),
    text: buffer.toString("utf8"),
    truncated: fileStats.size > MAX_NATIVE_CAPTION_FILE_BYTES,
  };
}

export function registerLiveAssistantRouteHandlers(ipcMain: IpcMain) {
  ipcMain.handle(
    "live-assistant:get-session",
    async (_event, payload: unknown) => {
      const input = InterviewSessionIdInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return service.getSession(input.sessionId);
    },
  );

  ipcMain.handle("live-assistant:get-workspace", async () => {
    const service = await getLiveAssistantService();
    return service.getWorkspace();
  });

  ipcMain.handle(
    "live-assistant:save-setup",
    async (_event, payload: unknown) => {
      const input = SaveInterviewSetupInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.saveSetup(input));
    },
  );

  ipcMain.handle("live-assistant:run-rehearsal", async () => {
    const service = await getLiveAssistantService();
    return withSyncedOverlays(() => service.runRehearsal());
  });

  ipcMain.handle("live-assistant:start-session", async () => {
    const service = await getLiveAssistantService();
    return withSyncedOverlays(() => service.startSession());
  });

  ipcMain.handle("live-assistant:begin-reconfiguration", async () => {
    const service = await getLiveAssistantService();
    return withSyncedOverlays(() => service.beginSessionReconfiguration());
  });

  ipcMain.handle("live-assistant:finish-reconfiguration", async () => {
    const service = await getLiveAssistantService();
    return withSyncedOverlays(() => service.finishSessionReconfiguration());
  });

  ipcMain.handle(
    "live-assistant:perform-action",
    async (_event, payload: unknown) => {
      const input = InterviewSessionActionInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.performAction(input));
    },
  );

  ipcMain.handle(
    "live-assistant:move-overlay-window",
    (_event, payload: unknown) => {
      const input = InterviewOverlayMoveInputSchema.parse(payload);
      return moveInterviewOverlayWindow(input);
    },
  );

  ipcMain.handle(
    "live-assistant:update-overlay-preference",
    async (_event, payload: unknown) => {
      const input = UpdateInterviewOverlayPreferenceInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.updateOverlayPreference(input));
    },
  );

  ipcMain.handle(
    "live-assistant:delete-session",
    async (_event, payload: unknown) => {
      const input = InterviewSessionIdInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.deleteSession(input.sessionId));
    },
  );

  ipcMain.handle(
    "live-assistant:save-cue-as-prep-artifact",
    async (_event, payload: unknown) => {
      const input = InterviewPrepArtifactFromCueInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.saveCueAsPrepArtifact(input));
    },
  );

  ipcMain.handle(
    "live-assistant:add-transcript-annotation",
    async (_event, payload: unknown) => {
      const input = InterviewTranscriptAnnotationInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.addTranscriptAnnotation(input));
    },
  );

  ipcMain.handle(
    "live-assistant:add-transcript-segment",
    async (_event, payload: unknown) => {
      const input = InterviewTranscriptSegmentInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.addTranscriptSegment(input));
    },
  );

  ipcMain.handle(
    "live-assistant:send-chat-message",
    async (_event, payload: unknown) => {
      const input = SendInterviewChatMessageInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      const turn = await service.sendChatMessage(input);
      syncInterviewOverlayWindows(await service.getWorkspace());
      return turn;
    },
  );

  ipcMain.handle(
    "live-assistant:transcribe-audio-chunk",
    async (_event, payload: unknown) => {
      const input = InterviewAudioTranscriptionInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return withSyncedOverlays(() => service.transcribeAudioChunk(input));
    },
  );
  ipcMain.handle("live-assistant:verify-overlay-protection", async () => {
    const protectedSurfaces = await verifyInterviewOverlayCaptureProtection();
    const service = await getLiveAssistantService();
    return withSyncedOverlays(() =>
      service.recordProtectedSurfaceVerification({ protectedSurfaces }),
    );
  });

  ipcMain.handle("live-assistant:reset-overlay-preferences", async () => {
    const service = await getLiveAssistantService();
    return withSyncedOverlays(() => service.resetOverlayPreferences());
  });

  ipcMain.handle("live-assistant:read-clipboard-text", () => ({
    text: clipboard.readText(),
  }));

  ipcMain.handle(
    "live-assistant:write-clipboard-text",
    async (_event, payload: unknown) => {
      const input = InterviewClipboardWriteInputSchema.parse(payload);
      await clipboard.writeText(input.text);
      return { written: true as const };
    },
  );

  ipcMain.handle("live-assistant:select-caption-file", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Select live caption or transcript file",
      properties: ["openFile"],
      filters: [
        {
          name: "Caption and transcript files",
          extensions: ["txt", "vtt", "srt", "json", "md"],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });

    const filePath = selection.filePaths[0];
    if (selection.canceled || !filePath) {
      return {
        selected: false,
        filePath: null,
        displayName: null,
        text: "",
        truncated: false,
      };
    }

    return readNativeCaptionFileText(filePath);
  });

  ipcMain.handle(
    "live-assistant:read-caption-file",
    async (_event, payload: unknown) => {
      const input = InterviewCaptionFileReadInputSchema.parse(payload);
      return readNativeCaptionFileText(input.filePath);
    },
  );

  ipcMain.handle(
    "live-assistant:export-session",
    async (_event, payload: unknown) => {
      const input = InterviewExportSessionInputSchema.parse(payload);
      const service = await getLiveAssistantService();
      return service.exportSession(input);
    },
  );

  ipcMain.handle(
    "live-assistant:record-job-finder-follow-up",
    async (_event, payload: unknown) => {
      const input = JobFinderInterviewFollowUpInputSchema.parse(payload);
      const jobFinderWorkspaceService = await getJobFinderWorkspaceService();
      return jobFinderWorkspaceService.recordLiveAssistantApplicationAction(
        input,
      );
    },
  );
}
