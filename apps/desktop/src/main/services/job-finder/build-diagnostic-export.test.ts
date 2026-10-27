import { describe, expect, it } from "vitest";
import {
  buildJobFinderDiagnosticExport,
  type JobFinderDiagnosticFacts,
} from "./build-diagnostic-export";

const build = {
  appVersion: "0.1.0",
  electronVersion: "37.0.0",
  chromiumVersion: "138.0.0",
  nodeVersion: "22.0.0",
  platform: "win32" as const,
  architecture: "x64" as const,
};

const facts: JobFinderDiagnosticFacts = {
  profileSetupStatus: "completed",
  browserStatus: "ready",
  configuredSources: 3,
  visibleJobs: 12,
  shortlistedJobs: 2,
  applications: { ready: 1, submitted: 2 },
  unresolvedActions: 1,
  approvedResumes: 2,
  originalResumeReady: true,
  siteChecks: 1,
  latestResumeImport: { durationMs: 456, ready: true },
  agentReady: true,
  visionReady: false,
};

describe("buildJobFinderDiagnosticExport", () => {
  it("original readiness is independent of import review status", () => {
    expect(
      buildJobFinderDiagnosticExport({
        build,
        facts: {
          ...facts,
          latestResumeImport: { durationMs: 10, ready: false },
        },
      }).capabilities.originalResumeReady,
    ).toBe(true);
    expect(
      buildJobFinderDiagnosticExport({
        build,
        facts: { ...facts, originalResumeReady: false },
      }).capabilities.originalResumeReady,
    ).toBe(false);
  });
  it("exports counts and readiness with a truthful manifest", () => {
    const diagnostic = buildJobFinderDiagnosticExport({
      facts,
      build,
      generatedAt: "2026-10-26T12:00:00.000Z",
    });
    expect(diagnostic.state.counts).toEqual({
      configuredSources: 3,
      visibleJobs: 12,
      shortlistedJobs: 2,
      applications: 3,
      unresolvedActions: 1,
    });
    expect(diagnostic.timings.latestResumeImportDurationMs).toBe(456);
    expect(diagnostic.capabilities).toMatchObject({
      browserReady: true,
      originalResumeReady: true,
      tailoredResumeCount: 2,
      prepareOnlyApplicationCount: 1,
      finalSubmissionAuthorized: false,
      accountCreationAuthorized: false,
    });
    expect(diagnostic.redactionManifest).toMatchObject({
      policy: "strict_allowlist_v1",
      localOnly: true,
      transmitted: false,
    });
  });

  it("warns about each AI provider that is not ready", () => {
    expect(buildJobFinderDiagnosticExport({ facts, build }).warnings).toEqual([
      {
        category: "provider_availability",
        code: "vision_not_ready",
        status: "warning",
      },
    ]);
  });
});
