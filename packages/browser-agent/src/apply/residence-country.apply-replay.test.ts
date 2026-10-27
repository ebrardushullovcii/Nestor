import {
  CandidateProfileSchema,
  type ApplyAnswerTags,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { buildApplyFormObservation } from "./page-hands";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import type { ApplyAgentConfig } from "./types";
import type { LLMClient } from "../agent/contracts";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";

const now = () => new Date("2026-10-26T00:00:00.000Z");

async function replay(
  label: string,
  kind: "text" | "select",
  groupLabel = "",
  sourceId: string | null = "profile.currentCountry",
  options = ["Germany", "France"],
  answerKind: ApplyAnswerTags["kind"] = "other",
) {
  const observation = buildApplyFormObservation(
    {
      url: "https://employer.example.test/apply",
      title: "Apply",
      bodyText: "Application questions",
      headings: [],
      controls: [
        {
          index: 0,
          tagName: kind === "text" ? "input" : "select",
          inputType: kind === "text" ? "text" : "",
          role: "",
          id: "residence",
          name: "residence",
          label,
          groupLabel,
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
          options: kind === "select" ? options : [],
          selectedOptionLabel: "",
        },
      ],
      actions: [],
      links: [],
      clickables: [],
      openedTabs: [],
      validationErrors: [],
      stepLabel: null,
      loading: false,
    },
    now().toISOString(),
  );
  const field = observation.controls[0];
  const write = vi.fn(() => {
    if (kind === "select" && !options.includes("Germany"))
      return Promise.resolve({
        ok: false as const,
        error: "The form does not offer Germany.",
        reason: "option_not_offered" as const,
        offeredOptions: options,
      });
    field.value = "Germany";
    return Promise.resolve({ ok: true as const, observedValue: "Germany" });
  });
  const checkWrittenAnswer = vi.fn(() =>
    Promise.resolve({ supported: true, reason: "Lying checker" }),
  );
  const config = {
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        currentCountry: "Germany",
        yearsExperience: 2,
        baseResume: {
          id: "resume",
          fileName: "synthetic.txt",
          uploadedAt: now().toISOString(),
        },
      }),
      resumeText: null,
      documents: [],
      reusableAnswers: [],
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
      startingUrl: observation.url!,
    },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    hands: {
      observe: () => Promise.resolve(observation),
      fillText: write,
      chooseOption: write,
      wait: () => Promise.resolve(),
    },
    siteLabel: "Synthetic employer",
  } as unknown as ApplyAgentConfig;
  const outcome = await executeApplyProposal(
    kind === "text"
      ? { tool: "type", ref: field.ref, text: "Germany" }
      : { tool: "select", ref: field.ref, option: "Germany" },
    observation.signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      checkWrittenAnswer,
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              [groupLabel, label].filter(Boolean).join(" — "),
              {
                asksAboutPay: false,
                declarationKind: null,
                answerTags: { kind: answerKind, country: null, sourceId },
              },
            ],
          ]),
        ),
    },
  );
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
                tags: [{ index: 0, kind: answerKind, country: null, sourceId }],
              }),
            },
          },
        ],
      }),
  };
  const send = (answer = "Germany") =>
    checkClassifiedApplicationAnswers({
      client,
      sources: config.sources,
      payDisclosed: false,
      answers: [
        { question: [groupLabel, label].filter(Boolean).join(" — "), answer },
      ],
      formControls: observation.controls,
      formContext: { pageText: "Application questions", fields: [] },
    });
  return { outcome, write, checkWrittenAnswer, send };
}

test.each([
  "Where do you currently live?",
  "País de residencia",
  "Land Ihres derzeitigen Wohnsitzes",
  "Pays de résidence",
  "País de residência",
])(
  "a typed residence-country question fills and rechecks in any language: %s",
  async (label) => {
    const result = await replay(
      label,
      "text",
      "",
      "profile.currentCountry",
      undefined,
      "residence_country",
    );
    expect(result.outcome.kind).toBe("filled");
    expect(result.write).toHaveBeenCalledOnce();
    expect(result.checkWrittenAnswer).not.toHaveBeenCalled();
    expect((await result.send())[0]?.supported).toBe(true);
    expect((await result.send("France"))[0]?.supported).toBe(false);
  },
);

test.each([
  ["País de residencia", "", null],
  ["País de residencia", "Professional reference", "profile.currentCountry"],
  ["Passport country", "", "profile.currentCountry"],
  ["Nationalité", "", "profile.currentCountry"],
  ["Nacionalidad", "", "profile.currentCountry"],
])(
  "a residence tag never supplies a missing or different personal fact: %s / %s",
  async (label, group, sourceId) => {
    const result = await replay(
      label,
      "text",
      group,
      sourceId,
      undefined,
      "residence_country",
    );
    expect(result.write).not.toHaveBeenCalled();
    expect((await result.send())[0]?.supported).toBe(false);
  },
);

test.each([
  ["What country are you based in?", "text"],
  ["What country are you based in?", "select"],
  ["What is your current country of residence?*", "text"],
  ["What is your current country of residence?*", "select"],
] as const)(
  "the residence question uses Profile: %s (%s)",
  async (label, kind) => {
    const result = await replay(label, kind);
    expect(result.outcome).toMatchObject({
      kind: "filled",
      filled: {
        answer: { value: "Germany", sourceId: "profile.currentCountry" },
      },
    });
    expect(result.write).toHaveBeenCalledOnce();
    expect(result.checkWrittenAnswer).not.toHaveBeenCalled();
  },
);

test.each([
  ["Passport country", "", "profile.currentCountry"],
  ["Citizenship", "", "profile.currentCountry"],
  [
    "What is your current country of residence?",
    "Professional reference",
    "profile.currentCountry",
  ],
  ["What country are you based in?", "", null],
] as const)(
  "residence never supplies an unrelated or unbound answer: %s / %s",
  async (label, group, sourceId) => {
    const result = await replay(label, "text", group, sourceId);
    expect(result.outcome.kind).toBe("suggestion");
    expect(result.write).not.toHaveBeenCalled();
    expect(result.checkWrittenAnswer).not.toHaveBeenCalled();
  },
);

test("an unoffered country cannot be replaced without a saved rule", async () => {
  const result = await replay(
    "What country are you based in?",
    "select",
    "",
    "profile.currentCountry",
    ["France"],
  );
  expect(result.outcome.kind).not.toBe("filled");
  expect(result.write).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    "Germany",
  );
});
