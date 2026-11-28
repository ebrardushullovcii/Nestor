import {
  CandidateProfileSchema,
  CandidateReusableAnswerSchema,
  type CandidateApplicationHistory,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import {
  applicationFacts,
  relevantSavedAnswers,
  serializeApplicationData,
  storedFacts,
} from "./application-facts";
import { applicationModelFactsMessages } from "./model-facts";
import type { ApplyAnswerSources } from "./types";

function sources(): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      fullName: "Robin Example",
      firstName: "Robin",
      middleName: "Jade",
      lastName: "Example",
      email: "robin@example.test",
      phone: "+49 30 12345678",
      currentCity: "Berlin",
      currentCountry: "Germany",
      timeZone: "Europe/Berlin",
      yearsExperience: 4,
      githubUrl: "https://github.com/robin-example",
      linkedinUrl: "https://www.linkedin.com/in/robin-example",
      portfolioUrl: "https://robin.example.test",
      personalWebsiteUrl: "https://robin.example.test",
      experiences: Array.from({ length: 4 }, (_, index) => ({
        id: `role-${index}`,
        companyName: `Example Workshop ${index}`,
        title: "Platform Engineer",
        summary:
          `Role ${index}: ` +
          "Maintained services and documented deployment procedures. ".repeat(
            16,
          ),
        startDate: "2021-01",
        endDate: "2024-01",
      })),
      baseResume: {
        id: "synthetic",
        fileName: "resume.pdf",
        uploadedAt: "2026-10-27T00:00:00Z",
        textContent: "Maintained internal deployment documentation. ".repeat(
          240,
        ),
        extractionStatus: "ready",
      },
    }),
    resumeText: "Maintained internal deployment documentation. ".repeat(240),
    posting: {
      title: "Platform Engineer",
      company: "Example Workshop",
      location: "Germany",
      description: "Maintain internal platform services. ".repeat(80),
    },
    reusableAnswers: Array.from({ length: 18 }, (_, index) =>
      CandidateReusableAnswerSchema.parse({
        id: `saved-${index}`,
        kind: "other",
        label: `Recorded work practice ${index}`,
        question: `Describe your recorded work practice ${index}`,
        answer:
          `Practice ${index}: ` +
          "Documented a repeatable process for reviewing service health. ".repeat(
            12,
          ),
      }),
    ),
    documents: [],
  };
}

interface CatalogRow {
  id: string;
  value?: string;
  at?: string;
}
function dereference(facts: Record<string, unknown>, row: CatalogRow): unknown {
  if (!row.at) return row.value;
  return row.at
    .slice(1)
    .split("/")
    .reduce<unknown>((value, part) => {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      return value && typeof value === "object"
        ? (value as Record<string, unknown>)[key]
        : undefined;
    }, facts);
}

function messageData<T = Record<string, unknown>>(message: string): T {
  return JSON.parse(message.slice(message.indexOf("\n") + 1)) as T;
}

test("the smaller model catalog preserves every fact, source id and record relationship", () => {
  const input = sources();
  const before = JSON.stringify(input);
  const messages = applicationModelFactsMessages(input, true);
  const { storedFactCatalog, ...facts } = messageData(messages.owner);
  const catalog = storedFactCatalog as CatalogRow[];
  const savedAnswers = messageData<
    ReturnType<typeof applicationFacts>["savedAnswers"]
  >(messages.savedAnswers!);
  expect({
    ...facts,
    savedAnswers,
    ...messageData(messages.job),
    applicationHistory: {},
  }).toEqual(
    JSON.parse(
      serializeApplicationData(applicationFacts(input, { payDisclosed: true })),
    ),
  );
  const selected = relevantSavedAnswers(input.reusableAnswers);
  // Every confirmed saved answer reaches the model; none is cut for length.
  expect(selected).toHaveLength(
    input.reusableAnswers.filter((answer) => !answer.needsConfirmation).length,
  );
  const original = storedFacts(
    { ...input, reusableAnswers: selected },
    { payDisclosed: true },
  );
  expect(
    catalog.map((row) => ({
      id: row.id,
      value: dereference(facts, row),
    })),
  ).toEqual(
    original
      .filter((row) => row.sourceKind !== "answer_library")
      .map((row) => ({ id: row.sourceId, value: row.value })),
  );
  expect(
    savedAnswers.map((entry) => ({
      id: entry.storedFactId,
      value: entry.answer,
    })),
  ).toEqual(
    original
      .filter((row) => row.sourceKind === "answer_library")
      .map((row) => ({ id: row.sourceId, value: row.value })),
  );
  expect(
    catalog.find((row) => row.id === "profile.experiences.role-2.summary")?.at,
  ).toBe("/experiences/2/summary");
  expect(JSON.stringify(input)).toBe(before);
});

test("new applications and saved answers preserve the complete history blocks", () => {
  const input = sources();
  const at = "2026-01-02T00:00:00Z";
  const applications: CandidateApplicationHistory["applications"] = Array.from(
    { length: 10 },
    (_, index) => ({
      source: "applications",
      id: index + 1,
      jobId: index + 20,
      mode: "autonomous_submit",
      title: "Engineer",
      company: "Example Test Employer",
      location: "Remote",
      state: "running",
      attempt: 1,
      queuedAt: at,
      updatedAt: at,
      submittedAt: null,
      error: null,
      url: `https://example.test/jobs/${index}`,
      applyUrl: null,
      submissionOutcome: null,
    }),
  );
  const active = applications[8];
  const tracker: CandidateApplicationHistory["tracker"] = [
    {
      source: "tracker",
      jobId: active.jobId,
      title: active.title,
      company: active.company,
      status: "interview",
      statusAt: at,
      appliedAt: at,
      events: [],
    },
  ];
  const first = applicationModelFactsMessages(
    {
      ...input,
      history: { applications: applications.slice(0, 9), tracker },
    },
    true,
    "application_9",
  );
  const next = applicationModelFactsMessages(
    {
      ...input,
      reusableAnswers: input.reusableAnswers.slice(1),
      history: { applications, tracker },
    },
    true,
    "application_10",
  );
  expect(next.owner).toBe(first.owner);
  expect(first.completeHistory).toHaveLength(1);
  expect(next.completeHistory).toEqual(first.completeHistory);
  expect(first.partialHistory).toBeUndefined();
  expect(next.partialHistory).toContain('"status":"interview"');
  expect(messageData(first.job)).toMatchObject({
    currentApplication: { id: 9, tracker: { status: "interview" } },
  });
  expect(messageData(next.job)).toMatchObject({
    currentApplication: { id: 10 },
  });
});

test("job facts and application answers do not change the reusable owner block", () => {
  const input = sources();
  const first = applicationModelFactsMessages(input, true);
  const localAnswer = CandidateReusableAnswerSchema.parse({
    id: "application_43_start_date",
    label: "Start date",
    question: "When can you start this assignment?",
    answer: "In June",
  });
  const next = applicationModelFactsMessages(
    {
      ...input,
      resumeText: "Resume tailored to the next employer.",
      listingDiscovery: {
        label: "Example board",
        url: "https://board.example.test",
      },
      taskInstructions: ["Use the availability I entered for this company."],
      reusableAnswers: [...input.reusableAnswers, localAnswer],
    },
    false,
  );
  expect(next.owner).toBe(first.owner);
  expect(messageData(next.job)).toMatchObject({
    attachedResume: { text: "Resume tailored to the next employer." },
    payDisclosure: false,
    savedAnswers: [
      {
        answer: "In June",
        storedFactId: `answerLibrary.${localAnswer.id}`,
      },
    ],
  });
});

// 24 visible controls and a 13k-character body, matching the real form's sizes.
// Every profile value, answer, URL and document here is synthetic.
