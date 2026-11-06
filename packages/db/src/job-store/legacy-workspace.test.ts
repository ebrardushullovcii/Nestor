import {
  ApplicationRecordSchema,
  CandidateProfileSchema,
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ResumeDraftSchema,
  ResumeExportArtifactSchema,
  SavedJobSchema,
  createFreshStartCandidateProfile,
} from "@nestor/contracts";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

import { createSavedAnswersStore } from "./applications";
import { openJobStore, type JobStore } from "./job-store";
import { createPreferencesStore } from "./preferences-store";
import { createProfileStore } from "./profile-store";
import { createResumeStore } from "./resumes";
import { resetJobStore } from "./reset";

const at = "2026-10-17T09:00:00.000Z";
const dirs: string[] = [];
const stores: JobStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-legacy-test-"));
  dirs.push(dir);
  const file = path.join(dir, "job-finder.sqlite");
  const legacyWorkspacePath = path.join(dir, "job-finder-workspace.sqlite");
  const source = new DatabaseSync(legacyWorkspacePath);
  source.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT);
    INSERT INTO schema_migrations VALUES(20,'normalized_discovery_storage');
    CREATE TABLE singleton_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,revision INTEGER DEFAULT 1);`);
  const state = (key: string, value: unknown) =>
    source
      .prepare("INSERT OR REPLACE INTO singleton_state(key,value) VALUES(?,?)")
      .run(key, JSON.stringify(value));
  const rows = (table: string, values: { id: string }[]) => {
    source.exec(
      `CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,value TEXT NOT NULL)`,
    );
    for (const value of values)
      source
        .prepare(`INSERT INTO ${table}(id,value) VALUES(?,?)`)
        .run(value.id, JSON.stringify(value));
  };
  const profile = CandidateProfileSchema.parse({
    ...createFreshStartCandidateProfile(),
    id: "synthetic-profile",
    fullName: "Morgan Example",
    firstName: "Morgan",
    lastName: "Example",
    email: "morgan@example.test",
    experiences: [
      {
        id: "experience",
        companyName: "Example",
        title: "Engineer",
        startDate: "2020-01",
      },
    ],
    education: [{ id: "education", schoolName: "Example University" }],
    spokenLanguages: [{ id: "language", language: "English" }],
    answerBank: {
      availability: "In two weeks",
      customAnswers: [
        {
          id: "scoped",
          label: "Permit",
          kind: "work_authorization",
          question: "Can you work here?",
          answer: "Yes",
          applicationScope: {
            resultId: null,
            applicationRecordId: null,
            location: "Somewhere",
          },
        },
      ],
    },
    baseResume: {
      ...createFreshStartCandidateProfile().baseResume,
      textContent: "Synthetic resume text",
      extractionStatus: "ready",
    },
  });
  state("profile", profile);
  state(
    "search_preferences",
    JobSearchPreferencesSchema.parse({
      targetRoles: ["Engineer"],
      locations: ["Remote"],
      workModes: ["remote"],
      minimumSalaryUsd: 100000,
      approvalMode: "review_before_submit",
      tailoringMode: "balanced",
      discovery: {
        targets: [
          {
            id: "site",
            label: "Example Jobs",
            startingUrl: "https://example.test/jobs",
            enabled: false,
            customInstructions: "Only permanent jobs",
          },
        ],
      },
    }),
  );
  state(
    "settings",
    JobFinderSettingsSchema.parse({
      resumeFormat: "pdf",
      resumeTemplateId: "classic_ats",
      fontPreset: "inter_requisite",
      appearanceTheme: "dark",
      humanReviewRequired: true,
      allowAutoSubmitOverride: false,
      applicationAutomationMode: "confirm_before_submit",
      salaryDisclosure: "pause_for_user",
      aiBehavior: { profileAssistant: { replyStyle: "conversational" } },
    }),
  );
  const jobs = ["approved", "submitted"].map((status, i) =>
    SavedJobSchema.parse({
      id: `old-job-${i}`,
      source: "target_site",
      sourceJobId: String(i),
      canonicalUrl: `https://example.test/jobs/${i}`,
      title: `Engineer ${i}`,
      company: "Example",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "unknown",
      easyApplyEligible: false,
      discoveredAt: at,
      salaryText: null,
      description: "Synthetic listing",
      status,
      matchAssessment: {
        score: 80,
        reasons: ["Relevant experience"],
        gaps: [],
      },
    }),
  );
  rows("saved_jobs", jobs);
  const pdf = path.join(dir, "synthetic.pdf");
  writeFileSync(pdf, "synthetic resume export");
  rows("resume_drafts", [
    ResumeDraftSchema.parse({
      id: "draft",
      jobId: jobs[0]!.id,
      status: "approved",
      templateId: "classic_ats",
      approvedAt: at,
      approvedExportId: "export",
      createdAt: at,
      updatedAt: at,
    }),
  ]);
  rows("resume_export_artifacts", [
    ResumeExportArtifactSchema.parse({
      id: "export",
      draftId: "draft",
      jobId: jobs[0]!.id,
      format: "pdf",
      filePath: pdf,
      sha256: createHash("sha256").update(readFileSync(pdf)).digest("hex"),
      templateId: "classic_ats",
      exportedAt: at,
      isApproved: true,
    }),
  ]);
  rows(
    "application_records",
    jobs.map((job) =>
      ApplicationRecordSchema.parse({
        id: `application-${job.id}`,
        jobId: job.id,
        title: job.title,
        company: job.company,
        status: job.status,
        lastActionLabel: "Prepared",
        nextActionLabel: null,
        lastUpdatedAt: at,
        automationMode: "autonomous_submit",
        events: [
          {
            id: "event",
            at,
            title: "Prepared",
            detail: "Synthetic history",
            emphasis: "neutral",
          },
        ],
      }),
    ),
  );
  source.close();
  const open = () => {
    const store = openJobStore(file, { legacyWorkspacePath });
    stores.push(store);
    return store;
  };
  return { dir, file, legacyWorkspacePath, profile, open };
}

function counts(store: JobStore) {
  return Object.fromEntries(
    [
      "jobs",
      "resumes",
      "applications",
      "job_sites",
      "form_answers",
      "tracker_events",
      "legacy_workspace_imports",
    ].map((table) => [
      table,
      Number(store.sql(`SELECT count(*) AS n FROM ${table}`).get()!.n),
    ]),
  );
}

test("imports the old format, verifies exports, keeps the source and reopens without duplicates", () => {
  const f = fixture();
  const before = readFileSync(f.legacyWorkspacePath);
  const store = f.open();
  expect(createProfileStore(store).read()).toMatchObject({
    fullName: f.profile.fullName,
    experiences: f.profile.experiences,
    education: f.profile.education,
    spokenLanguages: f.profile.spokenLanguages,
    baseResume: { textContent: "Synthetic resume text" },
  });
  expect(createPreferencesStore(store).goals.read()).toMatchObject({
    targetRoles: ["Engineer"],
    minimumSalaryUsd: 100000,
  });
  expect(createPreferencesStore(store).settings.read().appearanceTheme).toBe(
    "dark",
  );
  expect(
    store.sql("SELECT label,enabled,custom_instructions FROM job_sites").get(),
  ).toMatchObject({
    label: "Example Jobs",
    enabled: 0,
    custom_instructions: "Only permanent jobs",
  });
  expect(counts(store)).toEqual({
    jobs: 2,
    resumes: 1,
    applications: 2,
    job_sites: 1,
    form_answers: 2,
    tracker_events: 2,
    legacy_workspace_imports: 1,
  });
  const jobId = Number(
    store
      .sql("SELECT job_id FROM legacy_workspace_jobs WHERE old_id='old-job-0'")
      .get()!.job_id,
  );
  expect(createResumeStore(store).get(jobId)).toMatchObject({
    approvedAt: at,
    draft: { jobId: String(jobId) },
  });
  expect(
    store.sql("SELECT state,mode FROM applications ORDER BY job_id").all(),
  ).toEqual([
    { state: "stopped", mode: "confirm_before_submit" },
    { state: "submitted", mode: "confirm_before_submit" },
  ]);
  expect(store.sql("SELECT count(*) AS n FROM send_authorities").get()!.n).toBe(
    0,
  );
  const answers = createSavedAnswersStore(store);
  expect(answers.get({ key: "resume_import:availability" })).toMatchObject({
    answer: "In two weeks",
    needsConfirmation: false,
  });
  expect(answers.get({ key: "legacy:scoped" })).toMatchObject({
    needsConfirmation: true,
  });
  expect(readFileSync(f.legacyWorkspacePath)).toEqual(before);
  expect(
    readdirSync(f.dir).some((name) => name.includes("pre-legacy-import-")),
  ).toBe(true);
  const after = counts(store);
  store.close();
  expect(counts(f.open())).toEqual(after);
});

test("imports committed WAL rows without changing the older database", () => {
  const f = fixture();
  const source = new DatabaseSync(f.legacyWorkspacePath);
  try {
    source.exec("PRAGMA journal_mode=WAL");
    source
      .prepare("UPDATE singleton_state SET value=? WHERE key='profile'")
      .run(JSON.stringify({ ...f.profile, fullName: "WAL Candidate" }));
    expect(createProfileStore(f.open()).read().fullName).toBe("WAL Candidate");
    expect(
      CandidateProfileSchema.parse(
        JSON.parse(
          String(
            source
              .prepare("SELECT value FROM singleton_state WHERE key='profile'")
              .get()!.value,
          ),
        ),
      ).fullName,
    ).toBe("WAL Candidate");
  } finally {
    source.close();
  }
});

test("a late failure rolls back the entire import and can be retried", () => {
  const f = fixture();
  const source = new DatabaseSync(f.legacyWorkspacePath);
  source.exec(
    "CREATE TABLE profile_revisions(id TEXT,value TEXT); INSERT INTO profile_revisions VALUES('invalid','{}')",
  );
  source.close();
  expect(f.open).toThrow("older workspace could not be imported");
  const empty = openJobStore(f.file);
  expect(counts(empty)).toMatchObject({
    jobs: 0,
    applications: 0,
    job_sites: 0,
    legacy_workspace_imports: 0,
  });
  expect(createProfileStore(empty).read().fullName).toBeNull();
  empty.close();
  const repaired = new DatabaseSync(f.legacyWorkspacePath);
  repaired.exec("DELETE FROM profile_revisions");
  repaired.close();
  expect(counts(f.open()).jobs).toBe(2);
});

test("current edits and matching job decisions survive the first import", () => {
  const f = fixture();
  const current = openJobStore(f.file);
  createProfileStore(current).patch({
    fields: { fullName: "Current Candidate" },
  });
  createPreferencesStore(current).settings.patch({
    fields: { appearanceTheme: "light" },
  });
  const { ids } = current.saveFoundJobs({
    searchId: null,
    jobs: [
      {
        title: "Engineer 0",
        company: "Example",
        location: "Remote",
        workModes: ["remote"],
        url: "https://example.test/jobs/0",
        applyUrl: null,
        sourceId: "site",
        sourceLabel: "Site",
        sourceJobId: "0",
        postedAt: null,
        salaryText: null,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        seniority: null,
        employmentType: null,
        summary: null,
        description: "Current listing",
      },
    ],
  });
  current.setStage(ids, "hidden");
  current.close();
  const store = f.open();
  expect(createProfileStore(store).read().fullName).toBe("Current Candidate");
  expect(createPreferencesStore(store).settings.read().appearanceTheme).toBe(
    "light",
  );
  expect(
    createPreferencesStore(store).settings.read().aiBehavior?.profileAssistant
      .replyStyle,
  ).toBe("conversational");
  expect(store.getJob(ids[0]!)!.stage).toBe("hidden");
  expect(counts(store).jobs).toBe(2);
});

test("reset and a later empty Profile never resurrect retained legacy data", () => {
  const f = fixture();
  const store = f.open();
  resetJobStore(store);
  store.close();
  const reopened = f.open();
  expect(counts(reopened)).toMatchObject({
    jobs: 0,
    applications: 0,
    form_answers: 0,
    job_sites: 0,
    legacy_workspace_imports: 1,
  });
  expect(createProfileStore(reopened).read().fullName).toBeNull();
  expect(readFileSync(f.legacyWorkspacePath).length).toBeGreaterThan(0);
});

test("retains an unsupported early indexed file instead of deleting it", () => {
  const f = fixture();
  const old = new DatabaseSync(f.file);
  old.exec(
    "CREATE TABLE early_data(value TEXT); INSERT INTO early_data VALUES('synthetic'); PRAGMA user_version=5",
  );
  old.close();
  const store = f.open();
  expect(counts(store).jobs).toBe(2);
  const retained = readdirSync(f.dir).find((name) =>
    name.includes("pre-row-store-"),
  )!;
  const backup = new DatabaseSync(path.join(f.dir, retained), {
    readOnly: true,
  });
  expect(backup.prepare("SELECT value FROM early_data").get()!.value).toBe(
    "synthetic",
  );
  backup.close();
});

test("preserves unsent CRM records and does not merge unrelated provider IDs", () => {
  const f = fixture();
  const source = new DatabaseSync(f.legacyWorkspacePath);
  for (const row of source.prepare("SELECT id,value FROM saved_jobs").all()) {
    const job = SavedJobSchema.parse(JSON.parse(String(row.value)));
    source
      .prepare("UPDATE saved_jobs SET value=? WHERE id=?")
      .run(
        JSON.stringify({ ...job, sourceJobId: "shared-provider-id" }),
        row.id!,
      );
  }
  const row = source
    .prepare("SELECT id,value FROM application_records ORDER BY rowid LIMIT 1")
    .get()!;
  const application = ApplicationRecordSchema.parse(
    JSON.parse(String(row.value)),
  );
  source.prepare("UPDATE application_records SET value=? WHERE id=?").run(
    JSON.stringify({
      ...application,
      crm: { stage: "preparing", stageChangedAt: at, tags: ["Saved tag"] },
    }),
    row.id!,
  );
  source.close();
  const store = f.open();
  expect(counts(store).jobs).toBe(2);
  expect(
    store.sql("SELECT status FROM tracker ORDER BY job_id LIMIT 1").get()!
      .status,
  ).toBe("applying");
  expect(store.sql("SELECT tag FROM tracker_tags").get()!.tag).toBe(
    "Saved tag",
  );
});

test("keeps a draft whose approved export is missing, without approving an unavailable file", () => {
  const f = fixture();
  rmSync(path.join(f.dir, "synthetic.pdf"));
  const store = f.open();
  const resume = store
    .sql("SELECT approved_at,pdf_path,draft_json FROM resumes")
    .get()!;
  expect(resume.approved_at).toBeNull();
  expect(resume.pdf_path).toBeNull();
  expect(
    ResumeDraftSchema.parse(JSON.parse(String(resume.draft_json))),
  ).toMatchObject({ id: "draft", status: "needs_review" });
});
