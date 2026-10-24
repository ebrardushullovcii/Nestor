import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
import { ResumeDraftSchema } from "@nestor/contracts";
import { createTempRepository } from "./file-repository.test-support";

test("canonical draft reads preserve ownership, see external writes without parsing owned rows again", async () => {
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
    const parse = vi.spyOn(ResumeDraftSchema, "parse");
    try {
      expect((await repository.getResumeDraftByJobId("job"))?.status).toBe(
        "stale",
      );
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  } finally {
    other.close();
    await repository.close();
    await temp.cleanup();
  }
});
