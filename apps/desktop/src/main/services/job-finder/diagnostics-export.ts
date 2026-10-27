import { app } from "electron";
import { loadOriginalResumeBytes } from "@nestor/job-finder/applications";
import { createJobSitesStore, createResumeStore } from "@nestor/db/job-store";

import { getEmbeddedBrowser } from "../browser/embedded-browser";
import { getJobStore } from "../job-store";
import { getApplicationStore } from "./application-store";
import { buildJobFinderDiagnosticExport } from "./build-diagnostic-export";
import { startJobFinderRuntime } from "./runtime";

/** The content is shared by the native Save dialog and the chat export. */
export async function buildDiagnosticsFileExport() {
  const runtime = await startJobFinderRuntime();
  const store = getJobStore();
  const [setup, latestImport, siteChecks, session, waitingFormMemory] =
    await Promise.all([
      runtime.repository.getProfileSetupState(),
      runtime.repository.getLatestResumeImportRun(),
      runtime.repository.listSourceDebugRuns(),
      runtime.browserRuntime.getSessionState("target_site"),
      getEmbeddedBrowser()
        .reduceWaitingFormMemory()
        .catch(() => undefined),
    ]);
  const stages = store.stageCounts();
  const needsYou = getApplicationStore().needsYou.list({ limit: 1 }).counts;
  const originalResumeReady = await runtime.repository
    .getProfile()
    .then((profile) => loadOriginalResumeBytes(profile.baseResume))
    .then(
      () => true,
      () => false,
    );
  const content = buildJobFinderDiagnosticExport({
    facts: {
      profileSetupStatus: setup.status,
      browserStatus: session.status,
      configuredSources: createJobSitesStore(store).counts().all,
      visibleJobs: stages.found,
      shortlistedJobs: stages.shortlisted,
      applications: getApplicationStore().stateCounts(),
      unresolvedActions:
        needsYou.question + needsYou.sign_in + needsYou.captcha + needsYou.mfa,
      approvedResumes: createResumeStore(store).approvedJobIds().length,
      originalResumeReady,
      siteChecks: siteChecks.length,
      latestResumeImport: latestImport
        ? {
            durationMs: latestImport.timing?.totalMs ?? null,
            ready: latestImport.status === "review_ready",
          }
        : null,
      agentReady: runtime.aiClient.getStatus().ready,
      visionReady: runtime.visionProvider.getStatus().ready,
      ...(waitingFormMemory ? { waitingFormMemory } : {}),
    },
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
