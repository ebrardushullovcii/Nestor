import { describe, expect, test } from "vitest";
import { CandidateEducationSchema } from "@nestor/contracts";

import {
  mergeCertificationRecords,
  mergeEducationRecords,
  mergeProjectRecords,
} from "./profile-merge";

type SavedCertifications = Parameters<typeof mergeCertificationRecords>[0];
type ImportedCertifications = Parameters<typeof mergeCertificationRecords>[1];
type SavedProjects = Parameters<typeof mergeProjectRecords>[0];
type ImportedProjects = Parameters<typeof mergeProjectRecords>[1];

function certificate(id: string, issueDate: string, expiryDate: string) {
  return {
    id,
    name: "AWS Certified Developer",
    issuer: "AWS",
    issueDate,
    expiryDate,
    credentialUrl: null,
    isDraft: false,
  };
}

function project(id: string, role: string, summary: string) {
  return {
    id,
    name: "Payments platform",
    projectType: null,
    summary,
    role,
    skills: [],
    outcome: null,
    projectUrl: null,
    repositoryUrl: null,
    caseStudyUrl: null,
  };
}

describe("mergeCertificationRecords", () => {
  test("updates the exact certificate when two share a name", () => {
    const saved: SavedCertifications = [
      certificate("c2019", "2019", "2022"),
      certificate("c2022", "2022", "2025"),
    ];
    const imported = [
      {
        name: "AWS Certified Developer",
        issuer: "AWS",
        issueDate: "2022",
        expiryDate: "2025",
        credentialUrl: "https://aws.example/verify/2022",
      },
    ] as ImportedCertifications;

    expect(
      mergeCertificationRecords(saved, imported).map((entry) => [
        entry.id,
        entry.issueDate,
        entry.credentialUrl,
      ]),
    ).toEqual([
      ["c2019", "2019", null],
      ["c2022", "2022", "https://aws.example/verify/2022"],
    ]);
  });

  test("adds a same-name certificate when the name alone matches several", () => {
    const saved: SavedCertifications = [
      certificate("c2019", "2019", "2022"),
      certificate("c2022", "2022", "2025"),
    ];
    const imported = [
      {
        name: "AWS Certified Developer",
        issuer: "AWS",
        issueDate: "2025",
        expiryDate: "2028",
        credentialUrl: null,
      },
    ] as ImportedCertifications;

    const merged = mergeCertificationRecords(saved, imported);
    expect(merged.map((entry) => entry.issueDate)).toEqual([
      "2019",
      "2022",
      "2025",
    ]);
  });

  test("still renews the one saved certificate with that name", () => {
    const saved: SavedCertifications = [certificate("c2019", "2019", "2022")];
    const imported = [
      {
        name: "AWS Certified Developer",
        issuer: "AWS",
        issueDate: "2022",
        expiryDate: "2025",
        credentialUrl: null,
      },
    ] as ImportedCertifications;

    expect(
      mergeCertificationRecords(saved, imported).map((entry) => [
        entry.id,
        entry.issueDate,
      ]),
    ).toEqual([["c2019", "2022"]]);
  });

  test("keeps two same-name certificates read in one import", () => {
    const imported = [
      {
        name: "AWS Certified Developer",
        issuer: "AWS",
        issueDate: "2019",
        expiryDate: "2022",
        credentialUrl: null,
      },
      {
        name: "AWS Certified Developer",
        issuer: "AWS",
        issueDate: "2022",
        expiryDate: "2025",
        credentialUrl: null,
      },
    ] as ImportedCertifications;

    expect(
      mergeCertificationRecords([], imported).map((entry) => entry.issueDate),
    ).toEqual(["2019", "2022"]);
  });
});

describe("mergeEducationRecords", () => {
  test("does not bypass education identity with a school-only key", () => {
    const yearOnly = CandidateEducationSchema.parse({
      id: "year-only",
      schoolName: "Synthetic University",
      endDate: "2018",
    });
    const fieldOnly = CandidateEducationSchema.parse({
      id: "field-only",
      schoolName: "Synthetic University",
      fieldOfStudy: "Business Administration",
    });
    const merged = mergeEducationRecords([yearOnly], [fieldOnly]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(yearOnly);
  });

  test("re-importing a degree read without its school does not add a copy", () => {
    const saved = CandidateEducationSchema.parse({
      id: "no-school",
      degree: "BSc Computer Science",
      endDate: "2018",
      isDraft: true,
    });
    const merged = mergeEducationRecords(
      [saved],
      [
        {
          schoolName: null,
          degree: "BSc Computer Science",
          fieldOfStudy: null,
          location: null,
          startDate: null,
          endDate: "2018",
          summary: null,
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("no-school");
  });
});

describe("mergeProjectRecords", () => {
  test("updates the project with the same name and role when two share a name", () => {
    const saved: SavedProjects = [
      project("p_lead", "Tech lead", "Led the rewrite."),
      project("p_ic", "Engineer", "Built the ledger."),
    ];
    const imported = [
      {
        name: "Payments platform",
        projectType: null,
        summary: "Built the ledger and its reconciliation jobs.",
        role: "Engineer",
        skills: [],
        outcome: null,
        projectUrl: null,
        repositoryUrl: null,
        caseStudyUrl: null,
      },
    ] as ImportedProjects;

    expect(
      mergeProjectRecords(saved, imported).map((entry) => [
        entry.id,
        entry.summary,
      ]),
    ).toEqual([
      ["p_lead", "Led the rewrite."],
      ["p_ic", "Built the ledger and its reconciliation jobs."],
    ]);
  });
});
