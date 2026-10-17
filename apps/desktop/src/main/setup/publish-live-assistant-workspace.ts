import type { InterviewWorkspaceView } from "@nestor/contracts";

interface LiveAssistantEventWindow {
  isDestroyed(): boolean;
  webContents: {
    isLoading(): boolean;
    getURL(): string;
    send(channel: string, workspace: InterviewWorkspaceView): void;
  };
}

export function publishLiveAssistantWorkspace(
  workspace: InterviewWorkspaceView,
  windows: readonly LiveAssistantEventWindow[],
) {
  for (const window of windows) {
    if (window.isDestroyed() || window.webContents.isLoading()) continue;
    const route = window.webContents.getURL().split("#")[1] ?? "";
    if (!/^\/live-assistant(?:[/?]|$)/u.test(route)) continue;
    window.webContents.send("live-assistant:workspace-changed", workspace);
  }
}
