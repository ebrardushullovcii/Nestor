import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openJobStore, type JobStore } from "./job-store";
import { createResumeStore } from "./resumes";

const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it("reads a saved draft that still holds claimConfirmations and drops them", () => {
  const store = openJobStore(":memory:");
  stores.push(store);
  const resumes = createResumeStore(store);
  store
    .sql(
      `INSERT INTO jobs(id,stage,stage_at,title,company,location,found_at,seen_at,source_label,url) VALUES(1,'shortlisted',1,'Analyst','Synthetic Employer','Berlin',1,1,'Board','https://synthetic.test/jobs/1')`,
    )
    .run();
  resumes.startWriting(1, "tailored");
  const saved = readFileSync(
    path.join(__dirname, "stored-json", "resume-draft.full.json"),
    "utf8",
  );
  const row = JSON.parse(saved) as {
    id: string;
    claimConfirmations: unknown[];
  };
  expect(row.claimConfirmations).toHaveLength(1);
  store
    .sql("UPDATE resumes SET state='ready', draft_json=? WHERE job_id=1")
    .run(saved);

  const draft = resumes.get(1)?.draft;

  expect(draft?.id).toBe(row.id);
  expect(draft).not.toHaveProperty("claimConfirmations");
});
