import { JobSearchPreferencesSchema, SavedJobSchema } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { describeRemoteOnlySourceMismatch } from "./discovery-location-alignment";

const preferences = JobSearchPreferencesSchema.parse({
  targetRoles: ["Recruiter"],
  locations: ["Chicago, IL"],
  workModes: ["onsite", "hybrid"],
  minimumSalaryUsd: null,
  approvalMode: "review_before_submit",
  tailoringMode: "balanced",
});

function remoteJob() {
  return SavedJobSchema.parse({
    id: "job_remote",
    source: "target_site",
    sourceJobId: "remote_1",
    canonicalUrl: "https://jobs.example.test/remote_1",
    title: "Recruiter",
    company: "Example",
    location: "Anywhere",
    workMode: ["remote"],
    applyPath: "unknown",
    easyApplyEligible: false,
    salaryText: null,
    status: "discovered",
    discoveredAt: "2026-09-12T10:00:00.000Z",
    description: "Recruiter",
    summary: "Recruiter",
    matchAssessment: {
      score: 70,
      locationReach: "in_area",
      reasons: ["Location fits the saved search preferences."],
      gaps: [],
      dimensions: {
        preferenceAlignment: {
          state: "aligned",
          explanation: "Anywhere compared with Chicago, IL: aligned.",
          evidence: [
            {
              source: "derived",
              label: "Location comparison",
              detail: "Anywhere compared with Chicago, IL: aligned.",
            },
          ],
        },
      },
    },
  });
}

function judged(
  job: ReturnType<typeof remoteJob>,
  locationReach: "in_area" | "remote_preferred" | "outside_area",
) {
  return SavedJobSchema.parse({
    ...job,
    matchAssessment: {
      ...job.matchAssessment,
      judgment: {
        source: "batch",
        judgedAt: "2026-10-02T10:00:00.000Z",
        score: 50,
        recommendation: "review_before_applying",
        locationReach,
      },
    },
  });
}

describe("remote-only source warning", () => {
  it("warns when the model judged every remote result outside the saved places", () => {
    expect(
      describeRemoteOnlySourceMismatch(
        [judged(remoteJob(), "outside_area")],
        preferences,
      ),
    ).toBe(
      "This search returned only remote jobs; try another search for jobs in Chicago, IL.",
    );
  });

  it("does not warn when the model judged a result in the saved places", () => {
    expect(
      describeRemoteOnlySourceMismatch(
        [judged(remoteJob(), "outside_area"), judged(remoteJob(), "in_area")],
        preferences,
      ),
    ).toBeNull();
  });

  it("does not warn about a job that is not remote", () => {
    const office = judged(
      SavedJobSchema.parse({ ...remoteJob(), workMode: ["onsite"] }),
      "outside_area",
    );
    expect(describeRemoteOnlySourceMismatch([office], preferences)).toBeNull();
  });

  it("does not warn on a guess when the model has not judged a job", () => {
    expect(
      describeRemoteOnlySourceMismatch([remoteJob()], preferences),
    ).toBeNull();
  });

  it("does not warn when a saved location explicitly accepts remote work", () => {
    const remotePreferences = JobSearchPreferencesSchema.parse({
      ...preferences,
      locations: ["Chicago, IL", "Remote, Worldwide"],
    });

    expect(
      describeRemoteOnlySourceMismatch(
        [judged(remoteJob(), "outside_area")],
        remotePreferences,
      ),
    ).toBeNull();
  });
});
