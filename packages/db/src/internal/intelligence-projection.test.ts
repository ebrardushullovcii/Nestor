import { DatabaseSync } from "node:sqlite";
import { JobFinderIntelligenceStateSchema } from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInMemoryJobFinderRepository } from "../index";
import {
  createSavedJob,
  createTempRepository,
} from "../file-repository.test-support";
import { createSeed } from "../test-fixtures";
import { createIntelligenceProjectionReader } from "./intelligence-projection";

afterEach(() => vi.restoreAllMocks());

function intelligence(updatedAt = "2026-10-13T10:00:00.000Z") {
  return JobFinderIntelligenceStateSchema.parse({
    updatedAt,
    resumeOnShortlistJobIds: ["synthetic_job"],
  });
}

for (const mode of ["memory", "file"] as const) {
  describe(`${mode} intelligence display projection`, () => {
    test("warm reads reuse frozen state without parsing/cloning; canonical reads and updaters stay owned", async () => {
      const temp =
        mode === "file"
          ? await createTempRepository("nestor-intelligence-projection-")
          : null;
      const repo = temp
        ? await temp.createRepository()
        : createInMemoryJobFinderRepository(createSeed());
      let closed = false;
      try {
        await repo.saveIntelligenceState(intelligence());
        const before = await repo.readIntelligenceProjection!();
        const parse = vi.spyOn(JSON, "parse");
        const clone = vi.spyOn(globalThis, "structuredClone");
        expect(await repo.readIntelligenceProjection!()).toBe(before);
        expect(await repo.readIntelligenceProjection!()).toBe(before);
        expect(parse).not.toHaveBeenCalled();
        expect(clone).not.toHaveBeenCalled();
        parse.mockRestore();
        clone.mockRestore();
        expect(() => before.resumeOnShortlistJobIds!.push("illegal")).toThrow();
        expect(() => before.resumeOnShortlistJobIds!.splice(0, 1)).toThrow();
        const owned = await repo.getIntelligenceState();
        owned.updatedAt = "2026-10-13T10:02:00.000Z";
        owned.resumeOnShortlistJobIds![0] = "caller mutation";
        expect(await repo.getIntelligenceState()).toEqual(intelligence());
        await repo.commitSavedJobDelta({
          upserts: [createSavedJob({ id: "unrelated" })],
        });
        expect(await repo.readIntelligenceProjection!()).toBe(before);
        await repo.saveIntelligenceState({
          ...intelligence(),
          resumeOnShortlistJobIds: ["updated_job"],
        });
        const after = await repo.readIntelligenceProjection!();
        expect(after).not.toBe(before);
        expect(after.resumeOnShortlistJobIds).toEqual(["updated_job"]);
        const imported = await repo.exportState();
        await repo.reset(createSeed());
        expect(
          (await repo.readIntelligenceProjection!()).resumeOnShortlistJobIds,
        ).toBeUndefined();
        await repo.reset(imported);
        expect(await repo.readIntelligenceProjection!()).toEqual(
          imported.intelligence,
        );
        if (temp) {
          await repo.close();
          closed = true;
          const reopened = await temp.createRepository();
          try {
            expect(await reopened.readIntelligenceProjection!()).toEqual(
              imported.intelligence,
            );
            expect(await reopened.getIntelligenceState()).toEqual(
              imported.intelligence,
            );
          } finally {
            await reopened.close();
          }
        }
      } finally {
        if (!closed) await repo.close();
        await temp?.cleanup();
      }
    });
  });
}

test("singleton cache observes local writes, key removal, external commits, and rolled-back revision reuse", async () => {
  const temp = await createTempRepository("nestor-intelligence-cache-epoch-");
  const repo = await temp.createRepository();
  await repo.saveIntelligenceState(intelligence());
  await repo.close();
  const raw = new DatabaseSync(temp.filePath);
  const other = new DatabaseSync(temp.filePath);
  try {
    const read = createIntelligenceProjectionReader(raw);
    const put = (db: DatabaseSync, time: string) =>
      db
        .prepare(
          "UPDATE singleton_state SET value=?, revision=revision+1 WHERE key='intelligence_state'",
        )
        .run(JSON.stringify(intelligence(time)));
    const original = await read();
    raw.exec("BEGIN");
    put(raw, "2026-10-13T10:01:00.000Z");
    expect((await read()).updatedAt).toBe("2026-10-13T10:01:00.000Z");
    raw.exec("ROLLBACK");
    expect(await read()).toBe(original);
    raw.exec("BEGIN");
    put(raw, "2026-10-13T10:02:00.000Z");
    expect((await read()).updatedAt).toBe("2026-10-13T10:02:00.000Z");
    raw.exec("COMMIT");
    const committed = await read();
    expect(committed.updatedAt).toBe("2026-10-13T10:02:00.000Z");
    other.exec("BEGIN");
    put(other, "2026-10-13T10:03:00.000Z");
    expect(await read()).toBe(committed);
    other.exec("ROLLBACK");
    expect(await read()).toBe(committed);
    // External writers need not increment the singleton's revision.
    other
      .prepare(
        "UPDATE singleton_state SET value=? WHERE key='intelligence_state'",
      )
      .run(JSON.stringify(intelligence("2026-10-13T10:04:00.000Z")));
    expect((await read()).updatedAt).toBe("2026-10-13T10:04:00.000Z");
    expect(() =>
      raw
        .prepare(
          "UPDATE singleton_state SET value=? WHERE key='intelligence_state'",
        )
        .run("synthetic-private-invalid-json"),
    ).toThrow("malformed JSON");
    expect((await read()).updatedAt).toBe("2026-10-13T10:04:00.000Z");
    raw.exec("DELETE FROM singleton_state WHERE key='intelligence_state'");
    expect(await read()).toEqual(JobFinderIntelligenceStateSchema.parse({}));
    raw
      .prepare(
        "INSERT INTO singleton_state (key, value) VALUES ('intelligence_state', ?)",
      )
      .run(JSON.stringify(intelligence()));
    expect(await read()).toEqual(intelligence());
    raw.exec(
      "UPDATE singleton_state SET key='removed_intelligence' WHERE key='intelligence_state'",
    );
    expect(await read()).toEqual(JobFinderIntelligenceStateSchema.parse({}));
  } finally {
    other.close();
    raw.close();
    await temp.cleanup();
  }
});
