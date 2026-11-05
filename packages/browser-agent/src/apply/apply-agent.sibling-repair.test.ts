import { meaningHash, meaningTargetHash } from "./answer-meaning";
import { formWritingInstructions } from "./own-words";
import {
  executeApplyProposal,
  createApplyGuardState,
  type ApplyExecutorDeps,
} from "./policy-executor";
import {
  CandidateProfileSchema,
  CandidateReusableAnswerSchema,
  createFreshStartCandidateProfile,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

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
function setup(controls: RawApplyControl[]) {
  const raw: RawApplyPage = {
    url: "https://replica.example.test/apply",
    title: "Application",
    bodyText: "Personal information",
    controls,
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
    control.invalid = false;
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
      Promise.resolve({
        ok: true as const,
        observedValue: "clicked",
      }),
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
      salaryDisclosure: "pause_for_user",
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
        currentCity: "Riverside",
        currentCountry: "Germany",
        currentLocation: "Riverside, Germany",
      }),
      posting: {
        title: "Engineer",
        company: "Synthetic employer",
        location: "Germany",
        description: "Build software",
      },
      resumeText: null,
      reusableAnswers: [],
      documents: [],
    },
  };
  return { raw, input, write };
}

function checkingClient() {
  let actorTurn = 0;
  const calls: { name: string; messages: unknown }[] = [];
  const chatWithTools: LLMClient["chatWithTools"] = (messages, tools) => {
    const name = tools[0]?.function.name ?? "actor";
    calls.push({ name, messages });
    const reply = (tool: string, args: unknown) =>
      Promise.resolve({
        toolCalls: [
          {
            id: "offline",
            type: "function" as const,
            function: { name: tool, arguments: JSON.stringify(args) },
          },
        ],
      });
    if (name === "report_question_kinds") {
      const qs = JSON.parse(String(messages[1].content)) as {
        index: number;
        question: string;
      }[];
      return reply(name, {
        plainIndexes: qs.map((q) => q.index),
        flagged: [],
        tags: qs.map((q) => ({
          index: q.index,
          kind: "other",
          country: null,
          declarationPurpose: null,
          sourceId: q.question.includes("SQL")
            ? "answerLibrary.sql"
            : "answerLibrary.capacity",
        })),
      });
    }
    if (name === "match_application_answer")
      return reply(name, { sourceId: null });
    if (name === "report_answer_checks") {
      const data = JSON.parse(String(messages[1].content)) as {
        answers: { index: number; question: string }[];
      };
      return reply(name, {
        checks: data.answers.map((q) => ({
          index: q.index,
          supported: true,
          meaningPreserved: true,
          reason: "The supplied saved answer supports this value.",
          evidence: [
            {
              claim: "Recorded answer",
              kind: "applicant_fact",
              source: "applicant",
              path: q.question.includes("SQL")
                ? "/savedAnswers/1/answer"
                : "/savedAnswers/99/answer",
              quote: q.question.includes("SQL") ? "4" : "8",
            },
          ],
        })),
      });
    }
    if (actorTurn++ === 0)
      return reply("fill_fields", {
        fields: [
          { tool: "type", ref: "c0", text: "8" },
          { tool: "select", ref: "c1", option: "3–5" },
        ],
      });
    return reply("finish", {
      reason:
        "Checking failed for capacity; the supported SQL answer is filled.",
      needsPerson: false,
    });
  };
  return { client: { chatWithTools }, calls };
}

test("a checker refusal before a supported sibling leaves only the refused field unwritten", async () => {
  const { raw, input, write } = setup([
    field(0, "Weekly rota capacity"),
    {
      ...field(1, "Choose years using SQL professionally"),
      tagName: "select",
      inputType: "select-one",
      options: ["0–2", "3–5", "6+"],
    },
  ]);
  input.sources.reusableAnswers = [
    CandidateReusableAnswerSchema.parse({
      id: "capacity",
      label: "Weekly capacity",
      question: "Weekly capacity for the rota",
      answer: "8",
    }),
    CandidateReusableAnswerSchema.parse({
      id: "sql",
      label: "SQL duration",
      question: "Years using SQL professionally",
      answer: "4",
    }),
  ];
  const { client, calls } = checkingClient();
  const result = await runApplyAgent(input, client);
  expect(
    raw.controls.map((c) => c.value),
    JSON.stringify(result.timeline),
  ).toEqual(["", "3–5"]);
  expect(write).toHaveBeenCalledWith("c1", "3–5");
  expect(result.technicalFailure?.code).toBe("answer_grounding_unavailable");
  expect(JSON.stringify(calls)).toContain("checking is unavailable");
  expect(JSON.stringify(calls)).not.toContain("Reconsider it once");
  expect(input.hands.clickAction).not.toHaveBeenCalled();
});

test("an exact current-field decision writes and reads back without another semantic call", async () => {
  const { raw, input, write } = setup([
    {
      ...field(
        0,
        "Weekly hours available Sunday 09:00–17:00 from 20 December 2026",
      ),
      inputType: "number",
    },
  ]);
  input.application.applicationRecordId = "application_42";
  const before = await input.hands.observe();
  const control = before.controls[0];
  input.sources.reusableAnswers = [
    CandidateReusableAnswerSchema.parse({
      id: "application_current",
      label: control.label,
      question: control.label,
      answer: "8",
      applicationScope: {
        resultId: null,
        applicationRecordId: "application_42",
        location: null,
        currentFieldBinding: {
          pageUrl: before.url!,
          targetHash: meaningTargetHash(control, before.controls),
          instructionsHash: meaningHash(formWritingInstructions(before)),
        },
      },
    }),
  ];
  const classifyQuestions = vi
    .fn<NonNullable<ApplyExecutorDeps["classifyQuestions"]>>()
    .mockRejectedValue(new Error("No semantic question call should be needed"));
  const checkWrittenAnswer = vi
    .fn<NonNullable<ApplyExecutorDeps["checkWrittenAnswer"]>>()
    .mockRejectedValue(new Error("No semantic authorization should be needed"));
  const deps = {
    config: input,
    now: () => new Date("2026-11-05T00:00:00Z"),
    guardState: createApplyGuardState(),
    classifyQuestions,
    checkWrittenAnswer,
  };
  const result = await executeApplyProposal(
    { tool: "type", ref: "c0", text: "8" },
    before.signature,
    deps,
  );
  expect(result.kind).toBe("filled");
  expect(raw.controls[0]?.value).toBe("8");
  expect(write).toHaveBeenCalledWith("c0", "8");
  expect(classifyQuestions).not.toHaveBeenCalled();
  expect(checkWrittenAnswer).not.toHaveBeenCalled();
  raw.controls[0].value = "";
  raw.bodyText = "Saturday and Sunday shifts are required";
  const changed = await input.hands.observe();
  expect(
    (
      await executeApplyProposal(
        { tool: "type", ref: "c0", text: "8" },
        changed.signature,
        deps,
      )
    ).kind,
  ).not.toBe("filled");
  expect(write).toHaveBeenCalledTimes(1);
});

test("the whole apply path does not semantically reauthorize an unchanged current-field decision", async () => {
  const { raw, input } = setup([
    {
      ...field(
        0,
        "Weekly hours available Sunday 09:00–17:00 from 20 December 2026",
      ),
      inputType: "number",
    },
  ]);
  input.application.applicationRecordId = "application_42";
  const before = await input.hands.observe(),
    control = before.controls[0];
  const answer = CandidateReusableAnswerSchema.parse({
    id: "application_current",
    label: control.label,
    question: control.label,
    answer: "8",
    applicationScope: {
      resultId: null,
      applicationRecordId: "application_42",
      location: null,
      currentFieldBinding: {
        pageUrl: before.url!,
        targetHash: meaningTargetHash(control, before.controls),
        instructionsHash: meaningHash(formWritingInstructions(before)),
      },
    },
  });
  input.replay = {
    answers: [],
    attachments: [],
    path: [],
    formUrl: before.url!,
  };
  input.initialUnansweredPickerQuestions = [
    { prompt: control.label, options: [] },
  ];
  input.readReusableAnswers = () => Promise.resolve([answer]);
  const seen: string[] = [];
  let actor = 0;
  const client: LLMClient = {
    chatWithTools: (messages, tools) => {
      const tool = tools[0]?.function.name ?? "actor";
      seen.push(tool);
      const reply = (name: string, args: unknown) =>
        Promise.resolve({
          toolCalls: [
            {
              id: "offline",
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
      if (tool === "report_question_kinds")
        return reply(tool, {
          plainIndexes: [0],
          flagged: [],
          tags: [
            {
              index: 0,
              kind: "preference",
              country: null,
              sourceId: "answerLibrary.application_current",
              declarationPurpose: null,
            },
          ],
        });
      if (
        tool === "report_answer_checks" ||
        tool === "match_application_answer"
      )
        throw Error("Unnecessary semantic authorization");
      return actor++ === 0
        ? reply("type", { ref: "c0", text: "8" })
        : reply("finish", {
            reason: "The explicit current answer is filled.",
            needsPerson: false,
          });
    },
  };
  const result = await runApplyAgent(input, client);
  expect(raw.controls[0]?.value, JSON.stringify(result.timeline)).toBe("8");
  expect(seen).not.toContain("report_answer_checks");
  expect(seen).not.toContain("match_application_answer");
  expect(result.technicalFailure).toBeUndefined();
});
