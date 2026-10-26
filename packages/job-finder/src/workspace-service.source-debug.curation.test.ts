import { createTestJobSites } from "./source-debug.test-support";
import { describe, expect, test } from "vitest";
import { createInMemoryJobFinderRepository } from "@nestor/db";
import { createJobFinderWorkspaceService } from "./index";
import {
  createAgentAiClient,
  createAgentBrowserRuntime,
  createDocumentManager,
  createSeed,
  createStrongSourceDebugFindingsByPhase,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("treats collection result-changing guidance as positive search proof instead of leaving search coverage in draft", async () => {
    const sourceSeedForSites: Parameters<
      typeof createInMemoryJobFinderRepository
    >[0] = {
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    };
    const repository = createInMemoryJobFinderRepository(sourceSeedForSites);
    const strongFindings = createStrongSourceDebugFindingsByPhase();
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_collection_positive",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_collection_positive",
          title: "Senior Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "easy_apply",
          easyApplyEligible: true,
          postedAt: "2026-03-20T09:00:00.000Z",
          postedAtText: null,
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Collection route search-proof coverage.",
          description: "Collection route search-proof coverage.",
          keySkills: ["React"],
          responsibilities: [],
        },
      ],
      {
        debugFindingsByPhase: {
          ...strongFindings,
          search_filter_probe: {
            summary:
              '"Show all top job picks for you" is the primary result-changing control on the jobs hub.',
            reliableControls: [
              '"Show all top job picks for you" is the primary result-changing control - it navigates to /jobs/collections/recommended/ with a different job set.',
              "Recommendation routes are the primary way to access different job collections.",
            ],
            trickyFilters: [
              "No visible search box or filter dropdowns on the main jobs hub /jobs/.",
            ],
            navigationTips: [],
            applyTips: [],
            warnings: [],
          },
        },
      },
    );
    const jobSites = createTestJobSites(
      sourceSeedForSites.searchPreferences.discovery.targets,
    );
    const workspaceService = createJobFinderWorkspaceService({
      jobSites,
      repository,
      browserRuntime,
      aiClient: createAgentAiClient(),
      documentManager: createDocumentManager(),
    });

    await workspaceService.runSourceDebug("1");
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(
      latestArtifact?.warnings.some((warning) =>
        /search and filter behavior is still unproven/i.test(warning),
      ),
    ).toBe(false);
    expect(
      latestArtifact?.warnings.some((warning) =>
        /search and filter coverage is still missing/i.test(warning),
      ),
    ).toBe(false);
  });

  test("treats stable jobs search routes with visible filter controls as positive search proof", async () => {
    const sourceSeedForSites: Parameters<
      typeof createInMemoryJobFinderRepository
    >[0] = {
      ...createSeed(),
      savedJobs: [],
      tailoredAssets: [],
      resumeDrafts: [],
      resumeDraftRevisions: [],
      resumeExportArtifacts: [],
      resumeResearchArtifacts: [],
      resumeValidationResults: [],
      resumeAssistantMessages: [],
    };
    const repository = createInMemoryJobFinderRepository(sourceSeedForSites);
    const strongFindings = createStrongSourceDebugFindingsByPhase();
    const browserRuntime = createAgentBrowserRuntime(
      [
        {
          source: "target_site",
          sourceJobId: "linkedin_source_debug_search_route_positive",
          discoveryMethod: "catalog_seed",
          canonicalUrl:
            "https://www.linkedin.com/jobs/view/linkedin_source_debug_search_route_positive",
          title: "Senior Frontend Engineer",
          company: "Signal Systems",
          location: "Remote",
          workMode: ["remote"],
          applyPath: "unknown",
          easyApplyEligible: false,
          postedAt: "2026-03-20T09:00:00.000Z",
          postedAtText: null,
          discoveredAt: "2026-03-20T10:04:00.000Z",
          salaryText: null,
          summary: "Search route search-proof coverage.",
          description: "Search route search-proof coverage.",
          keySkills: ["React"],
          responsibilities: [],
        },
      ],
      {
        debugFindingsByPhase: {
          ...strongFindings,
          search_filter_probe: {
            summary:
              "LinkedIn Jobs search endpoint /jobs/search/?keywords=...&location=... reliably returns job cards with filter controls.",
            reliableControls: [
              "/jobs/search/?keywords=...&location=... reliably returns job cards with filter controls.",
              "Filter buttons visible on search results: Show all filters, Experience level, Remote.",
            ],
            trickyFilters: [
              "Homepage /jobs/ shows recommendation cards but has no visible search/filter UI.",
            ],
            navigationTips: [],
            applyTips: [],
            warnings: [],
          },
        },
      },
    );
    const jobSites = createTestJobSites(
      sourceSeedForSites.searchPreferences.discovery.targets,
    );
    const workspaceService = createJobFinderWorkspaceService({
      jobSites,
      repository,
      browserRuntime,
      aiClient: createAgentAiClient(),
      documentManager: createDocumentManager(),
    });

    await workspaceService.runSourceDebug("1");
    const latestArtifact = (
      await repository.listSourceInstructionArtifacts()
    ).at(-1);

    expect(
      latestArtifact?.warnings.some((warning) =>
        /search and filter behavior is still unproven/i.test(warning),
      ),
    ).toBe(false);
    expect(
      latestArtifact?.warnings.some((warning) =>
        /search and filter coverage is still missing/i.test(warning),
      ),
    ).toBe(false);
  });
});
