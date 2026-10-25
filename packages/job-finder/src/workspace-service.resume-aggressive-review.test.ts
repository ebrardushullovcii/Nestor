import { describe, expect, test } from "vitest";
import { completeTailoredResumeDraft } from "@nestor/ai-providers";
import {
  createAiClient,
  fakeResumeClaimCheck,
} from "./workspace-service.test-runtimes";
import {
  createDocumentManager,
  createWorkspaceServiceHarness,
  createSeed,
} from "./workspace-service.test-support";

describe("aggressive resume review routing", () => {
  test("an eight-skill profile generates reviewable stretch skills without country tokens", async () => {
    const seed = createSeed();
    const skills = [
      "React",
      "TypeScript",
      "JavaScript",
      "Node.js",
      "CSS",
      "HTML",
      "Git",
      "SQL",
    ];
    seed.profile = {
      ...seed.profile,
      skills,
      skillGroups: {
        coreSkills: skills,
        tools: [],
        languagesAndFrameworks: [],
        softSkills: [],
        highlightedSkills: [],
      },
      education: seed.profile.education.slice(0, 1),
    };
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? {
            ...job,
            resumeTailoringMode: "aggressive",
            location: "United States",
            keySkills: ["TypeScript"],
            minimumQualifications: [
              "Must be authorized to work in the United States.",
              "Experience with Terraform required.",
            ],
          }
        : job,
    );
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseAiClient,
        checkResumeClaims: fakeResumeClaimCheck({ Terraform: "stretch" }),
        createResumeDraft(input) {
          return Promise.resolve(
            completeTailoredResumeDraft(
              {
                coreSkills: [...skills, "United", "States", "Terraform"],
                languagePresentation: { language: "English", translations: [] },
              },
              input,
            ),
          );
        },
      },
    });
    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const generatedSkills = workspace.draft.sections
      .filter((section) => section.kind === "skills")
      .flatMap((section) => section.bullets);
    expect(
      generatedSkills.some((bullet) =>
        /^(?:United|States|United States)$/i.test(bullet.text),
      ),
    ).toBe(false);
    const stretch = generatedSkills.find(
      (bullet) => bullet.text === "Terraform",
    );
    expect(stretch).toMatchObject({
      origin: "ai_generated",
      included: true,
      locked: false,
    });
    expect(
      workspace.validation?.claimAssessments.find(
        (claim) => claim.bulletId === stretch?.id,
      ),
    ).toMatchObject({ status: "confirm_needed" });
    expect(workspace.draft.status).toBe("needs_review");
  });

  test.each([
    ["conservative", "aggressive"],
    ["balanced", "conservative"],
    ["aggressive", "balanced"],
  ] as const)(
    "generation sends the selected per-job %s level instead of the global %s level",
    async (jobLevel, globalLevel) => {
      const seed = createSeed();
      seed.searchPreferences = {
        ...seed.searchPreferences,
        tailoringMode: globalLevel,
      };
      seed.savedJobs = seed.savedJobs.map((job) =>
        job.id === "job_ready"
          ? { ...job, resumeTailoringMode: jobLevel }
          : job,
      );
      let capturedSearchPreference: string | null = null;
      const baseAiClient = createAiClient();
      const { workspaceService } = createWorkspaceServiceHarness({
        seed,
        aiClient: {
          ...baseAiClient,
          createResumeDraft(input) {
            capturedSearchPreference = input.searchPreferences.tailoringMode;
            return baseAiClient.createResumeDraft(input);
          },
        },
      });

      await workspaceService.generateResume("job_ready");
      const workspace = await workspaceService.getResumeWorkspace("job_ready");

      expect(capturedSearchPreference).toBe(jobLevel);
      expect(workspace.effectiveTailoringStrength).toBe(jobLevel);
    },
  );

  test("review uses the global aggressive default when no job level is selected", async () => {
    const seed = createSeed();
    seed.searchPreferences = {
      ...seed.searchPreferences,
      tailoringMode: "aggressive",
    };
    let capturedTailoringStrength: string | null | undefined;
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseAiClient,
        reviseResumeDraft(input) {
          capturedTailoringStrength = input.tailoringStrength ?? null;
          return Promise.resolve({
            content: "No edits.",
            patches: [],
          });
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    expect(workspace.effectiveTailoringStrength).toBe("aggressive");

    await workspaceService.sendResumeAssistantMessage(
      "job_ready",
      "Tighten the summary.",
    );
    expect(capturedTailoringStrength).toBe("aggressive");
  });

  test("a kept resume gets the checker's fixes for lines it rejected", async () => {
    const seed = createSeed();
    const invented =
      "Led a forty-person platform team through two acquisitions.";
    const fixedSummary = "Builds design systems and frontend platforms.";
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseAiClient,
        checkResumeClaims: fakeResumeClaimCheck(
          { [invented]: "unsupported", Terraform: "unsupported" },
          { [invented]: fixedSummary, Terraform: "" },
        ),
        createResumeDraft(input) {
          return Promise.resolve(
            completeTailoredResumeDraft(
              {
                languagePresentation: { language: "English", translations: [] },
                summary: invented,
                coreSkills: [...seed.profile.skills, "Terraform"],
              },
              input,
            ),
          );
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const sections = workspace.draft.sections;

    expect(sections.find((section) => section.kind === "summary")?.text).toBe(
      fixedSummary,
    );
    expect(
      sections
        .filter((section) => section.kind === "skills")
        .flatMap((section) => section.bullets)
        .find((bullet) => bullet.text === "Terraform"),
    ).toMatchObject({ included: false });
    expect(
      workspace.validation?.claimAssessments.filter(
        (claim) => claim.status === "unsupported",
      ),
    ).toEqual([]);
  });

  test("generation preview returns blocking model repairs separately from person confirmations", async () => {
    const seed = createSeed();
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? { ...job, resumeTailoringMode: "aggressive" }
        : job,
    );
    let requiredModelRepairCount = -1;
    let personConfirmationCount = -1;
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseAiClient,
        // The fact check finds the invented summary unbacked, so the writer
        // is asked to repair it.
        checkResumeClaims: fakeResumeClaimCheck({
          "Directed a fictional lunar migration for the target employer.":
            "unsupported",
        }),
        async createResumeDraft(input) {
          const draft = await baseAiClient.createResumeDraft(input);
          const preview = await input.renderPreview?.({
            draft: {
              ...draft,
              summary:
                "Directed a fictional lunar migration for the target employer.",
            },
            templateId:
              input.selectedTemplateId ?? input.settings.resumeTemplateId,
          });
          requiredModelRepairCount =
            preview?.requiredModelRepairs?.length ?? -1;
          personConfirmationCount = preview?.personConfirmationCount ?? -1;
          return draft;
        },
      },
    });

    await workspaceService.generateResume("job_ready");

    expect(requiredModelRepairCount).toBeGreaterThan(0);
    expect(personConfirmationCount).toBeGreaterThanOrEqual(0);
  });

  test("generation preview leaves a resume over the page target for the person", async () => {
    const baseDocumentManager = createDocumentManager();
    let requiredModelRepairs: readonly { category: string }[] | null = null;
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      documentManager: {
        ...baseDocumentManager,
        async renderResumeArtifact(input) {
          return {
            ...(await baseDocumentManager.renderResumeArtifact(input)),
            pageCount: 4,
          };
        },
      },
      aiClient: {
        ...baseAiClient,
        async createResumeDraft(input) {
          const draft = await baseAiClient.createResumeDraft(input);
          const preview = await input.renderPreview?.({
            draft,
            templateId:
              input.selectedTemplateId ?? input.settings.resumeTemplateId,
          });
          requiredModelRepairs = preview?.requiredModelRepairs ?? null;
          return draft;
        },
      },
    });

    await workspaceService.generateResume("job_ready");
    const workspace = await workspaceService.getResumeWorkspace("job_ready");

    expect(requiredModelRepairs).not.toBeNull();
    expect(
      requiredModelRepairs!.some(
        (repair) => repair.category === "page_overflow",
      ),
    ).toBe(false);
    expect(
      workspace.validation?.issues.some(
        (issue) => issue.category === "page_overflow",
      ),
    ).toBe(true);
  });

  test("generation preview leaves aggressive confirm-needed claims for the person", async () => {
    const seed = createSeed();
    seed.savedJobs = seed.savedJobs.map((job) =>
      job.id === "job_ready"
        ? {
            ...job,
            resumeTailoringMode: "aggressive",
            keySkills: [...job.keySkills, "Terraform"],
          }
        : job,
    );
    let requiredModelRepairCount = -1;
    let personConfirmationCount = -1;
    const baseAiClient = createAiClient();
    const { workspaceService } = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...baseAiClient,
        checkResumeClaims: fakeResumeClaimCheck({ Terraform: "stretch" }),
        async createResumeDraft(input) {
          const draft = await baseAiClient.createResumeDraft(input);
          const preview = await input.renderPreview?.({
            draft: {
              ...draft,
              coreSkills: [...draft.coreSkills, "Terraform"],
            },
            templateId:
              input.selectedTemplateId ?? input.settings.resumeTemplateId,
          });
          requiredModelRepairCount =
            preview?.requiredModelRepairs?.length ?? -1;
          personConfirmationCount = preview?.personConfirmationCount ?? -1;
          return draft;
        },
      },
    });

    await workspaceService.generateResume("job_ready");

    expect(personConfirmationCount).toBeGreaterThan(0);
    expect(requiredModelRepairCount).toBe(0);
  });
});
