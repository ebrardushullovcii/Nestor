import { DatabaseSync } from "node:sqlite";
import { ResumeValidationResultSchema } from "@nordri/contracts";
import { describe, expect, test } from "vitest";
import { createInMemoryJobFinderRepository } from "./index";
import type { JobFinderRepository } from "./index";
import { createTempRepository } from "./file-repository.test-support";
import { createSeed } from "./test-fixtures";

function validation(id: string, draftId: string, validatedAt: string) {
  return ResumeValidationResultSchema.parse({
    id,
    draftId,
    validatedAt,
    issues: [],
    claimAssessments: [],
    draftContentHash: "hash",
    pageCount: null,
  });
}

for (const storage of ["memory", "file"] as const) {
  describe(`${storage} latest resume validations`, () => {
    test("selects only requested drafts' latest results with stable timestamp ties and owned values", async () => {
      const temp =
        storage === "file"
          ? await createTempRepository("nordri-latest-validation-")
          : null;
      const repo: JobFinderRepository = temp
        ? await temp.createRepository()
        : createInMemoryJobFinderRepository(createSeed());
      try {
        const time = "2026-10-13T10:00:00.000Z";
        for (const result of [
          validation("a_old", "draft_a", "2026-10-12T10:00:00.000Z"),
          validation("a_tie_z", "draft_a", time),
          validation("a_tie_a", "draft_a", time),
          validation("b_latest", "draft_b", "2026-10-13T11:00:00.000Z"),
          validation(
            "not_requested",
            "draft_other",
            "2026-10-13T12:00:00.000Z",
          ),
        ])
          await repo.upsertResumeValidationResult(result);
        expect(await repo.listLatestResumeValidationResults([])).toEqual([]);
        const latest = await repo.listLatestResumeValidationResults([
          "draft_a",
          "missing",
          "draft_b",
          "draft_a",
        ]);
        expect(latest.map((result) => result.id)).toEqual([
          "b_latest",
          "a_tie_a",
        ]);
        for (const result of latest)
          expect(result).toEqual(
            (await repo.listResumeValidationResults(result.draftId))[0],
          );
        latest[0]!.draftContentHash = "caller edit";
        expect(
          (await repo.listLatestResumeValidationResults(["draft_b"]))[0]
            ?.draftContentHash,
        ).toBe("hash");
      } finally {
        await repo.close();
        await temp?.cleanup();
      }
    });
  });
}

test("SQLite latest-validation read never parses old or unrelated bodies", async () => {
  const temp = await createTempRepository("nordri-latest-validation-bounded-");
  const repo = await temp.createRepository();
  const db = new DatabaseSync(temp.filePath);
  try {
    await repo.upsertResumeValidationResult(
      validation("old_corrupt", "draft_a", "2026-10-12T10:00:00.000Z"),
    );
    await repo.upsertResumeValidationResult(
      validation("latest_valid", "draft_a", "2026-10-13T10:00:00.000Z"),
    );
    await repo.upsertResumeValidationResult(
      validation(
        "unrelated_corrupt",
        "draft_other",
        "2026-10-13T11:00:00.000Z",
      ),
    );
    db.prepare(
      "UPDATE resume_validation_results SET value='invalid body' WHERE id<>?",
    ).run("latest_valid");
    expect(
      (await repo.listLatestResumeValidationResults(["draft_a"])).map(
        (result) => result.id,
      ),
    ).toEqual(["latest_valid"]);
    expect(() => repo.listResumeValidationResults("draft_a")).toThrow(
      "Corrupted persisted row",
    );
  } finally {
    db.close();
    await repo.close();
    await temp.cleanup();
  }
});
