import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import {
  ResumeValidationResultSchema,
  TailoredAssetSchema,
} from "@nestor/contracts";
import { createDisplayCollectionsReader } from "./display-collections";
import { bootstrapState } from "./state";
import { runMigrations } from "./migrations";
import { createSeed } from "../test-fixtures";
import { createTempRepository } from "../file-repository.test-support";

afterEach(() => vi.restoreAllMocks());
const at = "2026-10-13T10:00:00.000Z";
function asset(id: string, body = "Full synthetic resume body") {
  return TailoredAssetSchema.parse({
    id,
    jobId: id,
    kind: "resume",
    status: "ready",
    label: id,
    version: "1",
    templateName: "Classic",
    compatibilityScore: 90,
    progressPercent: 100,
    updatedAt: at,
    contentText: body,
    previewSections: [{ heading: "Summary", lines: [body] }],
  });
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  bootstrapState(db, createSeed());
  return {
    db,
    read: createDisplayCollectionsReader(db),
    put: (value: ReturnType<typeof asset>) => {
      db.prepare(
        "INSERT INTO tailored_assets (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      ).run(value.id, JSON.stringify(value));
    },
  };
}

test("warm collections have zero parses/clones and one changed row leaves other rows/collections intact", async () => {
  const { db, read, put } = fixture();
  try {
    for (let i = 0; i < 1000; i++)
      put(asset(String(i), "Synthetic historical document. ".repeat(400)));
    const before = await read();
    const parse = vi.spyOn(JSON, "parse");
    const clone = vi.spyOn(globalThis, "structuredClone");
    for (let i = 0; i < 100; i++) {
      const current = await read();
      for (const key of Object.keys(before) as Array<keyof typeof before>)
        expect(current[key]).toBe(before[key]);
    }
    expect(parse).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
    parse.mockRestore();
    clone.mockRestore();
    const changedAsset = asset("25", "Changed full document body");
    put(changedAsset);
    const changedParse = vi.spyOn(JSON, "parse");
    const changedClone = vi.spyOn(globalThis, "structuredClone");
    const after = await read();
    expect(changedParse).toHaveBeenCalledTimes(1);
    expect(changedClone).not.toHaveBeenCalled();
    expect(after.resumeDrafts).toBe(before.resumeDrafts);
    expect(
      after.tailoredAssets.filter((row, i) => row !== before.tailoredAssets[i]),
    ).toHaveLength(1);
    expect(after.tailoredAssets.find((row) => row.id === "25")).toEqual(
      changedAsset,
    );
    expect(() =>
      before.tailoredAssets[0]!.previewSections[0]!.lines.push("bad edit"),
    ).toThrow();
  } finally {
    db.close();
  }
});

test("transaction reads, rollback epoch reuse, reset, and corrupt changed rows cannot publish stale bodies", async () => {
  const { db, read, put } = fixture();
  try {
    put(asset("a"));
    const before = await read();
    db.exec("BEGIN");
    put(asset("a", "Uncommitted"));
    put(asset("b"));
    expect((await read()).tailoredAssets[0]?.contentText).toBe("Uncommitted");
    db.exec("ROLLBACK");
    expect((await read()).tailoredAssets).toBe(before.tailoredAssets);
    put(asset("c"));
    expect((await read()).tailoredAssets.map((row) => row.contentText)).toEqual(
      ["Full synthetic resume body", "Full synthetic resume body"],
    );
    db.prepare(
      "UPDATE tailored_assets SET value='invalid JSON' WHERE id='a'",
    ).run();
    await expect(read()).rejects.toThrow(
      'Corrupted persisted row in table "tailored_assets"',
    );
    put(asset("a", "Repaired"));
    expect((await read()).tailoredAssets[0]?.contentText).toBe("Repaired");
    db.exec("BEGIN; DELETE FROM tailored_assets");
    put(asset("replacement"));
    db.exec("COMMIT");
    expect((await read()).tailoredAssets.map((row) => row.id)).toEqual([
      "replacement",
    ]);
  } finally {
    db.close();
  }
});

test("latest validations reuse only latest bodies and reveal older validation after deletion", async () => {
  const { db, read } = fixture();
  const put = (id: string, draftId: string, validatedAt: string) => {
    const value = ResumeValidationResultSchema.parse({
      id,
      draftId,
      validatedAt,
    });
    db.prepare(
      "INSERT INTO resume_validation_results (id, draft_id, validated_at, value) VALUES (?, ?, ?, ?)",
    ).run(id, draftId, validatedAt, JSON.stringify(value));
  };
  try {
    put("older", "draft", at);
    put("latest", "draft", "2026-10-13T11:00:00.000Z");
    put("other", "other", at);
    const before = await read();
    expect(before.latestResumeValidationResults.map((row) => row.id)).toEqual([
      "latest",
      "other",
    ]);
    db.prepare("DELETE FROM resume_validation_results WHERE id='latest'").run();
    const after = await read();
    expect(after.latestResumeValidationResults.map((row) => row.id)).toEqual([
      "older",
      "other",
    ]);
    expect(after.latestResumeValidationResults[1]).toBe(
      before.latestResumeValidationResults[1],
    );
  } finally {
    db.close();
  }
});

test("external connection commits invalidate display state; canonical reads/export/reset remain lossless and owned", async () => {
  const temp = await createTempRepository("nestor-history-cache-external-");
  const repo = await temp.createRepository();
  const external = new DatabaseSync(temp.filePath);
  try {
    await repo.upsertTailoredAsset(asset("a"));
    const before = await repo.readDisplayCollections!();
    const owned = await repo.getTailoredAssetById("a");
    owned!.previewSections[0]!.lines.push("Caller-owned edit");
    expect(
      (await repo.getTailoredAssetById("a"))?.previewSections[0]?.lines,
    ).not.toContain("Caller-owned edit");
    external
      .prepare("UPDATE tailored_assets SET value=? WHERE id='a'")
      .run(JSON.stringify(asset("a", "External body")));
    expect(
      (await repo.readDisplayCollections!()).tailoredAssets[0]?.contentText,
    ).toBe("External body");
    expect((await repo.readDisplayCollections!()).tailoredAssets).not.toBe(
      before.tailoredAssets,
    );
    const exported = await repo.exportState();
    expect(exported.tailoredAssets[0]?.contentText).toBe("External body");
    await repo.reset({
      ...exported,
      tailoredAssets: [asset("imported", "Imported body")],
    });
    expect(
      (await repo.readDisplayCollections!()).tailoredAssets.map(
        (row) => row.id,
      ),
    ).toEqual(["imported"]);
    await repo.reset(exported);
    expect((await repo.exportState()).tailoredAssets[0]?.contentText).toBe(
      "External body",
    );
  } finally {
    external.close();
    await repo.close();
    await temp.cleanup();
  }
});
