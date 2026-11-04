import {
  CandidateProfileSchema,
  createFreshStartCandidateProfile,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

// The Amplemarket Greenhouse form shape: plain contact fields beside a pay
// question and a personal story. Some question reads stall on the provider.
const FIRST = "First Name";
const LAST = "Last Name";
const EMAIL = "Email";
const SALARY =
  "What are your salary expectations? (Please specify the currency)";
const CODING = "How/when did you start coding?";
const SOURCES: Record<string, string> = {
  [FIRST]: "profile.firstName",
  [LAST]: "profile.lastName",
  [EMAIL]: "profile.email",
};

function field(index: number, label: string): RawApplyControl {
  return {
    index,
    label,
    tagName: "input",
    inputType: "text",
    role: "",
    id: `f${index}`,
    name: `f${index}`,
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: "",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  };
}

function setup() {
  const raw: RawApplyPage = {
    url: "https://replica.example.test/apply",
    title: "Application",
    bodyText: "Apply for this job",
    controls: [FIRST, LAST, EMAIL, SALARY, CODING].map((label, index) =>
      field(index, label),
    ),
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const write = vi.fn((ref: string, value: string) => {
    const control = raw.controls.find((entry) => `c${entry.index}` === ref)!;
    control.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  const hands: ApplyPageHands = {
    observe: () =>
      Promise.resolve(buildApplyFormObservation(raw, new Date().toISOString())),
    fillText: write,
    chooseOption: write,
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: () => Promise.resolve({ ok: false, error: "Upload refused" }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    clickAction: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "clicked" }),
    ),
    navigate: () => Promise.resolve({ ok: true, url: raw.url! }),
    followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
    goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    readText: () => Promise.resolve(raw.bodyText),
  };
  const input: ApplyAgentConfig = {
    hands,
    modelQuestionClassification: true,
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "answer_from_profile",
      allowedOrigins: [],
    },
    application: {
      jobId: "job",
      applicationId: "application",
      startingUrl: raw.url!,
    },
    siteLabel: "Synthetic replica",
    sources: {
      profile: CandidateProfileSchema.parse({
        ...createFreshStartCandidateProfile(),
        id: "synthetic",
        firstName: "Jamie",
        lastName: "Rivers",
        fullName: "Jamie Rivers",
        email: "jamie@example.test",
        currentCountry: "Germany",
      }),
      posting: {
        title: "Engineer",
        company: "Synthetic employer",
        location: "Remote",
        description: "Build software",
      },
      resumeText: null,
      reusableAnswers: [],
      documents: [],
    },
  };
  return { raw, input, write };
}

/** A model whose question reads fail for any group holding `stalls`. */
function client(stalls: readonly string[]) {
  const reads: string[][] = [];
  let turn = 0;
  const call = (name: string, args: unknown) =>
    Promise.resolve({
      toolCalls: [
        {
          id: `${name}-${turn}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
  const model: LLMClient = {
    chatWithTools: (messages, tools) => {
      const name = tools[0]?.function.name;
      if (name === "report_question_kinds") {
        const questions = JSON.parse(messages[1].content) as {
          index: number;
          question: string;
        }[];
        reads.push(questions.map((q) => q.question));
        if (questions.some((q) => stalls.includes(q.question)))
          return Promise.reject(new Error("The question read timed out."));
        return call(name, {
          plainIndexes: questions.map((q) => q.index),
          flagged: [],
          tags: questions.map((q) => ({
            index: q.index,
            kind: "other",
            country: null,
            sourceId: SOURCES[q.question] ?? null,
          })),
        });
      }
      if (name === "match_application_answer")
        return call(name, { sourceId: null });
      if (name === "report_answer_checks")
        return Promise.reject(new Error("No answer check is expected here."));
      turn += 1;
      // The model offers a value for every field, including the unread ones.
      return turn === 1
        ? call("fill_fields", {
            fields: [
              {
                tool: "type",
                ref: "c0",
                text: "Jamie",
                storedFactId: SOURCES[FIRST],
              },
              {
                tool: "type",
                ref: "c1",
                text: "Rivers",
                storedFactId: SOURCES[LAST],
              },
              {
                tool: "type",
                ref: "c2",
                text: "jamie@example.test",
                storedFactId: SOURCES[EMAIL],
              },
              { tool: "type", ref: "c3", text: "90000 EUR" },
              { tool: "type", ref: "c4", text: "At school." },
            ],
          })
        : call("finish", {
            reason: "The rest needs the person.",
            needsPerson: true,
          });
    },
  };
  return { model, reads };
}

function askedFor(result: Awaited<ReturnType<typeof runApplyAgent>>) {
  return new Map(
    result.pauses
      .flatMap(
        (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
      )
      .map((question) => [question.prompt, question] as const),
  );
}

test("stalled reads of other questions do not hand stored name and email to the person", async () => {
  const { raw, input } = setup();
  const { model, reads } = client([SALARY, CODING]);
  const result = await runApplyAgent(input, model);
  // Whole page, three groups, then each remaining question on its own.
  expect(reads.map((group) => group.length)).toEqual([5, 2, 2, 1, 1, 1, 1]);
  expect(raw.controls.map((control) => control.value)).toEqual([
    "Jamie",
    "Rivers",
    "jamie@example.test",
    "",
    "",
  ]);
  // Council D6: a partial outage fills what it can read, then ends as
  // Nestor's retained technical failure; it never asks per-field questions.
  expect(askedFor(result).size).toBe(0);
  expect(result.outcome).toBe("stuck");
  expect(result.readyToSend).toBeNull();
  expect(result.technicalFailure).toEqual({
    code: "question_classification_unavailable",
    retryable: true,
    pageDisposition: "retain",
  });
});

// Council D3 (2026-11-03): a reading outage is Nestor's problem, not a
// question for a fact Profile holds. An exact applicant-identity binding
// fills without a reading; an unread pay question still does not.
test("an unread first-name question fills from its exact Profile fact; unread pay is not written", async () => {
  const { raw, input } = setup();
  const { model } = client([FIRST, SALARY]);
  const result = await runApplyAgent(input, model);
  expect(raw.controls.slice(0, 4).map((control) => control.value)).toEqual([
    "Jamie",
    "Rivers",
    "jamie@example.test",
    "",
  ]);
  // Unread pay is not written and not asked: the run ends technical.
  expect(askedFor(result).size).toBe(0);
  expect(result.outcome).toBe("stuck");
  expect(result.technicalFailure?.code).toBe(
    "question_classification_unavailable",
  );
});

test("a page with no readable question stops before any model turn and says why", async () => {
  const { raw, input } = setup();
  const { model, reads } = client([FIRST, LAST, EMAIL, SALARY, CODING]);
  const fill = vi.spyOn(model, "chatWithTools");
  const result = await runApplyAgent(input, model);
  // Whole page, three groups, then each question on its own; no form turn.
  expect(reads).toHaveLength(9);
  expect(fill).toHaveBeenCalledTimes(9);
  expect(raw.controls.every((control) => control.value === "")).toBe(true);
  // Council B10/D6: a full outage is Nestor's technical failure, with no
  // personal question; the page is kept for one ordinary Retry.
  expect(askedFor(result).size).toBe(0);
  expect(result.filled).toEqual([]);
  expect(result.outcome).toBe("stuck");
  expect(result.technicalFailure).toEqual({
    code: "question_classification_unavailable",
    retryable: true,
    pageDisposition: "retain",
  });
});
