import { afterEach, expect, test } from "vitest";
import { CandidateExperienceSchema } from "@nestor/contracts";
import {
  openJobStore,
  createProfileStore,
  createPreferencesStore,
  type JobStore,
} from "./job-store";
const stores: JobStore[] = [];
function setup() {
  const store = openJobStore(":memory:");
  stores.push(store);
  return {
    store,
    profile: createProfileStore(store),
    preferences: createPreferencesStore(store),
  };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

test("the first direct Profile reader revokes approvals based on retired facts, once", () => {
  const store = openJobStore(":memory:");
  stores.push(store);
  store.db
    .exec(`INSERT INTO jobs(id,stage,stage_at,title,company,location,found_at,seen_at,source_label,url) VALUES(1,'resume',1,'Analyst','Synthetic','Berlin',1,1,'Board','https://example.test/jobs/1');
    INSERT INTO resumes(job_id,level,state,updated_at,approved_at,pdf_path) VALUES(1,'tailored','ready',1,1,'C:/synthetic/approved.pdf');`);
  const profile = createProfileStore(store);
  expect(profile.overview().fields.email).toBeNull();
  expect(
    store
      .sql("SELECT state,approved_at,pdf_path FROM resumes WHERE job_id=1")
      .get(),
  ).toMatchObject({ state: "queued", approved_at: null, pdf_path: null });
  store
    .sql("UPDATE resumes SET state='ready',approved_at=2 WHERE job_id=1")
    .run();
  createProfileStore(store);
  expect(
    store.sql("SELECT approved_at FROM resumes WHERE job_id=1").get()
      ?.approved_at,
  ).toBe(2);
});

test("editing one Profile field preserves full resume text and history; screen reads omit the private source body", () => {
  const { store, profile } = setup();
  const source = profile.read().baseResume;
  profile.setResumeSource({
    ...source,
    textContent: "Imported resume body ".repeat(50000),
    storagePath: "C:/synthetic/private/resume.txt",
  });
  profile.records.upsert({
    collection: "experiences",
    record: CandidateExperienceSchema.parse({
      id: "work-1",
      title: "Data Analyst",
      companyName: "Synthetic Analytics",
      workMode: ["hybrid"],
      achievements: ["Shipped reports"],
    }),
  });
  store.db.exec(
    `CREATE TABLE touched (kind TEXT); CREATE TEMP TRIGGER source_touched AFTER UPDATE ON profile_resume_source BEGIN INSERT INTO touched VALUES ('source'); END; CREATE TEMP TRIGGER work_touched AFTER UPDATE ON profile_experiences BEGIN INSERT INTO touched VALUES ('work'); END;`,
  );
  profile.patch({ fields: { headline: "Senior Data Analyst" } });
  expect(profile.overview().fields.headline).toBe("Senior Data Analyst");
  expect(JSON.stringify(profile.overview())).not.toContain(
    "Imported resume body",
  );
  expect(JSON.stringify(profile.overview())).not.toContain(
    "C:/synthetic/private",
  );
  expect(profile.read().baseResume.textContent).toBe(
    "Imported resume body ".repeat(50000).trim(),
  );
  expect(profile.read().experiences[0]?.achievements).toEqual([
    "Shipped reports",
  ]);
  expect(store.sql("SELECT * FROM touched").all()).toEqual([]);
  expect(profile.overview().fields).not.toHaveProperty("answerBank");
  expect(profile.read().answerBank.selfIntroduction).toBeNull();
});

test("independent field edits do not replay stale siblings, and conflicting edits explain how to recover", () => {
  const { store, profile } = setup(),
    other = createProfileStore(store);
  profile.patch({
    fields: { headline: "Analyst" },
    lists: { skills: ["SQL", "SQL", "Excel"] },
  });
  const before = profile.overview().fields;
  other.patch({ fields: { email: "synthetic@example.test" } });
  profile.patch({
    fields: { headline: "Senior Analyst" },
    expected: { headline: before.headline },
  });
  expect(other.overview().fields.email).toBe("synthetic@example.test");
  expect(other.overview().lists.skills).toEqual(["SQL", "SQL", "Excel"]);
  expect(() =>
    other.patch({
      fields: { headline: "Stale" },
      expected: { headline: before.headline },
    }),
  ).toThrow(/changed while you were editing/);
  expect(profile.overview().fields.headline).toBe("Senior Analyst");
  const ids = store
    .sql(
      "SELECT id FROM profile_items WHERE scope='profile' AND field='skills' ORDER BY position",
    )
    .all();
  profile.patch({ lists: { skills: ["SQL", "SQL", "Excel", "Power BI"] } });
  expect(
    store
      .sql(
        "SELECT id FROM profile_items WHERE scope='profile' AND field='skills' ORDER BY position LIMIT 3",
      )
      .all(),
  ).toEqual(ids);
});

test("work history has stable pages, searchable columns and row-local editing/removal", () => {
  const { profile } = setup();
  for (let n = 0; n < 60; n++)
    profile.records.upsert({
      collection: "experiences",
      record: CandidateExperienceSchema.parse({
        id: `work-${n}`,
        title: `Analyst ${n}`,
        companyName: n === 59 ? "Final Employer" : "Synthetic Employer",
        workMode: [],
        skills: ["SQL"],
      }),
    });
  const first = profile.records.list({ collection: "experiences" });
  expect(first.rows).toHaveLength(25);
  expect(first.total).toBe(60);
  const second = profile.records.list({
    collection: "experiences",
    after: first.nextCursor!,
  });
  expect(second.rows[0]?.record.id).toBe("work-25");
  const found = profile.records.list({
    collection: "experiences",
    text: "Final Employer",
  });
  expect(found.rows).toHaveLength(1);
  expect(found.rows[0]?.record.id).toBe("work-59");
  const row = profile.records.get("experiences", "work-59");
  if (!row || row.collection !== "experiences")
    throw Error("Missing experience");
  profile.records.upsert({
    ...row,
    record: { ...row.record, title: "Senior Analyst" },
  });
  expect(profile.records.get("experiences", "work-58")?.record.id).toBe(
    "work-58",
  );
  expect(profile.records.remove("experiences", "work-59")).toBe(true);
  expect(profile.records.list({ collection: "experiences" }).total).toBe(59);
});

test("Settings preserve Apply choices and a deliberately cleared declaration list across reader recreation", () => {
  const { store, preferences } = setup();
  expect(
    preferences.settings.read().aiBehavior?.applying.preApprovedDeclarations,
  ).toHaveLength(4);
  preferences.settings.patch({
    fields: { applicationAutomationMode: "autonomous_submit" },
  });
  preferences.settings.patch({
    fields: { appearanceTheme: "dark" },
    lists: { "aiBehavior.applying.preApprovedDeclarations": [] },
  });
  const again = createPreferencesStore(store);
  expect(again.settings.read().applicationAutomationMode).toBe(
    "autonomous_submit",
  );
  expect(again.settings.read().appearanceTheme).toBe("dark");
  expect(
    again.settings.read().aiBehavior?.applying.preApprovedDeclarations,
  ).toEqual([]);
});

test("browser permissions start off, save one at a time and survive reader recreation", () => {
  const { store, preferences } = setup();
  const off = {
    solveCaptchas: false,
    signIn: false,
    googleSignIn: false,
    createAccounts: false,
  };
  expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual(
    off,
  );
  preferences.settings.patch({
    fields: { "aiBehavior.browserPermissions.signIn": true },
  });
  const again = createPreferencesStore(store);
  expect(again.settings.read().aiBehavior?.browserPermissions).toEqual({
    ...off,
    signIn: true,
  });
  // Turning another one on leaves the first as it was, and the rest off.
  again.settings.patch({
    fields: { "aiBehavior.browserPermissions.createAccounts": true },
  });
  again.settings.patch({
    fields: { "aiBehavior.browserPermissions.signIn": false },
  });
  expect(again.settings.read().aiBehavior?.browserPermissions).toEqual({
    ...off,
    createAccounts: true,
  });
  again.settings.patch({
    fields: { "aiBehavior.browserPermissions.googleSignIn": true },
  });
  expect(
    createPreferencesStore(store).settings.read().aiBehavior
      ?.browserPermissions,
  ).toEqual({
    ...off,
    createAccounts: true,
    googleSignIn: true,
  });
  // A file from before the permissions has empty columns: all off.
  store
    .sql(
      "UPDATE profile_settings SET ai_behavior_browser_permissions_solve_captchas=NULL,ai_behavior_browser_permissions_sign_in=NULL,ai_behavior_browser_permissions_google_sign_in=NULL,ai_behavior_browser_permissions_create_accounts=NULL",
    )
    .run();
  expect(
    createPreferencesStore(store).settings.read().aiBehavior
      ?.browserPermissions,
  ).toEqual(off);
});

test("goals retain all constraints and reject an invalid partial range atomically", () => {
  const { preferences } = setup();
  preferences.goals.patch({
    lists: {
      targetRoles: ["Data Analyst"],
      employmentTypes: ["Part-time"],
      locations: ["Berlin"],
    },
    fields: {
      "compensation.minimum": 22,
      "compensation.maximum": 27,
      "compensation.currency": "EUR",
      "compensation.currencyStatus": "explicit",
      "compensation.interval": "hour",
    },
  });
  expect(preferences.goals.read().compensation).toMatchObject({
    minimum: 22,
    maximum: 27,
    currency: "EUR",
  });
  expect(() =>
    preferences.goals.patch({
      fields: { "compensation.maximum": 10 },
      lists: { locations: ["Lost city"] },
    }),
  ).toThrow();
  expect(preferences.goals.read().locations).toEqual(["Berlin"]);
  expect(preferences.goals.read().compensation.maximum).toBe(27);
});
