import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createFileJobFinderRepository } from "./index";
import { createSeed } from "./test-fixtures";

type FileRepository = Awaited<ReturnType<typeof createFileJobFinderRepository>>;

describe("createFileJobFinderRepository legacy restoration", () => {
  test("falls back safely when legacy JSON contains stale saved job records", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-legacy-"),
    );
    const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
    const legacyPath = path.join(tempDirectory, "job-finder-state.json");
    let repository: FileRepository | null = null;

    try {
      await writeFile(
        legacyPath,
        JSON.stringify({
          ...createSeed(),
          savedJobs: [
            {
              id: "legacy_job_1",
              source: "target_site",
              title: "Legacy Role",
              company: "Old Co",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "easy_apply",
              postedAt: "2026-03-20T10:00:00.000Z",
              salaryText: "$180k",
              summary: "Legacy data without new fields.",
              keySkills: [],
            },
          ],
        }),
      );

      repository = await createFileJobFinderRepository({
        filePath,
        seed: createSeed(),
      });
      const savedJobs = await repository.listSavedJobs();

      expect(savedJobs).toEqual([]);
    } finally {
      if (repository) {
        await repository.close();
      }
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("migrates legacy string workMode values in saved jobs and experiences", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-work-mode-"),
    );
    const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
    const legacyPath = path.join(tempDirectory, "job-finder-state.json");
    let repository: FileRepository | null = null;
    const seed = createSeed();

    try {
      await writeFile(
        legacyPath,
        JSON.stringify({
          ...seed,
          profile: {
            ...seed.profile,
            experiences: [
              {
                id: "experience_1",
                companyName: "Signal Systems",
                companyUrl: null,
                title: "Senior systems designer",
                employmentType: "Full-time",
                location: "London, UK",
                workMode: "hybrid",
                startDate: "2020-01",
                endDate: null,
                isCurrent: true,
                isDraft: false,
                summary: "Builds resilient workflows.",
                achievements: [],
                skills: [],
                domainTags: [],
                peopleManagementScope: null,
                ownershipScope: null,
              },
            ],
          },
          savedJobs: [
            {
              id: "job_legacy",
              source: "target_site",
              sourceJobId: "target_job_legacy",
              discoveryMethod: "catalog_seed",
              canonicalUrl: "https://jobs.example.com/roles/target_job_legacy",
              title: "Lead Designer",
              company: "Signal Systems",
              location: "Remote",
              workMode: "remote",
              applyPath: "easy_apply",
              easyApplyEligible: true,
              postedAt: "2026-03-20T10:00:00.000Z",
              postedAtText: null,
              discoveredAt: "2026-03-20T10:01:00.000Z",
              salaryText: "$180k",
              summary: "Lead product design.",
              description: "Lead product design for operational software.",
              keySkills: ["Figma"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
              status: "ready_for_review",
              matchAssessment: {
                score: 94,
                reasons: ["Strong overlap"],
                gaps: [],
              },
              provenance: [],
            },
          ],
        }),
      );

      repository = await createFileJobFinderRepository({
        filePath,
        seed,
      });
      const [profile, savedJobs] = await Promise.all([
        repository.getProfile(),
        repository.listSavedJobs(),
      ]);

      expect(profile.experiences[0]?.workMode).toEqual(["hybrid"]);
      expect(savedJobs[0]?.workMode).toEqual(["remote"]);
    } finally {
      if (repository) {
        await repository.close();
      }
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("migrates legacy source and adapter identifiers in restored JSON state", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-source-kinds-"),
    );
    const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
    const legacyPath = path.join(tempDirectory, "job-finder-state.json");
    let repository: FileRepository | null = null;
    const seed = createSeed();
    const legacyTarget = seed.searchPreferences.discovery?.targets?.[0];

    if (!legacyTarget) {
      throw new Error(
        "Expected a seeded discovery target for legacy-restoration tests.",
      );
    }

    try {
      await writeFile(
        legacyPath,
        JSON.stringify({
          ...seed,
          searchPreferences: {
            ...seed.searchPreferences,
            discovery: {
              ...seed.searchPreferences.discovery,
              targets: [
                {
                  ...legacyTarget,
                  adapterKind: "linkedin",
                },
              ],
            },
          },
          savedJobs: [
            {
              id: "job_legacy_source",
              source: "generic_site",
              sourceJobId: "legacy_source_job",
              discoveryMethod: "catalog_seed",
              canonicalUrl: "https://jobs.example.com/roles/legacy_source_job",
              title: "Legacy Source Role",
              company: "Signal Systems",
              location: "Remote",
              workMode: ["remote"],
              applyPath: "easy_apply",
              easyApplyEligible: true,
              postedAt: "2026-03-20T10:00:00.000Z",
              postedAtText: null,
              discoveredAt: "2026-03-20T10:01:00.000Z",
              salaryText: "$180k",
              summary: "Legacy source mapping.",
              description: "Legacy source mapping.",
              keySkills: ["React"],
              responsibilities: [],
              minimumQualifications: [],
              preferredQualifications: [],
              seniority: null,
              employmentType: null,
              department: null,
              team: null,
              employerWebsiteUrl: null,
              employerDomain: null,
              benefits: [],
              status: "ready_for_review",
              matchAssessment: {
                score: 94,
                reasons: ["Strong overlap"],
                gaps: [],
              },
              provenance: [],
            },
          ],
          discovery: {
            ...createSeed().discovery,
            sessions: [
              {
                adapterKind: "linkedin",
                status: "ready",
                driver: "catalog_seed",
                label: "Legacy LinkedIn session",
                detail: "Restored from legacy state.",
                lastCheckedAt: "2026-03-20T10:02:00.000Z",
              },
            ],
          },
        }),
      );

      repository = await createFileJobFinderRepository({
        filePath,
        seed: createSeed(),
      });
      const [searchPreferences, savedJobs, discoveryState] = await Promise.all([
        repository.getSearchPreferences(),
        repository.listSavedJobs(),
        repository.getDiscoveryState(),
      ]);

      expect(searchPreferences.discovery.targets[0]?.adapterKind).toBe("auto");
      expect(savedJobs[0]?.source).toBe("target_site");
      expect(discoveryState.sessions[0]?.adapterKind).toBe("target_site");
    } finally {
      if (repository) {
        await repository.close();
      }
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  test("normalizes persisted terminal source-debug runs that still carry an active phase", async () => {
    const tempDirectory = await mkdtemp(
      path.join(os.tmpdir(), "nestor-db-persisted-source-debug-run-"),
    );
    const filePath = path.join(tempDirectory, "job-finder-state.sqlite");
    const legacyPath = path.join(tempDirectory, "job-finder-state.json");
    let secondRepository: FileRepository | null = null;

    try {
      const legacyRun = {
        id: "legacy_source_debug_run",
        targetId: "target_primary",
        state: "completed",
        startedAt: "2026-03-20T10:00:00.000Z",
        updatedAt: "2026-03-20T10:10:00.000Z",
        completedAt: "2026-03-20T10:10:00.000Z",
        activePhase: "replay_verification",
        phases: [
          "access_auth_probe",
          "site_structure_mapping",
          "search_filter_probe",
          "job_detail_validation",
          "apply_path_validation",
          "replay_verification",
        ],
        targetLabel: "Primary target",
        targetUrl: "https://jobs.example.com/search",
        targetHostname: "jobs.example.com",
        manualPrerequisiteSummary: null,
        finalSummary: "Legacy finished run.",
        attemptIds: [],
        phaseSummaries: [],
        instructionArtifactId: null,
      };
      // A workspace saved before discovery moved into its own tables keeps
      // the whole discovery state in one blob; restoring it normalizes runs.
      await writeFile(
        legacyPath,
        JSON.stringify({
          ...createSeed(),
          discovery: {
            ...createSeed().discovery,
            activeSourceDebugRun: legacyRun,
            recentSourceDebugRuns: [legacyRun],
          },
        }),
      );

      secondRepository = await createFileJobFinderRepository({
        filePath,
        seed: createSeed(),
      });

      const discoveryState = await secondRepository.getDiscoveryState();

      expect(discoveryState.activeSourceDebugRun?.state).toBe("completed");
      expect(discoveryState.activeSourceDebugRun?.activePhase).toBeNull();
      expect(discoveryState.recentSourceDebugRuns[0]?.activePhase).toBeNull();
    } finally {
      if (secondRepository) {
        await secondRepository.close();
      }
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
