import { expect, test, vi } from "vitest";
import { InterviewWorkspaceViewSchema } from "@nestor/contracts";
import { publishLiveAssistantWorkspace } from "./publish-live-assistant-workspace";

test("publishes live state only to loaded Live Assistant surfaces, including session end", () => {
  const window = (route: string, loading = false, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: {
      isLoading: () => loading,
      getURL: () => `file:///renderer/index.html#${route}`,
      send: vi.fn(),
    },
  });
  const windows = [
    window("/live-assistant"),
    window("/live-assistant/overlay/answer"),
    window("/live-assistant/overlay/transcript"),
    window("/job-finder"),
    window("/job-finder/browser"),
    window("/live-assistant", true),
    window("/live-assistant", false, true),
  ];
  const overlay = (surfaceKind: string) => ({
    surfaceKind,
    mode: "compact",
    visible: false,
    interactionMode: false,
    opacity: 0.9,
    protectionState: "unknown",
    statusLabel: "Ended",
  });
  const workspace = InterviewWorkspaceViewSchema.parse({
    module: "live-assistant",
    generatedAt: "2026-10-13T00:00:00.000Z",
    setup: {},
    answerOverlay: overlay("live_answer_overlay"),
    transcriptOverlay: overlay("live_transcript_overlay"),
  });
  publishLiveAssistantWorkspace(workspace, windows);
  windows.forEach((entry, index) => {
    if (index < 3)
      expect(entry.webContents.send).toHaveBeenCalledWith(
        "live-assistant:workspace-changed",
        workspace,
      );
    else expect(entry.webContents.send).not.toHaveBeenCalled();
  });
});
