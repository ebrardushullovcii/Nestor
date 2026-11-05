import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig } from "./types";

// Council D4: a held summary question whose resume line is labelled with
// the question's own words ("Reporting routine: ...") gets that one exact
// statement as Nestor's own proposal; the independent check still decides.
const QUESTION = "Describe your reporting routine";
const STATEMENT = "I submit weekly reports";
const now = () => new Date("2026-11-04T01:00:00Z");

const NOTICE = "What is your notice period?";

function control(index = 0, label = QUESTION): RawApplyControl {
  return {
    index,
    tagName: "textarea",
    inputType: "",
    role: "",
    id: `q${index}`,
    name: `q${index}`,
    label,
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

function setup(resume: string, options: { notice?: boolean } = {}) {
  const raw: RawApplyPage = {
    url: "http://127.0.0.1:47950/case1/apply",
    title: "Apply",
    bodyText: `Application questions\n${QUESTION}`,
    controls: options.notice ? [control(), control(1, NOTICE)] : [control()],
    actions: [],
    headings: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
  const write = (ref: string, value: string) => {
    raw.controls.find((entry) => `c${entry.index}` === ref)!.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  };
  const config: ApplyAgentConfig = {
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        firstName: "Jamie",
        lastName: "Example",
        fullName: "Jamie Example",
        email: "jamie@clientnest.example",
        yearsExperience: 6,
        baseResume: {
          id: "resume",
          fileName: "jamie-synthetic-resume.txt",
          uploadedAt: "2026-11-01T00:00:00.000Z",
          extractionStatus: "ready",
          textContent: resume,
        },
      }),
      resumeText: resume,
      posting: {
        title: "Frontend Engineer",
        company: "Clientnest Replica",
        location: "Berlin, Germany",
        description: "Build React interfaces.",
      },
      reusableAnswers: [],
      documents: [],
    },
    application: {
      jobId: "synthetic",
      applicationId: "synthetic",
      startingUrl: raw.url!,
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    siteLabel: "Synthetic employer",
    modelQuestionClassification: true,
    now,
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, now().toISOString())),
      fillText: write,
      chooseOption: write,
      setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
      wait: () => Promise.resolve(),
      navigate: (url) => Promise.resolve({ ok: true, url }),
      goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
      followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
      clickElement: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      clickAction: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
      uploadFile: (_ref, file) =>
        Promise.resolve({ ok: true, observedValue: file.name }),
      readText: () => Promise.resolve(raw.bodyText),
    },
  };
  return { raw, config };
}

function call(name: string, args: unknown) {
  return {
    toolCalls: [
      {
        id: name,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

/**
 * The model paraphrases (which the summary rule refuses), then finishes. The
 * independent check supports only what `supports` allows.
 */
function model(supports: (answer: string) => boolean) {
  const checked: string[] = [];
  let turn = 0;
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>((messages, tools) => {
    const name = tools[0]?.function.name;
    if (name === "report_question_kinds") {
      const questions = JSON.parse(String(messages[1]?.content)) as {
        question?: string;
      }[];
      return Promise.resolve(
        call("report_question_kinds", {
          plainIndexes: questions.map((_, index) => index),
          flagged: [],
          tags: questions.map((entry, index) =>
            /notice/iu.test(entry.question ?? "")
              ? { index, kind: "other", country: null, sourceId: null }
              : {
                  index,
                  kind: "factual_summary",
                  country: null,
                  sourceId: "resume.text",
                },
          ),
        }),
      );
    }
    if (name === "report_answer_checks") {
      const input = JSON.parse(String(messages[1]?.content)) as {
        answers: { proposedAnswer: string }[];
      };
      return Promise.resolve(
        call("report_answer_checks", {
          checks: input.answers.map((entry, index) => {
            checked.push(entry.proposedAnswer);
            return {
              index,
              supported: supports(entry.proposedAnswer),
              reason: supports(entry.proposedAnswer)
                ? "The resume states this."
                : "Not confirmed.",
              evidence: [
                {
                  kind: "applicant_fact",
                  source: "resume",
                  path: "",
                  quote: `Reporting routine: ${STATEMENT}`,
                  claim: entry.proposedAnswer,
                },
              ],
            };
          }),
        }),
      );
    }
    if (!tools.some((tool) => tool.function.name === "finish"))
      return Promise.reject(new Error("not part of this replay"));
    turn += 1;
    return Promise.resolve(
      turn === 1
        ? call("fill_fields", {
            fields: [
              { tool: "type", ref: "c0", text: "I write status updates." },
            ],
          })
        : call("finish", {}),
    );
  });
  return { client: { chatWithTools } as LLMClient, checked };
}

const asked = (result: Awaited<ReturnType<typeof runApplyAgent>>) =>
  result.pauses.flatMap(
    (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
  );

test("one labelled resume statement is filled in its own words with no question", async () => {
  const { raw, config } = setup(
    `Jamie Example\nReporting routine: ${STATEMENT}\n`,
  );
  const { client, checked } = model((answer) => answer === STATEMENT);
  const result = await runApplyAgent(config, client);
  expect(raw.controls[0]?.value).toBe(STATEMENT);
  expect(checked).toContain(STATEMENT);
  expect(asked(result)).toEqual([]);
  expect(result.technicalFailure).toBeUndefined();
});

test("a refused recovery that is the only blocker is Nestor's retained technical failure", async () => {
  const { config } = setup(`Jamie Example\nReporting routine: ${STATEMENT}\n`);
  const { client, checked } = model(() => false);
  const result = await runApplyAgent(config, client);
  expect(checked).toContain(STATEMENT);
  expect(asked(result)).toEqual([]);
  expect(result.outcome).toBe("stuck");
  expect(result.readyToSend).toBeNull();
  expect(result.technicalFailure).toEqual({
    code: "answer_grounding_unavailable",
    retryable: true,
    pageDisposition: "retain",
  });
  expect(result.reason).toBe(
    `Nestor could not confirm its answer to "${QUESTION}" against your resume. Your page and answers are kept. Try again.`,
  );
});

test("two different labelled statements are no recovery: the question stays the person's", async () => {
  const { raw, config } = setup(
    `Reporting routine: ${STATEMENT}\nReporting routine: I submit monthly reports\n`,
  );
  const { client, checked } = model(() => false);
  const result = await runApplyAgent(config, client);
  expect(checked).not.toContain(STATEMENT);
  expect(raw.controls[0]?.value).not.toBe(STATEMENT);
  expect(asked(result).map((question) => question.prompt)).toContain(QUESTION);
  expect(result.technicalFailure).toBeUndefined();
});

test("beside another real question a refused statement stays asked, offered as its suggestion", async () => {
  const { config } = setup(`Jamie Example\nReporting routine: ${STATEMENT}\n`, {
    notice: true,
  });
  const { client, checked } = model(() => false);
  const result = await runApplyAgent(config, client);
  expect(checked).toContain(STATEMENT);
  expect(result.technicalFailure).toBeUndefined();
  const questions = asked(result);
  expect(questions.map((question) => question.prompt).sort()).toEqual(
    [NOTICE, QUESTION].sort(),
  );
  expect(
    questions.find((question) => question.prompt === QUESTION)
      ?.suggestedAnswers,
  ).toMatchObject([{ text: STATEMENT, sourceKind: "resume" }]);
});

test("a checking outage keeps a genuine question named by the actor", async () => {
  const { config } = setup(`Jamie Example\nReporting routine: ${STATEMENT}\n`, {
    notice: true,
  });
  const ordinary = model(() => true).client;
  const client: LLMClient = {
    chatWithTools: async (messages, tools, options) => {
      if (tools[0]?.function.name === "report_answer_checks")
        throw new Error("Synthetic check unavailable");
      const reply = await ordinary.chatWithTools(messages, tools, options);
      return reply.toolCalls?.some((tool) => tool.function.name === "finish")
        ? call("finish", {
            reason: "Your notice period is unknown.",
            needsPerson: true,
            forPerson: [NOTICE],
          })
        : reply;
    },
  };
  const result = await runApplyAgent(config, client);
  expect(asked(result).map((question) => question.prompt)).toEqual([NOTICE]);
  expect(result.readyToSend).toBeNull();
});

test("a checking outage preserves a separately readable missing fact even when the actor omits it", async () => {
  const { config } = setup(`Jamie Example\nReporting routine: ${STATEMENT}\n`, {
    notice: true,
  });
  const ordinary = model(() => true).client;
  const client: LLMClient = {
    chatWithTools: async (messages, tools, options) => {
      if (tools[0]?.function.name === "report_answer_checks")
        throw new Error("Synthetic check unavailable");
      return ordinary.chatWithTools(messages, tools, options);
    },
  };
  const result = await runApplyAgent(config, client);
  expect(asked(result).map((question) => question.prompt)).toEqual([NOTICE]);
  expect(result.technicalFailure?.code).toBe("answer_grounding_unavailable");
  expect(result.readyToSend).toBeNull();
});

test("technical cleanup waits for the current reading after page instructions change", async () => {
  const { config } = setup(`Jamie Example\nReporting routine: ${STATEMENT}\n`, {
    notice: true,
  });
  const ordinary = model(() => true).client;
  let failures = 0;
  const observe = config.hands.observe;
  config.hands.observe = async () => {
    const page = await observe();
    if (failures >= 2)
      page.bodyTextExcerpt += "\nAnswer format: use complete sentences.";
    return page;
  };
  const client: LLMClient = {
    chatWithTools: async (messages, tools, options) => {
      if (tools[0]?.function.name === "report_answer_checks") {
        failures++;
        throw new Error("Synthetic check unavailable");
      }
      if (
        tools[0]?.function.name === "report_question_kinds" &&
        JSON.stringify(messages).includes("complete sentences")
      )
        await new Promise((resolve) => setTimeout(resolve, 30));
      return ordinary.chatWithTools(messages, tools, options);
    },
  };
  const result = await runApplyAgent(config, client);
  expect(failures).toBeGreaterThanOrEqual(2);
  expect(asked(result).map((question) => question.prompt)).toEqual([NOTICE]);
  expect(result.technicalFailure?.code).toBe("answer_grounding_unavailable");
});
