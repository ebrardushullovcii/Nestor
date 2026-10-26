import { describe, expect, test } from "vitest";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

describe("createJobFinderWorkspaceService", () => {
  test("builds a snapshot with derived review queue ordering", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();

    const snapshot = await workspaceService.getWorkspaceSnapshot();

    expect(snapshot.discoveryJobs).toHaveLength(2);
    expect(snapshot.reviewQueue).toHaveLength(2);
    expect(snapshot.reviewQueue[0]?.jobId).toBe("job_ready");
    expect(snapshot.reviewQueue[1]?.assetStatus).toBe("generating");
    expect(snapshot.profileSetupState.status).toBe("completed");
  });

  test("derives fresh setup state for seeded first-run workspaces without placeholder facts", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          id: "candidate_fresh_start",
          firstName: null,
          lastName: null,
          fullName: null,
          headline: null,
          summary: null,
          currentLocation: null,
          email: null,
          phone: null,
          narrative: {
            professionalStory: null,
            nextChapterSummary: null,
            careerTransitionSummary: null,
            differentiators: [],
            motivationThemes: [],
          },
          proofBank: [],
          applicationIdentity: {
            preferredEmail: null,
            preferredPhone: null,
            preferredLinkIds: [],
          },
          targetRoles: [],
          experiences: [],
          projects: [],
          baseResume: {
            ...createSeed().profile.baseResume,
            textContent: null,
            extractionStatus: "needs_text",
            lastAnalyzedAt: null,
          },
        },
        searchPreferences: {
          ...createSeed().searchPreferences,
          targetRoles: [],
          locations: [],
          workModes: [],
        },
        profileSetupState: {
          status: "not_started",
          currentStep: "import",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.getWorkspaceSnapshot();

    // A first-run workspace persists no fake candidate facts.
    expect(snapshot.profile.firstName).toBeNull();
    expect(snapshot.profile.lastName).toBeNull();
    expect(snapshot.profile.fullName).toBeNull();
    expect(snapshot.profile.headline).toBeNull();
    expect(snapshot.profile.summary).toBeNull();
    expect(snapshot.profile.currentLocation).toBeNull();
    expect(snapshot.profileSetupState.status).toBe("not_started");
    expect(snapshot.profileSetupState.currentStep).toBe("import");
  });

  test("keeps legacy placeholder identity strings parseable but not ready", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          id: "candidate_legacy_seed",
          firstName: "New",
          lastName: "Candidate",
          fullName: "New Candidate",
          headline: "Import your resume to begin",
          summary:
            "Import a resume or paste resume text to build your profile, targeting, and tailored documents.",
          currentLocation: "Set your preferred location",
          email: null,
          phone: null,
        },
        profileSetupState: {
          status: "not_started",
          currentStep: "import",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.getWorkspaceSnapshot();

    // Legacy data still parses; the shared placeholder rule keeps it from
    // counting as a real core identity.
    expect(snapshot.profile.fullName).toBe("New Candidate");
    expect(snapshot.profileSetupState.status).not.toBe("completed");
  });

  test("completes setup without a work-mode preference", async () => {
    const baseSeed: ReturnType<typeof createSeed> = {
      ...createSeed(),
      searchPreferences: {
        ...createSeed().searchPreferences,
        workModes: [],
      },
      profileSetupState: {
        status: "not_started",
        currentStep: "import",
        completedAt: null,
        reviewItems: [],
        lastResumedAt: null,
      },
    };

    // A work mode is a hint on Job targets, not a gate: name, contact and a
    // job source are enough to finish.
    const blockedHarness = createWorkspaceServiceHarness({ seed: baseSeed });
    const blockedSnapshot =
      await blockedHarness.workspaceService.getWorkspaceSnapshot();
    expect(blockedSnapshot.profileSetupState.status).toBe("completed");

    // Adding the work mode changes nothing about completion.
    const readyHarness = createWorkspaceServiceHarness({
      seed: {
        ...baseSeed,
        searchPreferences: {
          ...baseSeed.searchPreferences,
          workModes: ["remote"],
        },
      },
    });
    const readySnapshot =
      await readyHarness.workspaceService.getWorkspaceSnapshot();
    expect(readySnapshot.profileSetupState.status).toBe("completed");
  });

  test("persists an explicit in-progress setup step while the profile remains incomplete", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          experiences: [],
          projects: [],
        },
        searchPreferences: {
          ...createSeed().searchPreferences,
          targetRoles: [],
          locations: [],
          workModes: [],
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "narrative",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        },
      },
    });

    const updatedSnapshot = await workspaceService.saveProfileSetupState({
      status: "in_progress",
      // A retired step id from an older workspace: the schema migrates it
      // onto the visible step that owns its content.
      currentStep: "answers",
      completedAt: null,
      reviewItems: [],
      lastResumedAt: "2026-04-11T12:00:00.000Z",
    });

    expect(updatedSnapshot.profileSetupState.status).toBe("in_progress");
    expect(updatedSnapshot.profileSetupState.currentStep).toBe("extras");
    expect(updatedSnapshot.profileSetupState.lastResumedAt).toBe(
      "2026-04-11T12:00:00.000Z",
    );
  });

  test("derives persistent setup review items from unresolved import candidates", async () => {
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...createSeed(),
        profile: {
          ...createSeed().profile,
          experiences: [],
          targetRoles: [],
          baseResume: {
            ...createSeed().profile.baseResume,
            // The stored resume belongs to the seeded candidate: this scenario
            // covers unresolved review items, not an identity replacement.
            textContent: [
              "Alex Vanguard",
              "Senior Product Designer",
              "Berlin, Germany",
              "alex@example.com",
              "+44 7700 900123",
            ].join("\n"),
            extractionStatus: "not_started",
            lastAnalyzedAt: null,
          },
        },
        searchPreferences: {
          ...createSeed().searchPreferences,
          targetRoles: [],
          jobFamilies: [],
          locations: [],
          workModes: [],
        },
        profileSetupState: {
          status: "in_progress",
          currentStep: "import",
          completedAt: null,
          reviewItems: [],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.analyzeProfileFromResume();

    expect(snapshot.profileSetupState.status).toBe("in_progress");
    expect(
      snapshot.profileSetupState.reviewItems.some(
        (item) => item.status === "pending",
      ),
    ).toBe(true);
    expect(
      snapshot.profileSetupState.reviewItems.map((item) => item.label),
    ).toEqual(expect.arrayContaining(["Headline", "Work history"]));
  });

  test("keeps setup completed when a later import only produces optional suggestions", async () => {
    const seed = createSeed();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        profileSetupState: {
          status: "completed",
          currentStep: "ready_check",
          completedAt: "2026-04-11T10:00:00.000Z",
          reviewItems: [],
          lastResumedAt: null,
        },
      },
    });

    const snapshot = await workspaceService.runResumeImport({
      baseResume: {
        ...seed.profile.baseResume,
        id: "resume_reopen_setup",
        fileName: "resume.txt",
        textContent: [
          "Jamie Rivers",
          "Senior Product Designer",
          "Berlin, Germany",
          "jamie@example.com",
        ].join("\n"),
      },
      documentBundle: {
        id: "bundle_reopen_setup",
        runId: "bundle_run_reopen_setup",
        sourceResumeId: "resume_reopen_setup",
        sourceFileKind: "plain_text",
        primaryParserKind: "plain_text",
        parserKinds: ["plain_text"],
        createdAt: "2026-04-11T10:10:00.000Z",
        warnings: [],
        languageHints: [],
        pages: [
          {
            pageNumber: 1,
            text: [
              "Jamie Rivers",
              "Senior Product Designer",
              "Berlin, Germany",
              "jamie@example.com",
            ].join("\n"),
            charCount: 68,
            parserKinds: ["plain_text"],
            usedOcr: false,
          },
        ],
        blocks: [
          {
            id: "block_1",
            pageNumber: 1,
            readingOrder: 0,
            text: "Jamie Rivers",
            kind: "heading",
            sectionHint: "identity",
            bbox: null,
            sourceParserKinds: ["plain_text"],
            sourceConfidence: 1,
          },
          {
            id: "block_2",
            pageNumber: 1,
            readingOrder: 1,
            text: "Senior Product Designer",
            kind: "paragraph",
            sectionHint: "summary",
            bbox: null,
            sourceParserKinds: ["plain_text"],
            sourceConfidence: 1,
          },
        ],
        fullText: [
          "Jamie Rivers",
          "Senior Product Designer",
          "Berlin, Germany",
          "jamie@example.com",
        ].join("\n"),
      },
    });

    // Recommended import suggestions never gate completion: the user keeps
    // their finished setup and reviews the suggestions later in Profile.
    expect(snapshot.profileSetupState.status).toBe("completed");
    // Finishing setup now parks on Job targets, the step that owns Finish.
    expect(snapshot.profileSetupState.currentStep).toBe("targeting");
    expect(
      snapshot.profileSetupState.reviewItems.some(
        (item) => item.status === "pending",
      ),
    ).toBe(true);
    expect(
      snapshot.profileSetupState.reviewItems.some(
        (item) => item.status === "pending" && item.severity === "critical",
      ),
    ).toBe(false);
  });
});
