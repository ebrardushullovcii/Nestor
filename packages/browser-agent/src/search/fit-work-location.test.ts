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
    name: "foreign hybrid work with missing permission needs review despite relocation assistance",
    location: "San Francisco",
    body: "Use a hybrid work model of 3 days in the office. We offer relocation assistance.",
    evidence: [
      "compatible",
      "hybrid work model of 3 days in the office",
      "hybrid",
      "US",
    ],
    expected: "review",
  },
  {
    name: "a remote work-mode quote does not prove worldwide hiring",
    location: "United States",
    body: "This role is fully remote.",
    evidence: ["compatible", "fully remote", "broader_remote", "US"],
    expected: "review",
  },
  {
    name: "a work-from-anywhere benefit cannot expand a published foreign country",
    location: "United States",
    body: "Work from anywhere – flexibility to fit your life.",
    evidence: ["compatible", "Work from anywhere", "broader_remote", "US"],
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
    name: "European country wording includes non-EU countries",
    location: "Remote, Europe",
    body: "Work remotely from any European country, including non-EU countries.",
    evidence: [
      "compatible",
      "Work remotely from any European country, including non-EU countries",
      "broader_remote",
      "",
    ],
    expected: "compatible",
  },
  {
    name: "a short European work-region quote needs no enumerated countries",
    location: "Remote, Europe",
    body: "Work remotely from any European country, including non-EU countries.",
    evidence: [
      "compatible",
      "Work remotely from any European country",
      "broader_remote",
      "",
    ],
    expected: "compatible",
  },
  {
    name: "European customers do not establish a European hiring region",
    location: "United States",
    body: "Our platform serves European customers.",
    evidence: ["compatible", "European customers", "broader_remote", "US"],
    expected: "review",
  },
  {
    name: "an EU-only restriction still excludes a non-EU candidate",
    location: "Remote, Europe",
    body: "Work remotely from European Union countries only.",
    evidence: [
      "blocked",
      "European Union countries only",
      "broader_remote",
      "",
    ],
    expected: "blocked",
  },
  ...["European Union", "European Economic Area"].map((region) => ({
    name: `${region} wording cannot prove eligibility throughout Europe`,
    location: "Remote, Europe",
    body: `Work remotely from ${region} countries only.`,
    evidence: [
      "compatible",
      `Work remotely from ${region} countries only`,
      "broader_remote",
      "",
    ] as FitLocationEvidence,
    expected: "review",
  })),
  {
    name: "a published remote region is not narrowed to the model's incomplete country list",
    location: "Remote - North America - South America - Europe",
    body: "Remote - North America - South America - Europe",
    evidence: [
      "compatible",
      "Remote - North America - South America - Europe",
      "broader_remote",
      "US,CA,BR",
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
  ).toBe("review");
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

test("worldwide recruitment leaves missing onsite permission unresolved", () => {
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
  ).toBe("review");
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
  ).toBe("review");
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

test("work from wherever is corroborated by a global remote location", () => {
  const job = {
    location: "Global Remote",
    description: "Work from wherever you want.",
    workModes: ["remote"],
  };
  for (const countries of ["", "US"])
    expect(
      assessFitWorkLocation(profile, job, [
        "compatible",
        "Work from wherever you want",
        "broader_remote",
        countries,
      ]).status,
    ).toBe("compatible");
  expect(
    assessFitWorkLocation(profile, { ...job, location: "United States" }, [
      "compatible",
      "Work from wherever you want",
      "broader_remote",
      "US",
    ]).status,
  ).toBe("review");
  expect(
    assessFitWorkLocation(
      profile,
      {
        ...job,
        description: "US residents only. Work from wherever you want.",
      },
      ["blocked", "US residents only", "country_remote", "US"],
    ).status,
  ).toBe("blocked");
  expect(
    assessFitWorkLocation(profile, job, [
      "review",
      "Work from wherever you want",
      "broader_remote",
      "US",
    ]).status,
  ).toBe("review");
});
