import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ResumeDraftSchema, SavedJobListFactsSchema } from "@nestor/contracts";
import { afterEach, expect, test, vi } from "vitest";
import { createFileJobFinderRepository } from "../file-repository";
import { createSavedJob } from "../file-repository.test-support";
import { createSeed } from "../test-fixtures";
import { createSavedJobProjectionReader } from "./saved-job-projection";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function workspaceFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "saved-job-marks-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "workspace.sqlite");
  const db = new DatabaseSync(filePath);
  db.exec("CREATE TABLE saved_jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.close();
  return filePath;
}

/** One start of the app: a connection and a reader for one build. */
function start(
  filePath: string,
  validationStamp: string | null,
  sqliteDetails = false,
) {
  const db = new DatabaseSync(filePath);
  cleanups.push(() => db.isOpen && db.close());
  return {
    db,
    read: createSavedJobProjectionReader(db, {
      validationStamp,
      sqliteDetails,
    }),
  };
}

function put(db: DatabaseSync, value: object & { id: string }): void {
  db.prepare("INSERT OR REPLACE INTO saved_jobs VALUES (?, ?)").run(
    value.id,
    JSON.stringify(value),
  );
}

function marks(db: DatabaseSync): string[] {
  return db
    .prepare(
      `SELECT validated_row_id AS id, validated_stamp AS stamp
        FROM row_validations WHERE validated_table = 'saved_jobs'
        ORDER BY validated_row_id`,
    )
    .all()
    .map((row) => `${String(row.id)}:${String(row.stamp)}`);
}

/** A row an older build wrote, before keySkills had a default. */
function olderRow(id: string) {
  const row: Partial<ReturnType<typeof createSavedJob>> = createSavedJob({
    id,
  });
  delete row.keySkills;
  return { ...row, id };
}

test("a build marks the rows it validated unchanged, and any write drops the mark", async () => {
  const filePath = workspaceFile();
  const first = start(filePath, "build-1");
  put(first.db, createSavedJob({ id: "a" }));
  put(first.db, createSavedJob({ id: "b" }));
  put(first.db, olderRow("c"));

  const jobs = await first.read();
  expect(jobs.find((job) => job.id === "c")?.keySkills).toEqual([]);
  // The older row parses differently from its text, so it is never marked.
  expect(marks(first.db)).toEqual(["a:build-1", "b:build-1"]);

  first.db
    .prepare(
      "UPDATE saved_jobs SET value = json_set(value, '$.title', 'Edited') WHERE id = ?",
    )
    .run("b");
  put(first.db, createSavedJob({ id: "a", title: "Replaced" }));
  expect(marks(first.db)).toEqual([]);
  first.db.close();

  const second = start(filePath, "build-1");
  expect((await second.read()).map((job) => job.title)).toEqual([
    "Replaced",
    "Edited",
    "Lead Designer",
  ]);
  expect(marks(second.db)).toEqual(["a:build-1", "b:build-1"]);
  second.db.prepare("DELETE FROM saved_jobs WHERE id = ?").run("a");
  expect(marks(second.db)).toEqual(["b:build-1"]);
  second.db.close();

  const nextBuild = start(filePath, "build-2");
  await nextBuild.read();
  expect(marks(nextBuild.db)).toEqual(["b:build-2"]);
});

test("only the build that marked a row skips its schema", async () => {
  const filePath = workspaceFile();
  const setup = start(filePath, "build-1");
  put(setup.db, olderRow("c"));
  // Stands in for a mark: proves a marked row is used exactly as stored.
  setup.db
    .prepare("INSERT INTO row_validations VALUES ('saved_jobs', ?, ?)")
    .run("c", "build-1");
  setup.db.close();

  const sameBuild = start(filePath, "build-1");
  const [asStored] = await sameBuild.read();
  expect(asStored?.keySkills).toBeUndefined();
  sameBuild.db.close();

  const otherBuild = start(filePath, "build-2");
  const [validated] = await otherBuild.read();
  expect(validated?.keySkills).toEqual([]);
});

test("a full unchanged validation also proves list facts, until a write or a new build", async () => {
  const filePath = workspaceFile();
  const first = start(filePath, "build-1", true);
  put(first.db, createSavedJob({ id: "a" }));
  await first.read();
  await first.read.validation();
  expect(marks(first.db)).toEqual(["a:build-1"]);
  first.db.close();

  const parse = vi.spyOn(SavedJobListFactsSchema, "parse");
  try {
    const sameBuild = start(filePath, "build-1", true);
    expect((await sameBuild.read())[0]!.title).toBe("Lead Designer");
    expect(parse).not.toHaveBeenCalled();
    put(sameBuild.db, createSavedJob({ id: "a", title: "Edited" }));
    expect((await sameBuild.read())[0]!.title).toBe("Edited");
    expect(parse).toHaveBeenCalledTimes(1);
    sameBuild.db.close();

    const nextBuild = start(filePath, "build-2", true);
    expect((await nextBuild.read())[0]!.title).toBe("Edited");
    expect(parse).toHaveBeenCalledTimes(2);
    await nextBuild.read.validation();
  } finally {
    parse.mockRestore();
  }
});

test("a missing trigger drops every mark before the next read", async () => {
  const filePath = workspaceFile();
  const first = start(filePath, "build-1");
  put(first.db, createSavedJob({ id: "a" }));
  await first.read();
  expect(marks(first.db)).toEqual(["a:build-1"]);
  // A table rebuilt by some other code loses its triggers; its writes then
  // go unseen until the next start notices.
  first.db.exec("DROP TRIGGER row_validations_saved_jobs_update");
  first.db
    .prepare("UPDATE saved_jobs SET value = ? WHERE id = ?")
    .run(JSON.stringify(olderRow("a")), "a");
  first.db.close();

  const second = start(filePath, "build-1");
  expect(marks(second.db)).toEqual([]);
  const [job] = await second.read();
  expect(job?.keySkills).toEqual([]);
});

test("without a stamp nothing is marked and no table is added", async () => {
  const filePath = workspaceFile();
  const { db, read } = start(filePath, null);
  put(db, createSavedJob({ id: "a" }));
  expect((await read()).map((job) => job.id)).toEqual(["a"]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name LIKE 'row_validations%'",
      )
      .all(),
  ).toEqual([]);
});

test("the workspace marks the saved jobs and drafts it read; staling a draft unmarks it", async () => {
  const filePath = workspaceFile();
  const repository = await createFileJobFinderRepository({
    filePath,
    seed: createSeed(),
    rowValidationStamp: Promise.resolve("build-1"),
  });
  cleanups.push(() => repository.close());
  await repository.commitSavedJobDelta({
    upserts: [
      createSavedJob({ id: "job_a" }),
      createSavedJob({ id: "job_b" }),
    ],
  });
  const draft = (id: string, jobId: string, approved: boolean) =>
    ResumeDraftSchema.parse({
      id,
      jobId,
      status: approved ? "approved" : "needs_review",
      templateId: "classic_ats",
      identity: null,
      sections: [],
      targetPageCount: 2,
      generationMethod: "manual",
      approvedAt: approved ? "2026-07-30T10:00:00.000Z" : null,
      approvedExportId: null,
      staleReason: null,
      createdAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:00:00.000Z",
    });
  await repository.upsertResumeDraft(draft("draft_a", "job_a", true));
  await repository.upsertResumeDraft(draft("draft_b", "job_b", false));
  await repository.readSavedJobsProjection();
  await repository.readDisplayCollections!();
  const db = new DatabaseSync(filePath, { readOnly: true });
  cleanups.push(() => db.isOpen && db.close());
  const allMarks = () =>
    db
      .prepare(
        `SELECT validated_table || ':' || validated_row_id AS mark
          FROM row_validations ORDER BY 1`,
      )
      .all()
      .map((row) => String(row.mark));
  await vi.waitFor(() =>
    expect(allMarks()).toEqual([
      "resume_drafts:draft_a",
      "resume_drafts:draft_b",
      "saved_jobs:job_a",
      "saved_jobs:job_b",
    ]),
  );

  await repository.staleResumeDrafts!({
    draftIds: ["draft_a", "draft_b"],
    staleReason: "Profile details changed.",
    updatedAt: "2026-07-31T09:00:00.000Z",
  });
  // An approved body is rewritten in the same commit so an older build never
  // reads it as approved (ADR 0059); that unmarks it. A draft with nothing to
  // un-approve keeps its validated body and its mark.
  expect(allMarks()).toEqual([
    "resume_drafts:draft_b",
    "saved_jobs:job_a",
    "saved_jobs:job_b",
  ]);
  const { resumeDrafts } = await repository.readDisplayCollections!();
  expect(resumeDrafts.map((draft) => draft.status)).toEqual([
    "stale",
    "stale",
  ]);
});
