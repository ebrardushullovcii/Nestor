import type { ApplicationRecord } from "@nestor/contracts";
import { ApplicationCrmSettingsSchema } from "@nestor/contracts";
import {
  createInMemoryJobFinderRepository,
  type JobFinderRepository,
} from "@nestor/db";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createJobFinderWorkspaceService } from "./index";
import { runApplicationNoResponseAutomation } from "./internal/application-crm";
import { createSeed } from "./workspace-service.test-fixtures";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
  createResearchAdapter,
} from "./workspace-service.test-runtimes";

vi.mock("./internal/application-crm", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runApplicationNoResponseAutomation: vi.fn(
      (): Promise<readonly ApplicationRecord[]> => Promise.resolve([]),
    ),
  };
});

const noResponseAutomationMock = vi.mocked(runApplicationNoResponseAutomation);

beforeEach(() => {
  noResponseAutomationMock.mockClear();
  noResponseAutomationMock.mockImplementation(() =>
    Promise.resolve<readonly ApplicationRecord[]>([]),
  );
});

function createTestHarness(repository: JobFinderRepository) {
  const workspaceService = createJobFinderWorkspaceService({
    repository,
    browserRuntime: createBrowserRuntime(),
    aiClient: createAiClient(),
    documentManager: createDocumentManager(),
    exportFileVerifier: { exists: () => Promise.resolve(true) },
    researchAdapter: createResearchAdapter(),
  });
  return workspaceService;
}

function seedWithApprovedDraft(): ReturnType<typeof createSeed> {
  const seed = createSeed();
  seed.resumeDrafts = [
    {
      id: "resume_draft_job_ready",
      jobId: "job_ready",
      status: "approved",
      templateId: "classic_ats",
      identity: null,
      sections: [
        {
          id: "section_summary",
          kind: "summary",
          label: "Summary",
          text: "Approved summary.",
          bullets: [],
          entries: [],
          origin: "user_edited",
          locked: false,
          included: true,
          sortOrder: 0,
          entryOrderMode: "chronology",
          profileRecordId: null,
          sourceRefs: [],
          updatedAt: "2026-04-18T12:00:00.000Z",
        },
      ],
      targetPageCount: 2,
      generationMethod: "manual",
      workHistoryReviewAcknowledgments: [],
      claimConfirmations: [],
      issueApprovals: [],
      approvedAt: "2026-04-18T12:00:00.000Z",
      approvedExportId: "resume_export_legacy",
      staleReason: null,
      createdAt: "2026-04-18T12:00:00.000Z",
      updatedAt: "2026-04-18T12:00:00.000Z",
    },
  ];
  seed.resumeExportArtifacts = [
    {
      id: "resume_export_legacy",
      draftId: "resume_draft_job_ready",
      jobId: "job_ready",
      format: "pdf",
      filePath: "/tmp/legacy-classic-ats.pdf",
      pageCount: 1,
      templateId: "classic_ats",
      exportedAt: "2026-04-18T12:00:00.000Z",
      isApproved: true,
    },
  ];
  return seed;
}

describe("scoped settings updates against transaction-current state", () => {
  test("tracker CRM commit merges over an application-defaults change landing mid-flight", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    let injectedDefaults = false;
    const repository: JobFinderRepository = {
      ...base,
      commitSettingsUpdate: async (update) => {
        if (!injectedDefaults) {
          injectedDefaults = true;
          await base.commitSettingsUpdate((current) => ({
            ...current,
            fontPreset: "space_grotesk_display",
            appearanceTheme: "dark",
          }));
        }
        return base.commitSettingsUpdate(update);
      },
    };
    const service = createTestHarness(repository);

    const snapshot = await service.updateTrackerCrm(
      ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 5 },
      }),
    );

    const settings = await base.getSettings();
    expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(5);
    expect(settings.fontPreset).toBe("space_grotesk_display");
    expect(settings.appearanceTheme).toBe("dark");
    expect(
      snapshot.settings.applicationCrm?.noResponseAutomation.afterDays,
    ).toBe(5);
  });

  test("application-defaults commit merges over a tracker change landing mid-flight", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    let injectedTracker = false;
    const repository: JobFinderRepository = {
      ...base,
      commitSettingsUpdate: async (update) => {
        if (!injectedTracker) {
          injectedTracker = true;
          await base.commitSettingsUpdate((current) => ({
            ...current,
            applicationCrm: ApplicationCrmSettingsSchema.parse({
              noResponseAutomation: { enabled: true, afterDays: 21 },
            }),
          }));
        }
        return base.commitSettingsUpdate(update);
      },
    };
    const service = createTestHarness(repository);

    const snapshot = await service.updateApplicationDefaults({
      fontPreset: "space_grotesk_display",
    });

    const settings = await base.getSettings();
    expect(settings.fontPreset).toBe("space_grotesk_display");
    expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(21);
    expect(snapshot.settings.fontPreset).toBe("space_grotesk_display");
  });

  test("workspace behavior keeps theme and CRM untouched", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    await base.commitSettingsUpdate((current) => ({
      ...current,
      appearanceTheme: "dark",
      applicationCrm: ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 30 },
      }),
    }));
    const service = createTestHarness(base);

    const snapshot = await service.updateWorkspaceBehavior({
      keepSessionAlive: true,
    });

    const settings = await base.getSettings();
    expect(settings.keepSessionAlive).toBe(true);
    expect(settings.appearanceTheme).toBe("dark");
    expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(30);
    expect(snapshot.settings.keepSessionAlive).toBe(true);
  });

  test("AI behavior saves settings, the letter preference, and both halves of the resume approach", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    await base.commitSettingsUpdate((current) => ({
      ...current,
      appearanceTheme: "dark",
    }));
    const service = createTestHarness(base);

    const snapshot = await service.updateAiBehavior({
      aiBehavior: {
        profileAssistant: { initiative: "proactive", replyStyle: "brief" },
        jobSearch: {
          selectivity: "best_matches",
          remoteCountsAsAnyLocation: false,
        },
        applying: {
          coverLetterPolicy: "never",
          writtenAnswerLength: "full",
          preApprovedDeclarations: [],
        },
      },
      coverLetter: {
        tone: "warm",
        length: "short",
        language: "German",
        sample: null,
      },
      resumeApproach: "aggressive",
    });

    const settings = await base.getSettings();
    const searchPreferences = await base.getSearchPreferences();
    expect(settings.aiBehavior?.jobSearch.selectivity).toBe("best_matches");
    expect(settings.aiBehavior?.applying.coverLetterPolicy).toBe("never");
    expect(settings.coverLetter?.tone).toBe("warm");
    expect(settings.resumeApplicationMode).toBe("tailored_per_job");
    expect(settings.appearanceTheme).toBe("dark");
    expect(searchPreferences.tailoringMode).toBe("aggressive");
    // Best matches only also turns on the strict collection filter.
    expect(searchPreferences.discovery.collectOnlyHardCriteriaMatches).toBe(
      true,
    );
    expect(snapshot.searchPreferences.tailoringMode).toBe("aggressive");

    // Keeping the original file is the other half of the same choice.
    const original = await service.updateAiBehavior({
      resumeApproach: "original_resume",
    });
    expect(original.settings.resumeApplicationMode).toBe("original_resume");
    expect(original.searchPreferences.tailoringMode).toBe("aggressive");
  });

  test("a stale Profile save cannot overwrite the AI behavior owned search fields", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const service = createTestHarness(base);
    const staleProfileDraft = await base.getSearchPreferences();

    await service.updateAiBehavior({
      aiBehavior: {
        profileAssistant: { initiative: "proactive", replyStyle: "brief" },
        jobSearch: {
          selectivity: "wide_net",
          remoteCountsAsAnyLocation: true,
        },
        applying: {
          coverLetterPolicy: "when_required",
          writtenAnswerLength: "short",
          preApprovedDeclarations: [],
        },
      },
      resumeApproach: "conservative",
    });

    await service.saveProfileAndSearchPreferences(await base.getProfile(), {
      ...staleProfileDraft,
      locations: ["Vienna, Austria"],
      tailoringMode: "aggressive",
      discovery: {
        ...staleProfileDraft.discovery,
        collectOnlyHardCriteriaMatches: true,
      },
    });

    const persisted = await base.getSearchPreferences();
    expect(persisted.locations).toEqual(["Vienna, Austria"]);
    expect(persisted.tailoringMode).toBe("conservative");
    expect(persisted.discovery.collectOnlyHardCriteriaMatches).toBe(false);
  });

  test("application defaults keep theme and CRM untouched", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    await base.commitSettingsUpdate((current) => ({
      ...current,
      appearanceTheme: "light",
      applicationCrm: ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 30 },
      }),
    }));
    const service = createTestHarness(base);

    await service.updateApplicationDefaults({
      resumeTemplateId: "compact_exec",
    });

    const settings = await base.getSettings();
    expect(settings.resumeTemplateId).toBe("compact_exec");
    expect(settings.appearanceTheme).toBe("light");
    expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(30);
  });
});

describe("tracker CRM automation side effects", () => {
  test("runs due-based automation once after the settings commit succeeds", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const sequence: string[] = [];
    const repository: JobFinderRepository = {
      ...base,
      commitSettingsUpdate: async (update) => {
        sequence.push("commit");
        return base.commitSettingsUpdate(update);
      },
    };
    const service = createTestHarness(repository);
    noResponseAutomationMock.mockImplementation(() => {
      sequence.push("automate");
      return Promise.resolve<readonly ApplicationRecord[]>([]);
    });

    await service.updateTrackerCrm(
      ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 7 },
      }),
    );

    expect(sequence).toEqual(["commit", "automate"]);
    expect(noResponseAutomationMock).toHaveBeenCalledTimes(1);
    expect(noResponseAutomationMock.mock.calls[0]?.[0].settings).toEqual(
      ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 7 },
      }),
    );
  });

  test("unrelated scoped saves never force automation past the due throttle", async () => {
    const service = createTestHarness(
      createInMemoryJobFinderRepository(createSeed()),
    );

    await service.getWorkspaceSnapshot();
    expect(noResponseAutomationMock).toHaveBeenCalledTimes(1);

    await service.updateApplicationDefaults({
      fontPreset: "space_grotesk_display",
    });
    await service.updateWorkspaceBehavior({ discoveryOnly: true });
    await service.updateAppearanceTheme("dark");

    expect(noResponseAutomationMock).toHaveBeenCalledTimes(1);
  });

  test("automation failure is classified separately and never rolls back committed settings", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const sequence: string[] = [];
    const repository: JobFinderRepository = {
      ...base,
      commitSettingsUpdate: async (update) => {
        sequence.push("commit");
        return base.commitSettingsUpdate(update);
      },
    };
    const service = createTestHarness(repository);
    noResponseAutomationMock.mockImplementation(() => {
      sequence.push("automate-failed");
      return Promise.reject(new Error("crm down"));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const snapshot = await service.updateTrackerCrm(
        ApplicationCrmSettingsSchema.parse({
          noResponseAutomation: { enabled: true, afterDays: 9 },
        }),
      );

      expect(sequence).toEqual(["commit", "automate-failed"]);
      expect(
        snapshot.settings.applicationCrm?.noResponseAutomation.afterDays,
      ).toBe(9);
      expect(
        (await base.getSettings()).applicationCrm?.noResponseAutomation
          .afterDays,
      ).toBe(9);
      expect(warnSpy).toHaveBeenCalledWith(
        "[JobFinderWorkspace] No-response automation skipped.",
        expect.any(Error),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("approval invalidation and per-job mode pinning", () => {
  test("resume-affecting defaults stale approved drafts before committing", async () => {
    const base = createInMemoryJobFinderRepository(seedWithApprovedDraft());
    const service = createTestHarness(base);

    await service.updateApplicationDefaults({
      fontPreset: "space_grotesk_display",
    });

    const draft = (await base.listResumeDrafts()).find(
      (candidate) => candidate.id === "resume_draft_job_ready",
    );
    expect(draft?.status).toBe("stale");
    expect(draft?.staleReason).toMatch(
      /resume settings changed after approval/i,
    );
    const exportsForJob = (await base.listResumeExportArtifacts()).filter(
      (artifact) => artifact.jobId === "job_ready",
    );
    expect(exportsForJob.some((artifact) => artifact.isApproved)).toBe(false);
  });

  test("non-resume-affecting defaults keep approvals intact", async () => {
    const base = createInMemoryJobFinderRepository(seedWithApprovedDraft());
    const service = createTestHarness(base);

    await service.updateApplicationDefaults({
      resumeTemplateId: "compact_exec",
    });

    const draft = (await base.listResumeDrafts()).find(
      (candidate) => candidate.id === "resume_draft_job_ready",
    );
    expect(draft?.status).toBe("approved");
    expect(draft?.approvedExportId).toBe("resume_export_legacy");
  });

  test("default mode changes pin the previous default onto active null-mode jobs only", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    await base.commitSavedJobDelta({
      update: (job) =>
        job.id === "job_generating" ? { ...job, status: "archived" } : job,
    });
    const service = createTestHarness(base);

    const snapshot = await service.updateApplicationDefaults({
      resumeApplicationMode: "original_resume",
    });

    const jobs = await base.listSavedJobs();
    expect(
      jobs.find((job) => job.id === "job_ready")?.resumeApplicationMode,
    ).toBe("tailored_per_job");
    expect(
      jobs.find((job) => job.id === "job_generating")?.resumeApplicationMode,
    ).toBeNull();
    expect(snapshot.settings.resumeApplicationMode).toBe("original_resume");
  });
});

describe("fault ordering for scoped saves", () => {
  test("failed approval invalidation leaves settings and saved jobs untouched", async () => {
    const base = createInMemoryJobFinderRepository(seedWithApprovedDraft());
    const repository: JobFinderRepository = {
      ...base,
      clearResumeApproval: () =>
        Promise.reject(new Error("invalidation failed")),
      staleResumeDrafts: () => Promise.reject(new Error("invalidation failed")),
    };
    const service = createTestHarness(repository);

    await expect(
      service.updateApplicationDefaults({
        fontPreset: "space_grotesk_display",
      }),
    ).rejects.toThrow("invalidation failed");

    const settings = await base.getSettings();
    expect(settings.fontPreset).toBe("inter_requisite");
    const draft = (await base.listResumeDrafts()).find(
      (candidate) => candidate.id === "resume_draft_job_ready",
    );
    expect(draft?.status).toBe("approved");
  });

  test("failed settings commit persists nothing", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const repository: JobFinderRepository = {
      ...base,
      commitSettingsUpdate: () => Promise.reject(new Error("commit failed")),
    };
    const service = createTestHarness(repository);

    await expect(
      service.updateWorkspaceBehavior({ keepSessionAlive: true }),
    ).rejects.toThrow("commit failed");
    expect(await base.getSettings()).toEqual(createSeed().settings);
  });

  test("failed paired legacy commit rolls back settings and job pinning together", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const repository: JobFinderRepository = {
      ...base,
      commitSavedJobDelta: async (input) => {
        if (input.updateSettings === undefined) {
          return base.commitSavedJobDelta(input);
        }
        return base.commitSavedJobDelta({
          ...input,
          updateSettings: () => {
            throw new Error("paired commit failed");
          },
        });
      },
    };
    const service = createTestHarness(repository);
    const snapshotBefore = await service.getWorkspaceSnapshot();

    await expect(
      service.saveSettings({
        ...snapshotBefore.settings,
        resumeApplicationMode: "original_resume",
      }),
    ).rejects.toThrow("paired commit failed");

    const settings = await base.getSettings();
    expect(settings.resumeApplicationMode ?? "tailored_per_job").toBe(
      "tailored_per_job",
    );
    const jobs = await base.listSavedJobs();
    expect(
      jobs.find((job) => job.id === "job_ready")?.resumeApplicationMode,
    ).toBeNull();
  });
});

describe("legacy saveSettings during desktop migration", () => {
  test("commits atomically through transaction-current state with paired mode capture", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const service = createTestHarness(base);
    const snapshotBefore = await service.getWorkspaceSnapshot();

    const snapshot = await service.saveSettings({
      ...snapshotBefore.settings,
      resumeApplicationMode: "original_resume",
      keepSessionAlive: true,
    });

    const settings = await base.getSettings();
    expect(settings.keepSessionAlive).toBe(true);
    expect(settings.resumeApplicationMode).toBe("original_resume");
    const jobs = await base.listSavedJobs();
    expect(
      jobs.find((job) => job.id === "job_ready")?.resumeApplicationMode,
    ).toBe("tailored_per_job");
    expect(snapshot.settings.resumeApplicationMode).toBe("original_resume");
  });

  test("scoped commits after a legacy save merge onto its result instead of reverting it", async () => {
    const base = createInMemoryJobFinderRepository(createSeed());
    const service = createTestHarness(base);
    const snapshotBefore = await service.getWorkspaceSnapshot();

    await service.saveSettings({
      ...snapshotBefore.settings,
      keepSessionAlive: true,
      discoveryOnly: true,
    });
    await service.updateTrackerCrm(
      ApplicationCrmSettingsSchema.parse({
        noResponseAutomation: { enabled: true, afterDays: 12 },
      }),
    );

    const settings = await base.getSettings();
    expect(settings.keepSessionAlive).toBe(true);
    expect(settings.discoveryOnly).toBe(true);
    expect(settings.applicationCrm?.noResponseAutomation.afterDays).toBe(12);
  });
});

test("pay choice saves through the real workspace service without sending permission or answer approval", async () => {
  const repository = createInMemoryJobFinderRepository(createSeed());
  const service = createTestHarness(repository);
  expect((await service.getWorkspaceSnapshot()).settings.salaryDisclosure).toBe(
    "pause_for_user",
  );
  for (const applicationAutomationMode of [
    "autonomous_submit",
    "confirm_before_submit",
    "prepare_only",
  ] as const) {
    const snapshot = await service.updateApplicationDefaults({
      salaryDisclosure: "answer_from_profile",
      applicationAutomationMode,
    });
    expect(snapshot.settings.salaryDisclosure).toBe("answer_from_profile");
    expect((await repository.getSettings()).salaryDisclosure).toBe(
      "answer_from_profile",
    );
    expect(await repository.listApplicationAuthorityEnvelopes({})).toEqual([]);
  }
  await service.updateApplicationDefaults({
    salaryDisclosure: "pause_for_user",
  });
  expect((await service.getWorkspaceSnapshot()).settings.salaryDisclosure).toBe(
    "pause_for_user",
  );
});
