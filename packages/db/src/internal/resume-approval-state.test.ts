import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { ResumeDraftSchema, TailoredAssetSchema } from "@nestor/contracts";
import { createTempRepository } from "../file-repository.test-support";

const originalAt = "2026-10-22T00:00:00.000Z";
const staleAt = "2026-10-23T00:00:00.000Z";
const reason = "Profile details changed.";
function draft(id: string) {
  return ResumeDraftSchema.parse({
    id,
    jobId: id,
    status: "approved",
    templateId: "classic_ats",
    createdAt: originalAt,
    updatedAt: originalAt,
    approvedAt: originalAt,
    sections: [
      {
        id: "summary",
        kind: "summary",
        label: "Summary",
        origin: "user_edited",
        sortOrder: 0,
        text: "Synthetic document body. ".repeat(4000),
        updatedAt: originalAt,
      },
    ],
  });
}

test("approval-only saves reuse bodies and remain canonical across rollback, restart, export and reset", async () => {
  const temp = await createTempRepository("nestor-approval-state-");
  let repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    await repo.upsertResumeDraft(draft("a"));
    await repo.upsertResumeDraft(draft("b"));
    const asset = TailoredAssetSchema.parse({
      id: "asset_a",
      jobId: "a",
      kind: "resume",
      status: "ready",
      label: "Synthetic resume",
      version: "1",
      templateName: "Classic",
      compatibilityScore: 90,
      progressPercent: 100,
      updatedAt: originalAt,
      contentText: "Synthetic document body. ".repeat(4000),
      storagePath: "/synthetic/resume.pdf",
    });
    await repo.upsertTailoredAsset(asset);
    const before = await repo.readDisplayCollections!();
    const bytes = db
      .prepare("SELECT value FROM resume_drafts WHERE id='a'")
      .get()!.value;
    const assetBytes = db
      .prepare("SELECT value FROM tailored_assets WHERE id='asset_a'")
      .get()!.value;
    const profile = {
      ...(await repo.getProfile()),
      headline: "Synthetic changed profile",
    };
    const preferences = {
      ...(await repo.getSearchPreferences()),
      targetRoles: ["Synthetic role"],
    };
    // A failure after the approval rows were written must roll back the whole save.
    db.exec(`CREATE TRIGGER fail_profile BEFORE UPDATE ON singleton_state WHEN NEW.key='profile'
      BEGIN SELECT RAISE(ABORT, 'synthetic commit failure'); END;`);
    await expect(
      repo.staleResumeDrafts!({
        draftIds: ["a", "b"],
        staleReason: reason,
        updatedAt: staleAt,
        profileInputs: { profile, searchPreferences: preferences },
      }),
    ).rejects.toThrow("synthetic commit failure");
    expect(await repo.getProfile()).not.toEqual(profile);
    expect(
      (await repo.listResumeDrafts()).every((d) => d.status === "approved"),
    ).toBe(true);
    expect(
      db.prepare("SELECT count(*) n FROM resume_draft_approval_state").get()!.n,
    ).toBe(0);
    db.exec("DROP TRIGGER fail_profile");
    // Warm the committed body cache after the other connection's schema changes.
    const warm = await repo.readDisplayCollections!();
    const parse = vi.spyOn(JSON, "parse");
    await repo.staleResumeDrafts!({
      draftIds: ["a"],
      staleReason: reason,
      updatedAt: staleAt,
      profileInputs: { profile, searchPreferences: preferences },
    });
    const after = await repo.readDisplayCollections!();
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    const changed = after.resumeDrafts.find((d) => d.id === "a")!;
    expect(changed.sections).toBe(
      warm.resumeDrafts.find((d) => d.id === "a")!.sections,
    );
    expect(after.resumeDrafts.find((d) => d.id === "b")).toBe(
      warm.resumeDrafts.find((d) => d.id === "b"),
    );
    expect(changed).toEqual({
      ...before.resumeDrafts.find((d) => d.id === "a"),
      status: "stale",
      staleReason: reason,
      approvedAt: null,
      approvedExportId: null,
      updatedAt: staleAt,
    });
    expect(
      db.prepare("SELECT value FROM resume_drafts WHERE id='a'").get()!.value,
    ).toBe(bytes);
    expect(await repo.getResumeDraftByJobId("a")).toEqual(changed);
    const changedAsset = { ...asset, storagePath: null, updatedAt: staleAt };
    expect(await repo.getTailoredAssetById(asset.id)).toEqual(changedAsset);
    expect(
      db.prepare("SELECT value FROM tailored_assets WHERE id='asset_a'").get()!
        .value,
    ).toBe(assetBytes);
    expect(await repo.getProfile()).toEqual(profile);
    expect(await repo.getSearchPreferences()).toEqual(preferences);
    const exported = await repo.exportState();
    expect(exported.resumeDrafts.find((d) => d.id === "a")).toEqual(changed);
    await repo.close();
    repo = await temp.createRepository();
    expect(await repo.getResumeDraftByJobId("a")).toEqual(changed);
    expect(await repo.getTailoredAssetById(asset.id)).toEqual(changedAsset);
    await repo.reset(exported);
    expect(await repo.getResumeDraftByJobId("a")).toEqual(changed);
    expect(
      db.prepare("SELECT count(*) n FROM resume_draft_approval_state").get()!.n,
    ).toBe(0);
    await repo.upsertResumeDraft(draft("a"));
    await repo.upsertTailoredAsset(asset);
    expect((await repo.readDisplayCollections!()).tailoredAssets[0]).toEqual(
      asset,
    );
    expect(
      (await repo.readDisplayCollections!()).resumeDrafts.find(
        (d) => d.id === "a",
      )!.status,
    ).toBe("approved");
  } finally {
    vi.restoreAllMocks();
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});

test("an existing workspace gains approval state without changing draft bytes", async () => {
  const temp = await createTempRepository("nestor-approval-upgrade-");
  let repo = await temp.createRepository();
  try {
    await repo.upsertResumeDraft(draft("legacy"));
    await repo.close();
    const legacy = new DatabaseSync(temp.filePath);
    legacy.exec(`DROP TRIGGER resume_draft_approval_body_insert;
      DROP TRIGGER resume_draft_approval_body_update;
      DROP TRIGGER resume_draft_approval_body_delete;
      DROP TABLE resume_draft_approval_state;`);
    legacy.close();
    repo = await temp.createRepository();
    expect(await repo.getResumeDraftByJobId("legacy")).toEqual(draft("legacy"));
    await repo.staleResumeDrafts!({
      draftIds: ["legacy"],
      staleReason: reason,
      updatedAt: staleAt,
    });
    expect((await repo.readDisplayCollections!()).resumeDrafts[0]!.status).toBe(
      "stale",
    );
  } finally {
    await repo.close();
    await temp.cleanup();
  }
});
