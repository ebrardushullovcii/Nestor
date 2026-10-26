import { afterEach, expect, test } from "vitest";
import {
  CandidateExperienceSchema,
  ResumeDraftSchema,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "./job-store";
import { createProfileStore } from "./profile-store";
import { createPreferencesStore } from "./preferences-store";
import { createResumeStore } from "./resumes";
const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = openJobStore(":memory:");
  stores.push(store);
  const profile = createProfileStore(store),
    preferences = createPreferencesStore(store),
    resumes = createResumeStore(store);
  preferences.goals.patch({ fields: { tailoringMode: "balanced" } });
  for (const id of [1, 2, 3])
    store
      .sql(
        `INSERT INTO jobs(id,stage,stage_at,title,company,location,found_at,seen_at,source_label,url) VALUES(?,'shortlisted',1,'Analyst','Synthetic Employer','Berlin',1,1,'Board',?)`,
      )
      .run(id, `https://synthetic.test/jobs/${id}`);
  for (const id of [1, 2, 3])
    store
      .sql(
        "INSERT INTO job_details(job_id,description) VALUES(?,'Full synthetic description')",
      )
      .run(id);
  const draft = ResumeDraftSchema.parse({
    id: "draft",
    jobId: "1",
    status: "approved",
    templateId: "classic_ats",
    sections: [],
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    approvedAt: "2026-10-26T00:00:00.000Z",
  });
  for (const id of [1, 2]) {
    resumes.startWriting(id, "tailored");
    resumes.finishWriting(id, {
      ...draft,
      id: "draft-" + id,
      jobId: String(id),
    });
    resumes.approve(id, "C:/synthetic/approved.pdf");
  }
  store.sql("UPDATE jobs SET stage='applied' WHERE id=2").run();
  return { store, profile, preferences, resumes };
}

test("changing remote location policy retires active fit scores without changing drafts or applied history", () => {
  const { store, preferences, resumes } = setup();
  store.setFit(
    [1, 2].map((id) => ({
      id,
      score: 90,
      summary: "Remote match",
      reasons: [],
      gaps: [],
    })),
  );
  const draft = resumes.get(1);
  expect(() =>
    store.transaction(() => {
      preferences.settings.patch({
        fields: { "aiBehavior.jobSearch.remoteCountsAsAnyLocation": false },
      });
      throw Error("Abort");
    }),
  ).toThrow("Abort");
  expect(store.getJob(1)?.fitScore).toBe(90);
  preferences.settings.patch({
    fields: { "aiBehavior.jobSearch.remoteCountsAsAnyLocation": false },
  });
  expect(store.getJob(1)?.fitScore).toBeNull();
  expect(store.getJob(1)?.fit).toBeNull();
  expect(store.getJob(2)?.fitScore).toBe(90);
  expect(resumes.get(1)).toEqual(draft);
});

test("every Profile fact writer invalidates active approval atomically while submitted history stays intact", () => {
  const { store, profile, resumes } = setup();
  expect(() =>
    store.transaction(() => {
      profile.patch({ fields: { headline: "Must roll back" } });
      throw Error("Abort");
    }),
  ).toThrow("Abort");
  expect(resumes.get(1)?.approvedAt).not.toBeNull();
  expect(profile.overview().fields.headline).not.toBe("Must roll back");
  profile.patch({ fields: { headline: "Senior Analyst" } });
  expect(resumes.get(1)).toMatchObject({
    state: "queued",
    approvedAt: null,
    pdfPath: null,
    draft: {
      status: "stale",
      approvedAt: null,
    },
  });
  expect(resumes.get(1)?.draft?.staleReason).toContain("Profile details");
  expect(store.getJob(1)?.stage).toBe("shortlisted");
  expect(resumes.get(2)?.approvedAt).not.toBeNull();
  resumes.startWriting(1, "tailored");
  resumes.finishWriting(
    1,
    ResumeDraftSchema.parse({
      ...resumes.get(2)!.draft,
      id: "fresh",
      jobId: "1",
    }),
  );
  resumes.approve(1, "C:/synthetic/new.pdf");
  profile.records.upsert({
    collection: "experiences",
    record: CandidateExperienceSchema.parse({
      id: "work",
      title: "Analyst",
      companyName: "Synthetic Employer",
      workMode: [],
    }),
  });
  expect(resumes.get(1)?.approvedAt).toBeNull();
});

test.each([
  { resumeFormat: "docx" as const },
  { fontPreset: "space_grotesk_display" as const },
])("resume Settings changes invalidate approval: %j", (fields) => {
  const { preferences, resumes } = setup();
  preferences.settings.patch({ fields });
  expect(resumes.get(1)).toMatchObject({
    approvedAt: null,
    draft: {
      status: "stale",
    },
  });
  expect(resumes.get(1)?.draft?.staleReason).toContain("Resume settings");
  expect(resumes.get(2)?.approvedAt).not.toBeNull();
});

test("changing the default pins active queued jobs and preserves a reviewed job's own level", () => {
  const { preferences, resumes, store } = setup();
  preferences.settings.patch({
    fields: { resumeApplicationMode: "original_resume" },
  });
  expect(resumes.get(1)?.level).toBe("tailored");
  expect(resumes.get(3)).toMatchObject({ level: "tailored", state: "queued" });
  store
    .sql(
      `INSERT INTO jobs(id,stage,stage_at,title,company,location,found_at,seen_at,source_label,url) VALUES(4,'shortlisted',1,'Analyst','Synthetic Employer','Berlin',1,1,'Board','https://synthetic.test/jobs/4')`,
    )
    .run();
  preferences.settings.patch({
    fields: { resumeApplicationMode: "tailored_per_job" },
  });
  expect(resumes.get(4)?.level).toBe("original");
  expect(resumes.get(3)?.level).toBe("tailored");
});

test("mirrored application email and phone follow their primary facts; deliberate alternatives stay", () => {
  const { profile } = setup();
  profile.patch({
    fields: {
      email: "old@example.test",
      phone: "+49 123",
      "applicationIdentity.preferredEmail": "old@example.test",
      "applicationIdentity.preferredPhone": "+49 123",
    },
  });
  profile.patch({ fields: { email: "new@example.test", phone: "+49 456" } });
  expect(profile.read().applicationIdentity).toMatchObject({
    preferredEmail: "new@example.test",
    preferredPhone: "+49 456",
  });
  profile.patch({
    fields: {
      "applicationIdentity.preferredEmail": "applications@example.test",
    },
  });
  profile.patch({ fields: { email: "latest@example.test" } });
  expect(profile.read().applicationIdentity.preferredEmail).toBe(
    "applications@example.test",
  );
});
