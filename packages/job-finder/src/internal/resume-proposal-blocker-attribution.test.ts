import type { ResumeDraftPatch } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { findResumeProposalPatchForBlocker } from "./resume-workspace-helpers";

function patch(
  fields: Partial<ResumeDraftPatch> &
    Pick<ResumeDraftPatch, "id" | "operation" | "targetSectionId">,
): ResumeDraftPatch {
  return {
    draftId: "draft_1",
    targetEntryId: null,
    anchorEntryId: null,
    targetBulletId: null,
    anchorBulletId: null,
    position: null,
    newText: null,
    newIncluded: null,
    newLocked: null,
    newBullets: null,
    appliedAt: "2026-09-24T12:00:00.000Z",
    origin: "assistant",
    conflictReason: null,
    ...fields,
  };
}

describe("findResumeProposalPatchForBlocker", () => {
  const move = patch({
    id: "resume_patch_4",
    operation: "move_bullet",
    targetSectionId: "section_skills",
    targetBulletId: "section_skills_bullet_4",
  });
  const insert = patch({
    id: "resume_patch_9",
    operation: "insert_bullet",
    targetSectionId: "section_skills",
    newText: "Performance",
  });

  test("blames the change that wrote an inserted line, not the first change in its section", () => {
    expect(
      findResumeProposalPatchForBlocker([move, insert], {
        sectionId: "section_skills",
        entryId: null,
        bulletId: "section_skills_bullet_generated",
        flaggedText: "performance",
      }),
    ).toBe("resume_patch_9");
  });

  test("keeps exact target matches first and falls back to the section", () => {
    expect(
      findResumeProposalPatchForBlocker([insert, move], {
        sectionId: "section_skills",
        entryId: null,
        bulletId: "section_skills_bullet_4",
        flaggedText: "Performance",
      }),
    ).toBe("resume_patch_4");
    expect(
      findResumeProposalPatchForBlocker([move, insert], {
        sectionId: "section_skills",
        entryId: null,
        bulletId: "section_skills_bullet_other",
        flaggedText: "Something else",
      }),
    ).toBe("resume_patch_4");
    expect(
      findResumeProposalPatchForBlocker([move], {
        sectionId: null,
        entryId: null,
        bulletId: null,
        flaggedText: null,
      }),
    ).toBeNull();
  });
});
