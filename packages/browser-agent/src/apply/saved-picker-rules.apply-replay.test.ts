import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { buildApplyFormObservation } from "./page-hands";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { strictOptionMatch } from "./option-fallback";
import type { ApplyAgentConfig } from "./types";

const rule = {
  primary: "Kosovo",
  fallback: "Albania",
  whenNeitherOffered: "skip_application" as const,
};
const saved = {
  id: "country-rule",
  kind: "other" as const,
  label: "Country of residence",
  question: "Country of residence",
  answer: "Kosovo",
  roleFamilies: [],
  proofEntryIds: [],
  optionFallback: rule,
};
const now = () => new Date("2026-10-27T00:00:00Z");
function fixture(
  label: string,
  options: string[],
  groupLabel = "",
  withRule = true,
  answerKind: ApplyAnswerTags["kind"] = "other",
) {
  const page = buildApplyFormObservation(
    {
      url: "https://employer.example.test/apply",
      title: "Apply",
      bodyText: "Apply",
      headings: [],
      actions: [],
      links: [],
      clickables: [],
      openedTabs: [],
      validationErrors: [],
      stepLabel: null,
      loading: false,
      controls: [
        {
          index: 0,
          tagName: "select",
          inputType: "",
          role: "",
          id: "country",
          name: "country",
          label,
          groupLabel,
          placeholder: "",
          autocomplete: "",
          required: true,
          disabled: false,
          readOnly: false,
          visible: true,
          value: "",
          checked: false,
          multiple: false,
          options,
          selectedOptionLabel: "",
          invalid: false,
          validationMessage: "",
        },
      ],
    },
    now().toISOString(),
  );
  const field = page.controls[0];
  const chooseOption = vi.fn((_ref: string, value: string) => {
    if (!options.includes(value))
      return Promise.resolve({
        ok: false as const,
        error: "Not offered",
        reason: "option_not_offered" as const,
        offeredOptions: options,
      });
    field.value = value;
    field.selectedOptionLabel = value;
    field.answered = true;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  const config = {
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        currentCountry: "Kosovo",
        yearsExperience: 2,
        baseResume: {
          id: "resume",
          fileName: "synthetic.txt",
          uploadedAt: now().toISOString(),
        },
      }),
      resumeText: null,
      documents: [],
      reusableAnswers: withRule ? [saved] : [],
      posting: {
        title: "Engineer",
        company: "Example Workshop",
        location: "Remote",
        description: "Build software.",
      },
    },
    application: {
      jobId: "1",
      applicationId: "1",
      applicationRecordId: "1",
      startingUrl: page.url!,
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    hands: { observe: () => Promise.resolve(page), chooseOption },
    siteLabel: "Synthetic employer",
  } as unknown as ApplyAgentConfig;
  const tags = {
    kind: answerKind,
    country: null,
    sourceId: "profile.currentCountry",
  };
  const client: LLMClient = {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: "read",
            type: "function",
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                plainIndexes: [0],
                flagged: [],
                tags: [{ index: 0, ...tags }],
              }),
            },
          },
        ],
      }),
  };
  const fill = () =>
    executeApplyProposal(
      { tool: "select", ref: field.ref, option: "Kosovo" },
      page.signature,
      {
        config,
        now,
        guardState: createApplyGuardState(),
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                questionPrompt(field),
                {
                  asksAboutPay: false,
                  declarationKind: null,
                  answerTags: tags,
                },
              ],
            ]),
          ),
      },
    );
  const send = (answer: string) =>
    checkClassifiedApplicationAnswers({
      client,
      sources: config.sources,
      application: config.application,
      payDisclosed: false,
      answers: [{ question: questionPrompt(field), answer }],
      formControls: page.controls,
      formContext: { pageText: "Apply", fields: [] },
    });
  return { page, field, config, chooseOption, fill, send };
}

test("a typed residence question uses its saved country fallback and rechecks it at Send", async () => {
  const f = fixture(
    "País de residencia",
    ["Albania", "Serbia"],
    "",
    true,
    "residence_country",
  );
  const filled = await f.fill();
  expect(filled, filled.kind === "suggestion" ? filled.note : "").toMatchObject(
    { kind: "filled" },
  );
  expect(f.field.value).toBe("Albania");
  expect((await f.send("Albania"))[0]?.supported).toBe(true);
});

test("a residence tag cannot turn a saved passport rule into a residence fallback", async () => {
  const f = fixture(
    "País de residencia",
    ["Albania", "Serbia"],
    "",
    true,
    "residence_country",
  );
  f.config.sources.reusableAnswers = [
    { ...saved, question: "Passport country", label: "Passport country" },
  ];
  expect((await f.fill()).kind).not.toBe("filled");
  expect(f.chooseOption.mock.calls.some((call) => call[1] === "Albania")).toBe(
    false,
  );
  expect((await f.send("Albania"))[0]?.supported).toBe(false);
});

test.each([
  "Country of residence",
  "What country are you based in?",
  "What is your current country of residence?*",
])("one saved rule covers the residence question: %s", async (label) => {
  const f = fixture(label, ["Albania", "Serbia"]);
  const result = await f.fill();
  expect(result).toMatchObject({
    kind: "filled",
    filled: {
      answer: {
        value: "Albania",
        sourceKind: "answer_library",
        sourceId: "answerLibrary.country-rule#fallback",
      },
    },
  });
  expect(f.chooseOption.mock.calls.map((call) => call[1])).toEqual([
    "Kosovo",
    "Albania",
  ]);
  expect((await f.send("Albania"))[0]?.supported).toBe(true);
  // A current list with the primary offered never authorizes the fallback.
  f.field.options = ["Kosovo", "Albania"];
  expect((await f.send("Albania"))[0]?.supported).toBe(false);
});

test.each(["Country of residence", "What country are you based in?"])(
  "the current list can skip %s without a write or Needs-you item",
  async (label) => {
    const f = fixture(label, ["Serbia"]);
    const result = await f.fill();
    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped")
      expect(result.reason).toContain("neither Kosovo nor Albania");
    expect(f.field.value).toBe("");
    expect(f.chooseOption.mock.calls.map((call) => call[1])).toEqual([
      "Kosovo",
      "Albania",
    ]);
  },
);

test.each([
  ["Passport country", "", true],
  ["State", "Country of residence", true],
  ["Country of residence", "Professional reference", true],
  ["What country are you based in?", "", false],
] as const)(
  "a residence rule cannot authorize %s / %s (saved: %s)",
  async (label, group, withRule) => {
    const f = fixture(label, ["Albania"], group, withRule);
    const result = await f.fill();
    expect(result.kind).not.toBe("filled");
    expect(result.kind).not.toBe("skipped");
    if (withRule) expect(f.chooseOption).not.toHaveBeenCalled();
    else
      expect(f.chooseOption.mock.calls.map((call) => call[1])).toEqual([
        "Kosovo",
      ]);
    expect((await f.send("Albania"))[0]?.supported).toBe(false);
  },
);

test("a saved spelling keeps the form's own label", async () => {
  const f = fixture("Country of residence", ["Albania (Shqipëri)", "Serbia"]);
  expect(await f.fill()).toMatchObject({
    kind: "filled",
    filled: { answer: { value: "Albania (Shqipëri)" } },
  });
  expect((await f.send("Albania (Shqipëri)"))[0]?.supported).toBe(true);
});

test("technology spellings are distinct choices", () => {
  expect(strictOptionMatch(["C#", "Go"], "C++")).toEqual({ kind: "none" });
  expect(strictOptionMatch(["C++", "C#"], "C#")).toEqual({
    kind: "match",
    value: "C#",
  });
});

test("a rule for C# never answers a C++ question", async () => {
  const f = fixture("Experience with C++", ["8 years", "6 years"]);
  f.config.sources.reusableAnswers = [
    {
      ...saved,
      question: "Experience with C#",
      answer: "8 years",
      optionFallback: {
        primary: "8 years",
        fallback: "6 years",
        whenNeitherOffered: "skip_application",
      },
    },
  ];
  expect((await f.fill()).kind).not.toBe("filled");
  expect(f.chooseOption).not.toHaveBeenCalled();
  expect((await f.send("8 years"))[0]?.supported).toBe(false);
});
