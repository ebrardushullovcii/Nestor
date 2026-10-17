import { describe, expect, test } from "vitest";

import {
  CandidateProfileSchema,
  ResumeImportFieldCandidateSchema,
  createFreshStartCandidateProfile,
  type ResumeImportFieldCandidate,
} from "@nestor/contracts";
import { applyResolvedResumeImportCandidatesToWorkspace } from "./internal/resume-import-apply";
import {
  FOLDED_INTO_RECORD_REASON,
  reconcileCandidates,
} from "./internal/resume-import-reconciliation";
import { createSeed } from "./workspace-service.test-fixtures";
import { createStageCandidate } from "./workspace-service.resume-analysis.shared";

const runId = "resume_import_run_loose_fields";

// The saved roles after importing the synthetic Morgan Lee resume once.
const savedRoles = [
  {
    id: "experience_acme_payments_senior_backend_engineer_2021_03",
    companyName: "Acme Payments",
    title: "Senior Backend Engineer",
    location: "Lisbon, Portugal",
    startDate: "2021-03",
    endDate: null,
    isCurrent: true,
    achievements: [
      "Led the migration of the settlement service from a monolith to Go microservices.",
      "Cut nightly reconciliation time from 4 hours to 35 minutes.",
      "Mentored four engineers through their first on-call rotations.",
    ],
  },
  {
    id: "experience_northwind_data_backend_engineer_2018_06",
    companyName: "Northwind Data",
    title: "Backend Engineer",
    location: "Porto, Portugal",
    startDate: "2018-06",
    endDate: "2021-02",
    isCurrent: false,
    achievements: [
      "Built ingestion pipelines in Python for 40 retail customers.",
      "Owned the PostgreSQL schema for the analytics warehouse.",
    ],
  },
  {
    id: "experience_northwind_data_data_engineer_2017_01",
    companyName: "Northwind Data",
    title: "Data Engineer",
    location: "Porto, Portugal",
    startDate: "2017-01",
    endDate: "2018-05",
    isCurrent: false,
    achievements: ["Wrote ETL jobs in Python and Airflow."],
  },
  {
    id: "experience_bluebird_studio_junior_developer_2015",
    companyName: "Bluebird Studio",
    title: "Junior Developer",
    location: null,
    startDate: "2015",
    endDate: "2016",
    isCurrent: false,
    achievements: ["Maintained internal tools in PHP."],
  },
];

let blockCounter = 0;

/**
 * One role the way the model returned it on the second import: loose fields
 * (experience.companyName, experience.title, ...) under the model's own
 * recordId instead of one experience.record object.
 */
function looseRoleCandidates(
  recordId: string,
  fields: Record<string, ResumeImportFieldCandidate["value"]>,
): ResumeImportFieldCandidate[] {
  return Object.entries(fields).map(([key, value]) => {
    blockCounter += 1;
    return ResumeImportFieldCandidateSchema.parse({
      runId,
      ...createStageCandidate({
        target: { section: "experience", key, recordId },
        label: `${recordId} ${key}`,
        value,
        sourceBlockIds: [`page_1_block_${blockCounter}`],
        confidence: 0.98,
        overall: 0.83,
        recommendation: "needs_review",
      }),
      id: `candidate_${recordId}_${key}`,
      sourceKind: "model_experience",
      resolution: "needs_review",
      createdAt: "2026-09-23T14:31:16.996Z",
      resolvedAt: null,
    });
  });
}

function looseCandidatesForSavedRoles(): ResumeImportFieldCandidate[] {
  const recordIds = [
    "exp_acme_payments",
    "exp_northwind_backend",
    "exp_northwind_dataeng",
    "exp_bluebird",
  ];
  return savedRoles.flatMap((role, index) => {
    const fields: Record<string, ResumeImportFieldCandidate["value"]> = {
      companyName: role.companyName,
      title: role.title,
      startDate: role.startDate,
      achievements: role.achievements,
    };
    if (role.location) {
      fields.location = role.location;
    }
    if (role.isCurrent) {
      fields.isCurrent = true;
    } else if (role.endDate) {
      fields.endDate = role.endDate;
    }
    return looseRoleCandidates(recordIds[index] ?? `exp_${index}`, fields);
  });
}

describe("loose record fields from the model", () => {
  test("adopts named singleton skills instead of marking ignored slug keys applied", () => {
    const seed = createSeed();
    const profile = createFreshStartCandidateProfile();
    const skills = ["Guest service", "reservation management"];
    const candidates = skills.map((name, index) =>
      ResumeImportFieldCandidateSchema.parse({
        id: `skill_${index}`,
        runId,
        target: { section: "skill", key: `skill_${index}`, recordId: null },
        label: name,
        value: { name },
        evidenceText: name,
        sourceBlockIds: ["skills_block"],
        confidence: 0.97,
        sourceKind: "model_background",
        resolution: "needs_review",
        createdAt: "2026-09-26T13:00:00.000Z",
      }),
    );
    const reconciled = reconcileCandidates(
      profile,
      seed.searchPreferences,
      candidates,
    );
    const merged = applyResolvedResumeImportCandidatesToWorkspace({
      profile,
      searchPreferences: seed.searchPreferences,
      candidates: reconciled,
      analysisProviderKind: "openai_compatible",
      analysisProviderLabel: "Test model",
      analysisWarnings: [],
    });

    expect(merged.profile.skills).toEqual(skills);
    expect(reconciled.every((item) => item.resolution === "auto_applied")).toBe(
      true,
    );
    const repeated = reconcileCandidates(
      merged.profile,
      seed.searchPreferences,
      candidates,
    );
    const reapplied = applyResolvedResumeImportCandidatesToWorkspace({
      profile: merged.profile,
      searchPreferences: merged.searchPreferences,
      candidates: repeated,
      analysisProviderKind: "openai_compatible",
      analysisProviderLabel: "Test model",
      analysisWarnings: [],
    });
    expect(reapplied.profile.skills).toEqual(skills);
    expect(repeated.some((item) => item.resolution === "needs_review")).toBe(
      false,
    );
  });

  test("replacement keeps new facts on the same role available for review and acceptance", () => {
    const seed = createSeed();
    const role = savedRoles[0]!;
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      experiences: [role],
    });
    const addedBullet = "Handled 40 guest arrivals per shift.";
    const candidate = ResumeImportFieldCandidateSchema.parse({
      ...looseRoleCandidates("same_role", { title: role.title })[0],
      id: "updated_role",
      target: { section: "experience", key: "record", recordId: "same_role" },
      value: { ...role, achievements: [...role.achievements, addedBullet] },
    });
    const [review] = reconcileCandidates(profile, seed.searchPreferences, [
      candidate,
    ]);
    expect(review?.resolution).toBe("needs_review");
    const merged = applyResolvedResumeImportCandidatesToWorkspace({
      profile,
      searchPreferences: seed.searchPreferences,
      candidates: [{ ...review!, resolution: "auto_applied" }],
      analysisProviderKind: "openai_compatible",
      analysisProviderLabel: "Test model",
      analysisWarnings: [],
    });
    expect(merged.profile.headline).toBe(profile.headline);
    expect(merged.profile.workEligibility).toEqual(profile.workEligibility);
    expect(merged.profile.experiences).toHaveLength(1);
    expect(merged.profile.experiences[0]?.id).toBe(role.id);
    expect(merged.profile.experiences[0]?.achievements).toEqual([
      ...role.achievements,
      addedBullet,
    ]);
    const [repeated] = reconcileCandidates(
      merged.profile,
      seed.searchPreferences,
      [candidate],
    );
    expect(repeated?.resolutionReason).toBe("already_matches_workspace_value");
  });

  test("replacement keeps a newly read qualification year on the same school available for review", () => {
    const seed = createSeed();
    const education = {
      id: "school",
      schoolName: "Example Community College",
      degree: "Certificate in Hospitality Operations",
    };
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      education: [education],
    });
    const candidate = ResumeImportFieldCandidateSchema.parse({
      ...looseRoleCandidates("school", { title: "unused" })[0],
      id: "updated_school",
      target: { section: "education", key: "record", recordId: "school" },
      sourceKind: "model_background",
      evidenceText: "Certificate in Hospitality Operations | Example Community College | 2019",
      value: { ...education, endDate: "2019" },
    });
    const [review] = reconcileCandidates(profile, seed.searchPreferences, [
      candidate,
    ]);
    expect(review?.resolution).toBe("needs_review");
    const merged = applyResolvedResumeImportCandidatesToWorkspace({
      profile,
      searchPreferences: seed.searchPreferences,
      candidates: [{ ...review!, resolution: "auto_applied" }],
      analysisProviderKind: "openai_compatible",
      analysisProviderLabel: "Test model",
      analysisWarnings: [],
    });
    expect(merged.profile.education).toHaveLength(1);
    expect(merged.profile.education[0]).toMatchObject({
      ...education,
      endDate: "2019",
    });
  });

  test("an identical or partial reread does not ask to remove saved role details", () => {
    const seed = createSeed();
    const role = savedRoles[0]!;
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      experiences: [role],
    });
    for (const achievements of [
      role.achievements,
      role.achievements.slice(0, 1),
      [],
    ]) {
      const candidate = ResumeImportFieldCandidateSchema.parse({
        ...looseRoleCandidates("same_role", { title: role.title })[0],
        id: "partial_role",
        target: { section: "experience", key: "record", recordId: "same_role" },
        value: {
          ...role,
          achievements,
          summary: null,
          location: null,
          skills: [],
        },
      });
      const [result] = reconcileCandidates(profile, seed.searchPreferences, [
        candidate,
      ]);
      expect(result?.resolutionReason).toBe("already_matches_workspace_value");
    }
  });

  test("importing the same resume again asks nothing about roles already saved", () => {
    const seed = createSeed();
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      experiences: savedRoles,
    });
    const candidates = looseCandidatesForSavedRoles();

    const firstPass = reconcileCandidates(
      profile,
      seed.searchPreferences,
      candidates,
    );
    // The workflow reconciles again after adjudication, with the first
    // pass's output as input; the fold must not add a second record.
    const secondPass = reconcileCandidates(
      profile,
      seed.searchPreferences,
      firstPass,
    );

    for (const pass of [firstPass, secondPass]) {
      const experience = pass.filter(
        (candidate) => candidate.target.section === "experience",
      );
      expect(
        experience.filter(
          (candidate) =>
            candidate.resolution === "needs_review" ||
            candidate.resolution === "auto_applied",
        ),
      ).toEqual([]);
      const loose = experience.filter(
        (candidate) => candidate.target.key !== "record",
      );
      expect(loose).toHaveLength(candidates.length);
      expect(
        loose.every(
          (candidate) =>
            candidate.resolution === "rejected" &&
            candidate.resolutionReason === FOLDED_INTO_RECORD_REASON,
        ),
      ).toBe(true);
      const records = experience.filter(
        (candidate) => candidate.target.key === "record",
      );
      expect(records).toHaveLength(4);
      expect(
        records.every(
          (candidate) =>
            candidate.resolutionReason === "already_matches_workspace_value",
        ),
      ).toBe(true);
    }
  });

  test("a new role read as loose fields becomes one role card on a fresh profile", () => {
    const seed = createSeed();
    const profile = createFreshStartCandidateProfile();
    const candidates = looseRoleCandidates("exp_acme_payments", {
      companyName: "Acme Payments",
      title: "Senior Backend Engineer",
      location: "Lisbon, Portugal",
      startDate: "March 2021",
      isCurrent: true,
      achievements: [
        "Cut nightly reconciliation time from 4 hours to 35 minutes.",
      ],
    });

    const reconciled = reconcileCandidates(
      profile,
      seed.searchPreferences,
      candidates,
    );
    const record = reconciled.find(
      (candidate) =>
        candidate.target.section === "experience" &&
        candidate.target.key === "record",
    );
    expect(record).toMatchObject({
      label: "Acme Payments — Senior Backend Engineer",
      resolution: "auto_applied",
      value: {
        companyName: "Acme Payments",
        title: "Senior Backend Engineer",
        startDate: "2021-03",
        isCurrent: true,
      },
    });
    expect(
      reconciled.filter((candidate) => candidate.resolution === "needs_review"),
    ).toEqual([]);

    const merged = applyResolvedResumeImportCandidatesToWorkspace({
      profile,
      searchPreferences: seed.searchPreferences,
      candidates: reconciled,
      analysisProviderKind: null,
      analysisProviderLabel: null,
      analysisWarnings: [],
    });
    expect(merged.profile.experiences).toHaveLength(1);
    expect(merged.profile.experiences[0]).toMatchObject({
      companyName: "Acme Payments",
      title: "Senior Backend Engineer",
      location: "Lisbon, Portugal",
      startDate: "2021-03",
      isCurrent: true,
      achievements: [
        "Cut nightly reconciliation time from 4 hours to 35 minutes.",
      ],
    });
  });

  test("leaves a lone field and a recordId that holds two different roles alone", () => {
    const seed = createSeed();
    const profile = CandidateProfileSchema.parse({
      ...seed.profile,
      experiences: savedRoles,
    });
    const lone = looseRoleCandidates("exp_lone", { title: "Staff Engineer" });
    const clashing = [
      ...looseRoleCandidates("exp_clash", {
        companyName: "Acme Payments",
        title: "Staff Engineer",
      }),
      ResumeImportFieldCandidateSchema.parse({
        ...looseRoleCandidates("exp_clash", { companyName: "Globex" })[0],
        id: "candidate_exp_clash_companyName_second",
      }),
    ];

    const reconciled = reconcileCandidates(profile, seed.searchPreferences, [
      ...lone,
      ...clashing,
    ]);

    expect(
      reconciled.some(
        (candidate) => candidate.resolutionReason === FOLDED_INTO_RECORD_REASON,
      ),
    ).toBe(false);
    expect(
      reconciled.filter(
        (candidate) =>
          candidate.target.section === "experience" &&
          candidate.target.key === "record",
      ),
    ).toEqual([]);
  });
});
