import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { answerSourceCatalog } from "./answer-source-catalog";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { createQuestionClassifier } from "./question-classification";
import type { ApplyAnswerSources, ApplyFormControl } from "./types";

// The local /employer-a/apply/1 replica, including its optional letter and
// required file. Send used to drop those fields and all native required flags.
const fields = [
  ["Name *", "Alex Vanguard", "profile.fullName"],
  ["Email *", "alex.replay@example.test", "profile.email"],
  ["Phone *", "+44 7700 900123", "profile.phone"],
  ["Resume / CV", "synthetic.pdf", null],
  ["Cover letter", "", null],
  ["I certify the information is true", "Yes", null],
] as const;
const pageText =
  "Apply: Engineer\nName *\nEmail *\nPhone *\nResume / CV\nCover letter\nI certify the information is true\nSubmit";

function fixture() {
  const sources: ApplyAnswerSources = {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      fullName: fields[0][1],
      email: fields[1][1],
      phone: fields[2][1],
      yearsExperience: 3,
      baseResume: {
        id: "resume",
        fileName: "synthetic.pdf",
        uploadedAt: "2026-10-26T00:00:00Z",
      },
    }),
    resumeText: null,
    documents: [],
    reusableAnswers: [],
    posting: {
      title: "Engineer",
      company: "Synthetic Workshop",
      location: "Remote, Europe",
      description: "Build software.",
    },
  };
  const controls: ApplyFormControl[] = fields.map(([label, value], index) => ({
    ref: `c${index}`,
    kind:
      index === 3
        ? "file"
        : index === 4
          ? "long_text"
          : index === 5
            ? "checkbox"
            : "text",
    label,
    groupLabel: "",
    placeholder: "",
    required: index !== 4,
    disabled: false,
    readOnly: false,
    visible: true,
    value,
    checked: index === 5,
    options: [],
    selectedOptionLabel: "",
    invalid: false,
    validationMessage: "",
    questionKind: "other",
    answerControlType: index === 5 ? "boolean" : "text",
    attestationKind: index === 5 ? "truthfulness_certification" : null,
    answered: !!value,
  }));
  const answers = fields
    .filter((_, index) => index < 3 || index === 5)
    .map(([question, answer]) => ({ question, answer }));
  return { sources, controls, answers, scope: {} };
}

function reply(
  questions: { question: string }[],
  withSources: boolean,
  ownWords = false,
) {
  return {
    toolCalls: [
      {
        id: "read",
        type: "function" as const,
        function: {
          name: "report_question_kinds",
          arguments: JSON.stringify({
            plainIndexes: questions.map((_, index) => index),
            flagged: [],
            tags: questions.map((question, index) => ({
              index,
              kind: ownWords ? "own_words" : "other",
              country: null,
              sourceId: withSources
                ? (fields.find(([label]) => label === question.question)?.[2] ??
                  null)
                : null,
              declarationPurpose:
                question.question === fields[5][0] ? "acknowledgement" : null,
            })),
          }),
        },
      },
    ],
  };
}

function reader() {
  let calls = 0;
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>((messages) => {
    const content = messages.find(
      (message) => message.role === "user",
    )?.content;
    const questions = JSON.parse(String(content)) as { question: string }[];
    // A second, different model reading is valid but has no contact source.
    // It must never replace an identical full-form reading from preparation.
    return Promise.resolve(
      reply(
        questions,
        ++calls === 1,
        messages.some((message) =>
          String(message.content).includes("Write your answer yourself."),
        ),
      ),
    );
  });
  return { chatWithTools };
}

async function prepare(f: ReturnType<typeof fixture>, client: LLMClient) {
  await createQuestionClassifier({
    client,
    cacheScope: f.scope,
    sources: () => answerSourceCatalog(f.sources),
  })(f.controls, JSON.stringify({ instructions: pageText }));
}

function sendCheck(
  f: ReturnType<typeof fixture>,
  client: LLMClient,
  instructions = pageText,
) {
  return checkClassifiedApplicationAnswers({
    client,
    sources: f.sources,
    payDisclosed: false,
    approvedAttestations: ["truthfulness_certification"],
    answers: f.answers,
    formControls: f.controls,
    questionReadCacheScope: f.scope,
    formContext: { pageText: instructions, fields: [] },
  });
}

test("replica Send keeps unchanged Profile contacts and the full form's reading", async () => {
  const f = fixture(),
    client = reader();
  await prepare(f, client);
  const checked = await sendCheck(f, client);
  expect(checked.map((check) => check.supported)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  const questions = JSON.parse(
    String(
      client.chatWithTools.mock.calls[0]?.[0].find(
        (message) => message.role === "user",
      )?.content,
    ),
  ) as { nativeRequired: boolean }[];
  expect(questions.map((question) => question.nativeRequired)).toEqual([
    true,
    true,
    true,
    true,
    false,
    true,
  ]);
});

test("an uncached reading still resolves plain identity; phone needs its classified source", async () => {
  const f = fixture(),
    client = reader();
  await prepare(f, client);
  const uncached = await sendCheck({ ...f, scope: {} }, client);
  expect(uncached.map((check) => check.supported)).toEqual([
    true,
    true,
    false,
    true,
  ]);
  const sameForm = await sendCheck(f, client);
  expect(sameForm.map((check) => check.supported)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test.each(["profile", "reference", "instructions"] as const)(
  "a changed %s cannot borrow the previous safe contact reading",
  async (change) => {
    const f = fixture(),
      client = reader();
    await prepare(f, client);
    let instructions = pageText;
    if (change === "profile") f.sources.profile.fullName = "Another Applicant";
    if (change === "reference")
      f.controls = f.controls.map((control) => ({
        ...control,
        groupLabel: "Professional reference",
      }));
    if (change === "instructions")
      instructions += "\nWrite your answer yourself.";
    const checked = await sendCheck(f, client, instructions);
    expect(checked.slice(0, 3).map((check) => check.supported)).toEqual(
      change === "profile" ? [false, true, false] : [false, false, false],
    );
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  },
);

test("plain identity resolves a missing source without authorizing unrelated contacts", async () => {
  const f = fixture();
  const client: LLMClient = {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((messages) => {
      const questions = JSON.parse(
        String(messages.find((message) => message.role === "user")?.content),
      ) as { question: string }[];
      return Promise.resolve(reply(questions, false));
    }),
  };
  await prepare(f, client);
  const checked = await sendCheck(f, client);
  expect(checked.slice(0, 3).map((check) => check.supported)).toEqual([
    true,
    true,
    false,
  ]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});
