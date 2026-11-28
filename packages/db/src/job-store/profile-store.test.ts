import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("a new profile starts with every browser permission on and pay answered; each saves alone and survives reader recreation", () => {
  const { store, preferences } = setup();
  const on = {
    solveCaptchas: true,
    signIn: true,
    googleSignIn: true,
    createAccounts: true,
  };
  const off = {
    solveCaptchas: false,
    signIn: false,
    googleSignIn: false,
    createAccounts: false,
  };
  expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual(
    on,
  );
  expect(preferences.settings.read().salaryDisclosure).toBe(
    "answer_from_profile",
  );
  preferences.settings.patch({
    fields: { "aiBehavior.browserPermissions.signIn": false },
  });
  const again = createPreferencesStore(store);
  expect(again.settings.read().aiBehavior?.browserPermissions).toEqual({
    ...on,
    signIn: false,
  });
  // Turning another one off leaves the first as it was, and the rest on.
  again.settings.patch({
    fields: { "aiBehavior.browserPermissions.createAccounts": false },
  });
  again.settings.patch({
    fields: { "aiBehavior.browserPermissions.signIn": true },
  });
  expect(again.settings.read().aiBehavior?.browserPermissions).toEqual({
    ...on,
    createAccounts: false,
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

test.each([
  "solveCaptchas",
  "signIn",
  "googleSignIn",
  "createAccounts",
] as const)(
  "an upgraded workspace can save %s from its default without losing conflict protection",
  (permission) => {
    const { store, preferences } = setup();
    store
      .sql(
        "UPDATE profile_settings SET ai_behavior_browser_permissions_solve_captchas=NULL,ai_behavior_browser_permissions_sign_in=NULL,ai_behavior_browser_permissions_google_sign_in=NULL,ai_behavior_browser_permissions_create_accounts=NULL",
      )
      .run();
    const field = `aiBehavior.browserPermissions.${permission}` as const;
    const before = preferences.settings.read().aiBehavior!.browserPermissions;
    expect(before[permission]).toBe(false);
    preferences.settings.patch({
      fields: { [field]: true },
      expected: { [field]: before[permission] },
    });
    expect(
      createPreferencesStore(store).settings.read().aiBehavior
        ?.browserPermissions,
    ).toEqual({
      ...before,
      [permission]: true,
    });
    expect(() =>
      preferences.settings.patch({
        fields: { [field]: false },
        expected: { [field]: false },
      }),
    ).toThrow(/changed while you were editing/);
    preferences.settings.patch({
      fields: { [field]: false },
      expected: { [field]: true },
    });
    expect(preferences.settings.read().aiBehavior?.browserPermissions).toEqual(
      before,
    );
  },
);

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

test("the pay range's tax basis is stored, cleared, and added to a file from before it existed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-pay-tax-basis-"));
  const file = path.join(dir, "jobs.sqlite");
  try {
    const first = openJobStore(file);
    createPreferencesStore(first).goals.patch({
      fields: { "compensation.minimum": 2000 },
    });
    first.close();
    const old = new DatabaseSync(file);
    old.exec("ALTER TABLE profile_goals DROP COLUMN compensation_tax_basis");
    old.close();

    const upgraded = openJobStore(file);
    const goals = createPreferencesStore(upgraded).goals;
    expect(goals.read().compensation).not.toHaveProperty("taxBasis");
    expect(goals.read().compensation.minimum).toBe(2000);
    goals.replace({
      ...goals.read(),
      compensation: {
        ...goals.read().compensation,
        maximum: 4000,
        interval: "month",
        currency: "EUR",
        currencyStatus: "explicit",
        taxBasis: "after_tax",
      },
    });
    upgraded.close();

    const reopened = openJobStore(file);
    const saved = createPreferencesStore(reopened).goals;
    expect(saved.read().compensation).toMatchObject({
      minimum: 2000,
      maximum: 4000,
      interval: "month",
      currency: "EUR",
      taxBasis: "after_tax",
    });
    const { taxBasis: _cleared, ...withoutTaxBasis } =
      saved.read().compensation;
    void _cleared;
    saved.replace({ ...saved.read(), compensation: withoutTaxBasis });
    expect(saved.read().compensation).not.toHaveProperty("taxBasis");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the work rule in the person's own words is stored, also in a file from before it existed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-work-rule-"));
  const file = path.join(dir, "jobs.sqlite");
  const rule =
    "Remote from Kosovo I need no sponsorship for any employer. To work in the UK or the EU I would need sponsorship, and I'm open to it.";
  try {
    const first = openJobStore(file);
    createProfileStore(first).patch({
      fields: { "workEligibility.requiresVisaSponsorship": false },
    });
    first.close();
    // A file written before the field: the column is not there yet.
    const old = new DatabaseSync(file);
    old.exec(
      "ALTER TABLE profile DROP COLUMN work_eligibility_work_authorization_in_own_words",
    );
    old.close();

    const upgraded = openJobStore(file);
    const profile = createProfileStore(upgraded);
    expect(profile.read().workEligibility.workAuthorizationInOwnWords).toBe(
      null,
    );
    expect(profile.read().workEligibility.requiresVisaSponsorship).toBe(false);
    profile.patch({
      fields: { "workEligibility.workAuthorizationInOwnWords": rule },
    });
    upgraded.close();

    const reopened = openJobStore(file);
    expect(
      createProfileStore(reopened).read().workEligibility
        .workAuthorizationInOwnWords,
    ).toBe(rule);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("date of birth, postal address and citizenship are stored, also in a file from before they existed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "nestor-personal-facts-"));
  const file = path.join(dir, "jobs.sqlite");
  try {
    const first = openJobStore(file);
    createProfileStore(first).patch({
      fields: { currentCity: "Exampleville" },
    });
    first.close();
    // A file written before the fields: the columns are not there yet.
    const old = new DatabaseSync(file);
    for (const column of ["street_address", "postal_code", "date_of_birth"])
      old.exec(`ALTER TABLE profile DROP COLUMN ${column}`);
    old.close();

    const upgraded = openJobStore(file);
    const profile = createProfileStore(upgraded);
    expect(profile.read()).toMatchObject({
      currentCity: "Exampleville",
      streetAddress: null,
      postalCode: null,
      dateOfBirth: null,
      citizenshipCountries: [],
    });
    profile.replace({
      ...profile.read(),
      streetAddress: "1 Synthetic Way, Apt 2",
      postalCode: "00000",
      dateOfBirth: "1990-01-31",
      citizenshipCountries: ["Examplestan", "Samplia"],
    });
    upgraded.close();

    const reopened = openJobStore(file);
    const saved = createProfileStore(reopened);
    expect(saved.read()).toMatchObject({
      currentCity: "Exampleville",
      streetAddress: "1 Synthetic Way, Apt 2",
      postalCode: "00000",
      dateOfBirth: "1990-01-31",
      citizenshipCountries: ["Examplestan", "Samplia"],
    });
    // The passport country leads; reordering is a change the store keeps.
    saved.patch({
      lists: { citizenshipCountries: ["Samplia", "Examplestan"] },
      fields: { postalCode: null },
    });
    expect(saved.read().citizenshipCountries).toEqual([
      "Samplia",
      "Examplestan",
    ]);
    expect(saved.read().postalCode).toBeNull();
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
