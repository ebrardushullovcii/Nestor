import { createSourceDebugServiceHarness } from "./source-debug.test-support";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import { describe, expect, test } from "vitest";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createSeed,
  createSourceInstructionArtifact,
  createStrongSourceDebugFindingsByPhase,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("verify source instructions replays the chosen artifact without overwriting it mid-run", async () => {
    const seed = createSeed();
    seed.searchPreferences.discovery.targets[0] = {
      ...seed.searchPreferences.discovery.targets[0]!,
      instructionStatus: "validated",
      validatedInstructionId: "instruction_existing_validated",
      draftInstructionId: null,
      lastVerifiedAt: "2026-03-20T10:05:00.000Z",
      staleReason: null,
    };
    seed.sourceInstructionArtifacts = [
      createSourceInstructionArtifact({
        id: "instruction_existing_validated",
        targetId: "1",
        status: "validated",
        createdAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:05:00.000Z",
        acceptedAt: "2026-03-20T10:05:00.000Z",
        basedOnRunId: "existing_run",
        basedOnAttemptIds: ["existing_attempt"],
        notes: "Existing validated instructions",
        navigationGuidance: [
          "Use the existing validated collection route first.",
        ],
        searchGuidance: [
          "Use the existing validated keyword search box to change the result set.",
        ],
        detailGuidance: [
          "Use same-host detail pages as the canonical source of job data.",
        ],
        applyGuidance: [
          "Use the on-site apply entry when the detail page exposes it.",
        ],
        warnings: ["Keep this source in draft if replay fails later."],
        versionInfo: {
          promptProfileVersion: "source-debug-v1",
          toolsetVersion: "browser-tools-v1",
          adapterVersion: "target-site-adapter-v1",
          appSchemaVersion: "job-finder-source-debug-v1",
        },
        verification: {
          id: "existing_verification",
          replayRunId: "existing_replay_run",
          verifiedAt: "2026-03-20T10:05:00.000Z",
          outcome: "passed",
          proofSummary: "Existing replay passed.",
          reason: null,
          versionInfo: {
            promptProfileVersion: "source-debug-v1",
            toolsetVersion: "browser-tools-v1",
            adapterVersion: "target-site-adapter-v1",
            appSchemaVersion: "job-finder-source-debug-v1",
          },
        },
      }),
    ];

    const replayInstructionsByLabel = new Map<string, readonly string[]>();
    const baseRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_verify_case",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_verify_case",
          title: "Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          postedAtText: null,
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Verify artifact coverage.",
          description: "Verify artifact coverage.",
          keySkills: ["React"],
          responsibilities: ["Verify artifact coverage."],
          minimumQualifications: [],
          preferredQualifications: [],
          seniority: null,
          employmentType: null,
          department: null,
          team: null,
          employerWebsiteUrl: null,
          employerDomain: null,
          benefits: [],
        },
      ],
      {
        debugFindingsByPhase: createStrongSourceDebugFindingsByPhase(),
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery(source, options) {
        replayInstructionsByLabel.set(options.siteLabel, [
          ...(options.siteInstructions ?? []),
        ]);
        return baseRuntime.runAgentDiscovery!(source, options);
      },
    };
    const { repository, workspaceService, jobSites } =
      createSourceDebugServiceHarness({
        seed: {
          ...seed,
          savedJobs: [],
          tailoredAssets: [],
        },
        browserRuntime,
        aiClient: createAgentAiClient(),
      });

    await workspaceService.verifySourceInstructions(
      "1",
      "instruction_existing_validated",
    );
    const artifacts = await repository.listSourceInstructionArtifacts();
    const originalArtifact = artifacts.find(
      (artifact) => artifact.id === "instruction_existing_validated",
    );
    const successorArtifact = artifacts.find(
      (artifact) =>
        artifact.id !== "instruction_existing_validated" &&
        artifact.targetId === "1",
    );

    expect(
      replayInstructionsByLabel.get("Primary target Replay Verification"),
    ).toEqual(
      expect.arrayContaining([
        "[Navigation] Use the existing validated collection route first.",
        "[Search] Use the existing validated keyword search box to change the result set.",
        "[Detail] Use same-host detail pages as the canonical source of job data.",
        "[Apply] Use the on-site apply entry when the detail page exposes it.",
      ]),
    );
    expect(
      replayInstructionsByLabel
        .get("Primary target Replay Verification")
        ?.join("\n"),
    ).not.toContain("Keep this source in draft if replay fails later.");
    expect(originalArtifact?.status).toBe("validated");
    expect(originalArtifact?.navigationGuidance).toEqual([
      "Use the existing validated collection route first.",
    ]);
    expect(successorArtifact?.status).toBe("validated");
    expect(successorArtifact?.verification?.outcome).toBe("passed");
    expect(jobSites.get(1)?.validatedInstructionId).toBe(
      successorArtifact?.id ?? null,
    );
  });
});
