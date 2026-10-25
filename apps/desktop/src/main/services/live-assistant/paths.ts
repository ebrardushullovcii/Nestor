import { app } from "electron";
import path from "node:path";

function getUserDataDirectory() {
  return process.env.NESTOR_USER_DATA_DIR ?? app.getPath("userData");
}

export function getLiveAssistantWorkspaceFilePath() {
  return path.join(getUserDataDirectory(), "live-assistant-workspace.json");
}

export function getLiveAssistantTemporaryScreenshotDirectory() {
  return path.join(
    getUserDataDirectory(),
    "live-assistant-screenshots",
    "temporary",
  );
}
