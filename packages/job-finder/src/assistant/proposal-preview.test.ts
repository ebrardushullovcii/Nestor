import { expect, it } from "vitest";
import { createProfileServiceHarness } from "../profile-service.test-support";
import { profileProposalPreview } from "./proposal-preview";

it("shows the complete current and proposed summary, including text beyond old preview limits", async () => {
  const { service } = createProfileServiceHarness();
  const snapshot = await service.read();
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
  const { service } = createProfileServiceHarness();
  const snapshot = await service.read();
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
