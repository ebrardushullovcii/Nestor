import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { ResumeDraftSchema } from "@nestor/contracts";
import { createTempRepository } from "./file-repository.test-support";

test("canonical draft reads preserve ownership, see external writes and validate changed stored text", async () => {
  const temp = await createTempRepository("nestor-draft-read-");
  const repository = await temp.createRepository();
  const other = new DatabaseSync(temp.filePath);
  const draft = ResumeDraftSchema.parse({
    id: "draft",
    jobId: "job",
    status: "needs_review",
    templateId: "classic_ats",
    sections: [],
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
  });
  try {
    await repository.upsertResumeDraft(draft);
    const read = await repository.getResumeDraftByJobId("job");
    expect(read).toEqual(draft);
    read!.status = "stale";
    expect(await repository.getResumeDraftByJobId("job")).toEqual(draft);
    other
      .prepare("UPDATE resume_drafts SET value=? WHERE id=?")
      .run(JSON.stringify({ ...draft, status: "stale" }), draft.id);
    expect((await repository.getResumeDraftByJobId("job"))?.status).toBe(
      "stale",
    );
    other
      .prepare("UPDATE resume_drafts SET value=? WHERE id=?")
      .run(
        JSON.stringify({
          ...draft,
          status: "invalid",
          privateField: "private resume wording",
        }),
        draft.id,
      );
    expect(() => repository.getResumeDraftByJobId("job")).toThrow(
      'Corrupted persisted row in table "resume_drafts"',
    );
    expect(() => repository.getResumeDraftByJobId("job")).not.toThrow(
      "private resume wording",
    );
  } finally {
    other.close();
    await repository.close();
    await temp.cleanup();
  }
});
