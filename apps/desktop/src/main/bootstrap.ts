import { app } from "electron";
import { hasSingleInstanceLock } from "./setup/desktop-startup";
import { prepareWorkspaceStartupContextReads } from "./setup/workspace-database-startup";

// Start database preparation before parsing the main application graph.
if (hasSingleInstanceLock) {
  void prepareWorkspaceStartupContextReads().catch(() => undefined);
  void import("./index").catch((error: unknown) => {
    console.error("Could not start the desktop application.", error);
    app.quit();
  });
} else {
  app.quit();
}
