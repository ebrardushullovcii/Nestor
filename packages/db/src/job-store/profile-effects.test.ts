import { afterEach, expect, test } from "vitest";
import {
  CandidateExperienceSchema,
  CandidateLinkSchema,
  ResumeDraftIdentitySchema,
  ResumeDraftSchema,
} from "@nestor/contracts";
import { openJobStore, type JobStore } from "./job-store";
import { createProfileStore } from "./profile-store";
import { createPreferencesStore } from "./preferences-store";
import { createResumeStore } from "./resumes";
import { createApplicationStore } from "./applications";
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

test.each([null, "github.com/riley-synthetic"])(
  "adding https to GitHub keeps Original and tailored approvals and waiting applications (saved link: %s)",
  (githubUrl) => {
    const { store, profile, resumes } = setup();
    profile.patch({ fields: { githubUrl: "github.com/riley-synthetic" } });
    store.sql("UPDATE jobs SET stage='shortlisted' WHERE id IN (1,3)").run();
    store.sql("DELETE FROM resumes WHERE job_id IN (1,3)").run();
    resumes.startWriting(1, "original");
    resumes.finishWriting(1, null);
    resumes.approve(1, null);
    resumes.startWriting(3, "tailored");
    resumes.finishWriting(
      3,
      ResumeDraftSchema.parse({
        id: "snapshot",
        jobId: "3",
        status: "needs_review",
        templateId: "classic_ats",
        identity: {
          fullName: "Riley Okafor",
          headline: "Analyst",
          location: "Berlin",
          githubUrl,
        },
        sections: [],
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
    resumes.approve(3, "C:/synthetic/approved.pdf");
    const applications = createApplicationStore(store);
    applications.applyJobs({ selection: { ids: [1, 3] } });
    for (let i = 0; i < 2; i++) {
      const work = applications.claimNext()!;
      applications.needsYou.request({
        applicationId: work.id,
        attempt: work.attempt,
        fieldKey: "notice",
        key: "notice",
        kind: "question",
        prompt: "Notice period?",
        input: "text",
        options: [],
        scope: {},
      });
    }
    const before = [resumes.get(1), resumes.get(3)];
    const waiting = applications.listApplications({ state: "needs_you" });
    const tasks = applications.needsYou.list();
    expect(waiting.rows).toHaveLength(2);
    expect(tasks.rows).toHaveLength(1);

    profile.patch({
      fields: { githubUrl: "https://github.com/riley-synthetic" },
    });

    expect([resumes.get(1), resumes.get(3)]).toEqual(before);
    expect([store.getJob(1)?.stage, store.getJob(3)?.stage]).toEqual([
      "resume",
      "resume",
    ]);
    expect(applications.listApplications({ state: "needs_you" })).toEqual(
      waiting,
    );
    expect(applications.needsYou.list()).toEqual(tasks);
    const answered = applications.needsYou.answer({
      id: tasks.rows[0]!.id,
      answer: "Two weeks",
      remember: false,
    });
    expect(answered).toEqual({ resolved: true, queued: 2 });
    expect(applications.claimNext()).not.toBeNull();
  },
);

test("a live Profile fallback revokes only the resume whose printed header changes", () => {
  const { store, profile, resumes } = setup();
  profile.patch({ fields: { headline: "Analyst" } });
  for (const id of [1, 3]) {
    resumes.startWriting(id, "tailored");
    resumes.finishWriting(
      id,
      ResumeDraftSchema.parse({
        id: "draft-" + id,
        jobId: String(id),
        status: "needs_review",
        templateId: "classic_ats",
        identity: id === 1 ? null : { headline: "Reviewed headline" },
        sections: [],
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      }),
    );
    resumes.approve(id, "C:/synthetic/approved.pdf");
  }
  const kept = resumes.get(3);
  const applications = createApplicationStore(store);
  applications.applyJobs({ selection: { ids: [1, 3] } });
  const running = [applications.claimNext()!, applications.claimNext()!];
  const affected = running.find((row) => row.jobId === 1)!;
  const unaffected = running.find((row) => row.jobId === 3)!;
  profile.patch({ fields: { headline: "Senior Analyst" } });
  expect(resumes.get(1)?.approvedAt).toBeNull();
  expect(store.getJob(1)?.stage).toBe("shortlisted");
  expect(resumes.get(3)).toEqual(kept);
  expect(store.getJob(3)?.stage).toBe("resume");
  expect(applications.getApplication(affected.id)?.state).toBe("stopped");
  expect(applications.getApplication(unaffected.id)?.state).toBe("running");
});

test("saved identity fields stay fixed; null header fields still follow Profile", () => {
  const { profile, resumes } = setup();
  const draft = resumes.get(1)!.draft!;
  resumes.setLevel(1, "tailored");
  resumes.startWriting(1, "tailored");
  resumes.finishWriting(1, {
    ...draft,
    identity: ResumeDraftIdentitySchema.parse({
      fullName: "Reviewed Name",
      githubUrl: "github.com/reviewed",
    }),
  });
  resumes.approve(1, "C:/synthetic/approved.pdf");
  const before = resumes.get(1);
  profile.patch({
    fields: {
      fullName: "Updated Name",
      githubUrl: "https://github.com/updated",
    },
  });
  expect(resumes.get(1)).toEqual(before);
  profile.patch({ fields: { headline: "A new fallback headline" } });
  expect(resumes.get(1)?.approvedAt).toBeNull();
});

test("Profile links affect only live contact fallbacks, not reviewed snapshots", () => {
  const { profile, resumes } = setup();
  const before = resumes.get(1);
  profile.records.upsert({
    collection: "links",
    record: CandidateLinkSchema.parse({
      id: "github",
      kind: "github",
      url: "https://github.com/riley-synthetic",
    }),
  });
  expect(resumes.get(1)?.approvedAt).toBeNull();
  resumes.startWriting(1, "tailored");
  resumes.finishWriting(1, before!.draft);
  resumes.approve(1, "C:/synthetic/approved.pdf");
  profile.records.remove("links", "github");
  expect(resumes.get(1)?.approvedAt).toBeNull();
});

test("Profile body edits restart unreviewed writing while an approved Original stays fixed", () => {
  const { profile, resumes } = setup();
  resumes.setLevel(1, "original");
  resumes.startWriting(1, "original");
  resumes.finishWriting(1, null);
  resumes.approve(1, null);
  const original = resumes.get(1);
  resumes.startWriting(3, "tailored");
  profile.patch({ fields: { summary: "New evidence for the writer" } });
  expect(resumes.get(3)?.state).toBe("queued");
  expect(resumes.get(1)).toEqual(original);
  profile.records.upsert({
    collection: "experiences",
    record: CandidateExperienceSchema.parse({
      id: "work",
      title: "Analyst",
      companyName: "Synthetic",
    }),
  });
  expect(resumes.get(1)).toEqual(original);
});

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
  expect(store.getJob(1)?.stage).toBe("resume");
  expect(store.unscoredJobIds(10)).toContain(1);
  expect(store.unscoredJobIds(10)).not.toContain(2);
  expect(store.getJob(2)?.fitScore).toBe(90);
  expect(resumes.get(1)).toEqual(draft);
});

test("a changed live header invalidates approval atomically; snapshot history stays intact", () => {
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
  const before = resumes.get(1);
  profile.records.upsert({
    collection: "experiences",
    record: CandidateExperienceSchema.parse({
      id: "work",
      title: "Analyst",
      companyName: "Synthetic Employer",
      workMode: [],
    }),
  });
  expect(resumes.get(1)).toEqual(before);
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
