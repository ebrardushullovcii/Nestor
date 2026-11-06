import { expect, test } from "vitest";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
} from "@nestor/contracts";
import { buildListingFitPerson } from "@nestor/browser-agent";
import { fitContextFingerprint } from "./fit-input";
import type { JobSearchContext } from "./types";

const profile = CandidateProfileSchema.parse({
  id: "synthetic",
  fullName: "Synthetic Applicant",
  email: "synthetic@example.test",
  headline: "Analyst",
  summary: null,
  currentLocation: "Germany",
  yearsExperience: 2,
  skills: ["SQL"],
  baseResume: {
    id: "synthetic",
    fileName: "synthetic.txt",
    uploadedAt: "2026-11-06T00:00:00Z",
    textContent:
      "Synthetic resume: certified analyst with a reporting portfolio.",
  },
  certifications: [
    {
      id: "cert",
      name: "Analytics Certificate",
      issuer: "Synthetic Institute",
    },
    { id: "draft-cert", name: "Unconfirmed Licence", isDraft: true },
  ],
  experiences: [
    { id: "draft-role", title: "Unconfirmed Director", isDraft: true },
  ],
});
const context: JobSearchContext = {
  profile,
  searchPreferences: JobSearchPreferencesSchema.parse({
    targetRoles: ["Data Analyst"],
    locations: ["Germany"],
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
  }),
  sources: [],
  sourceInstructionArtifacts: [],
};

test("partial parsed facts retain resume/certification evidence and exclude unconfirmed drafts", () => {
  const evidence = buildListingFitPerson(profile);
  expect(evidence.resume).toContain("reporting portfolio");
  expect(evidence.certifications.map((entry) => entry.name)).toEqual([
    "Analytics Certificate",
  ]);
  expect(evidence.experiences).toEqual([]);
  expect(JSON.stringify(evidence)).not.toContain(profile.email);
});

test("changed resume or certificate rejudges fit even when skills were parsed; contact edits do not", () => {
  const before = fitContextFingerprint(context);
  expect(
    fitContextFingerprint({
      ...context,
      profile: { ...profile, email: "changed@example.test" },
    }),
  ).toBe(before);
  expect(
    fitContextFingerprint({
      ...context,
      profile: {
        ...profile,
        baseResume: {
          ...profile.baseResume,
          textContent: "Synthetic changed evidence",
        },
      },
    }),
  ).not.toBe(before);
  expect(
    fitContextFingerprint({
      ...context,
      profile: { ...profile, certifications: [] },
    }),
  ).not.toBe(before);
});
