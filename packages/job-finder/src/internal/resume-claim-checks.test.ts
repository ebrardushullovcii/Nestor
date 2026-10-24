import { ResumeDraftSchema } from "@nestor/contracts";
import {
  createOpenAiCompatibleJobFinderAiClient,
  RESUME_CLAIM_CHECK_BATCH_SIZE,
} from "@nestor/ai-providers";
import type { ResumeClaimCheckInput } from "@nestor/ai-providers";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createSeed } from "../workspace-service.test-support";
import {
  withResumeClaimChecks,
  withResumeClaimFixes,
} from "./resume-claim-checks";
import {
  buildResumeRenderDocument,
  resumeClaimContentHash,
  sanitizeResumeDraft,
} from "./resume-workspace-helpers";

const at = "2026-10-03T10:00:00.000Z";

function supported(input: ResumeClaimCheckInput) {
  return input.claims.map((claim) => ({
    id: claim.id,
    verdict: "supported" as const,
    reason: "Supported synthetic test evidence.",
    evidenceIds: [],
    fix: null,
  }));
}

function context() {
  const seed = createSeed();
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready");
  if (!job) throw new Error("job_ready missing");
  return { profile: seed.profile, job };
}

function draftWith(bullets: ReadonlyArray<{ text: string; origin: string }>) {
  return ResumeDraftSchema.parse({
    id: "resume_draft_job_ready",
    jobId: "job_ready",
    status: "draft",
    templateId: "classic_ats",
    sections: [
      {
        id: "section_summary",
        kind: "summary",
        label: "Highlights",
        text: null,
        bullets: bullets.map((bullet, index) => ({
          id: `bullet_${index + 1}`,
          text: bullet.text,
          origin: bullet.origin,
          locked: false,
          included: true,
          updatedAt: at,
        })),
        entries: [],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 0,
        updatedAt: at,
      },
    ],
    createdAt: at,
    updatedAt: at,
  });
}

describe("nested claim-check writing deadline and cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("uses the remaining transaction budget across batches without duplicating provider retries", async () => {
    vi.useFakeTimers();
    const { job, profile } = context();
    const began = Date.now();
    const checkResumeClaims = vi
      .fn<
        (input: ResumeClaimCheckInput) => Promise<ReturnType<typeof supported>>
      >()
      .mockImplementationOnce(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return supported(input);
      })
      .mockImplementationOnce(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return supported(input);
      })
      .mockImplementation(async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return supported(input);
      });
    const draft = draftWith(
      Array.from({ length: RESUME_CLAIM_CHECK_BATCH_SIZE + 1 }, (_, index) => ({
        text: `Transaction-bound generated claim ${index + 1} about a separate synthetic accomplishment.`,
        origin: "ai_generated",
      })),
    );
    const checking = withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      draft,
      job,
      profile,
      getRemainingBudgetMs: () => 1000 - (Date.now() - began),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const checked = await checking;
    expect(
      checkResumeClaims.mock.calls.map(([input]) => input.timeoutMs),
    ).toEqual([1000, 750]);
    expect(
      checkResumeClaims.mock.calls.map(([input]) => input.claims.length),
    ).toEqual([RESUME_CLAIM_CHECK_BATCH_SIZE, 1]);
    expect(checked.claimChecks).toHaveLength(RESUME_CLAIM_CHECK_BATCH_SIZE + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("times out a provider that ignores cancellation and starts no retry or next batch", async () => {
    vi.useFakeTimers();
    const { job, profile } = context();
    const began = Date.now();
    const checkResumeClaims = vi
      .fn<
        (input: ResumeClaimCheckInput) => Promise<ReturnType<typeof supported>>
      >()
      .mockImplementationOnce(
        (input) =>
          new Promise((resolve) =>
            setTimeout(() => resolve(supported(input)), 100),
          ),
      )
      .mockResolvedValue([]);
    const checking = withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      job,
      profile,
      draft: draftWith(
        Array.from(
          { length: RESUME_CLAIM_CHECK_BATCH_SIZE + 1 },
          (_, index) => ({
            text: `Deadline-only generated claim ${index + 1} that must not outlive this writing transaction.`,
            origin: "ai_generated",
          }),
        ),
      ),
      getRemainingBudgetMs: () => 50 - (Date.now() - began),
    });
    const timedOut = expect(checking).rejects.toMatchObject({
      name: "TimeoutError",
    });
    void timedOut.catch(() => {});
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    expect(checkResumeClaims).toHaveBeenCalledOnce();
    expect(checkResumeClaims.mock.calls[0]![0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not dispatch a check after the writing budget is exhausted", async () => {
    const { job, profile } = context();
    const checkResumeClaims = vi.fn((input: ResumeClaimCheckInput) =>
      Promise.resolve(supported(input)),
    );
    await expect(
      withResumeClaimChecks({
        aiClient: { checkResumeClaims },
        job,
        profile,
        draft: draftWith([
          {
            text: "An expired writing transaction must never start this synthetic claim check.",
            origin: "ai_generated",
          },
        ]),
        getRemainingBudgetMs: () => 0,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(checkResumeClaims).not.toHaveBeenCalled();
  });

  test("does not dispatch for an already-cancelled preview", async () => {
    const { job, profile } = context();
    const controller = new AbortController();
    controller.abort(new DOMException("The writer stopped.", "AbortError"));
    const checkResumeClaims = vi.fn((input: ResumeClaimCheckInput) =>
      Promise.resolve(supported(input)),
    );
    await expect(
      withResumeClaimChecks({
        aiClient: { checkResumeClaims },
        job,
        profile,
        signal: controller.signal,
        draft: draftWith([
          {
            text: "An already-cancelled preview must never check this synthetic sentence.",
            origin: "ai_generated",
          },
        ]),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkResumeClaims).not.toHaveBeenCalled();
  });

  test("cancels an active provider that ignores its signal without retrying", async () => {
    vi.useFakeTimers();
    const { job, profile } = context();
    const controller = new AbortController();
    const checkResumeClaims = vi.fn(
      (input: ResumeClaimCheckInput) =>
        new Promise<ReturnType<typeof supported>>((resolve) =>
          setTimeout(() => resolve(supported(input)), 100),
        ),
    );
    const checking = withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      job,
      profile,
      signal: controller.signal,
      draft: draftWith([
        {
          text: "Cancellation must stop this synthetic active grounding check promptly.",
          origin: "ai_generated",
        },
      ]),
    });
    const cancelled = expect(checking).rejects.toMatchObject({
      name: "AbortError",
    });
    void cancelled.catch(() => {});
    await vi.advanceTimersByTimeAsync(40);
    controller.abort(new DOMException("Workspace reset.", "AbortError"));
    await vi.advanceTimersByTimeAsync(60);
    await cancelled;
    expect(checkResumeClaims).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not start a fix recheck after the same writing transaction expires", async () => {
    const { job, profile } = context();
    let remaining = 100;
    const checkResumeClaims = vi.fn((input: ResumeClaimCheckInput) =>
      Promise.resolve(
        input.claims.map((claim) => ({
          id: claim.id,
          verdict: "unsupported" as const,
          reason: "Synthetic unsupported statement.",
          evidenceIds: [],
          fix: "A distinct safe synthetic replacement awaiting its own grounding check.",
        })),
      ),
    );
    const input = {
      aiClient: { checkResumeClaims },
      job,
      profile,
      draft: draftWith([
        {
          text: "The synthetic unsupported achievement needs a bounded fix recheck.",
          origin: "ai_generated",
        },
      ]),
      getRemainingBudgetMs: () => remaining,
    };
    const checked = await withResumeClaimChecks(input);
    remaining = 0;
    await expect(
      withResumeClaimFixes({
        ...input,
        draft: checked,
        stretchesAreThePersons: false,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(checkResumeClaims).toHaveBeenCalledOnce();
  });
});

describe("resume claim checks before a draft is kept (ADR 0041)", () => {
  test("asks the model about generated lines only, once per wording", async () => {
    const { profile, job } = context();
    const checkResumeClaims = vi.fn(
      (input: { claims: ReadonlyArray<{ id: string; text: string }> }) =>
        Promise.resolve(
          input.claims.map((claim) => ({
            id: claim.id,
            verdict: "stretch" as const,
            reason: "A small step past the evidence.",
            evidenceIds: [],
            fix: null,
          })),
        ),
    );
    const draft = draftWith([
      {
        text: "Steered a thirty-person migration to event sourcing.",
        origin: "ai_generated",
      },
      {
        text: "Wrote this line myself after the interview.",
        origin: "user_edited",
      },
    ]);

    const checked = await withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      draft,
      job,
      profile,
      now: () => at,
    });

    expect(checkResumeClaims).toHaveBeenCalledOnce();
    expect(
      checkResumeClaims.mock.calls[0]?.[0].claims.map((claim) => claim.text),
    ).toEqual(["Steered a thirty-person migration to event sourcing."]);
    expect(checked.claimChecks).toMatchObject([
      {
        contentHash: resumeClaimContentHash(
          "Steered a thirty-person migration to event sourcing.",
        ),
        verdict: "stretch",
      },
    ]);

    // The stored verdict is reused; the model is not asked again.
    await withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      draft: checked,
      job,
      profile,
    });
    expect(checkResumeClaims).toHaveBeenCalledOnce();
  });

  test("a project line built from the person's own records is theirs", async () => {
    const { profile, job } = context();
    const checkResumeClaims = vi.fn(() => Promise.resolve([]));
    const withProject = {
      ...profile,
      projects: [
        {
          id: "project_workflow_os",
          name: "Workflow OS",
          projectType: "product",
          summary: "Scaled an internal design system.",
          role: "Design lead",
          skills: ["Figma", "Accessibility"],
          outcome: "Reduced release churn for operations teams.",
          projectUrl: null,
          repositoryUrl: null,
          caseStudyUrl: null,
          isDraft: false,
        },
      ],
    };

    const checked = await withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      draft: draftWith([
        {
          text: "Scaled an internal design system. Reduced release churn for operations teams. Technologies: Figma, Accessibility.",
          origin: "ai_generated",
        },
      ]),
      job,
      profile: withProject,
      now: () => at,
    });

    expect(checkResumeClaims).not.toHaveBeenCalled();
    expect(checked.claimChecks ?? []).toEqual([]);
  });

  test("a changed profile has the lines checked again", async () => {
    const { profile, job } = context();
    const checkResumeClaims = vi.fn(
      (input: { claims: ReadonlyArray<{ id: string }> }) =>
        Promise.resolve(
          input.claims.map((claim) => ({
            id: claim.id,
            verdict: "supported" as const,
            reason: "In the evidence.",
            evidenceIds: [],
            fix: null,
          })),
        ),
    );
    const draft = draftWith([
      {
        text: "Rebuilt the onboarding funnel analytics end to end.",
        origin: "ai_generated",
      },
    ]);
    const checked = await withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      draft,
      job,
      profile,
    });
    await withResumeClaimChecks({
      aiClient: { checkResumeClaims },
      draft: checked,
      job,
      profile: {
        ...profile,
        summary: `${profile.summary ?? ""} Now leads analytics.`,
      },
    });
    expect(checkResumeClaims).toHaveBeenCalledTimes(2);
  });

  test("a failed check leaves the lines unchecked", async () => {
    const { profile, job } = context();
    const checked = await withResumeClaimChecks({
      aiClient: {
        checkResumeClaims: () => Promise.reject(new Error("model unavailable")),
      },
      draft: draftWith([
        {
          text: "Negotiated a vendor contract worth two million.",
          origin: "ai_generated",
        },
      ]),
      job,
      profile,
    });
    expect(checked.claimChecks).toEqual([]);
  });

  describe("fixing what the check did not pass", () => {
    test.each(["aggressive", "balanced", "conservative"])(
      "%s keeps the saved summary in both the editor draft and later preview when the model removes its rewrite",
      async (tailoringStrength) => {
        const { profile, job } = context();
        profile.summary = `Builds reliable software (${tailoringStrength}-summary-fallback).`;
        const draft = draftWith([]);
        draft.sections[0]!.text = `Invented executive scope (${tailoringStrength}-summary-fallback).`;
        const checkResumeClaims = vi.fn(async (input: ResumeClaimCheckInput) =>
          input.claims.map((claim) => ({
            id: claim.id,
            verdict: "unsupported" as const,
            reason: "The evidence does not show executive scope.",
            evidenceIds: [],
            fix: "",
          })),
        );
        const base = {
          aiClient: { checkResumeClaims },
          job,
          profile,
          tailoringStrength,
        };
        const fixed = await withResumeClaimFixes({
          ...base,
          draft: await withResumeClaimChecks({ ...base, draft }),
          stretchesAreThePersons: tailoringStrength === "aggressive",
        });
        expect(fixed.sections[0]!.text).toBe(profile.summary);
        const previewDraft = sanitizeResumeDraft({
          draft: fixed,
          profile,
          job,
        });
        expect(buildResumeRenderDocument(profile, fixed)).toEqual(
          buildResumeRenderDocument(profile, previewDraft),
        );
        expect(checkResumeClaims).toHaveBeenCalledOnce();
      },
    );

    // Verdicts are remembered for the session, so each test words its own lines.
    function lines(tag: string) {
      return {
        invented: `Cut cloud spend by 40% across twelve teams (${tag}).`,
        fixedInvented: `Worked on cloud spend reviews (${tag}).`,
        skill: `Kubernetes ${tag}`,
        stretch: `Owned the platform roadmap (${tag}).`,
        fixedStretch: `Contributed to the platform roadmap (${tag}).`,
        theirs: `Wrote this line myself after the interview (${tag}).`,
      };
    }

    function checker(
      verdicts: Record<string, "supported" | "stretch" | "unsupported">,
      fixes: Record<string, string>,
      styles: Record<string, string> = {},
    ) {
      return vi.fn(
        (input: { claims: ReadonlyArray<{ id: string; text: string }> }) =>
          Promise.resolve(
            input.claims.map((claim) => ({
              id: claim.id,
              verdict: verdicts[claim.text] ?? ("supported" as const),
              reason: "Test verdict.",
              evidenceIds: [],
              fix: fixes[claim.text] ?? null,
              style: styles[claim.text] ?? null,
            })),
          ),
      );
    }

    async function generateAndFix(
      line: ReturnType<typeof lines>,
      checkResumeClaims: ReturnType<typeof checker>,
      stretchesAreThePersons: boolean,
    ) {
      const { profile, job } = context();
      const base = {
        aiClient: { checkResumeClaims },
        job,
        profile,
        now: () => at,
      };
      const checked = await withResumeClaimChecks({
        ...base,
        draft: draftWith([
          { text: line.invented, origin: "ai_generated" },
          { text: line.skill, origin: "ai_generated" },
          { text: line.stretch, origin: "ai_generated" },
          { text: line.theirs, origin: "user_edited" },
        ]),
      });
      return withResumeClaimFixes({
        ...base,
        draft: checked,
        stretchesAreThePersons,
      });
    }

    test("rewrites or hides failed lines, checks the rewrites, keeps the person's lines", async () => {
      const line = lines("fixes");
      const checkResumeClaims = checker(
        {
          [line.invented]: "unsupported",
          [line.skill]: "unsupported",
          [line.stretch]: "stretch",
        },
        {
          [line.invented]: line.fixedInvented,
          [line.skill]: "",
          [line.stretch]: line.fixedStretch,
        },
      );

      const fixed = await generateAndFix(line, checkResumeClaims, false);
      const bullets = fixed.sections[0]?.bullets ?? [];

      expect(bullets.map((bullet) => [bullet.text, bullet.included])).toEqual([
        [line.fixedInvented, true],
        [line.skill, false],
        [line.fixedStretch, true],
        [line.theirs, true],
      ]);
      // The two rewrites were checked in a second call.
      expect(checkResumeClaims).toHaveBeenCalledTimes(2);
      expect(
        checkResumeClaims.mock.calls[1]?.[0].claims.map((claim) => claim.text),
      ).toEqual([line.fixedInvented, line.fixedStretch]);
      expect(
        fixed.claimChecks?.find(
          (check) =>
            check.contentHash === resumeClaimContentHash(line.fixedInvented),
        )?.verdict,
      ).toBe("supported");
    });

    test("a supported line the checker notes as unfinished writing gets its fix", async () => {
      const line = lines("style");
      const checkResumeClaims = checker(
        {},
        { [line.invented]: line.fixedInvented },
        { [line.invented]: "This reads as a fragment." },
      );

      const fixed = await generateAndFix(line, checkResumeClaims, true);

      expect(fixed.sections[0]?.bullets[0]?.text).toBe(line.fixedInvented);
    });

    test("a stretch stays for the person in aggressive tailoring", async () => {
      const line = lines("aggressive");
      const checkResumeClaims = checker(
        { [line.stretch]: "stretch" },
        { [line.stretch]: line.fixedStretch },
      );

      const fixed = await generateAndFix(line, checkResumeClaims, true);

      expect(fixed.sections[0]?.bullets.map((bullet) => bullet.text)).toContain(
        line.stretch,
      );
      expect(checkResumeClaims).toHaveBeenCalledOnce();
    });

    test("a fix that repeats a line already there hides the line", async () => {
      const line = lines("duplicate");
      const checkResumeClaims = checker(
        { [line.invented]: "unsupported" },
        { [line.invented]: line.theirs },
      );

      const fixed = await generateAndFix(line, checkResumeClaims, false);

      expect(
        fixed.sections[0]?.bullets.map((bullet) => [
          bullet.text,
          bullet.included,
        ]),
      ).toContainEqual([line.invented, false]);
      // Hiding the line leaves no new wording, so nothing is asked again.
      expect(checkResumeClaims).toHaveBeenCalledTimes(1);
    });

    test("a fix that rewords a line already there hides the line too", async () => {
      const line = lines("reworded");
      const checkResumeClaims = checker(
        { [line.invented]: "unsupported" },
        {
          [line.invented]:
            "Wrote this same line myself after the interview (reworded).",
        },
      );

      const fixed = await generateAndFix(line, checkResumeClaims, false);

      expect(
        fixed.sections[0]?.bullets.find(
          (bullet) => bullet.text === line.invented,
        )?.included,
      ).toBe(false);
    });

    test("a rewrite that still fails is left off without a third check", async () => {
      const line = lines("again");
      const worse = "Cut cloud spend by 30% across ten teams (again).";
      const checkResumeClaims = checker(
        { [line.invented]: "unsupported", [worse]: "unsupported" },
        { [line.invented]: worse, [worse]: "Worked on cloud spend." },
      );

      const fixed = await generateAndFix(line, checkResumeClaims, false);

      expect(fixed.sections[0]?.bullets[0]?.text).toBe(worse);
      expect(fixed.sections[0]?.bullets[0]?.included).toBe(false);
      expect(fixed.sections[0]?.bullets[3]?.included).toBe(true);
      expect(checkResumeClaims).toHaveBeenCalledTimes(2);
    });

    test("a failed rewrite restores its saved achievement without checking the person's wording", async () => {
      const { profile, job } = context();
      const experience = profile.experiences[0]!;
      const source =
        "Maintained the synthetic migration ledger (saved-recheck).";
      experience.achievements = [source];
      const invented = "Owned twelve migration teams (saved-recheck).";
      const rewrite = "Led the migration programme (saved-recheck).";
      const checkResumeClaims = checker(
        { [invented]: "unsupported", [rewrite]: "unsupported" },
        { [invented]: rewrite, [rewrite]: "Another unchecked rewrite." },
      );
      const draft = draftWith([{ text: invented, origin: "ai_generated" }]);
      draft.sections[0]!.bullets[0]!.sourceRefs = [
        {
          id: "saved-recheck-source",
          sourceKind: "profile",
          sourceId: `experience:${experience.id}:achievement:0`,
          snippet: source,
        },
      ];
      const base = { aiClient: { checkResumeClaims }, job, profile };
      const checked = await withResumeClaimChecks({ ...base, draft });
      const fixed = await withResumeClaimFixes({
        ...base,
        draft: checked,
        stretchesAreThePersons: true,
      });
      expect(fixed.sections[0]!.bullets[0]).toMatchObject({
        text: source,
        included: true,
        origin: "ai_generated",
        sourceRefs: draft.sections[0]!.bullets[0]!.sourceRefs,
      });
      expect(checkResumeClaims).toHaveBeenCalledTimes(2);
    });
  });
});

test("a provider access rejection is neither retried nor turned into unchecked success", async () => {
  const { job, profile } = context();
  const draft = draftWith([
    {
      text: "Synthetic claim for provider-block regression unique402",
      origin: "ai_generated",
    },
  ]);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Insufficient account funds" } }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    );
  const aiClient = createOpenAiCompatibleJobFinderAiClient({
    apiKey: "synthetic",
    baseUrl: "https://example.test/v1",
    model: "synthetic",
  });
  try {
    await expect(
      withResumeClaimChecks({ draft, job, profile, aiClient }),
    ).rejects.toThrow("Insufficient account funds");
    expect(fetchMock).toHaveBeenCalledOnce();
  } finally {
    fetchMock.mockRestore();
  }
});

test("an exhausted transport retry budget is not run a second time by claim checking", async () => {
  const { job, profile } = context();
  const draft = draftWith([
    {
      text: "Unique retry budget claim that must remain unchecked after unavailable provider503",
      origin: "ai_generated",
    },
  ]);
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "Service unavailable" } }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  const aiClient = createOpenAiCompatibleJobFinderAiClient({
    apiKey: "synthetic",
    baseUrl: "https://example.test/v1",
    model: "synthetic",
    maxAttempts: 2,
    retryBaseDelayMs: 1,
  });
  try {
    const result = await withResumeClaimChecks({
      draft,
      job,
      profile,
      aiClient,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.claimChecks).toEqual([]);
  } finally {
    fetchMock.mockRestore();
  }
});

test("claim reuse is invalidated when the target job's checker context changes", async () => {
  const { job, profile } = context();
  const draft = draftWith([
    {
      text: "Job-dependent synthetic check uniquecontextv3",
      origin: "ai_generated",
    },
  ]);
  const checkResumeClaims = vi.fn((input: ResumeClaimCheckInput) =>
    Promise.resolve(supported(input)),
  );
  const first = await withResumeClaimChecks({
    draft,
    job,
    profile,
    aiClient: { checkResumeClaims },
  });
  await withResumeClaimChecks({
    draft: first,
    job,
    profile,
    aiClient: { checkResumeClaims },
  });
  expect(checkResumeClaims).toHaveBeenCalledOnce();
  await withResumeClaimChecks({
    draft: first,
    job: {
      ...job,
      description: job.description + " Changed target requirements.",
    },
    profile,
    aiClient: { checkResumeClaims },
  });
  expect(checkResumeClaims).toHaveBeenCalledTimes(2);
});
