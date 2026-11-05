import { CandidateProfileSchema, type RawApplyPage } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import type { ApplyAgentConfig } from "./types";

const resume = "Built React interfaces. Maintained shared UI components.";
const report = (name: string, args: unknown) => ({
  toolCalls: [
    {
      id: name,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
});

function setup(labels: readonly string[]) {
  const raw: RawApplyPage = {
    url: "http://127.0.0.1:47950/synthetic/apply",
    title: "Application",
    bodyText: "Application questions",
    controls: labels.map((label, index) => ({
      index,
      label,
      tagName: /experience/iu.test(label) ? "textarea" : "input",
      inputType: "text",
      id: `field-${index}`,
      name: `field-${index}`,
      groupLabel: "",
      role: "",
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
    })),
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
    headings: [],
    links: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const write = vi.fn((ref: string, value: string) => {
    raw.controls[Number(ref.slice(1))].value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  const click = vi.fn(() =>
    Promise.resolve({ ok: true as const, observedValue: "clicked" }),
  );
  const config: ApplyAgentConfig = {
    modelQuestionClassification: true,
    application: {
      jobId: "synthetic",
      applicationId: "synthetic",
      startingUrl: raw.url!,
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      allowedOrigins: [],
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
    },
    siteLabel: "Synthetic replica",
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Jamie Rivers",
        email: "jamie@example.test",
        yearsExperience: 12,
        baseResume: {
          id: "resume",
          fileName: "synthetic.txt",
          uploadedAt: "2026-11-05T00:00:00Z",
          textContent: resume,
        },
      }),
      resumeText: resume,
      reusableAnswers: [],
      documents: [],
      posting: {
        title: "Engineer",
        company: "Synthetic",
        location: "United States",
        description: "Build interfaces.",
      },
    },
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, "2026-11-05T00:00:00Z")),
      fillText: write,
      chooseOption: write,
      clickAction: click,
      clickElement: click,
      navigate: (url) => Promise.resolve({ ok: true, url }),
      goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
      followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
      setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
      uploadFile: () => Promise.resolve({ ok: false, error: "No file" }),
      wait: () => Promise.resolve(),
      scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
      readText: () => Promise.resolve(raw.bodyText),
    },
  };
  return { raw, config, write, click };
}

function model(
  proposals: readonly string[],
  check: LLMClient["chatWithTools"],
) {
  let actorTurns = 0;
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>(
    async (messages, tools, options) => {
      const name = tools[0]?.function.name;
      if (name === "report_question_kinds") {
        const questions = JSON.parse(messages[1].content) as {
          question: string;
        }[];
        return report(name, {
          plainIndexes: questions.map((_, index) => index),
          flagged: [],
          tags: questions.map(({ question }, index) => ({
            index,
            kind: /experience/iu.test(question) ? "factual_summary" : "other",
            country: null,
            sourceId: /name/iu.test(question)
              ? "profile.fullName"
              : /experience/iu.test(question)
                ? "resume.text"
                : null,
          })),
        });
      }
      if (name === "report_answer_checks")
        return check(messages, tools, options);
      if (name === "match_application_answer")
        throw new Error("Per-field matching was removed");
      return actorTurns++ === 0
        ? report("fill_fields", {
            fields: proposals.map((text, index) => ({
              tool: "type",
              ref: `c${index}`,
              text,
            })),
          })
        : report("finish", {
            reason: "The unanswered fields need the person.",
            needsPerson: true,
          });
    },
  );
  return { chatWithTools };
}

const evidence = {
  claim: "Build interfaces",
  kind: "applicant_fact",
  source: "resume",
  path: "",
  quote: "Built React interfaces.",
};
const questions = (result: Awaited<ReturnType<typeof runApplyAgent>>) =>
  result.pauses.flatMap(
    (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
  );

test("saved preferences with changed wording share one batch check", async () => {
  const s = setup([
    "Your favourite frontend language",
    "Your favourite testing tool",
  ]);
  s.config.sources.reusableAnswers = [
    {
      id: "language",
      kind: "other",
      label: "Language",
      question: "Preferred frontend language",
      answer: "TypeScript",
      roleFamilies: [],
      proofEntryIds: [],
    },
    {
      id: "tool",
      kind: "other",
      label: "Tool",
      question: "Preferred testing tool",
      answer: "Playwright",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const checks = vi.fn<LLMClient["chatWithTools"]>((messages) => {
    const { answers } = JSON.parse(messages[1].content) as {
      answers: { index: number; question: string }[];
    };
    expect(answers).toHaveLength(2);
    return Promise.resolve(
      report("report_answer_checks", {
        checks: answers.map(({ index, question }) => {
          const row = /language/iu.test(question) ? 0 : 1;
          return {
            index,
            supported: true,
            reason: "The saved preference answers this question.",
            evidence: [
              {
                claim: question,
                kind: "applicant_fact",
                source: "applicant",
                path: `/savedAnswers/${row}/answer`,
                quote: row === 0 ? "TypeScript" : "Playwright",
              },
            ],
          };
        }),
      }),
    );
  });
  const client: LLMClient = {
    chatWithTools: (messages, tools, options) => {
      const name = tools[0].function.name;
      if (name === "report_question_kinds")
        return Promise.resolve(
          report(name, {
            plainIndexes: [0, 1],
            flagged: [],
            tags: ["language", "tool"].map((id, index) => ({
              index,
              kind: "preference",
              country: null,
              sourceId: `answerLibrary.${id}`,
            })),
          }),
        );
      if (name === "report_answer_checks")
        return checks(messages, tools, options);
      return Promise.resolve(
        report("fill_fields", {
          fields: [
            { tool: "type", ref: "c0", text: "TypeScript" },
            { tool: "type", ref: "c1", text: "Playwright" },
          ],
          finishWhenReady: true,
        }),
      );
    },
  };
  const result = await runApplyAgent(s.config, client);
  expect(checks).toHaveBeenCalledTimes(1);
  expect(s.raw.controls.map((control) => control.value)).toEqual([
    "TypeScript",
    "Playwright",
  ]);
  expect(questions(result)).toEqual([]);
});

test("one batch check rejects inferred age and invented dates while filling recorded facts and supported prose", async () => {
  const s = setup([
    "Full name",
    "Describe your interface experience",
    "Are you at least 18 years old?",
    "Employment start date",
  ]);
  const check = vi.fn<LLMClient["chatWithTools"]>((messages) => {
    const data = JSON.parse(messages[1].content) as {
      answers: { index: number; question: string }[];
    };
    expect(data.answers).toHaveLength(3);
    return Promise.resolve(
      report("report_answer_checks", {
        checks: data.answers.map(({ index, question }) => ({
          index,
          supported: /experience/iu.test(question),
          reason: /experience/iu.test(question)
            ? "The resume supports this paraphrase."
            : "This fact is not recorded.",
          evidence: /experience/iu.test(question) ? [evidence] : [],
        })),
      }),
    );
  });
  const result = await runApplyAgent(
    s.config,
    model(
      ["Jamie Rivers", "I build interfaces with React.", "Yes", "2026-01-01"],
      check,
    ),
  );
  expect(check).toHaveBeenCalledTimes(1);
  expect(s.raw.controls.map((c) => c.value)).toEqual([
    "Jamie Rivers",
    "I build interfaces with React.",
    "",
    "",
  ]);
  expect(
    questions(result)
      .map((q) => q.prompt)
      .sort(),
  ).toEqual(["Are you at least 18 years old?", "Employment start date"].sort());
  expect(result.outcome).toBe("paused");
  expect(result.readyToSend).toBeNull();
  expect(result.technicalFailure).toBeUndefined();
  expect(s.click).not.toHaveBeenCalled();
});

test.each(["missing report", "request failure"])(
  "one retry of a %s keeps supported siblings and asks only unchecked fields",
  async (failure) => {
    const s = setup([
      "Full name",
      "Describe your interface experience",
      "Describe your support experience",
    ]);
    const check = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValueOnce(
        report("report_answer_checks", {
          checks: [
            {
              index: 0,
              supported: true,
              reason: "Recorded interface work.",
              evidence: [evidence],
            },
          ],
        }),
      )
      .mockImplementationOnce(() => {
        if (failure === "request failure")
          throw new Error("Synthetic transport failure");
        return Promise.resolve({ toolCalls: [] });
      });
    const result = await runApplyAgent(
      s.config,
      model(
        [
          "Jamie Rivers",
          "I build interfaces with React.",
          "I maintain shared UI components.",
        ],
        check,
      ),
    );
    expect(check).toHaveBeenCalledTimes(2);
    expect(s.raw.controls.map((c) => c.value)).toEqual([
      "Jamie Rivers",
      "I build interfaces with React.",
      "",
    ]);
    expect(questions(result).map((q) => q.prompt)).toEqual([
      "Describe your support experience",
    ]);
    expect(result.technicalFailure).toBeUndefined();
    expect(result.readyToSend).toBeNull();
    expect(s.click).not.toHaveBeenCalled();
  },
);

test.each([
  "Are you authorized to work in the United States?",
  "Will you require US visa sponsorship?",
])("unsupported legal answer stays unwritten: %s", async (question) => {
  const s = setup(["Full name", question]);
  const check = vi.fn<LLMClient["chatWithTools"]>((messages) => {
    const { answers } = JSON.parse(messages[1].content) as {
      answers: { index: number }[];
    };
    return Promise.resolve(
      report("report_answer_checks", {
        checks: answers.map(({ index }) => ({
          index,
          supported: false,
          reason: "No US permission or sponsorship fact is recorded.",
          evidence: [],
        })),
      }),
    );
  });
  const result = await runApplyAgent(
    s.config,
    model(["Jamie Rivers", "No"], check),
  );
  expect(s.raw.controls.map((c) => c.value)).toEqual(["Jamie Rivers", ""]);
  expect(questions(result).map((q) => q.prompt)).toEqual([question]);
  expect(result.readyToSend).toBeNull();
  expect(s.click).not.toHaveBeenCalled();
});

test.each([false, "unavailable"] as const)(
  "Send review still refuses an unsupported or unchecked answer: %s",
  async (verdict) => {
    const s = setup(["Describe your interface experience"]);
    s.raw.controls[0].value = "I led a team of twelve engineers.";
    const client: LLMClient = {
      chatWithTools: vi.fn<LLMClient["chatWithTools"]>((_messages, tools) => {
        const name = tools[0].function.name;
        if (name === "report_question_kinds")
          return Promise.resolve(
            report(name, {
              plainIndexes: [0],
              flagged: [],
              tags: [
                {
                  index: 0,
                  kind: "factual_summary",
                  country: null,
                  sourceId: "resume.text",
                },
              ],
            }),
          );
        expect(name).toBe("report_answer_checks");
        if (verdict === "unavailable")
          throw new Error("Synthetic check outage");
        return Promise.resolve(
          report(name, {
            checks: [
              {
                index: 0,
                supported: false,
                reason: "Team leadership is not recorded.",
                evidence: [],
              },
            ],
          }),
        );
      }),
    };
    const controls = (await s.config.hands.observe()).controls;
    const checks = await checkClassifiedApplicationAnswers({
      client,
      sources: s.config.sources,
      payDisclosed: false,
      answers: [{ question: controls[0].label, answer: controls[0].value }],
      formControls: controls,
      formContext: { pageText: s.raw.bodyText, fields: [] },
    });
    expect(checks).toMatchObject([{ supported: false }]);
    expect(client.chatWithTools).toHaveBeenCalledTimes(
      verdict === "unavailable" ? 3 : 2,
    );
  },
);
