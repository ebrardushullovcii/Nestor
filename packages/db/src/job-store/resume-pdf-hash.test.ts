import { afterEach, expect, it } from "vitest";

import { openJobStore, type JobStore } from "./job-store";
import { createResumeStore } from "./resumes";

const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it("records the hash of a resume approved before hashes were kept, once", () => {
  const store = openJobStore(":memory:");
  stores.push(store);
  const { ids } = store.saveFoundJobs({
    searchId: null,
    jobs: [
      {
        title: "Designer",
        company: "Northfield",
        location: "Remote",
        workModes: ["remote"],
        url: "https://board.example.test/jobs/1",
        applyUrl: null,
        sourceId: "board",
        sourceLabel: "Board",
        sourceJobId: "1",
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Listing",
      },
    ],
  });
  const jobId = ids[0]!;
  store
    .sql(
      `INSERT INTO resumes (job_id, level, state, updated_at, approved_at, pdf_path)
       VALUES (?, 'tailored', 'ready', 1, 1, 'C:/generated/resume.pdf')`,
    )
    .run(jobId);
  const resumes = createResumeStore(store);
  expect(resumes.approvedJobIds()).toEqual([jobId]);
  expect(resumes.get(jobId)?.pdfSha256).toBeNull();
  resumes.rememberPdfHash(jobId, "a".repeat(64));
  expect(resumes.get(jobId)?.pdfSha256).toBe("a".repeat(64));
  // A later hash never replaces the one recorded first.
  resumes.rememberPdfHash(jobId, "b".repeat(64));
  expect(resumes.get(jobId)?.pdfSha256).toBe("a".repeat(64));
});
