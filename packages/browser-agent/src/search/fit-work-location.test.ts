import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import {
  assessFitWorkLocation,
  type FitLocationEvidence,
} from "./fit-work-location";

const profile = CandidateProfileSchema.parse({
  id: "synthetic",
  yearsExperience: 8,
  currentCountry: "Kosovo",
  currentLocation: "Pristina",
  workEligibility: {
    authorizedWorkCountries: ["Kosovo"],
    willingToRelocate: true,
  },
  baseResume: {
    id: "synthetic",
    fileName: "synthetic.txt",
    uploadedAt: "2026-10-27T00:00:00Z",
  },
});
const cases: Array<{
  name: string;
  location: string;
  body: string;
  evidence: FitLocationEvidence;
  expected: string;
}> = [
  {
    name: "a bare foreign country cannot become worldwide remote",
    location: "United States",
    body: "Build production software.",
    evidence: ["compatible", "Remote flexible", "unknown", "US"],
    expected: "review",
  },
  {
    name: "a foreign city without broader hiring evidence needs review",
    location: "New York City",
    body: "Build production software.",
    evidence: ["compatible", "New York City", "unknown", "US"],
    expected: "review",
  },
  {
    name: "foreign hybrid work is blocked despite relocation assistance",
    location: "San Francisco",
    body: "Use a hybrid work model of 3 days in the office. We offer relocation assistance.",
    evidence: [
      "compatible",
      "hybrid work model of 3 days in the office",
      "hybrid",
      "US",
    ],
    expected: "blocked",
  },
  {
    name: "a remote work-mode quote does not prove worldwide hiring",
    location: "United States",
    body: "This role is fully remote.",
    evidence: ["compatible", "fully remote", "broader_remote", "US"],
    expected: "review",
  },
  {
    name: "an invented global quote cannot override the published country",
    location: "United States",
    body: "Build production software.",
    evidence: [
      "compatible",
      "We hire remotely worldwide",
      "broader_remote",
      "US",
    ],
    expected: "review",
  },
  {
    name: "worldwide customers do not make a job worldwide remote",
    location: "United States",
    body: "Our platform serves customers worldwide.",
    evidence: ["compatible", "customers worldwide", "broader_remote", "US"],
    expected: "review",
  },
  {
    name: "working with customers worldwide does not establish a work region",
    location: "United States",
    body: "You work with customers worldwide.",
    evidence: [
      "compatible",
      "work with customers worldwide",
      "broader_remote",
      "US",
    ],
    expected: "review",
  },
  {
    name: "explicit worldwide hiring may broaden a US location",
    location: "United States",
    body: "We hire remotely worldwide.",
    evidence: [
      "compatible",
      "We hire remotely worldwide",
      "broader_remote",
      "US",
    ],
    expected: "compatible",
  },
  {
    name: "an explicit Europe work region includes this candidate",
    location: "Remote, Europe",
    body: "Work remotely throughout Europe, including non-EU countries.",
    evidence: [
      "compatible",
      "Work remotely throughout Europe",
      "broader_remote",
      "",
    ],
    expected: "compatible",
  },
  {
    name: "an unresolved authorization requirement stays review",
    location: "Worldwide",
    body: "Work remotely worldwide. US work authorization required.",
    evidence: [
      "review",
      "US work authorization required",
      "broader_remote",
      "",
    ],
    expected: "review",
  },
];
test.each(cases)("$name", ({ location, body, evidence, expected }) => {
  expect(
    assessFitWorkLocation(
      profile,
      { location, description: body, workModes: [] },
      evidence,
    ).status,
  ).toBe(expected);
});

test("recorded work permission and relocation willingness are separate facts", () => {
  const job = {
    location: "United States",
    description: "This is an onsite role.",
    workModes: ["onsite"] as const,
  };
  const evidence: FitLocationEvidence = [
    "compatible",
    "onsite role",
    "onsite",
    "US",
  ];
  expect(
    assessFitWorkLocation(
      profile,
      { ...job, workModes: [...job.workModes] },
      evidence,
    ).status,
  ).toBe("blocked");
  const allowed = CandidateProfileSchema.parse({
    ...profile,
    workEligibility: {
      ...profile.workEligibility,
      authorizedWorkCountries: ["United States"],
    },
  });
  expect(
    assessFitWorkLocation(
      allowed,
      { ...job, workModes: [...job.workModes] },
      evidence,
    ).status,
  ).toBe("compatible");
  expect(
    assessFitWorkLocation(
      {
        ...allowed,
        workEligibility: {
          ...allowed.workEligibility,
          willingToRelocate: false,
        },
      },
      { ...job, workModes: [...job.workModes] },
      evidence,
    ).status,
  ).toBe("review");
});

test("worldwide recruitment does not waive a published onsite requirement", () => {
  expect(
    assessFitWorkLocation(
      profile,
      {
        location: "United States",
        description: "We hire worldwide.",
        workModes: ["onsite"],
      },
      ["compatible", "We hire worldwide", "broader_remote", "US"],
    ).status,
  ).toBe("blocked");
});

test("missing passages retain an explanation for an uncertain verdict", () => {
  const result = assessFitWorkLocation(
    profile,
    {
      location: "New York City",
      description: "Build software.",
      workModes: [],
    },
    ["review", "", "unknown", "US"],
  );
  expect(result.status).toBe("review");
  expect(result.reason).toBe(
    "Your work location or permission needs checking.",
  );
});

test("a saved country-choice fallback permits its offered list, never onsite work permission", () => {
  const rule = {
    primary: "Kosovo",
    fallback: "Albania",
    whenNeitherOffered: "skip_application" as const,
  };
  const job = {
    location: "Remote",
    description: "Our offered countries are Albania, Serbia and Montenegro.",
    workModes: [],
  };
  expect(
    assessFitWorkLocation(
      profile,
      job,
      [
        "compatible",
        "Albania, Serbia and Montenegro",
        "offered_list",
        "AL,RS,ME",
      ],
      [rule],
    ).status,
  ).toBe("compatible");
  expect(
    assessFitWorkLocation(
      profile,
      { ...job, location: "Albania", workModes: ["onsite"] },
      [
        "compatible",
        "Albania, Serbia and Montenegro",
        "offered_list",
        "AL,RS,ME",
      ],
      [rule],
    ).status,
  ).toBe("blocked");
});

test("a US city suffix is not a Canadian work country", () => {
  const local = CandidateProfileSchema.parse({
    ...profile,
    currentCountry: "United States",
    workEligibility: { authorizedWorkCountries: ["United States"] },
  });
  expect(
    assessFitWorkLocation(
      local,
      {
        location: "San Francisco, CA",
        description: "This is an onsite role.",
        workModes: ["onsite"],
      },
      ["compatible", "onsite role", "onsite", "US"],
    ).status,
  ).toBe("compatible");
});

test("unknown profile or work countries need review", () => {
  const job = {
    location: "Office",
    description: "Build software.",
    workModes: [],
  };
  expect(
    assessFitWorkLocation(profile, job, ["compatible", "", "unknown", ""])
      .status,
  ).toBe("review");
  expect(
    assessFitWorkLocation(
      { ...profile, currentCountry: "" },
      {
        ...job,
        location: "United States",
      },
      ["compatible", "", "unknown", "US"],
    ).status,
  ).toBe("review");
});
