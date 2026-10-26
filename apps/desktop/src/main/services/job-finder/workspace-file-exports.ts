import { app } from "electron";
import type { JobFinderWorkspaceService } from "@nestor/job-finder";

import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { getApplicationStore } from "./application-store";
import { buildJobFinderDiagnosticExport } from "./build-diagnostic-export";
import { collectJobFinderPerformanceSnapshot } from "./collect-performance-snapshot";

/** The content is shared by the native Save dialog and the chat export. */
export async function buildDiagnosticsFileExport(
  service: JobFinderWorkspaceService,
) {
  const { performance, workspace } = await collectJobFinderPerformanceSnapshot({
    service,
    waitingFormMemory: () => getEmbeddedBrowser().reduceWaitingFormMemory(),
  });
  const content = buildJobFinderDiagnosticExport({
    workspace,
    applications: getApplicationStore().stateCounts(),
    performance,
    build: {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? "unknown",
      chromiumVersion: process.versions.chrome ?? "unknown",
      nodeVersion: process.versions.node,
      platform:
        process.platform === "win32" || process.platform === "darwin"
          ? process.platform
          : "linux",
      architecture:
        process.arch === "arm64" || process.arch === "ia32"
          ? process.arch
          : "x64",
    },
  });
  return {
    fileName: "nestor-job-finder-diagnostics.json",
    content: `${JSON.stringify(content, null, 2)}
`,
    exportedCount: 0,
  };
}
