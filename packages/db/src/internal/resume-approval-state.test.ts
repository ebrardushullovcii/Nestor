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
      db.prepare("SELECT value FROM resume_drafts WHERE id='a'").get()!.value,
    ).toBe(bytes);
    expect(
      db.prepare("SELECT value FROM tailored_assets WHERE id='asset_a'").get()!
        .value,
    ).toBe(assetBytes);
    expect(
      (await repo.readDisplayCollections!()).resumeDrafts.every(
        (d) => d.status === "approved",
      ),
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
      JSON.parse(
        String(
          db.prepare("SELECT value FROM resume_drafts WHERE id='a'").get()!
            .value,
        ),
      ),
    ).toEqual(changed);
    expect(await repo.getResumeDraftByJobId("a")).toEqual(changed);
    const changedAsset = { ...asset, storagePath: null, updatedAt: staleAt };
    expect(await repo.getTailoredAssetById(asset.id)).toEqual(changedAsset);
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT value FROM tailored_assets WHERE id='asset_a'")
            .get()!.value,
        ),
      ),
    ).toEqual(changedAsset);
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

test("a failed body write rolls back all approval fields and the Profile commit", async () => {
  const temp = await createTempRepository("nestor-approval-atomic-");
  const repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    await repo.upsertResumeDraft(draft("a"));
    await repo.upsertResumeDraft(draft("b"));
    db.exec(`CREATE TRIGGER fail_second_body BEFORE UPDATE ON resume_drafts
      WHEN NEW.id='b' BEGIN SELECT RAISE(ABORT, 'synthetic body failure'); END;`);
    const before = await repo.readDisplayCollections!();
    const profile = await repo.getProfile();
    await expect(
      repo.staleResumeDrafts!({
        draftIds: ["a", "b"],
        staleReason: reason,
        updatedAt: staleAt,
        profileInputs: {
          profile: { ...profile, headline: "Changed synthetic headline" },
        },
      }),
    ).rejects.toThrow("synthetic body failure");
    expect(await repo.getProfile()).toEqual(profile);
    expect(await repo.readDisplayCollections!()).toEqual(before);
    for (const row of db.prepare("SELECT id, value FROM resume_drafts").all())
      expect(JSON.parse(String(row.value))).toEqual(draft(String(row.id)));
    expect(
      db.prepare("SELECT count(*) n FROM resume_draft_approval_state").get()!.n,
    ).toBe(0);
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_second_body");
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});

test.each(["local", "external"])(
  "an uncached %s approval edit is folded in the Profile transaction",
  async (writer) => {
    const temp = await createTempRepository("nestor-approval-cache-edit-");
    const repo = await temp.createRepository();
    const db = new DatabaseSync(temp.filePath);
    try {
      await repo.upsertResumeDraft({
        ...draft("a"),
        status: "needs_review",
        approvedAt: null,
      });
      await repo.readDisplayCollections!();
      if (writer === "local") await repo.upsertResumeDraft(draft("a"));
      else
        db.prepare("UPDATE resume_drafts SET value=? WHERE id='a'").run(
          JSON.stringify(draft("a")),
        );
      await repo.staleResumeDrafts!({
        draftIds: ["a"],
        staleReason: reason,
        updatedAt: staleAt,
        profileInputs: { profile: await repo.getProfile() },
      });
      expect(
        JSON.parse(
          String(db.prepare("SELECT value FROM resume_drafts").get()!.value),
        ),
      ).toMatchObject({
        status: "stale",
        staleReason: reason,
        approvedAt: null,
        approvedExportId: null,
      });
    } finally {
      db.close();
      await repo.close();
      await temp.cleanup();
    }
  },
);

test("approval changes reach legacy SQL before returning; cached bodies stay shared", async () => {
  const temp = await createTempRepository("nestor-approval-fold-");
  const repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    for (let i = 0; i < 8; i++) await repo.upsertResumeDraft(draft(String(i)));
    const before = await repo.readDisplayCollections!();
    await repo.staleResumeDrafts!({
      draftIds: before.resumeDrafts.map((d) => d.id),
      staleReason: reason,
      updatedAt: staleAt,
    });
    const pending = () =>
      Number(
        db.prepare("SELECT count(*) n FROM resume_draft_approval_state").get()!
          .n,
      );
    expect(pending()).toBe(0);
    const parse = vi.spyOn(JSON, "parse");
    const after = await repo.readDisplayCollections!();
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    for (const value of after.resumeDrafts) {
      expect(value.sections).toBe(
        before.resumeDrafts.find((d) => d.id === value.id)!.sections,
      );
      const body: unknown = JSON.parse(
        String(
          db
            .prepare("SELECT value FROM resume_drafts WHERE id=?")
            .get(value.id)!.value,
        ),
      );
      expect(body).toEqual(value);
      expect(body).toMatchObject({
        status: "stale",
        staleReason: reason,
        approvedAt: null,
        approvedExportId: null,
      });
    }
  } finally {
    vi.restoreAllMocks();
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});

test("startup reads pending approval state before its background fold; close flushes and later body writes win", async () => {
  const temp = await createTempRepository("nestor-approval-fold-lifecycle-");
  let repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    await repo.upsertResumeDraft(draft("a"));
    await repo.upsertTailoredAsset(
      TailoredAssetSchema.parse({
        id: "asset",
        jobId: "a",
        kind: "resume",
        status: "ready",
        label: "Synthetic",
        version: "1",
        templateName: "Classic",
        compatibilityScore: 90,
        progressPercent: 100,
        updatedAt: originalAt,
        storagePath: "/synthetic.pdf",
      }),
    );
    await repo.close();
    // Simulate a process killed immediately after its atomic profile commit.
    db.prepare("INSERT INTO resume_draft_approval_state VALUES (?, ?, ?)").run(
      "a",
      reason,
      staleAt,
    );
    db.prepare("INSERT INTO tailored_asset_file_state VALUES (?, ?)").run(
      "asset",
      staleAt,
    );
    repo = await temp.createRepository();
    expect((await repo.listResumeDrafts())[0]).toMatchObject({
      status: "stale",
      staleReason: reason,
      approvedAt: null,
      approvedExportId: null,
    });
    expect((await repo.listTailoredAssets())[0]).toMatchObject({
      storagePath: null,
      updatedAt: staleAt,
    });
    const display = await repo.readDisplayCollections!();
    expect(display.resumeDrafts[0]?.status).toBe("stale");
    expect(display.tailoredAssets[0]?.storagePath).toBeNull();
    expect((await repo.exportState()).resumeDrafts[0]?.status).toBe("stale");
    await vi.waitFor(() => {
      expect(
        db.prepare("SELECT count(*) n FROM resume_draft_approval_state").get()!
          .n,
      ).toBe(0);
      expect(
        db.prepare("SELECT count(*) n FROM tailored_asset_file_state").get()!.n,
      ).toBe(0);
    });
    expect(
      JSON.parse(
        String(db.prepare("SELECT value FROM resume_drafts").get()!.value),
      ),
    ).toMatchObject({ status: "stale", staleReason: reason });
    expect(
      JSON.parse(
        String(db.prepare("SELECT value FROM tailored_assets").get()!.value),
      ),
    ).toMatchObject({ storagePath: null, updatedAt: staleAt });

    await repo.staleResumeDrafts!({
      draftIds: ["a"],
      staleReason: "New reason",
      updatedAt: staleAt,
    });
    await repo.upsertResumeDraft(draft("a"));
    await repo.close();
    expect(
      JSON.parse(
        String(db.prepare("SELECT value FROM resume_drafts").get()!.value),
      ),
    ).toEqual(draft("a"));
    repo = await temp.createRepository();
    await repo.staleResumeDrafts!({
      draftIds: ["a"],
      staleReason: "Close reason",
      updatedAt: staleAt,
    });
    await repo.close();
    expect(
      JSON.parse(
        String(db.prepare("SELECT value FROM resume_drafts").get()!.value),
      ),
    ).toMatchObject({ status: "stale", staleReason: "Close reason" });
    repo = await temp.createRepository();
  } finally {
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});

test("unapproved folds yield and retry without publishing rolled-back cache fields", async () => {
  const temp = await createTempRepository("nestor-approval-fold-retry-");
  const repo = await temp.createRepository();
  let closed = false;
  const db = new DatabaseSync(temp.filePath);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await repo.upsertResumeDraft({
      ...draft("a"),
      status: "needs_review",
      approvedAt: null,
      approvedExportId: null,
    });
    await repo.readDisplayCollections!();
    db.exec(`CREATE TRIGGER fail_fold BEFORE UPDATE ON resume_drafts
      BEGIN SELECT RAISE(ABORT, 'synthetic fold failure'); END;`);
    await repo.staleResumeDrafts!({
      draftIds: ["a"],
      staleReason: reason,
      updatedAt: staleAt,
    });
    for (let i = 0; i < 20 && warn.mock.calls.length === 0; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalled();
    expect(
      JSON.parse(
        String(db.prepare("SELECT value FROM resume_drafts").get()!.value),
      ),
    ).toMatchObject({ status: "needs_review", updatedAt: originalAt });
    expect(
      db.prepare("SELECT count(*) n FROM resume_draft_approval_state").get()!.n,
    ).toBe(1);
    expect(
      (await repo.readDisplayCollections!()).resumeDrafts[0],
    ).toMatchObject({ status: "stale", staleReason: reason });
    db.exec("DROP TRIGGER fail_fold");
    await repo.close();
    closed = true;
    expect(
      JSON.parse(
        String(db.prepare("SELECT value FROM resume_drafts").get()!.value),
      ),
    ).toMatchObject({ status: "stale", staleReason: reason });
  } finally {
    db.exec("DROP TRIGGER IF EXISTS fail_fold");
    if (!closed) await repo.close();
    db.close();
    warn.mockRestore();
    await temp.cleanup();
  }
});
