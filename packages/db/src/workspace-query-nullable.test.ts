import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { createSavedJob, createTempRepository } from "./file-repository.test-support";
import { createWorkspaceQueryRepository, prepareWorkspaceQueryDatabase } from "./workspace-query-repository";

test("nullable posting fields survive index creation, rebuild and detail reads", async () => {
  const temp = await createTempRepository("nestor-query-nullable-");
  const writer = await temp.createRepository();
  try {
    const job = createSavedJob({id: "no-apply-url", applicationUrl: null, postedAt: null, postedAtText: null,
      providerUpdatedAt: null, firstSeenAt: null, lastSeenAt: null, lastVerifiedActiveAt: null, salaryText: null,
      seniority: null, employmentType: null, department: null, team: null, employerWebsiteUrl: null,
      employerDomain: null, atsProvider: null, providerKey: null, providerBoardToken: null, providerIdentifier: null,
      resumeApplicationMode: null, resumeTailoringMode: null});
    await writer.commitSavedJobDelta({upserts: [job]});
    const db = new DatabaseSync(temp.filePath);
    try {
      expect(db.prepare("PRAGMA table_info(workspace_job_index)").all().find(row => row.name === "application_url")?.notnull).toBe(0);
      db.exec("UPDATE workspace_read_meta SET value = 'old-version' WHERE key = 'version'");
    } finally { db.close(); }
    prepareWorkspaceQueryDatabase(temp.filePath);
    const reader = createWorkspaceQueryRepository(temp.filePath);
    try {
      expect(reader.queryJobList({list: "all", filters: {planId: null}}).rows[0]).toMatchObject({id: job.id, applicationUrl: null, postedAt: null, salaryText: null});
      expect(reader.getJobDetail(job.id)?.job.applicationUrl).toBeNull();
    } finally { reader.close(); }
  } finally { await writer.close(); await temp.cleanup(); }
});
