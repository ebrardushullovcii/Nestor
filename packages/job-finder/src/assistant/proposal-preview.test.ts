import {
  ResumeDraftBulletSchema,
  ResumeDraftPatchSchema,
} from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { createWorkspaceServiceHarness } from "../workspace-service.test-support";
import {
  profileProposalPreview,
  resumeProposalPreview,
} from "./proposal-preview";

it("shows the complete current and proposed summary, including text beyond old preview limits", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  const current = "Current summary with a 23% result. ".repeat(30);
  const proposed = "Senior in-house designer with a 23% result. ".repeat(35);
  snapshot.profile.professionalSummary.fullSummary = current;
  const preview = profileProposalPreview(
    {
      operation: "replace_professional_summary_fields",
      value: { fullSummary: proposed },
    },
    snapshot,
  );
  expect(preview.label).toBe("Update summary");
  expect(preview.detail).toContain(current);
  expect(preview.detail).toContain(proposed);
  expect(preview.detail).not.toContain("fullSummary");
});

it("names the role and changed fields instead of an upsert command", async () => {
  const { workspaceService } = createWorkspaceServiceHarness();
  const snapshot = await workspaceService.getWorkspaceSnapshot();
  const role = snapshot.profile.experiences[0]!;
  role.title = "Research Assistant";
  role.achievements = [
    "Published a synthetic report.",
    "Published a synthetic report.",
  ];
  const preview = profileProposalPreview(
    {
      operation: "upsert_experience_record",
      record: { id: role.id, achievements: [role.achievements[0]!] },
    },
    snapshot,
  );
  expect(preview.label).toBe("Update achievements under Research Assistant");
  expect(preview.detail).toBe(
    "Current achievements: Published a synthetic report.\nPublished a synthetic report.\nProposed achievements: Published a synthetic report.",
  );
  expect(JSON.stringify(preview)).not.toMatch(/upsert|experiences|recordId/u);
});

describe("resume replacements", () => {
  it("shows full section and bullet wording with their current text", async () => {
    const { workspaceService } = createWorkspaceServiceHarness();
    const snapshot = await workspaceService.getWorkspaceSnapshot();
    const workspace = await workspaceService.getResumeWorkspace(
      snapshot.reviewQueue[0]!.jobId,
    );
    const section = workspace.draft.sections[0]!;
    section.text = "Current synthetic summary.";
    section.bullets = [
      ResumeDraftBulletSchema.parse({
        id: "bullet_test",
        text: "Current synthetic achievement.",
        included: true,
        locked: false,
        origin: "user_edited",
        updatedAt: snapshot.generatedAt,
      }),
    ];
    const newText = "The proposed exact sentence. ".repeat(90).trim();
    const patch = ResumeDraftPatchSchema.parse({
      id: "patch_1",
      draftId: workspace.draft.id,
      operation: "replace_section_text",
      targetSectionId: section.id,
      newText,
      origin: "assistant",
      appliedAt: snapshot.generatedAt,
    });
    expect(resumeProposalPreview(patch, workspace.draft).detail).toBe(
      `Current: ${section.text}\nProposed: ${newText}`,
    );
    const bulletPatch = {
      ...patch,
      operation: "update_bullet" as const,
      targetBulletId: "bullet_test",
    };
    expect(resumeProposalPreview(bulletPatch, workspace.draft).detail).toBe(
      `Current: Current synthetic achievement.\nProposed: ${newText}`,
    );
  });
});
