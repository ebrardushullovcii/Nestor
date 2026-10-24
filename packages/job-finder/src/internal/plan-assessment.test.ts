import { expect, it } from "vitest";
import {
  writeDiscoveryPreparation,
  readPreparedBodySalaryRange,
  readPreparedSavedJobIdentity,
} from "@nestor/contracts";
import { jobNeedsFitJudgment, toFitJudgment } from "./fit-judgment";
import { createMatchAssessmentPostingFingerprint } from "./match-assessment-session";
import { createSeed } from "../workspace-service.test-fixtures";
import {
  personPickedJob,
  readPlanAssessment,
  withPlanAssessment,
} from "./plan-assessment";

it("a frozen assessment view carries body preparation without opening unchanged text", () => {
  const job = createSeed().savedJobs[0]!;
  writeDiscoveryPreparation(job, {
    fingerprints: {
      owner: job,
      value: {
        version: 1,
        card: "card",
        detail: "detail",
        material: "material",
      },
    },
    savedIdentity: {
      owner: job,
      value: {
        version: 1,
        local: { keys: [], priorities: [] },
        acrossSources: { keys: [], priorities: [] },
        content: null,
      },
    },
    bodySalaryRange: "EUR 96,000",
  });
  Object.defineProperty(job, "description", {
    enumerable: true,
    get() {
      throw new Error("Assessment view opened unchanged text");
    },
  });
  Object.freeze(job);
  const assessment = { ...job.matchAssessment, score: 71 };
  const view = readPlanAssessment(job, "test", assessment);
  expect(Object.isFrozen(view)).toBe(true);
  expect(view.matchAssessment).toBe(assessment);
  expect(readPreparedBodySalaryRange(view)).toBe("EUR 96,000");
  expect(readPreparedSavedJobIdentity(view)).not.toBeNull();
  expect(readPlanAssessment(job, "test", assessment)).toBe(view);
});

it("stores a plan verdict and the original shared verdict without reading lazy details", () => {
  const base = createSeed().savedJobs[0]!;
  const shared = base.matchAssessment;
  const assessment = { ...shared, score: 12 };
  const job = { ...base, matchAssessment: assessment };
  let bodyReads = 0;
  const getDescription = () => {
    bodyReads++;
    return base.description;
  };
  Object.defineProperty(job, "description", {
    enumerable: true,
    configurable: true,
    get: getDescription,
  });
  const stored = withPlanAssessment(job, "other", assessment, shared);
  expect(stored.matchAssessment).toBe(shared);
  expect(stored.planAssessments?.other).toBe(assessment);
  expect(Object.getOwnPropertyDescriptor(stored, "description")).toMatchObject({
    get: getDescription,
  });
  expect(withPlanAssessment(stored, "other", assessment, shared)).toBe(stored);
  expect(withPlanAssessment(job, null)).toBe(job);
  expect(bodyReads).toBe(0);
});

it("reuses immutable plan views and replaces them when the plan or saved evidence changes", () => {
  const base = createSeed().savedJobs[0]!;
  const a = { ...base.matchAssessment, score: 90 };
  const b = { ...base.matchAssessment, score: 20 };
  const saved = Object.freeze({ ...base, planAssessments: { a, b } });
  const first = readPlanAssessment(saved, "a");
  expect(readPlanAssessment(saved, "a")).toBe(first);
  expect(readPlanAssessment(saved, "b").matchAssessment.score).toBe(20);
  const changed = Object.freeze({ ...saved, planAssessments: { a: b, b } });
  expect(readPlanAssessment(changed, "a").matchAssessment.score).toBe(20);
  expect(readPlanAssessment(changed, "a")).not.toBe(first);
});
it("stores each plan's verdict independently and shows the selected plan's score", () => {
  const job = createSeed().savedJobs[0]!;
  const a = { ...job.matchAssessment, score: 90 };
  const b = { ...job.matchAssessment, score: 20 };
  const shared = withPlanAssessment(
    withPlanAssessment(job, "design", a),
    "engineering",
    b,
  );
  expect(readPlanAssessment(shared, "design").matchAssessment.score).toBe(90);
  expect(readPlanAssessment(shared, "engineering").matchAssessment.score).toBe(
    20,
  );
  expect(
    personPickedJob({ ...job, status: "discovered", personSupplied: true }),
  ).toBe(true);
  expect(personPickedJob({ ...job, status: "shortlisted" })).toBe(true);
  expect(
    personPickedJob({
      ...job,
      status: "discovered",
      provenance: [{ ...job.provenance[0]!, targetId: "assistant_page" }],
    }),
  ).toBe(true);
});

it("prioritizes a person-supplied job even after its source has been named", () => {
  const job = createSeed().savedJobs[0]!;
  expect(
    personPickedJob({
      ...job,
      status: "discovered",
      personSupplied: true,
      provenance: [],
    }),
  ).toBe(true);
});

it("another plan's verdict leaves the shared fit unchanged, and a plan without its own verdict shows the shared one", () => {
  const job = createSeed().savedJobs[0]!;
  const stored = withPlanAssessment(job, "other", {
    ...job.matchAssessment,
    score: 12,
  });
  expect(stored.matchAssessment).toEqual(job.matchAssessment);
  expect(readPlanAssessment(stored, "other").matchAssessment.score).toBe(12);
  // Jobs judged before plans kept their own verdicts keep their fit.
  expect(readPlanAssessment(stored, "missing").matchAssessment).toEqual(
    job.matchAssessment,
  );
});

it("checks staleness against each plan's own context and listing", () => {
  const job = createSeed().savedJobs[0]!;
  const judgment = toFitJudgment(
    {
      score: 80,
      recommendation: "strong_fit",
      role: "exact",
      roleExplanation: null,
      preferences: "aligned",
      preferencesExplanation: null,
      locationReach: "in_area",
      reasons: [],
      gaps: [],
      listingClosed: false,
      listingClosedEvidence: null,
    },
    {
      source: "batch",
      judgedAt: "2026-10-05T10:00:00Z",
      contextFingerprint: "plan-a-goals",
      postingFingerprint: createMatchAssessmentPostingFingerprint(job),
    },
  );
  const a = { ...job.matchAssessment, judgment };
  const b = {
    ...a,
    judgment: { ...judgment, contextFingerprint: "plan-b-goals" },
  };
  const stored = withPlanAssessment(withPlanAssessment(job, "a", a), "b", b);
  expect(
    jobNeedsFitJudgment(readPlanAssessment(stored, "a"), "plan-a-goals"),
  ).toBe(false);
  expect(
    jobNeedsFitJudgment(readPlanAssessment(stored, "b"), "plan-b-goals"),
  ).toBe(false);
  expect(
    jobNeedsFitJudgment(readPlanAssessment(stored, "b"), "changed-b-goals"),
  ).toBe(true);
  expect(
    jobNeedsFitJudgment(readPlanAssessment(stored, "unjudged"), "plan-a-goals"),
  ).toBe(true);
});
