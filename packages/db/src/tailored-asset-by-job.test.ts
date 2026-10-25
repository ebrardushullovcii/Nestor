import { DatabaseSync } from "node:sqlite";
import { TailoredAssetSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import { createInMemoryJobFinderRepository } from "./index";
import type { JobFinderRepository } from "./index";
import { createTempRepository } from "./file-repository.test-support";
import { runMigrations } from "./internal/migrations";
import { TAILORED_ASSET_JOB_ID_SQL } from "./internal/tailored-asset-storage";
import { createSeed } from "./test-fixtures";

function asset(id: string, jobId: string) {
  return TailoredAssetSchema.parse({
    id,
    jobId,
    kind: "resume",
    status: "ready",
    label: id,
    version: "1",
    templateName: "Classic",
    compatibilityScore: 90,
    progressPercent: 100,
    updatedAt: "2026-10-13T10:00:00.000Z",
    contentText: "Full synthetic resume body",
    previewSections: [{ heading: "Summary", lines: ["Synthetic evidence"] }],
  });
}

for (const storage of ["memory", "file"] as const) {
  describe(`${storage} selected-job tailored asset`, () => {
    test("matches the existing list's first row and returns caller-owned nested values", async () => {
      const temp =
        storage === "file"
          ? await createTempRepository("nestor-selected-tailored-asset-")
          : null;
      const repo: JobFinderRepository = temp
        ? await temp.createRepository()
        : createInMemoryJobFinderRepository(createSeed());
      try {
        for (const row of [
          asset("z_first_inserted", "selected"),
          asset("unrelated", "another"),
          asset("a_first_sorted", "selected"),
        ])
          await repo.upsertTailoredAsset(row);
        const expected = (await repo.listTailoredAssets()).find(
          (row) => row.jobId === "selected",
        );
        const selected = await repo.getTailoredAssetByJobId("selected");
        expect(selected).toEqual(expected);
        expect(selected?.id).toBe(
          storage === "memory" ? "z_first_inserted" : "a_first_sorted",
        );
        expect(await repo.getTailoredAssetByJobId("missing")).toBeNull();
        selected!.contentText = "Caller edit";
        selected!.previewSections[0]!.lines.push("Caller nested edit");
        expect(await repo.getTailoredAssetByJobId("selected")).toEqual(
          expected,
        );
        expect(await repo.getTailoredAssetById(expected!.id)).toEqual(expected);

        await repo.upsertTailoredAsset({ ...expected!, jobId: "moved" });
        expect((await repo.getTailoredAssetByJobId("moved"))?.id).toBe(
          expected!.id,
        );
        expect((await repo.getTailoredAssetByJobId("selected"))?.id).not.toBe(
          expected!.id,
        );
        await repo.reset({
          ...createSeed(),
          tailoredAssets: [asset("reset", "selected")],
        });
        expect((await repo.getTailoredAssetByJobId("selected"))?.id).toBe(
          "reset",
        );
        expect(await repo.getTailoredAssetByJobId("moved")).toBeNull();
      } finally {
        await repo.close();
        await temp?.cleanup();
      }
    });
  });
}

test("SQLite selected-job lookup uses the index and never parses unrelated or later matching bodies", async () => {
  const temp = await createTempRepository("nestor-tailored-bounded-");
  const repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    const selected = asset("a_selected", "selected");
    await repo.upsertTailoredAsset(selected);
    await repo.upsertTailoredAsset(asset("z_later_selected", "selected"));
    await repo.upsertTailoredAsset(asset("unrelated", "another"));
    db.prepare("UPDATE tailored_assets SET value=? WHERE id=?").run(
      JSON.stringify({ jobId: "selected" }),
      "z_later_selected",
    );
    db.prepare(
      "UPDATE tailored_assets SET value='invalid JSON' WHERE id=?",
    ).run("unrelated");
    // An older workspace may contain bad JSON before this index is installed.
    db.exec("DROP INDEX tailored_assets_job_id_idx");
    expect(() => runMigrations(db)).not.toThrow();
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT id, value FROM tailored_assets WHERE ${TAILORED_ASSET_JOB_ID_SQL} = ? ORDER BY id LIMIT 1`,
      )
      .all("selected");
    expect(plan.map((row) => row.detail).join(" ")).toContain(
      "USING INDEX tailored_assets_job_id_idx",
    );
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(await repo.getTailoredAssetByJobId("selected")).toEqual(selected);
      expect(parse).toHaveBeenCalledTimes(1);
      parse.mockClear();
      expect(await repo.getTailoredAssetByJobId("missing")).toBeNull();
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    expect(await repo.getTailoredAssetById("a_selected")).toEqual(selected);
    expect(() => repo.getTailoredAssetById("unrelated")).toThrow(
      "Corrupted persisted row",
    );
    expect(() => repo.listTailoredAssets()).toThrow("Corrupted persisted row");
    db.prepare("DELETE FROM tailored_assets WHERE id=?").run("a_selected");
    db.prepare(
      "UPDATE tailored_assets SET value='invalid JSON' WHERE id=?",
    ).run("z_later_selected");
    expect(await repo.getTailoredAssetByJobId("selected")).toBeNull();
    expect(() => repo.getTailoredAssetById("z_later_selected")).toThrow(
      "Corrupted persisted row",
    );
  } finally {
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});
