import { describe, expect, test } from "vitest";
import type {
  ResumeDraft,
  WorkHistoryReviewAcknowledgment,
} from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";

import {
  buildResumeDraftContentHash,
  buildResumeDraftStateHash,
} from "./resume-workspace-helpers";

const updatedAt = "2026-08-09T10:00:00.000Z";

function legacyStableContentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function createAcknowledgment(
  overrides: Partial<WorkHistoryReviewAcknowledgment> = {},
): WorkHistoryReviewAcknowledgment {
  return {
    id: "work_history_ack_experience_2",
    draftId: "resume_draft_hash",
    profileRecordId: "experience_2",
    kind: "weak_fit",
    action: "consider_showing",
    messageContentHash: "fnv1a32:0a1b2c3d",
    reason: "intentional_omission",
    acknowledgedAt: "2026-08-09T11:00:00.000Z",
    ...overrides,
  };
}

function createDraft(): ResumeDraft {
  return {
    id: "resume_draft_hash",
    jobId: "job_hash",
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
            summary: "Owned platform reliability work.",
            bullets: [
              {
                id: "experience_1_bullet_1",
                text: "Led rollout of reliability dashboards across core services.",
                origin: "ai_generated",
                locked: false,
                included: true,
                sourceRefs: [],
                lastGeneratedContentHash: null,
                updatedAt,
              },
            ],
            origin: "ai_generated",
            locked: false,
            included: true,
            sortOrder: 0,
            profileRecordId: "experience_1",
            sourceRefs: [],
            updatedAt,
          },
        ],
        origin: "ai_generated",
        locked: false,
        included: true,
        sortOrder: 0,
        entryOrderMode: "chronology",
        profileRecordId: null,
        sourceRefs: [],
        updatedAt,
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
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("resume draft hash invariants", () => {
  test("excludes work-history review acknowledgments from content and state hashes", () => {
    const base = createDraft();
    const baselineContentHash = buildResumeDraftContentHash(base);
    const baselineStateHash = buildResumeDraftStateHash(base);
    const withAcknowledgment: ResumeDraft = {
      ...base,
      workHistoryReviewAcknowledgments: [createAcknowledgment()],
    };
    const withChangedAcknowledgment: ResumeDraft = {
      ...base,
      workHistoryReviewAcknowledgments: [
        createAcknowledgment({
          id: "work_history_ack_experience_3",
          profileRecordId: "experience_3",
          kind: "compact_recommended",
          action: "keep_compact",
          messageContentHash: "fnv1a32:ffffffff",
          reason: "intentional_compaction",
          acknowledgedAt: "2026-08-09T12:00:00.000Z",
        }),
      ],
    };
    const withoutAcknowledgment: ResumeDraft = {
      ...withAcknowledgment,
      workHistoryReviewAcknowledgments: [],
    };

    for (const variant of [
      withAcknowledgment,
      withChangedAcknowledgment,
      withoutAcknowledgment,
    ]) {
      expect(buildResumeDraftContentHash(variant)).toBe(baselineContentHash);
      expect(buildResumeDraftStateHash(variant)).toBe(baselineStateHash);
    }
  });

  test("still changes hashes for normal resume content edits", () => {
    const base = createDraft();
    const editedDraft: ResumeDraft = {
      ...base,
      sections: base.sections.map((section) => ({
        ...section,
        entries: section.entries.map((entry) => ({
          ...entry,
          bullets: entry.bullets.map((bullet) =>
            bullet.id === "experience_1_bullet_1"
              ? {
                  ...bullet,
                  text: "Rewrote the grounded achievement statement.",
                }
              : bullet,
          ),
        })),
      })),
    };
    const retargetedDraft: ResumeDraft = { ...base, targetPageCount: 1 };

    expect(buildResumeDraftContentHash(editedDraft)).not.toBe(
      buildResumeDraftContentHash(base),
    );
    expect(buildResumeDraftStateHash(editedDraft)).not.toBe(
      buildResumeDraftStateHash(base),
    );
    expect(buildResumeDraftStateHash(retargetedDraft)).not.toBe(
      buildResumeDraftStateHash(base),
    );
  });

  test("keeps legacy stableContentHash digests byte-identical after core migration", () => {
    const base = createDraft();

    expect(buildResumeDraftContentHash(base)).toBe("fnv1a32:33aa2b80");
    expect(buildResumeDraftStateHash(base)).toBe("fnv1a32:3059b1b8");
    expect(buildResumeDraftStateHash({ ...base, targetPageCount: 1 })).toBe(
      "fnv1a32:da55ed3f",
    );
  });

  test("core fnv1a32 matches the retired local hash implementation", () => {
    for (const value of [
      "",
      "resume_draft_hash",
      "section_bullet\u0000experience_1_bullet_1",
      "\u{1F680}",
      "\u{1D11E}music",
      "h\u00E9llo \u{1F30D}",
    ]) {
      expect(fnv1a32(value)).toBe(legacyStableContentHash(value));
    }
  });
});
