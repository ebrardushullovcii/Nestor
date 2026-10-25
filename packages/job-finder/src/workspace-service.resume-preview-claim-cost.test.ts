import { readFileSync } from "node:fs";
import type { ResumeClaimCheckInput } from "@nestor/ai-providers";
import { ResumeDraftSchema, type ResumeDraft } from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";
import { expect, test, vi } from "vitest";

import { withResumeClaimChecks } from "./internal/resume-claim-checks";
import {
  buildResumeClaimEvidenceBank,
  resumeClaimContentHash,
} from "./internal/resume-workspace-helpers";
import {
  createAiClient,
  createSeed,
  createWorkspaceServiceHarness,
  fakeResumeClaimCheck,
} from "./workspace-service.test-support";

const at = "2026-10-21T10:00:00.000Z";

function generatedDraft(texts: readonly string[]): ResumeDraft {
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
        bullets: texts.map((text, index) => ({
          id: `bullet_${index + 1}`,
          text,
          origin: "ai_generated",
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

function editBullet(draft: ResumeDraft, index: number, text: string) {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      bullets: section.bullets.map((bullet, position) =>
        position === index ? { ...bullet, text } : bullet,
      ),
    })),
  };
}

function seedJob() {
  const seed = createSeed();
  const job = seed.savedJobs.find((entry) => entry.id === "job_ready")!;
  return { seed, job };
}

test("editing one generated line has only that line checked again", async () => {
  const { seed, job } = seedJob();
  const check = vi.fn(fakeResumeClaimCheck());
  const lines = [
    "Per-line cost synthetic line one about dashboards.",
    "Per-line cost synthetic line two about reporting.",
    "Per-line cost synthetic line three about forecasting.",
  ];
  const first = await withResumeClaimChecks({
    aiClient: { checkResumeClaims: check },
    draft: generatedDraft(lines),
    job,
    profile: seed.profile,
  });
  const edited = editBullet(
    first,
    1,
    "Per-line cost synthetic line two, edited by the person.",
  );
  const second = await withResumeClaimChecks({
    aiClient: { checkResumeClaims: check },
    draft: edited,
    job,
    profile: seed.profile,
  });

  expect(check.mock.calls.map(([input]) => input.claims.length)).toEqual([
    3, 1,
  ]);
  expect(check.mock.calls[1]?.[0].claims.map((claim) => claim.text)).toEqual([
    "Per-line cost synthetic line two, edited by the person.",
  ]);
  expect(second.claimChecks).toHaveLength(3);
});

test("a verdict stored under the earlier whole-draft key of this same draft is reused and re-keyed", async () => {
  const { seed, job } = seedJob();
  const lines = ["Legacy-keyed synthetic verdict line about audits."];
  const evidence = buildResumeClaimEvidenceBank(seed.profile).map(
    (entry) => entry.text,
  );
  // The key verdicts were stored under before per-line keys.
  const legacyKey = fnv1a32(
    JSON.stringify([
      "resume-fact-check-2026-10-14-context-v3",
      [
        job.title,
        job.company,
        job.description,
        [
          ...job.responsibilities,
          ...job.minimumQualifications,
          ...job.preferredQualifications,
        ],
      ],
      lines.map((text) => ["Highlights", resumeClaimContentHash(text)]),
      evidence,
      seed.profile.baseResume.textContent ?? "",
      "balanced",
    ]),
  );
  const stored = {
    ...generatedDraft(lines),
    claimChecks: [
      {
        contentHash: resumeClaimContentHash(lines[0]!),
        verdict: "supported" as const,
        reason: "Stored by an earlier build.",
        evidenceIds: [],
        fix: null,
        style: null,
        evidenceKey: legacyKey,
        checkedAt: at,
      },
    ],
  };
  const check = vi.fn(fakeResumeClaimCheck());
  const checked = await withResumeClaimChecks({
    aiClient: { checkResumeClaims: check },
    draft: stored,
    job,
    profile: seed.profile,
  });
  expect(check).not.toHaveBeenCalled();
  expect(checked.claimChecks?.[0]).toMatchObject({
    reason: "Stored by an earlier build.",
  });
  expect(checked.claimChecks?.[0]?.evidenceKey).not.toBe(legacyKey);
});

test("each check sends the imported resume once, as cited evidence", async () => {
  const { seed, job } = seedJob();
  seed.profile.baseResume.textContent = readFileSync(
    new URL(
      "../../../apps/desktop/test-fixtures/job-finder/resume-import-personas/lina-haddad.txt",
      import.meta.url,
    ),
    "utf8",
  );
  const requests: ResumeClaimCheckInput[] = [];
  await withResumeClaimChecks({
    aiClient: {
      checkResumeClaims: (input) => {
        requests.push(input);
        return fakeResumeClaimCheck()(input);
      },
    },
    draft: generatedDraft(["Resume-once synthetic generated line about SQL."]),
    job,
    profile: seed.profile,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.resumeText).toBeNull();
  expect(
    requests[0]?.evidence.some((entry) =>
      entry.text.includes("Wrote SQL models in BigQuery"),
    ),
  ).toBe(true);
});

test("the live preview asks the model nothing; saving checks the new wording once", async () => {
  const seed = createSeed();
  seed.resumeDrafts = [];
  seed.tailoredAssets = [];
  const aiClient = createAiClient();
  const check = vi.fn(fakeResumeClaimCheck());
  aiClient.checkResumeClaims = check;
  const { workspaceService } = createWorkspaceServiceHarness({
    seed,
    aiClient,
  });
  try {
    const workspace = await workspaceService.getResumeWorkspace("job_ready");
    const generated = generatedDraft([
      "Preview-cost synthetic generated line about onboarding.",
      "Preview-cost synthetic generated line about tooling.",
    ]);
    const base = {
      ...workspace.draft,
      sections: generated.sections,
    };
    await workspaceService.saveResumeDraft(base);
    const callsAfterSave = check.mock.calls.length;
    expect(callsAfterSave).toBe(1);
    const saved = (await workspaceService.getResumeWorkspace("job_ready"))
      .draft;

    // Typing: three previews of three intermediate wordings.
    for (const wording of [
      "Preview-cost typed a",
      "Preview-cost typed ab",
      "Preview-cost typed abc, final.",
    ]) {
      await workspaceService.previewResumeDraft(editBullet(saved, 0, wording));
    }
    expect(check.mock.calls.length).toBe(callsAfterSave);

    await workspaceService.saveResumeDraft(
      editBullet(saved, 0, "Preview-cost typed abc, final."),
    );
    expect(check.mock.calls.length).toBe(callsAfterSave + 1);
    expect(
      check.mock.calls.at(-1)?.[0].claims.map((claim) => claim.text),
    ).toEqual(["Preview-cost typed abc, final."]);
  } finally {
    await workspaceService.shutdown();
  }
});
