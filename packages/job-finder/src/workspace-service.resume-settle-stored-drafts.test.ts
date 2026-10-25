import { describe, expect, test } from "vitest";
import { isBlockingResumeClaimAssessment } from "@nestor/contracts";
import {
  resumeClaimContentHash,
  validateResumeDraft,
} from "./internal/resume-workspace-helpers";
import {
  createAiClient,
  fakeResumeClaimCheck,
} from "./workspace-service.test-runtimes";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

const UNBACKED_LINE = "Ran the entire cloud migration single-handedly.";

describe("drafts written before lines were settled during generation", () => {
  test("their unbacked generated lines are settled when the workspace loads, without the model", async () => {
    const seed = createSeed();
    const first = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        checkResumeClaims: fakeResumeClaimCheck(),
      },
    });
    await first.workspaceService.generateResume("job_ready");
    const generated = await first.repository.getResumeDraftByJobId("job_ready");
    if (!generated) throw new Error("Expected a generated draft.");

    // An older draft: one achievement line rewritten by the AI into a claim
    // the fact check called unsupported, with no fix, still on the resume.
    let savedWording: string | null = null;
    let replaced = false;
    const olderDraft = {
      ...generated,
      claimChecks: [
        ...(generated.claimChecks ?? []),
        {
          contentHash: resumeClaimContentHash(UNBACKED_LINE),
          verdict: "unsupported" as const,
          reason: "Test verdict.",
          evidenceIds: [],
          fix: null,
          evidenceKey: null,
          checkedAt: "2026-10-16T10:00:00.000Z",
        },
      ],
      sections: generated.sections.map((section) =>
        section.kind !== "experience"
          ? section
          : {
              ...section,
              entries: section.entries.map((entry) => ({
                ...entry,
                bullets: entry.bullets.map((bullet) => {
                  const source = bullet.sourceRefs.find(
                    (ref) =>
                      ref.sourceKind === "profile" &&
                      ref.sourceId?.includes(":achievement:"),
                  );
                  if (
                    replaced ||
                    !entry.included ||
                    !bullet.included ||
                    !source
                  ) {
                    return bullet;
                  }
                  replaced = true;
                  // Settling restores the person's saved achievement itself.
                  const [, recordId, index] =
                    source.sourceId!.match(
                      /^experience:(.+):achievement:(\d+)$/u,
                    ) ?? [];
                  savedWording =
                    seed.profile.experiences
                      .find((record) => record.id === recordId)
                      ?.achievements[Number(index)]?.trim() ?? null;
                  return {
                    ...bullet,
                    text: UNBACKED_LINE,
                    origin: "ai_generated" as const,
                  };
                }),
              })),
            },
      ),
    };
    if (!replaced || !savedWording) {
      throw new Error("Expected an achievement line to rewrite.");
    }
    const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
    const olderValidation = validateResumeDraft({
      draft: olderDraft,
      job,
      profile: seed.profile,
    });
    expect(
      olderValidation.claimAssessments.some((assessment) =>
        isBlockingResumeClaimAssessment({ assessment, draft: olderDraft }),
      ),
    ).toBe(true);

    // The app starts again over that saved state.
    let modelChecks = 0;
    const second = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        tailoredAssets: [...(await first.repository.listTailoredAssets())],
        resumeDrafts: [olderDraft],
        resumeValidationResults: [olderValidation],
      },
      aiClient: {
        ...createAiClient(),
        checkResumeClaims(input) {
          modelChecks += 1;
          return fakeResumeClaimCheck()(input);
        },
      },
    });
    const snapshot = await second.workspaceService.getWorkspaceSnapshot();

    const settled = await second.repository.getResumeDraftByJobId("job_ready");
    const shownLines = settled!.sections.flatMap((section) =>
      section.entries.flatMap((entry) =>
        entry.bullets
          .filter((bullet) => bullet.included)
          .map((bullet) => bullet.text),
      ),
    );
    expect(shownLines).not.toContain(UNBACKED_LINE);
    expect(shownLines).toContain(savedWording);
    expect(
      snapshot.reviewQueue.find((item) => item.jobId === "job_ready")
        ?.resumeLinesToDecide ?? 0,
    ).toBe(0);
    expect(modelChecks).toBe(0);
  });

  test("a single skill an older word check called unsupported stops blocking, and the draft is kept", async () => {
    const seed = createSeed();
    const first = createWorkspaceServiceHarness({
      seed,
      aiClient: {
        ...createAiClient(),
        checkResumeClaims: fakeResumeClaimCheck(),
      },
    });
    await first.workspaceService.generateResume("job_ready");
    const generated = await first.repository.getResumeDraftByJobId("job_ready");
    if (!generated) throw new Error("Expected a generated draft.");
    const skills = generated.sections.find(
      (section) => section.kind === "skills",
    );
    if (!skills) throw new Error("Expected a skills section.");

    // An older draft: the AI added a skill, and the check of the time saved
    // its verdict only as a blocking issue, with no fact-check verdict to
    // settle from.
    const olderDraft = {
      ...generated,
      sections: generated.sections.map((section) =>
        section.id !== skills.id
          ? section
          : {
              ...section,
              bullets: [
                ...section.bullets,
                {
                  ...section.bullets[0]!,
                  id: "bullet_older_skill",
                  text: "Synthetic Framework",
                  origin: "ai_generated" as const,
                  included: true,
                },
              ],
            },
      ),
    };
    const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
    const current = validateResumeDraft({
      draft: olderDraft,
      job,
      profile: seed.profile,
    });
    const olderValidation = {
      ...current,
      issues: [
        ...current.issues,
        {
          id: "issue_older_word_check",
          severity: "error" as const,
          category: "unsupported_claim" as const,
          sectionId: skills.id,
          entryId: null,
          bulletId: "bullet_older_skill",
          message:
            "Your saved evidence does not back this generated claim. Rewrite it, or approve it as accurate if you can stand behind it.",
          flaggedText: "Synthetic Framework",
        },
      ],
    };

    const second = createWorkspaceServiceHarness({
      seed: {
        ...seed,
        tailoredAssets: [...(await first.repository.listTailoredAssets())],
        resumeDrafts: [olderDraft],
        resumeValidationResults: [olderValidation],
      },
      aiClient: createAiClient(),
    });
    await second.workspaceService.getWorkspaceSnapshot();

    const [stored] = await second.repository.listLatestResumeValidationResults([
      olderDraft.id,
    ]);
    expect(
      stored?.issues.some(
        (issue) =>
          issue.category === "unsupported_claim" && issue.severity === "error",
      ),
    ).toBe(false);
    const kept = await second.repository.getResumeDraftByJobId("job_ready");
    expect(JSON.stringify(kept?.sections)).toBe(
      JSON.stringify(olderDraft.sections),
    );
  });
});
