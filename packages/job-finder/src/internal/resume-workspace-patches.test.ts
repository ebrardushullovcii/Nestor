import { describe, expect, test } from "vitest";
import type { ResumeDraft, ResumeDraftPatch } from "@nestor/contracts";

import { applyPatchToResumeDraft } from "./resume-workspace-patches";
import {
  hasBlockingResumeClaimAssessment,
  validateResumeDraft,
} from "./resume-workspace-helpers";
import { fnv1a32 } from "@nestor/core";
import { normalizeText } from "./shared";
import { createSeed } from "../workspace-service.test-support";

const updatedAt = "2026-08-09T12:00:00.000Z";

function createDraft(): ResumeDraft {
  return {
    id: "draft_restore",
    jobId: "job_restore",
    status: "draft",
    templateId: "classic_ats",
    identity: null,
    sections: [
      {
        id: "section_experience",
        kind: "experience",
        label: "Experience",
        text: null,
        bullets: [],
        entries: [
          {
            id: "experience_1",
            entryType: "experience",
            title: "Software Engineer",
            subtitle: "Signal Systems",
            location: null,
            dateRange: "2022 – Present",
            startDate: "2022",
            endDate: null,
            isCurrent: true,
            summary: "Tailored summary.",
            bullets: [],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: 0,
            profileRecordId: "experience_1",
            sourceRefs: [],
            updatedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt: "2026-08-09T10:00:00.000Z",
      },
    ],
    targetPageCount: 2,
    generationMethod: "ai",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };
}

function createPatch(overrides: Partial<ResumeDraftPatch>): ResumeDraftPatch {
  return {
    id: "patch_restore_summary",
    draftId: "draft_restore",
    operation: "replace_entry_summary",
    targetSectionId: "section_experience",
    targetEntryId: "experience_1",
    anchorEntryId: null,
    targetBulletId: null,
    anchorBulletId: null,
    position: null,
    newText: "Original summary.",
    newIncluded: null,
    newLocked: null,
    newBullets: null,
    appliedAt: updatedAt,
    origin: "user",
    conflictReason: null,
    ...overrides,
  };
}

describe("resume workspace patches", () => {
  test("restores an original entry summary as a user edit", () => {
    const nextDraft = applyPatchToResumeDraft({
      draft: createDraft(),
      patch: createPatch({}),
      updatedAt,
    });

    expect(nextDraft.sections[0]?.entries[0]).toMatchObject({
      summary: "Original summary.",
      origin: "user_edited",
      updatedAt,
    });
    expect(nextDraft.updatedAt).toBe(updatedAt);
  });

  test("rejects summary restoration without a target entry", () => {
    expect(() =>
      applyPatchToResumeDraft({
        draft: createDraft(),
        patch: createPatch({ targetEntryId: null }),
        updatedAt,
      }),
    ).toThrow("replace_entry_summary requires a target resume entry");
  });

  test("showing a role also restores its hidden parent section", () => {
    const draft = createDraft();
    const hiddenDraft: ResumeDraft = {
      ...draft,
      sections: draft.sections.map((section) => ({
        ...section,
        included: false,
      })),
    };

    const nextDraft = applyPatchToResumeDraft({
      draft: hiddenDraft,
      patch: createPatch({
        operation: "toggle_include",
        newIncluded: true,
        newText: null,
      }),
      updatedAt,
    });

    expect(nextDraft.sections[0]).toMatchObject({ included: true });
    expect(nextDraft.sections[0]?.entries[0]).toMatchObject({
      included: true,
    });
  });
});

const WEAK_GENERATED_BULLET_TEXT =
  "Championed resilient delivery improvements across organizations.";
const WEAK_GENERATED_BULLET_HASH = fnv1a32(
  normalizeText(WEAK_GENERATED_BULLET_TEXT),
);
const MENTORSHIP_BULLET_TEXT =
  "Mentored two designers through their first system launch.";

function createGeneratedDraft(): ResumeDraft {
  return {
    id: "draft_generated",
    jobId: "job_ready",
    status: "needs_review",
    templateId: "classic_ats",
    identity: null,
    sections: [
      {
        id: "section_experience",
        kind: "experience",
        label: "Experience",
        text: null,
        bullets: [],
        entries: [
          {
            id: "experience_1",
            entryType: "experience",
            title: "Senior systems designer",
            subtitle: "Signal Systems",
            location: null,
            dateRange: "2022 – Present",
            startDate: "2022",
            endDate: null,
            isCurrent: true,
            summary: "Tailored summary.",
            bullets: [
              {
                id: "experience_1_bullet_1",
                text: WEAK_GENERATED_BULLET_TEXT,
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                lastGeneratedContentHash: WEAK_GENERATED_BULLET_HASH,
                updatedAt: "2026-08-09T10:00:00.000Z",
              },
            ],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: 0,
            profileRecordId: "experience_1",
            sourceRefs: [],
            updatedAt: "2026-08-09T10:00:00.000Z",
          },
        ],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt: "2026-08-09T10:00:00.000Z",
      },
    ],
    targetPageCount: 2,
    generationMethod: "ai",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    workHistoryReviewAcknowledgments: [],
    claimConfirmations: [],
    issueApprovals: [],
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  };
}

function createGeneratedPatch(
  overrides: Partial<ResumeDraftPatch>,
): ResumeDraftPatch {
  return {
    id: "patch_generated",
    draftId: "draft_generated",
    operation: "update_bullet",
    targetSectionId: "section_experience",
    targetEntryId: "experience_1",
    anchorEntryId: null,
    targetBulletId: "experience_1_bullet_1",
    anchorBulletId: null,
    position: null,
    newText: WEAK_GENERATED_BULLET_TEXT,
    newIncluded: null,
    newLocked: null,
    newBullets: null,
    appliedAt: updatedAt,
    origin: "user",
    conflictReason: null,
    ...overrides,
  };
}

describe("resume workspace patch generated-claim provenance", () => {
  test("normalization-equivalent bullet rewrites keep generated origin and hash", () => {
    const nextDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        newText:
          "championed RESILIENT delivery improvements across organizations",
      }),
      updatedAt,
    });
    const section = nextDraft.sections[0]!;
    const entry = section.entries[0]!;
    const bullet = entry.bullets[0]!;

    // Text is updated but the generated identity survives untouched.
    expect(bullet).toMatchObject({
      origin: "ai_generated",
      lastGeneratedContentHash: WEAK_GENERATED_BULLET_HASH,
    });
    expect(entry.origin).toBe("ai_generated");
    expect(section.origin).toBe("ai_generated");
  });

  test("substantive bullet rewrites flip origin but preserve the historical hash", () => {
    const nextDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        newText: "Rebuilt delivery operations end to end with new tooling.",
      }),
      updatedAt,
    });
    const bullet = nextDraft.sections[0]!.entries[0]!.bullets[0]!;

    expect(bullet.origin).toBe("user_edited");
    // The historical generated hash is never deleted by an edit.
    expect(bullet.lastGeneratedContentHash).toBe(WEAK_GENERATED_BULLET_HASH);
  });

  test("normalization-equivalent summary rewrites keep generated origins", () => {
    const nextDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        operation: "replace_entry_summary",
        newText: "TAILORED summary.",
      }),
      updatedAt,
    });
    const section = nextDraft.sections[0]!;
    const entry = section.entries[0]!;

    expect(entry.summary).toBe("TAILORED summary.");
    expect(entry.origin).toBe("ai_generated");
    expect(section.origin).toBe("ai_generated");
  });

  test("substantive summary rewrites still flip to the patch origin", () => {
    const nextDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        operation: "replace_entry_summary",
        newText: "Owned platform reliability for three product lines.",
      }),
      updatedAt,
    });
    const section = nextDraft.sections[0]!;
    const entry = section.entries[0]!;

    expect(entry.origin).toBe("user_edited");
    expect(section.origin).toBe("user_edited");
  });

  test("assistant-inserted bullets are stamped while user inserts stay unstamped", () => {
    const assistantDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        operation: "insert_bullet",
        targetBulletId: "experience_1_bullet_new",
        newText: MENTORSHIP_BULLET_TEXT,
        origin: "assistant",
      }),
      updatedAt,
    });
    const assistantBullet =
      assistantDraft.sections[0]!.entries[0]!.bullets.at(-1)!;
    expect(assistantBullet.lastGeneratedContentHash).toBe(
      fnv1a32(normalizeText(MENTORSHIP_BULLET_TEXT)),
    );

    const userDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        operation: "insert_bullet",
        targetBulletId: "experience_1_bullet_new",
        newText: MENTORSHIP_BULLET_TEXT,
        origin: "user",
      }),
      updatedAt,
    });
    const userBullet = userDraft.sections[0]!.entries[0]!.bullets.at(-1)!;
    expect(userBullet.origin).toBe("user_edited");
    expect(userBullet.lastGeneratedContentHash ?? null).toBeNull();
  });

  test("a normalization-only patch keeps the line's generated origin", () => {
    const { profile, job } = (() => {
      const seed = createSeed();
      const job = seed.savedJobs.find((entry) => entry.id === "job_ready");
      if (!job) {
        throw new Error("job not found: job_ready");
      }
      return { profile: seed.profile, job };
    })();

    // Whitespace/punctuation-only rewrite with a user patch: without the
    // anti-flip rule this would reclassify the claim as user-authored, and
    // the person's own lines are never fact-checked against them. Case-only rewrites are not a
    // normalization fixture here — mid-sentence capital letters genuinely
    // change classification (they become evidence-required named words), so
    // the canonical classifier fail-closes them to unsupported.
    const patchedDraft = applyPatchToResumeDraft({
      draft: createGeneratedDraft(),
      patch: createGeneratedPatch({
        newText: `  ${WEAK_GENERATED_BULLET_TEXT.replace(/\.$/, "")}  `,
      }),
      updatedAt,
    });
    const afterValidation = validateResumeDraft({
      draft: patchedDraft,
      job,
      profile,
    });

    const rewrittenAssessment = afterValidation.claimAssessments.find(
      (assessment) => assessment.bulletId === "experience_1_bullet_1",
    );
    expect(rewrittenAssessment?.claimOrigin).toBe("ai_generated");
    // Not checked by the model yet; that does not hold the resume back.
    expect(rewrittenAssessment?.status).toBe("review");
    expect(
      hasBlockingResumeClaimAssessment({
        validation: afterValidation,
        draft: patchedDraft,
      }),
    ).toBe(false);
  });
});

describe("R3-118 seasonal date wording", () => {
  test("restores the summers qualifier without changing dates or generated claim origins", () => {
    const draft = createDraft();
    Object.assign(draft.sections[0]!.entries[0]!, {
      dateRange: "June 2019 – August 2022",
      startDate: "June 2019",
      endDate: "August 2022",
      isCurrent: false,
    });
    const entry = draft.sections[0]!.entries[0]!;
    const next = applyPatchToResumeDraft({
      draft,
      patch: createPatch({
        operation: "replace_entry_date_range",
        origin: "assistant",
        newText: "June 2019 – August 2022 (summers)",
      }),
      updatedAt,
    });
    expect(next.sections[0]!.entries[0]).toEqual({
      ...entry,
      dateRange: "June 2019 – August 2022 (summers)",
      updatedAt,
    });
    expect(next.sections[0]!.origin).toBe(draft.sections[0]!.origin);
  });
  test("rejects date wording edits without an entry or on locked content", () => {
    const draft = createDraft();
    expect(() =>
      applyPatchToResumeDraft({
        draft,
        patch: createPatch({
          operation: "replace_entry_date_range",
          targetEntryId: null,
        }),
        updatedAt,
      }),
    ).toThrow("requires a target resume entry");
    draft.sections[0]!.entries[0]!.locked = true;
    expect(() =>
      applyPatchToResumeDraft({
        draft,
        patch: createPatch({
          operation: "replace_entry_date_range",
          origin: "assistant",
        }),
        updatedAt,
      }),
    ).toThrow("locked resume content");
  });
});
