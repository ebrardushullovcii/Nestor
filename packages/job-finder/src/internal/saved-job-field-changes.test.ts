import { expect, test } from "vitest";
import { copyView } from "@nestor/core";
import { createSeed } from "../workspace-service.test-fixtures";
import { changedSavedJobFields } from "./saved-job-field-changes";
import { toSightingIdentityInput } from "./matching";
import { withPlanAssessment } from "./plan-assessment";

test("plan verdict copies and field deltas leave unchanged immutable detail evidence unopened", () => {
  let reads = 0;
  const job = createSeed().savedJobs[0]!;
  const body = job.description;
  Object.defineProperty(job, "description", {
    enumerable: true,
    configurable: true,
    get: () => {
      reads++;
      return body;
    },
  });
  Object.freeze(job);
  const assessment = { ...job.matchAssessment, score: 72 };
  const intended = withPlanAssessment(
    copyView(job, { status: "shortlisted" as const }),
    "plan",
    assessment,
  );
  expect(changedSavedJobFields(job, intended)).toEqual([
    "status",
    "planAssessments",
  ]);
  const identity = toSightingIdentityInput(job);
  expect(identity.title).toBe(job.title);
  expect(reads).toBe(0);
  expect(identity.description).toBe(body);
  expect(reads).toBe(1);
  const edited = copyView(job, {});
  Object.defineProperty(edited, "description", {
    enumerable: true,
    value: "Changed listing",
  });
  expect(changedSavedJobFields(job, edited)).toEqual(["description"]);
});

test("ordinary identity inputs keep captured descriptions after a mutable row changes", () => {
  const job = createSeed().savedJobs[0]!;
  const body = job.description;
  const identity = toSightingIdentityInput(job);
  job.description = "Later listing";
  expect(identity.description).toBe(body);
});
