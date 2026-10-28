import { writeFileSync } from "node:fs";
import {
  CandidateProfileSchema,
  CandidateReusableAnswerSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import type { LLMClient } from "../agent/contracts";
import {
  applicationFacts,
  serializeApplicationData,
  storedFacts,
  relevantSavedAnswers,
} from "./application-facts";
import { runApplyAgent } from "./apply-agent";
import { applicationModelFacts } from "./model-facts";
import { buildApplyFormObservation } from "./page-hands";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import type { ApplyAgentConfig, ApplyAnswerSources } from "./types";

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

test("the smaller model catalog preserves every fact, source id and record relationship", () => {
  const input = sources();
  const before = JSON.stringify(input);
  const { storedFactCatalog, ...facts } = JSON.parse(
    applicationModelFacts(input, { payDisclosed: true }),
  ) as Record<string, unknown> & { storedFactCatalog: CatalogRow[] };
  expect(facts).toEqual(
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
    storedFactCatalog.map((row) => ({
      id: row.id,
      value: dereference(facts, row),
    })),
  ).toEqual(original.map((row) => ({ id: row.sourceId, value: row.value })));
  expect(
    storedFactCatalog.filter((row) => row.at).length,
  ).toBeGreaterThanOrEqual(selected.length + 4);
  expect(
    storedFactCatalog.find(
      (row) => row.id === "profile.experiences.role-2.summary",
    )?.at,
  ).toBe("/experiences/2/summary");
  expect(
    storedFactCatalog.find((row) => row.id === "answerLibrary.saved-2")?.at,
  ).toBe("/savedAnswers/2/answer");
  expect(JSON.stringify(input)).toBe(before);
});

// 24 visible controls and a 13k-character body, matching the real form's sizes.
// Every profile value, answer, URL and document here is synthetic.
test("a GitLab-sized fill keeps the same facts and handovers with bounded input and matching", async () => {
  const input = sources();
  const entries = [
    ["Full name", "profile.fullName"],
    ["Email", "profile.email"],
    ["First name", "profile.firstName"],
    ["Last name", "profile.lastName"],
    ["Phone", "profile.phone"],
    ["City", "profile.currentCity"],
    ["GitHub profile URL", "profile.githubUrl"],
    ["LinkedIn", "profile.linkedinUrl"],
    ["Website", "profile.personalWebsiteUrl"],
    ["Country of residence", "profile.currentCountry"],
    ["Middle name", "profile.middleName"],
    ["Describe your recorded work practice 0", "answerLibrary.saved-0"],
    ["Passport country", ""],
    ["Your favourite monitoring tool", ""],
    ["Tell us about a time you resolved an unusual incident", ""],
    ["Resume", ""],
    ...Array.from({ length: 8 }, (_, index) => [
      `Previously answered question ${index}`,
      "",
    ]),
  ];
  const controls: RawApplyControl[] = entries.map(([label], index) => ({
    index,
    tagName: index === 9 ? "select" : "input",
    inputType: index === 15 ? "file" : "text",
    role: "",
    id: `field-${index}`,
    name: `field-${index}`,
    label,
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: index < 16,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    checked: false,
    multiple: false,
    value:
      index === 15
        ? "resume.pdf"
        : index > 15
          ? "Previously supplied by the person"
          : "",
    options:
      index === 9
        ? [
            "Germany",
            ...Array.from({ length: 39 }, (_, n) => `Synthetic territory ${n}`),
          ]
        : [],
    selectedOptionLabel: "",
    ...(index === 15
      ? {
          upload: {
            described: "",
            nearby: "Resume attached",
            shown: true,
            network: "accepted" as const,
          },
        }
      : {}),
  }));
  const raw: RawApplyPage = {
    url: "https://employer.example.test/apply",
    title: "Apply for Platform Engineer",
    bodyText: "Application information and role details. ".repeat(325),
    controls,
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
    headings: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    loading: false,
    stepLabel: null,
  };
  let turns = 0,
    reads = 0;
  const requests: string[] = [];
  const expected = new Map(
    storedFacts(input, { payDisclosed: false }).map((fact) => [
      fact.sourceId,
      fact.value,
    ]),
  );
  const client: LLMClient = {
    chatWithTools: (messages, tools) => {
      requests.push(JSON.stringify({ messages, tools }));
      if (tools[0]?.function.name === "match_application_answer")
        return Promise.resolve({ toolCalls: [] });
      if (tools[0]?.function.name === "report_question_kinds") {
        reads++;
        const questions = JSON.parse(messages[1].content) as {
          question: string;
        }[];
        return Promise.resolve({
          toolCalls: [
            {
              id: `read-${reads}`,
              type: "function",
              function: {
                name: "report_question_kinds",
                arguments: JSON.stringify({
                  plainIndexes: questions.map((_, index) => index),
                  flagged: [],
                  tags: questions.map((question, index) => ({
                    index,
                    kind:
                      question.question === "Passport country"
                        ? "passport"
                        : question.question === "Your favourite monitoring tool"
                          ? "preference"
                          : "other",
                    country: null,
                    sourceId:
                      entries.find(
                        ([label]) => label === question.question,
                      )?.[1] || null,
                  })),
                }),
              },
            },
          ],
        });
      }
      turns++;
      if (turns > 6) throw new Error("The form should already be handed over.");
      const message = messages.find((message) =>
        message.content.startsWith("The person's facts"),
      )!;
      const facts = JSON.parse(
        message.content.slice(message.content.indexOf("\n") + 1),
      ) as Record<string, unknown> & { storedFactCatalog: CatalogRow[] };
      // Proposals read the actual serialized catalog, including dereferencing it.
      const fields = entries
        .slice((turns - 1) * 2, turns * 2)
        .map(([, id], offset) => {
          const row = facts.storedFactCatalog.find((row) => row.id === id)!;
          const value = dereference(facts, row);
          expect(value).toBe(expected.get(id));
          const index = (turns - 1) * 2 + offset;
          return index === 9
            ? {
                tool: "select",
                ref: `c${index}`,
                option: value,
                storedFactId: id,
              }
            : { tool: "type", ref: `c${index}`, text: value, storedFactId: id };
        });
      if (turns === 1)
        fields.push(
          ...[12, 13, 14].map((index) => ({
            tool: "type",
            ref: `c${index}`,
            text: "Unsupported personal claim",
            storedFactId: "",
          })),
        );
      return Promise.resolve({
        toolCalls: [
          {
            id: `fill-${turns}`,
            type: "function",
            function: {
              name: "fill_fields",
              arguments: JSON.stringify({ fields }),
            },
          },
        ],
      });
    },
  };
  const config: ApplyAgentConfig = {
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      allowedOrigins: [],
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
    },
    application: {
      jobId: "synthetic",
      applicationId: "synthetic",
      startingUrl: raw.url!,
    },
    siteLabel: "Synthetic company careers",
    modelQuestionClassification: true,
    sources: input,
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, "2026-10-27T00:00:00Z")),
      fillText: (ref, value) => {
        controls[Number(ref.slice(1))].value = value;
        return Promise.resolve({ ok: true, observedValue: value });
      },
      chooseOption: (ref, value) => {
        controls[Number(ref.slice(1))].value = value;
        controls[Number(ref.slice(1))].selectedOptionLabel = value;
        return Promise.resolve({ ok: true, observedValue: value });
      },
      navigate: (url) => Promise.resolve({ ok: true, url }),
      goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
      followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
      clickElement: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      clickAction: () => {
        throw new Error("No final submit in this replay");
      },
      setToggle: () => Promise.resolve({ ok: true, observedValue: "true" }),
      uploadFile: () =>
        Promise.resolve({ ok: true, observedValue: "resume.pdf" }),
      scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
      wait: () => Promise.resolve(),
      readText: () => Promise.resolve(raw.bodyText),
    },
  };
  const result = await runApplyAgent(config, client);
  if (process.env.NESTOR_APPLY_TURN_COST_CAPTURE)
    writeFileSync(
      process.env.NESTOR_APPLY_TURN_COST_CAPTURE,
      JSON.stringify({
        requests,
        turns,
        reads,
        filled: result.filled.map((field) => ({
          ref: field.ref,
          answer: field.answer,
        })),
        questions: result.pauses
          .flatMap((pause) => pause.questions ?? [])
          .map((question) => question.prompt),
      }),
    );
  expect(turns).toBe(1); // Last-chance lookup fills the known fields before handover.
  expect(reads).toBe(1);
  expect(result.filled).toHaveLength(12);
  expect(controls.slice(0, 12).map((control) => control.value)).toEqual(
    entries.slice(0, 12).map(([, id]) => expected.get(id)),
  );
  expect(
    result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .map((question) => question.prompt),
  ).toEqual(
    expect.arrayContaining(entries.slice(12, 15).map(([label]) => label)),
  );
  expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toHaveLength(
    3,
  );
  expect(result.outcome).toBe("paused");
  expect(controls[11].value).toBe(input.reusableAnswers[0].answer);
  expect(
    result.filled.find((field) => field.ref === "c11")?.answer.sourceId,
  ).toBe("answerLibrary.saved-0");
  const observation = buildApplyFormObservation(raw, "2026-10-27T00:00:00Z");
  const rechecked = await checkClassifiedApplicationAnswers({
    client,
    sources: input,
    payDisclosed: false,
    answers: result.filled.map((field) => ({
      question: field.label,
      answer: field.answer.value,
    })),
    formControls: observation.controls,
    formContext: { pageText: observation.bodyTextExcerpt, fields: [] },
  });
  expect(rechecked.every((check) => check.supported)).toBe(true);
});
