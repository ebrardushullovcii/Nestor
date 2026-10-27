import pickerReplay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/picker-handover.json";
import fallbackReplay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/saved-option-fallback.json";
import {
  CandidateProfileSchema,
  normalizeFormQuestionPrompt,
} from "@nestor/contracts";
import repeatedStep from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/repeated-employment-step.json";
import emptiedAttach from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/emptied-required-attach.json";
import { describe, expect, test, vi } from "vitest";

import type {
  RawApplyAction,
  RawApplyControl,
  RawApplyPage,
} from "@nestor/contracts";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import {
  createApplySystemPrompt,
  createApplyUserPrompt,
} from "./apply-prompts";
import type { FillFieldsEntry } from "./apply-tools";
import { buildApplyFormObservation } from "./page-hands";
import { reviewFieldKey, screenKey } from "./form-replay";
import { STEP_HANDOVER_QUESTION_ID } from "./submit-preflight";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import { savedAnswerForQuestion } from "./application-facts";
import type {
  ApplyAgentConfig,
  ApplyAgentResult,
  ApplyPageHands,
} from "./types";
import {
  checkWrittenApplicationAnswer,
  WrittenAnswerCheckUnavailableError,
} from "./written-answer-grounding";

/**
 * How the loop ends.
 *
 * There is no step quota: the agent decides when the form is done. What is
 * bounded is going nowhere — a stall gets one warning and then the run stops,
 * and the agent can stop itself by finishing as stuck.
 */

/** One ordinary question, so the page reads as a form rather than a listing. */
function nameControl(): RawApplyControl {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "f0",
    name: "f0",
    label: "Full name",
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: true,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: "Robin Ashford",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
  };
}

function workAuthorizationRadio(
  index: number,
  label: "Yes" | "No",
): RawApplyControl {
  return {
    ...nameControl(),
    index,
    inputType: "radio",
    id: `work-authorization-${label.toLowerCase()}`,
    name: "workAuthorization",
    label,
    groupLabel: "Are you legally authorized to work in this country?",
    value: label,
    checked: false,
  };
}

function page(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    url: "https://apply.example.test/form",
    title: "Apply",
    bodyText: "Apply for the role",
    controls: [nameControl()],
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
    ...overrides,
  };
}

function hands(source: RawApplyPage): ApplyPageHands {
  return {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(source, "2026-09-14T10:00:00.000Z"),
      ),
    navigate: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    clickElement: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
    readText: () => Promise.resolve("Apply for the role"),
    fillText: (ref, value) => {
      const control = source.controls.find(
        (entry) => (entry.ref ?? `c${entry.index}`) === ref,
      );
      if (control) control.value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    },
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () =>
      Promise.resolve({ ok: true, url: "https://apply.example.test/form" }),
  };
}

function config(
  source: RawApplyPage,
  overrides: Partial<ApplyAgentConfig> = {},
): ApplyAgentConfig {
  return {
    hands: hands(source),
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "candidate_test",
        firstName: "Robin",
        lastName: "Ashford",
        fullName: "Robin Ashford",
        headline: "Platform engineer",
        summary: "Builds dependable internal tools.",
        currentLocation: "Manchester",
        workEligibility: {
          authorizedWorkCountries: ["United Kingdom", "Germany"],
        },
        yearsExperience: 8,
        baseResume: {
          id: "resume_test",
          fileName: "resume.txt",
          uploadedAt: "2026-09-01T09:00:00.000Z",
          textContent: "8 years of platform engineering.",
          textUpdatedAt: "2026-09-01T09:00:00.000Z",
          extractionStatus: "ready",
        },
      }),
      resumeText: null,
      posting: {
        title: "Platform Engineer",
        company: "Northwind Tools",
        location: "Manchester",
        description: "Own the internal platform.",
      },
      reusableAnswers: [],
      documents: [],
    },
    application: {
      jobId: "job_test",
      applicationId: "application_test",
      startingUrl: "https://apply.example.test/form",
    },
    siteLabel: "the careers site",
    now: () => new Date("2026-09-14T10:00:00.000Z"),
    // Most of these tests walk a form step by step, which only Send for me
    // does; Fill in for me's own tests turn this off.
    intermediateWritesAuthorized: true,
    ...overrides,
  };
}

/**
 * The fact check's answer when a scripted model is asked to check answers:
 * every answer supported. It does not use up a scripted turn.
 */
function flowEvidence(
  applicant: Record<string, unknown>,
  answer: { question: string; proposedAnswer: string },
) {
  const scalars: Array<{ path: string; value: string }> = [];
  const visit = (value: unknown, path: string) => {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    )
      scalars.push({ path, value: String(value) });
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value))
        visit(
          item,
          `${path}/${key.replace(/~/gu, "~0").replace(/\//gu, "~1")}`,
        );
  };
  visit(applicant, "");
  const saved = Array.isArray(applicant.savedAnswers)
    ? applicant.savedAnswers
    : [];
  const savedIndex = saved.findIndex((entry: unknown) => {
    const item = entry as { question?: string; answer?: string };
    return (
      item.question === answer.question && item.answer === answer.proposedAnswer
    );
  });
  const field =
    savedIndex >= 0
      ? scalars.find(
          (entry) => entry.path === `/savedAnswers/${savedIndex}/answer`,
        )
      : /authori[sz]ed/iu.test(answer.question) &&
          answer.proposedAnswer === "Yes"
        ? scalars.find((entry) =>
            entry.path.startsWith(
              "/workEligibility/Countries where you can work/",
            ),
          )
        : /\bFrom$/iu.test(answer.question) &&
            /^\d{4}-\d{2}$/u.test(answer.proposedAnswer)
          ? scalars.find((entry) =>
              /^\/experiences\/\d+\/startDate$/u.test(entry.path),
            )
          : (scalars.find((entry) =>
              entry.value.includes(answer.proposedAnswer),
            ) ?? scalars.find((entry) => entry.path === "/summary"));
  return field
    ? [
        {
          kind: "applicant_fact",
          claim: answer.proposedAnswer,
          source: "applicant",
          path: field.path,
          quote: field.value,
        },
      ]
    : [];
}

function supportedChecks(
  messages: Parameters<LLMClient["chatWithTools"]>[0],
  definitions: Parameters<LLMClient["chatWithTools"]>[1],
): ReturnType<LLMClient["chatWithTools"]> | null {
  if (definitions[0]?.function.name !== "report_answer_checks") return null;
  const asked = JSON.parse(String(messages[1]?.content ?? "{}")) as {
    applicant: Record<string, unknown>;
    postingContextOnly?: { description?: string };
    answers?: Array<{ question: string; proposedAnswer: string }>;
  };
  return Promise.resolve({
    toolCalls: [
      {
        id: "check",
        type: "function" as const,
        function: {
          name: "report_answer_checks",
          arguments: JSON.stringify({
            checks: (asked.answers ?? []).map((answer, index) => ({
              index,
              supported: true,
              reason: "Supported by the applicant facts.",
              evidence:
                /why this role/iu.test(answer.question) &&
                asked.postingContextOnly?.description
                  ? [
                      {
                        kind: "role_motivation",
                        claim: answer.proposedAnswer,
                        source: "posting",
                        path: "/description",
                        quote: asked.postingContextOnly.description,
                      },
                    ]
                  : flowEvidence(asked.applicant, answer),
            })),
          }),
        },
      },
    ],
  });
}

function repeatingModel(
  name: string,
  args: Record<string, unknown>,
): LLMClient {
  let calls = 0;
  return {
    chatWithTools: (messages, definitions) => {
      const check = supportedChecks(messages, definitions);
      if (check) return check;
      calls += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
    },
  };
}

test.each([true, false])(
  "last-chance semantic matches still require independent grounding (supported: %s)",
  async (supported) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          label: "Contact e-mail",
          inputType: "email",
          value: "",
        },
      ],
    });
    const input = config(source, { modelQuestionClassification: true });
    const value = "robin@example.test";
    input.sources.profile.email = value;
    const fill = vi.fn((ref: string, text: string) => {
      source.controls[0].value = text;
      return Promise.resolve({ ok: true as const, observedValue: text });
    });
    input.hands.fillText = fill;
    let matches = 0;
    const finish = repeatingModel("finish", {
      reason: "I filled what I could.",
    });
    const report = (name: string, args: Record<string, unknown>) =>
      Promise.resolve({
        toolCalls: [
          {
            id: name,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
    const result = await runApplyAgent(input, {
      chatWithTools: (messages, definitions, options) => {
        const tool = definitions[0]?.function.name;
        if (tool === "report_question_kinds")
          return report(tool, {
            plainIndexes: [0],
            flagged: [],
            tags: [{ index: 0, kind: "other", country: null, sourceId: null }],
          });
        if (tool === "match_application_answer") {
          matches += 1;
          return report(tool, { sourceId: "profile.email", answer: value });
        }
        if (tool === "report_answer_checks" && !supported)
          return report(tool, {
            checks: [
              {
                index: 0,
                supported: false,
                reason:
                  "This question is not established by the applicant facts.",
                evidence: [],
              },
            ],
          });
        return finish.chatWithTools(messages, definitions, options);
      },
    });
    expect(matches).toBe(1);
    if (supported) {
      expect(fill).toHaveBeenCalledExactlyOnceWith("c0", value);
      expect(result.outcome).toBe("prepared");
      expect(result.pauses).toEqual([]);
    } else {
      expect(fill).not.toHaveBeenCalled();
      expect(result.outcome).toBe("paused");
    }
  },
);

function scriptedModel(
  turns: Array<{ name: string; args: Record<string, unknown> }>,
): LLMClient {
  let calls = 0;
  return {
    chatWithTools: (messages, definitions) => {
      const check = supportedChecks(messages, definitions);
      if (check) return check;
      const turn = turns[Math.min(calls, turns.length - 1)];
      calls += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function" as const,
            function: { name: turn.name, arguments: JSON.stringify(turn.args) },
          },
        ],
      });
    },
  };
}

test.each([false,true])("Fill completes four proven local steps after a finish, including an earlier premature Next: %s", async premature => {
  const source=page({stepLabel:"Step 1 of 4",actions:[{index:0,label:"Next",visible:true,disabled:false,inForm:true,submitsForm:false}]});
  let step=1,turns=0;
  const input=config(source,{pressesFormButtons:false,intermediateWritesAuthorized:false});
  const press=vi.fn(() => {
    step++;
    source.stepLabel=`Step ${step} of 4`;
    if(step===4) source.actions=[{index:0,label:"Send application",visible:true,disabled:false,inForm:true,submitsForm:true}];
    return Promise.resolve({ok:true as const,observedValue:"clicked"});
  });
  input.hands.clickWithoutWrites=press;
  const normalClick=vi.spyOn(input.hands,"clickElement");
  const result=await runApplyAgent(input,{
    chatWithTools:(messages,definitions) => {
      const check=supportedChecks(messages,definitions);
      if(check) return check;
      turns++;
      source.loading=premature && turns===1;
      return Promise.resolve({toolCalls:[{id:`step_${turns}`,type:"function" as const,function:{name:source.loading?"click":"finish",arguments:JSON.stringify(source.loading?{ref:"a0"}:{reason:"This step is filled."})}}]});
    },
  });
  expect(result.outcome).toBe("prepared");
  expect(result.pauses).toEqual([]);
  expect(press).toHaveBeenCalledTimes(3);
  expect(normalClick).not.toHaveBeenCalled();
  expect(step).toBe(4);
  expect(result.formPath).toHaveLength(3);
});

test("a completed form returns an obstructed final button to the model in fill-only mode", async () => {
  const source = page();
  const input = config(source);
  const checks = vi
    .fn()
    .mockResolvedValueOnce({
      ok: false,
      error: "Cookie choices cover Send. Reject optional is available.",
    })
    .mockResolvedValue({ ok: true, observedValue: "Reachable" });
  input.hands.checkAction = checks;
  const click = vi.fn(input.hands.clickElement);
  input.hands.clickElement = click;
  const model = scriptedModel([
    { name: "finish", args: { reason: "The form is complete." } },
    {
      name: "finish",
      args: { reason: "The overlay is cleared and the form is complete." },
    },
  ]);
  const chat = vi.spyOn(model, "chatWithTools");
  const result = await runApplyAgent(input, model);
  expect(checks).toHaveBeenCalledTimes(2);
  expect(chat).toHaveBeenCalledTimes(2);
  expect(
    chat.mock.calls[1][0].some((message) =>
      String(message.content).includes("Cookie choices cover Send"),
    ),
  ).toBe(true);
  expect(result.outcome).toBe("prepared");
  expect(result.readyToSend).toBeNull();
  expect(click).not.toHaveBeenCalled();
});

test.each(["upload", "type"] as const)(
  "a chosen letter drafts during the other fills and is reused for %s",
  async (tool) => {
    const source = page({
      controls: [
        { ...nameControl(), value: "" },
        {
          ...nameControl(),
          index: 1,
          inputType: tool === "upload" ? "file" : "text",
          label: "Cover letter",
          value: "",
        },
      ],
    });
    const input = config(source);
    const text = "I build dependable internal tools. ".repeat(8);
    let finishDraft: (value: {
      ok: true;
      text: string;
      document: null;
    }) => void = () => {};
    const drafted = new Promise<{
      ok: true;
      text: string;
      document: null;
    }>((resolve) => {
      finishDraft = resolve;
    });
    const provide = vi.fn(async () => {
      const result = await drafted;
      return {
        ...result,
        document:
          tool === "upload"
            ? {
                id: "letter",
                kind: "cover_letter" as const,
                label: "Cover letter",
                fileName: "letter.pdf",
                mimeType: "application/pdf",
                loadBytes: () => Promise.resolve(new Uint8Array([1])),
              }
            : null,
      };
    });
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    const fill = input.hands.fillText;
    input.hands.fillText = (ref, value) => {
      if (ref === "c0") {
        expect(provide).toHaveBeenCalledOnce();
        finishDraft({ ok: true, text, document: null });
      }
      return fill(ref, value);
    };
    input.hands.uploadFile = (_ref, file) => {
      source.controls[1].value = file.name;
      return Promise.resolve({ ok: true, observedValue: file.name });
    };
    const result = await runApplyAgent(
      input,
      scriptedModel([
        {
          name: "fill_fields",
          args: {
            fields: [
              {
                tool: "type",
                ref: "c0",
                text: "Robin Ashford",
                storedFactId: "profile.fullName",
              },
              tool === "upload"
                ? { tool, ref: "c1", documentId: "letter" }
                : {
                    tool,
                    ref: "c1",
                    text: "Write the letter from the saved facts.",
                  },
            ],
            finishWhenReady: true,
          },
        },
        { name: "finish", args: { reason: "Done." } },
      ]),
    );
    expect(provide).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("prepared");
    expect(
      tool === "upload" ? result.attachments : result.filled,
    ).not.toHaveLength(0);
    if (tool === "type") expect(source.controls[1].value).toBe(text);
  },
);

test.each(
  ["Passport Country", "Citizenship", "Nationality"].flatMap((label) =>
    [false, true].map((prefilled) => ({ label, prefilled })),
  ),
)(
  "nationality refusal never retains residence in the review ($label, prefilled=$prefilled)",
  async ({ label, prefilled }) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          label,
          value: prefilled ? "Primary territory" : "",
          required: true,
        },
      ],
    });
    const input = config(source);
    input.sources.profile.currentRegion = "Primary territory";
    input.sources.profile.currentCountry = "Primary territory";
    const result = await runApplyAgent(
      input,
      scriptedModel([
        {
          name: "type",
          args: {
            ref: "c0",
            text: "Primary territory",
            storedFactId: "profile.currentRegion",
          },
        },
        { name: "finish", args: { reason: "Done" } },
      ]),
    );
    expect(result.outcome).toBe("paused");
    expect(result.readyToSend).toBeNull();
    expect(result.filled).toEqual([]);
    expect(result.reviewFilled).toEqual([]);
    expect(
      result.pauses
        .flatMap((pause) => pause.questions ?? [])
        .some((question) => question.prompt.includes(label)),
    ).toBe(true);
    expect(source.controls[0].value).toBe(prefilled ? "Primary territory" : "");
  },
);

test.each(["never", "when_required"] as const)(
  "an optional letter does not start a draft under %s",
  async (policy) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Cover letter",
          required: false,
          value: "",
        },
      ],
    });
    const input = config(source);
    const provide = vi.fn(() =>
      Promise.resolve({ ok: false as const, reason: "Must not run" }),
    );
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    input.writing = {
      coverLetterPolicy: policy,
      writtenAnswerLength: "short",
      preApprovedDeclarations: [],
    };
    await runApplyAgent(
      input,
      scriptedModel([
        {
          name: "fill_fields",
          args: {
            fields: [{ tool: "upload", ref: "c0", documentId: "letter" }],
          },
        },
        { name: "finish", args: { reason: "Done." } },
      ]),
    );
    expect(provide).not.toHaveBeenCalled();
  },
);

test("Stop drains a pending local letter without attaching it", async () => {
  const source = page({
    controls: [
      { ...nameControl(), value: "" },
      {
        ...nameControl(),
        index: 1,
        inputType: "file",
        label: "Cover letter",
        value: "",
      },
    ],
  });
  const controller = new AbortController();
  const input = config(source, { signal: controller.signal });
  let drained = false;
  const provide = vi.fn(
    () =>
      new Promise<{ ok: false; reason: string }>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () => {
            drained = true;
            resolve({ ok: false, reason: "Stopped" });
          },
          { once: true },
        );
      }),
  );
  input.letters = {
    preference: {
      tone: "direct",
      length: "short",
      language: null,
      sample: null,
    },
    provide,
  };
  input.hands.fillText = (_ref, value) => {
    controller.abort();
    return Promise.resolve({ ok: true, observedValue: value });
  };
  const upload = vi.fn(input.hands.uploadFile);
  input.hands.uploadFile = upload;
  await runApplyAgent(
    input,
    scriptedModel([
      {
        name: "fill_fields",
        args: {
          fields: [
            {
              tool: "type",
              ref: "c0",
              text: "Robin Ashford",
              storedFactId: "profile.fullName",
            },
            { tool: "upload", ref: "c1", documentId: "letter" },
          ],
        },
      },
    ]),
  ).catch((error: unknown) => {
    expect(error).toBeInstanceOf(Error);
  });
  expect(provide).toHaveBeenCalledOnce();
  expect(drained).toBe(true);
  expect(upload).not.toHaveBeenCalled();
});

test("a rejected background letter fills the contact field and leaves the letter for review", async () => {
  const source = page({
    controls: [
      { ...nameControl(), value: "" },
      {
        ...nameControl(),
        index: 1,
        inputType: "file",
        label: "Cover letter",
        value: "",
      },
    ],
  });
  const input = config(source);
  const provide = vi.fn(() =>
    Promise.resolve({
      ok: false as const,
      draftText: "A letter needing review.",
      reason: "The proposed hours conflict with your saved availability.",
    }),
  );
  input.letters = {
    preference: {
      tone: "direct",
      length: "short",
      language: null,
      sample: null,
    },
    provide,
  };
  const upload = vi.fn(input.hands.uploadFile);
  input.hands.uploadFile = upload;
  const result = await runApplyAgent(
    input,
    scriptedModel([
      {
        name: "fill_fields",
        args: {
          fields: [
            {
              tool: "type",
              ref: "c0",
              text: "Robin Ashford",
              storedFactId: "profile.fullName",
            },
            { tool: "upload", ref: "c1", documentId: "letter" },
          ],
        },
      },
      {
        name: "finish",
        args: { reason: "The letter needs review.", needsPerson: true },
      },
    ]),
  );
  expect(source.controls[0].value).toBe("Robin Ashford");
  expect(provide).toHaveBeenCalledOnce();
  expect(upload).not.toHaveBeenCalled();
  expect(result.outcome).toBe("paused");
  expect(result.pauses[0]?.reviewDraft?.text).toBe("A letter needing review.");
});

test("a checked letter taking over ninety seconds is awaited once", async () => {
  vi.useFakeTimers();
  try {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Cover letter",
          value: "",
        },
      ],
    });
    const input = config(source);
    const provide = vi.fn(
      () =>
        new Promise<{
          ok: true;
          text: string;
          document: NonNullable<
            ApplyAgentConfig["sources"]["documents"][number]
          >;
        }>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                text: "I build dependable internal tools. ".repeat(8),
                document: {
                  id: "letter",
                  kind: "cover_letter",
                  label: "Cover letter",
                  fileName: "letter.pdf",
                  mimeType: "application/pdf",
                  loadBytes: () => Promise.resolve(new Uint8Array([1])),
                },
              }),
            100_000,
          );
        }),
    );
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    input.hands.uploadFile = (_ref, file) => {
      source.controls[0].value = file.name;
      return Promise.resolve({ ok: true, observedValue: file.name });
    };
    const pending = runApplyAgent(
      input,
      scriptedModel([
        {
          name: "fill_fields",
          args: {
            fields: [{ tool: "upload", ref: "c0", documentId: "letter" }],
            finishWhenReady: true,
          },
        },
        { name: "finish", args: { reason: "Done." } },
      ]),
    );
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(provide).toHaveBeenCalledOnce();
    expect(result.outcome).toBe("prepared");
    expect(result.notes.join("\n")).not.toContain("took too long");
    expect(result.attachments).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("a covered Send is handed back to the model before the form finishes", async () => {
  const source = page({
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
      { index: 1, label: "Use essential only", visible: true, disabled: false },
    ],
  });
  const input = config(source);
  let covered = true;
  input.hands.checkAction = () =>
    Promise.resolve(
      covered
        ? { ok: false, error: "Use essential only covers Send." }
        : { ok: true, observedValue: "Reachable" },
    );
  input.hands.clickElement = (ref) => {
    expect(ref).toBe("a1");
    covered = false;
    source.actions[1].visible = false;
    return Promise.resolve({ ok: true, observedValue: "dismissed" });
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "finish", args: { reason: "Done." } },
      {
        name: "click",
        args: { ref: "a1", reason: "Dismiss the ordinary storage notice." },
      },
      { name: "finish", args: { reason: "Done." } },
    ]),
  );
  expect(covered).toBe(false);
  expect(result.outcome).toBe("prepared");
  expect(result.pauses).toEqual([]);
});

test("prose instructions separate candidate evidence from job requirements", () => {
  const prompt = createApplySystemPrompt(config(page()));
  expect(prompt).toContain(
    "Answers about this person come only from their facts",
  );
  expect(prompt).toContain(
    "never turn a job requirement into a claim that the person has done it",
  );
  expect(prompt).toContain("Leave unsupported candidate claims out");
  expect(prompt).toContain(
    "EVERY field you can answer into ONE fill_fields call",
  );
  expect(prompt).toContain("read it before handling newly revealed fields");
  expect(prompt).toContain("even on the first step");
  expect(prompt).toContain("tool: upload and documentId");
  expect(prompt).toContain("tool: click and ref");
  expect(prompt).toContain("call finish once");
  expect(prompt).toContain("include thenContinue");
  expect(prompt).toContain("Otherwise fill without continuing");
  expect(prompt).toContain("Never use thenContinue for final submit");
  expect(prompt).toContain("Single-field tools remain available");
});

test("a final fill batch finishes in one turn after the live readiness checks", async () => {
  const source = page({ controls: [{ ...nameControl(), value: "" }] });
  const model = scriptedModel([
    {
      name: "fill_fields",
      args: {
        fields: [
          {
            tool: "type",
            ref: "c0",
            text: "Robin Ashford",
            storedFactId: "profile.fullName",
          },
        ],
        finishWhenReady: true,
      },
    },
  ]);
  const chat = vi.spyOn(model, "chatWithTools");
  const result = await runApplyAgent(config(source), model);
  expect(result.outcome).toBe("prepared");
  expect(source.controls[0].value).toBe("Robin Ashford");
  expect(chat).toHaveBeenCalledTimes(1);
});

test("a final fill batch cannot mark an incomplete wizard ready", async () => {
  const source = page({
    controls: [{ ...nameControl(), value: "" }],
    stepLabel: "Step 1 of 2",
    actions: [{ index: 0, label: "Continue", visible: true, disabled: false }],
  });
  const model = scriptedModel([
    {
      name: "fill_fields",
      args: {
        fields: [
          {
            tool: "type",
            ref: "c0",
            text: "Robin Ashford",
            storedFactId: "profile.fullName",
          },
        ],
        finishWhenReady: true,
      },
    },
    {
      name: "finish",
      args: {
        reason: "The next step needs the person.",
        stuck: true,
        needsPerson: true,
      },
    },
  ]);
  const result = await runApplyAgent(config(source), model);
  expect(result.outcome).not.toBe("prepared");
  expect(result.readyToSend).toBeNull();
});

test("an application sees an answer saved in another open application on its next turn", async () => {
  const source = page({
    controls: [{ ...nameControl(), label: "Team preference", value: "" }],
  });
  const input = config(source);
  let shared: ApplyAgentConfig["sources"]["reusableAnswers"] = [];
  input.readReusableAnswers = () => Promise.resolve(shared);
  input.hands.wait = () => {
    shared = [
      {
        id: "answer_memory_team",
        label: "Team preference",
        question: "Team preference",
        answer: "Platform team",
        kind: "other",
        roleFamilies: [],
        proofEntryIds: [],
      },
      {
        id: "private-pay",
        kind: "salary_expectation",
        label: "Expected salary",
        question: "Expected salary",
        answer: "PRIVATE_PAY_987654321",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    return Promise.resolve();
  };
  const model = scriptedModel([
    { name: "wait", args: { milliseconds: 1 } },
    {
      name: "fill_fields",
      args: {
        fields: [
          {
            tool: "type",
            ref: "c0",
            text: "Platform team",
            storedFactId: "answerLibrary.answer_memory_team",
          },
        ],
        finishWhenReady: true,
      },
    },
  ]);
  const chat = vi.spyOn(model, "chatWithTools");
  const result = await runApplyAgent(input, model);
  expect(result.outcome).toBe("prepared");
  expect(JSON.stringify(chat.mock.calls[1]?.[0])).toContain(
    "answerLibrary.answer_memory_team",
  );
  expect(JSON.stringify(chat.mock.calls[1]?.[0])).not.toContain(
    "PRIVATE_PAY_987654321",
  );
  expect(source.controls[0].value).toBe("Platform team");
});

test.each([
  { groupLabel: "", question: "Annual salary expectation" },
  {
    groupLabel: "Step 3 of 6: Compensation",
    question: "Step 1 of 4: Compensation — Annual salary expectation",
  },
  {
    groupLabel: "Application",
    question: "Annual salary expectation *",
  },
])(
  "explicit pay answers remain usable with automatic pay answering off: $groupLabel / $question",
  async ({ groupLabel, question }) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "number",
          label: "Annual salary expectation",
          groupLabel,
          value: "",
        },
      ],
    });
    const input = config(source);
    input.application.applicationRecordId = "application_1";
    input.sources.reusableAnswers = [
      {
        id: "remembered_pay",
        kind: "salary_expectation",
        label: "Annual salary expectation",
        question,
        answer: "50000",
        roleFamilies: [],
        proofEntryIds: [],
        applicationScope: {
          applicationRecordId: "application_1",
          resultId: null,
          location: null,
        },
      },
    ];
    const model = scriptedModel([
      {
        name: "fill_fields",
        args: {
          fields: [
            {
              tool: "type",
              ref: "c0",
              text: "50000",
              storedFactId: "answerLibrary.remembered_pay",
            },
          ],
          finishWhenReady: true,
        },
      },
    ]);
    const chat = vi.spyOn(model, "chatWithTools");
    const result = await runApplyAgent(input, model);
    expect(result.outcome).toBe("prepared");
    expect(source.controls[0].value).toBe("50000");
    expect(
      chat.mock.calls[0]?.[0].find((message) =>
        message.content?.startsWith("The person's facts"),
      )?.content,
    ).toContain('"answer":"50000"');
  },
);

test("a terms answer cannot approve a different declaration under a wizard heading", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        inputType: "checkbox",
        label: "I agree",
        groupLabel: "Step 4 of 6: Marketing consent",
        value: "yes",
        checked: false,
      },
    ],
  });
  const input = config(source);
  input.sources.reusableAnswers = [
    {
      id: "remembered_terms",
      kind: "other",
      label: "Terms",
      question: "Step 2 of 6: Terms — I agree",
      answer: "Yes",
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  await runApplyAgent(
    input,
    scriptedModel([
      { name: "set_checkbox", args: { ref: "c0", checked: true } },
      {
        name: "finish",
        args: {
          reason: "The declaration needs the person.",
          needsPerson: true,
        },
      },
    ]),
  );
  expect(source.controls[0]?.checked).toBe(false);
});

test.each([
  [
    "Step 2 of 6: Employment",
    "Step 3 of 6: Education",
    "Start date",
    "2020-01-01",
  ],
  [
    "Step 4 of 7: Reference 1",
    "Step 5 of 7: Reference 2",
    "Email address",
    "first@example.test",
  ],
  ["Step 2 of 6: Terms", "Step 4 of 6: Marketing", "I agree", "Yes"],
])(
  "saved answers keep %s distinct from %s before question classification",
  (first, second, label, answer) => {
    const observation = buildApplyFormObservation(
      page({ controls: [{ ...nameControl(), label, groupLabel: second }] }),
      new Date().toISOString(),
    );
    const control = { ...observation.controls[0], attestationKind: null };
    expect(
      savedAnswerForQuestion(control, [
        {
          id: "remembered_first",
          kind: "other",
          label,
          question: `${first} — ${label}`,
          answer,
          roleFamilies: [],
          proofEntryIds: [],
        },
      ]),
    ).toBeNull();
  },
);

test("a counter-only declaration prompt keeps its heading instead of becoming empty", () => {
  const observation = buildApplyFormObservation(
    page(),
    new Date().toISOString(),
  );
  const control = {
    ...observation.controls[0],
    kind: "checkbox" as const,
    attestationKind: "terms_acceptance" as const,
    label: "Step 2 of 6",
    groupLabel: "",
  };
  expect(questionPrompt(control)).toBe("Step 2 of 6");
  expect(
    questionPrompt({ ...control, kind: "radio", groupLabel: "Step 2 of 6" }),
  ).toBe("Step 2 of 6");
});

test("a retained form receives current exact answers and only named corrections replace entered values", () => {
  const input = config(page(), {
    application: {
      jobId: "job_test",
      applicationId: "application_test",
      startingUrl: "https://apply.example.test/form?step=3",
      continuation: { sourceUrls: ["https://apply.example.test/form"] },
      instructions: [
        'Answer to "Are you legally authorized to work in this country?": Yes',
        'Correct "Address" to "1 Example Road" before sending.',
      ],
    },
  });
  const user = createApplyUserPrompt(input);
  const system = createApplySystemPrompt(input);
  expect(user).toContain(JSON.stringify(input.application.instructions));
  expect(system).toContain("even when a field already contains an older value");
  expect(system).toContain("Preserve unrelated values entered by the person");
  expect(system).toContain("leave it intact and ask");
  expect(user).toContain("does not widen application authority");
});

describe("written answer fact check recovery", () => {
  const input = () => ({
    sources: config(page()).sources,
    payDisclosed: false,
    question: "Why do you want to work here?",
    answer: "I like the advertised work.",
  });
  const call = (args: Record<string, unknown>) => ({
    id: "check",
    type: "function" as const,
    function: {
      name: "report_answer_checks",
      arguments: JSON.stringify({ checks: [{ index: 0, ...args }] }),
    },
  });

  test("repairs a malformed report once and keeps the independent fact verdict", async () => {
    const client: LLMClient = {
      chatWithTools: vi
        .fn()
        .mockResolvedValueOnce({
          toolCalls: [call({ reason: "missing verdict" })],
        })
        .mockResolvedValueOnce({
          toolCalls: [
            call({ supported: false, reason: "No supporting fact." }),
          ],
        }),
    };
    await expect(
      checkWrittenApplicationAnswer({ ...input(), client }),
    ).resolves.toEqual({ supported: false, reason: "No supporting fact." });
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
    const lastCall = vi.mocked(client.chatWithTools).mock.lastCall;
    expect(
      lastCall?.[0].some((message) =>
        message.content.includes("previous check did not return"),
      ),
    ).toBe(true);
    expect(lastCall?.[1].length).toBeGreaterThan(0);
    expect(lastCall?.[2]?.maxOutputTokens).toBeGreaterThan(4_000);
  });

  test("refuses to enter an answer when both fact reports are unusable", async () => {
    const client: LLMClient = {
      chatWithTools: vi.fn().mockResolvedValue({ toolCalls: [] }),
    };
    await expect(
      checkWrittenApplicationAnswer({ ...input(), client }),
    ).rejects.toBeInstanceOf(WrittenAnswerCheckUnavailableError);
    expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  });

  test("accepts a valid supported verdict without a retry", async () => {
    const client: LLMClient = {
      chatWithTools: vi.fn().mockResolvedValue({
        toolCalls: [
          call({
            supported: true,
            reason: "Only ordinary motivation.",
            evidence: [
              {
                kind: "role_motivation",
                claim: "Interest in the work",
                source: "posting",
                path: "/description",
                quote: "Own the internal platform.",
              },
            ],
          }),
        ],
      }),
    };
    await expect(
      checkWrittenApplicationAnswer({
        ...input(),
        question: "What work is advertised?",
        answer: "Owning the internal platform.",
        client,
      }),
    ).resolves.toEqual({
      supported: true,
      reason: "Only ordinary motivation.",
    });
    expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  });

  test("gives the independent choice check saved Needs-you answers as applicant context", async () => {
    const request = input();
    const savedAnswer =
      "I will need employer sponsorship after my student permit ends.";
    request.sources.reusableAnswers = [
      {
        id: "sponsorship",
        kind: "visa_sponsorship",
        label: "Sponsorship",
        question: "Do you need visa sponsorship?",
        answer: savedAnswer,
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const client: LLMClient = {
      chatWithTools: vi.fn().mockResolvedValue({
        toolCalls: [
          call({ supported: true, reason: "The saved answer supports Yes." }),
        ],
      }),
    };
    await checkWrittenApplicationAnswer({
      ...request,
      client,
      question: "Do you need visa sponsorship in Germany?",
      answer: "Yes",
    });
    const content = vi
      .mocked(client.chatWithTools)
      .mock.calls[0]?.[0].find((message) => message.role === "user")?.content;
    const facts: unknown = JSON.parse(content ?? "{}");
    expect(facts).toMatchObject({
      applicant: {
        savedAnswers: [{ id: "sponsorship", answer: savedAnswer }],
      },
    });
  });
});

test("preserves an explicitly reported CAPTCHA even when finish omits needsPerson", async () => {
  const result = await runApplyAgent(
    config(page()),
    scriptedModel([
      {
        name: "finish",
        args: {
          reason:
            'Form filled. Ready for person to review hCaptcha ("Please try again" showing) and submit.',
        },
      },
    ]),
  );
  expect(result.outcome).toBe("paused");
  expect(result.pauses[0]?.blocker).toMatchObject({
    code: "security_challenge",
    requiresPerson: true,
  });
});

test.each([false, true])(
  "checks prose with independent applicant facts and finishes without repeating an unsupported answer (required=%s)",
  async (required) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          tagName: "textarea",
          inputType: "",
          label:
            "Tell me about a feature you built using an AI coding assistant",
          required,
          value: "",
        },
      ],
    });
    const fillText = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "written",
      }),
    );
    const testConfig = config(source);
    testConfig.hands.fillText = fillText;
    let writerTurn = 0;
    let checks = 0;
    const model: LLMClient = {
      chatWithTools: (messages, definitions) => {
        const checking =
          definitions[0]?.function.name === "report_answer_checks";
        if (checking) {
          checks += 1;
          expect(messages).toHaveLength(2);
          expect(messages[0]?.content).toContain(
            "General industry practice and job requirements do not prove personal experience",
          );
          expect(messages[1]?.content).toContain(
            "8 years of platform engineering",
          );
          expect(messages[1]?.content).not.toContain("self-declared proof");
        }
        const call = checking
          ? {
              name: "report_answer_checks",
              args: {
                checks: [
                  {
                    index: 0,
                    supported: false,
                    reason:
                      "Applicant facts do not mention AI coding assistant use.",
                  },
                ],
              },
            }
          : writerTurn++ === 0
            ? {
                name: "type",
                args: {
                  ref: "c0",
                  text: "I use an AI coding assistant daily.",
                  groundedIn: ["self-declared proof"],
                },
              }
            : {
                name: "finish",
                args: {
                  reason:
                    "All supported fields filled; unsupported answer left blank.",
                },
              };
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${writerTurn}_${checks}`,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args),
              },
            },
          ],
        });
      },
    };
    const result = await runApplyAgent(testConfig, model);
    expect(checks).toBe(1);
    expect(writerTurn).toBe(required ? 1 : 2);
    expect(fillText).not.toHaveBeenCalled();
    expect(result.outcome).toBe(required ? "paused" : "prepared");
    expect(
      result.pauses.flatMap(
        (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
      ),
    ).toHaveLength(required ? 1 : 0);
  },
);

test.each([
  "No CAPTCHA remains; the form is complete.",
  "The invisible hCaptcha script loaded.",
  "The person completed the CAPTCHA successfully.",
])(
  "does not turn non-blocking CAPTCHA mention into a handoff: %s",
  async (reason) => {
    const result = await runApplyAgent(
      config(page()),
      scriptedModel([{ name: "finish", args: { reason } }]),
    );
    expect(result.outcome).toBe("prepared");
  },
);

test("records a finished form's final action itself, without another model turn", async () => {
  const source = page({
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
  });
  const prompts: string[] = [];
  let turn = 0;
  const model: LLMClient = {
    chatWithTools: (messages) => {
      prompts.push(messages.at(-1)?.content ?? "");
      const call =
        turn === 0
          ? { name: "finish", args: { reason: "Everything is filled in" } }
          : turn === 1
            ? { name: "submit_application", args: { ref: "a0" } }
            : { name: "finish", args: { reason: "Ready to send" } };
      turn += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${turn}`,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: JSON.stringify(call.args),
            },
          },
        ],
      });
    },
  };

  const result = await runApplyAgent(
    config(source, {
      authority: {
        mode: "autonomous_submit",
        submitAuthorized: true,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "pause_for_user",
        allowedOrigins: ["https://apply.example.test"],
      },
    }),
    model,
  );

  expect(prompts).toHaveLength(1);
  expect(result.outcome).toBe("ready_to_send");
  expect(result.readyToSend).toEqual({
    actionRef: "a0",
    actionLabel: "Submit application",
  });
});

test("lets fill-in mode finish without recording a final action", async () => {
  const result = await runApplyAgent(
    config(
      page({
        actions: [
          {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
          },
        ],
      }),
    ),
    repeatingModel("finish", { reason: "The form is filled in" }),
  );

  expect(result.outcome).toBe("prepared");
  expect(result.readyToSend).toBeNull();
});

test("repeated finish cannot record readiness on an unauthorized origin", async () => {
  const result = await runApplyAgent(
    config(page(), {
      authority: {
        mode: "autonomous_submit",
        submitAuthorized: true,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "pause_for_user",
        allowedOrigins: [],
      },
    }),
    repeatingModel("finish", { reason: "Ready to send" }),
  );

  expect(result.outcome).toBe("paused");
  expect(result.readyToSend).toBeNull();
  expect(result.pauses[0]?.summary).toContain("not authorized");
});

test("a hidden final action cannot be ready for review", async () => {
  const result = await runApplyAgent(
    config(
      page({
        actions: [
          {
            index: 0,
            label: "Submit application",
            visible: false,
            disabled: false,
          },
        ],
      }),
      {
        authority: {
          mode: "confirm_before_submit",
          submitAuthorized: false,
          preApprovedAttestationKinds: [],
          salaryDisclosure: "pause_for_user",
          allowedOrigins: ["https://apply.example.test"],
        },
      },
    ),
    repeatingModel("finish", { reason: "The visible form is finished" }),
  );

  expect(result.outcome).toBe("paused");
  expect(result.readyToSend).toBeNull();
});

test("creates a grounded requested document and attaches the generated file", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        inputType: "file",
        label: "Motivation letter",
        value: "",
      },
    ],
  });
  const baseHands = hands(source);
  let capturedGrounding: string[] = [];
  let capturedPrompt = "";
  const result = await runApplyAgent(
    config(source, {
      hands: {
        ...baseHands,
        uploadFile: (_ref, file) => {
          source.controls = source.controls.map((control) => ({
            ...control,
            value: file.name,
          }));
          return Promise.resolve({
            ok: true as const,
            observedValue: file.name,
          });
        },
      },
      letters: {
        preference: {
          tone: "plain_professional",
          length: "short",
          language: null,
          sample: null,
        },
        provide: (request) => {
          capturedGrounding = request.groundedIn;
          capturedPrompt = request.prompt;
          return Promise.resolve({
            ok: true as const,
            text: "Dear Hiring Team,\n\nI am applying for the Platform Engineer role at Northwind Tools. My saved profile and resume show eight years of platform engineering and dependable internal-tool work. That experience aligns with your need for someone to own the internal platform.\n\nSincerely,\nRobin Ashford",
            document: {
              id: "generated_motivation_letter",
              fileName: "motivation-letter.pdf",
              mimeType: "application/pdf",
              label: "Motivation letter",
              kind: "cover_letter" as const,
              loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
            },
          });
        },
      },
    }),
    scriptedModel([
      {
        name: "finish",
        args: { reason: "The rest of the form is complete." },
      },
      {
        name: "create_application_document",
        args: {
          purpose: "motivation_letter",
          instructions: "Explain the supported platform-engineering fit.",
          fileType: "pdf",
        },
      },
      {
        name: "upload",
        args: { ref: "c0", documentId: "generated_motivation_letter" },
      },
      {
        name: "finish",
        args: { reason: "The requested document is attached." },
      },
    ]),
  );

  expect(result.pauses).toEqual([]);
  expect(result).toMatchObject({
    attachments: [
      {
        documentId: "generated_motivation_letter",
        fileName: "motivation-letter.pdf",
        controlLabel: "Motivation letter",
      },
    ],
  });
  expect(result.notes).toContain(
    "Created motivation letter motivation-letter.pdf for this application.",
  );
  expect(capturedGrounding.join("\n")).toContain(
    "Profile summary: Builds dependable internal tools.",
  );
  expect(capturedPrompt).toContain("8 years of platform engineering.");
  expect(capturedPrompt).toContain("Own the internal platform.");
  expect(capturedGrounding.join("\n")).not.toContain("{\n");
});

describe("apply agent run endings", () => {
  test("one selected radio answers its required group without selecting its opposite", () => {
    const observation = buildApplyFormObservation(
      page({
        controls: [
          { ...workAuthorizationRadio(0, "Yes"), checked: true },
          workAuthorizationRadio(1, "No"),
        ],
      }),
      "2026-09-14T10:00:00.000Z",
    );

    expect(observation.controls.map((control) => control.answered)).toEqual([
      true,
      true,
    ]);
    expect(observation.controls.map((control) => control.checked)).toEqual([
      true,
      false,
    ]);
  });

  test("reports reading and model-turn progress while it works", async () => {
    const progress: string[] = [];
    await runApplyAgent(
      config(page(), {
        onProgress: ({ note }) => {
          progress.push(note);
        },
      }),
      repeatingModel("finish", { reason: "The form is ready for review" }),
    );

    expect(progress[0]).toBe("reading the application form");
    expect(progress).toContain("asking the assistant what to do next");
  });

  test("an agent that keeps doing nothing is warned once and then stopped", async () => {
    const result = await runApplyAgent(
      config(page(), { runControl: { maxSteps: 40, noProgressStepLimit: 3 } }),
      repeatingModel("inspect_form", {}),
    );

    expect(result.outcome).toBe("stuck");
    expect(result.reason).toContain("stopped responding");
    // Stopped well before the ceiling: one warning, then one more idle window.
    expect(result.steps).toBeLessThan(12);
  });

  test("an agent that says it is stuck is believed, and its words reach the person", async () => {
    const result = await runApplyAgent(
      config(page()),
      repeatingModel("finish", {
        reason: "The form will not accept the phone number in any format",
        stuck: true,
      }),
    );

    expect(result.outcome).toBe("stuck");
    expect(result.reason).toBe(
      "Job Finder stopped on the careers site because it got stuck: The form will not accept the phone number in any format.",
    );
  });

  test("a run stopping for the person first fills what it knows, then names what is still empty", async () => {
    const seen: string[] = [];
    let calls = 0;
    const model: LLMClient = {
      chatWithTools: (messages) => {
        calls += 1;
        seen.push(JSON.stringify(messages.at(-1) ?? null));
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${calls}`,
              type: "function" as const,
              function: {
                name: "finish",
                arguments: JSON.stringify({
                  reason:
                    "The form is filled in; a security check needs the person.",
                  stuck: true,
                }),
              },
            },
          ],
        });
      },
    };

    const result = await runApplyAgent(
      config(page({ controls: [{ ...nameControl(), value: "" }] })),
      model,
    );

    expect(
      seen.some(
        (entry) =>
          entry.includes("Full name") &&
          entry.includes("Fill it now if the person's facts answer it"),
      ),
    ).toBe(true);
    expect(result.outcome).toBe("paused");
    expect(result.pauses[0]?.question?.prompt).toBe("Full name");
  });

  test("finishing normally reports what was filled in, in plain words", async () => {
    const result = await runApplyAgent(
      config(
        page({
          controls: [
            {
              index: 0,
              tagName: "input",
              inputType: "text",
              role: "",
              id: "f0",
              name: "f0",
              label: "Full name",
              groupLabel: "",
              placeholder: "",
              autocomplete: "",
              required: true,
              invalid: false,
              validationMessage: "",
              disabled: false,
              readOnly: false,
              visible: true,
              value: "Robin Ashford",
              checked: false,
              multiple: false,
              options: [],
              selectedOptionLabel: "",
            },
          ],
        }),
      ),
      repeatingModel("finish", {
        reason: "Send application not pressed per fill-only mode",
      }),
    );

    expect(result.outcome).toBe("prepared");
    expect(result.reason).toContain("It is filled in and waiting");
    expect(result.reason).not.toContain("fill-only mode");
    expect(result.reason).toContain("nothing was sent");
  });

  test("does not call a form ready while a visible required answer is empty", async () => {
    const seen: string[] = [];
    const model = repeatingModel("finish", {
      reason: "The form is ready for review",
    });
    const result = await runApplyAgent(
      config(page({ controls: [{ ...nameControl(), value: "" }] })),
      {
        chatWithTools: (messages, definitions, options) => {
          seen.push(JSON.stringify(messages.at(-1) ?? null));
          return model.chatWithTools(messages, definitions, options);
        },
      },
    );

    // Asked once to fill it; then the empty field is handed to the person.
    expect(
      seen.some((entry) => entry.includes("is required and still empty")),
    ).toBe(true);
    expect(result.outcome).toBe("paused");
    expect(
      result.pauses
        .flatMap((pause) => pause.questions ?? [])
        .map((question) => question.prompt),
    ).toEqual(["Full name"]);
  });

  test("does not call a native select ready while only its placeholder is displayed", async () => {
    const result = await runApplyAgent(
      config(
        page({
          controls: [
            {
              ...nameControl(),
              tagName: "select",
              inputType: "select-one",
              role: "combobox",
              label: "Location",
              value: "",
              options: ["", "Remote Europe"],
              selectedOptionLabel: "Select an option",
              invalid: true,
              validationMessage: "Please select an item in the list.",
            },
          ],
        }),
      ),
      repeatingModel("finish", { reason: "The form is ready for review" }),
    );

    expect(result.outcome).toBe("paused");
    expect(
      result.pauses.flatMap((pause) => pause.questions ?? []),
    ).toHaveLength(1);
  });

  test("refuses an early finish, fills a known required radio, then becomes ready", async () => {
    const source = page({
      controls: [
        workAuthorizationRadio(0, "Yes"),
        workAuthorizationRadio(1, "No"),
      ],
    });
    const baseHands = hands(source);
    const baseConfig = config(source);
    const result = await runApplyAgent(
      config(source, {
        hands: {
          ...baseHands,
          setToggle: (ref, checked) => {
            const index = Number(ref.slice(1));
            source.controls = source.controls.map((control) =>
              control.index === index
                ? { ...control, checked }
                : control.name === "workAuthorization"
                  ? { ...control, checked: false }
                  : control,
            );
            return Promise.resolve({
              ok: true as const,
              observedValue: checked ? "checked" : "unchecked",
            });
          },
        },
        sources: {
          ...baseConfig.sources,
          profile: CandidateProfileSchema.parse({
            ...baseConfig.sources.profile,
          }),
        },
      }),
      scriptedModel([
        { name: "finish", args: { reason: "The form is ready" } },
        {
          name: "set_checkbox",
          args: { ref: "c0", checked: true },
        },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(result.filled).toHaveLength(1);
    expect(result.filled[0]?.answer.value).toBe("Yes");
  });

  test("does not trust a write receipt when the live required field stayed empty", async () => {
    const source = page({ controls: [{ ...nameControl(), value: "" }] });
    const input = config(source);
    input.hands.fillText = (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value });
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );

    expect(result.filled).toHaveLength(0);
    // The field the site cleared is not called done: it goes to the person.
    expect(result.outcome).toBe("paused");
  });

  test("keeps a hidden required file input unfinished until its supplied document is attached", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Resume",
          visible: false,
          value: "",
        },
      ],
    });
    const baseHands = hands(source);
    const suppliedResume = {
      id: "resume_document",
      fileName: "resume.txt",
      mimeType: "text/plain",
      label: "Resume",
      kind: "resume" as const,
      loadBytes: () => Promise.resolve(new TextEncoder().encode("Resume")),
    };
    const result = await runApplyAgent(
      config(source, {
        hands: {
          ...baseHands,
          uploadFile: (_ref, file) => {
            source.controls = source.controls.map((control) => ({
              ...control,
              value: file.name,
            }));
            return Promise.resolve({
              ok: true as const,
              observedValue: file.name,
            });
          },
        },
        sources: {
          ...config(source).sources,
          documents: [suppliedResume],
        },
      }),
      scriptedModel([
        { name: "finish", args: { reason: "The form is ready" } },
        {
          name: "upload",
          args: { ref: "c0", documentId: suppliedResume.id },
        },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(result.attachments).toHaveLength(1);
  });

  test.each([false, true])(
    "a rejected upload is a file handover even when the file input retained its value (native invalid: %s)",
    async (invalid) => {
      const source = page({
        bodyText: "Application form. Resume failed to upload.",
        controls: [
          {
            ...nameControl(),
            inputType: "file",
            label: "Resume",
            value: "resume.txt",
            invalid,
            validationMessage: invalid ? "Resume failed to upload" : "",
          },
        ],
      });
      const model = repeatingModel("finish", {
        reason: "The upload failed; repair it on the site.",
        stuck: true,
      });
      const chat = vi.spyOn(model, "chatWithTools");
      const result = await runApplyAgent(config(source), model);
      expect(result.outcome).toBe("paused");
      expect(result.readyToSend).toBeNull();
      expect(result.reviewAttachments).toEqual([]);
      expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            answerControlType: "file",
            prompt: "Resume — upload failed",
          }),
        ]),
      );
      expect(chat).toHaveBeenCalledOnce();
    },
  );

  test("several refused uploads on one form are one item for the person", async () => {
    const source = page({
      bodyText: "Application form.",
      controls: ["Resume", "Cover letter"].map((label, index) => ({
        ...nameControl(),
        index,
        id: `file${index}`,
        name: `file${index}`,
        inputType: "file",
        label,
        value: `${label}.txt`,
        upload: {
          described: "",
          nearby: `${label} Upload rejected by server`,
          shown: false,
        },
      })),
    });
    const model = repeatingModel("finish", {
      reason: "The uploads failed; repair them on the site.",
      stuck: true,
    });
    const result = await runApplyAgent(config(source), model);
    expect(result.outcome).toBe("paused");
    const files = result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .filter((question) => question.answerControlType === "file");
    expect(files).toEqual([
      expect.objectContaining({
        id: "upload_repair",
        prompt: "Resume, Cover letter — upload failed",
      }),
    ]);
  });

  const resumeFile = (
    nearby: string,
    overrides: Partial<RawApplyControl> = {},
  ): RawApplyControl => ({
    ...nameControl(),
    index: 1,
    id: "resume",
    name: "resume",
    inputType: "file",
    label: "Resume",
    value: "resume.txt",
    upload: { described: "", nearby, shown: false },
    ...overrides,
  });
  const fileQuestions = (result: Awaited<ReturnType<typeof runApplyAgent>>) =>
    result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .filter((question) => question.answerControlType === "file");

  test("a refusal on an earlier step still stops the form on its last step", async () => {
    const source = page({
      stepLabel: "Step 1 of 2",
      controls: [nameControl(), resumeFile("Resume Upload rejected by server")],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const input = config(source);
    const toLastStep = () => {
      source.stepLabel = "Step 2 of 2";
      source.controls = [nameControl()];
      source.actions = [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ];
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    };
    input.hands.clickAction = vi.fn(toLastStep);
    input.hands.clickElement = vi.fn(toLastStep);
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "click", args: { ref: "a0" } },
        { name: "finish", args: { reason: "The form is ready" } },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(source.stepLabel).toBe("Step 2 of 2");
    expect(result.readyToSend).toBeNull();
    expect(result.outcome).not.toBe("prepared");
    expect(fileQuestions(result)).toEqual([
      expect.objectContaining({
        id: "upload_repair",
        prompt: "Resume — upload failed",
      }),
    ]);
  });

  test("a field that stays on the page across steps clears its item once the server takes the file", async () => {
    const source = page({
      stepLabel: "Step 1 of 2",
      controls: [nameControl(), resumeFile("Resume Upload rejected by server")],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const input = config(source);
    const toLastStep = () => {
      source.stepLabel = "Step 2 of 2";
      source.controls = [
        nameControl(),
        resumeFile("Resume resume.txt", {
          upload: {
            described: "",
            nearby: "Resume resume.txt",
            shown: false,
            network: "accepted",
          },
        }),
      ];
      source.actions = [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ];
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    };
    input.hands.clickAction = vi.fn(toLastStep);
    input.hands.clickElement = vi.fn(toLastStep);
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "click", args: { ref: "a0" } },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(fileQuestions(result)).toEqual([]);
    expect(result.outcome).toBe("prepared");
  });

  test("a file the site cleared is missing even on a field marked optional", async () => {
    const source = page({
      controls: [
        { ...nameControl(), value: "" },
        resumeFile("Resume resume.txt", { required: false }),
      ],
    });
    const input = config(source);
    input.hands.fillText = vi.fn((_ref: string, value: string) => {
      source.controls[0].value = value;
      source.controls[1] = resumeFile("Resume", { required: false, value: "" });
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "finish", args: { reason: "The form is ready" } },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(result.readyToSend).toBeNull();
    expect(fileQuestions(result)).toEqual([
      expect.objectContaining({ id: "upload_repair" }),
    ]);
  });

  test("a required file field the widget emptied after storage took the file is answered", async () => {
    // Replay of the Greenhouse-shaped gate run: the field is labelled only
    // "Attach", is required by its "Resume/CV *" description, and is empty
    // again once the widget has sent the file.
    const { fields, file, url } = emptiedAttach;
    const source = page({
      url,
      bodyText: "Platform Engineer. Apply for this job.",
      controls: [
        ...fields.map((field, index) => ({
          ...nameControl(),
          index,
          id: field.id,
          name: field.id,
          label: field.label,
          value: field.value,
        })),
        {
          ...nameControl(),
          index: fields.length,
          id: file.id,
          name: "",
          inputType: "file",
          label: file.label,
          hint: file.described,
          value: "",
          upload: {
            described: file.described,
            nearby: file.nearby,
            shown: false,
          },
        },
      ],
    });
    const suppliedResume = {
      id: "resume_document",
      fileName: "resume.txt",
      mimeType: "text/plain",
      label: "Your CV",
      kind: "resume" as const,
      loadBytes: () => Promise.resolve(new TextEncoder().encode("Resume")),
    };
    const uploadFile = vi.fn((_ref: string, upload: { name: string }) => {
      source.controls[fields.length] = {
        ...source.controls[fields.length],
        value: file.afterUpload.value,
        upload: {
          described: file.described,
          nearby: file.afterUpload.nearby,
          shown: false,
          fileName: upload.name,
          network: "accepted",
        },
      };
      return Promise.resolve({ ok: true as const, observedValue: upload.name });
    });
    const input = config(source, {
      intermediateWritesAuthorized: false,
      sources: { ...config(source).sources, documents: [suppliedResume] },
    });
    input.hands.uploadFile = uploadFile;
    const result = await runApplyAgent(
      input,
      scriptedModel([
        {
          name: "upload",
          args: { ref: `c${fields.length}`, documentId: suppliedResume.id },
        },
        { name: "submit_application", args: { ref: "a0" } },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toEqual([]);
    expect(result.outcome).toBe("prepared");
  });

  test("a widget that empties its input still hands over a file the server or fence refused", async () => {
    // Greenhouse reads the file, empties the input, then sends the file
    // itself; Nestor's fence held that request back.
    const source = page({
      controls: [
        nameControl(),
        resumeFile("Resume Attach", {
          required: false,
          value: "",
          upload: {
            described: "",
            nearby: "Resume Attach",
            shown: false,
            network: "rejected",
          },
        }),
      ],
    });
    const result = await runApplyAgent(
      config(source),
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(result.readyToSend).toBeNull();
    expect(fileQuestions(result)).toEqual([
      expect.objectContaining({
        id: "upload_repair",
        prompt: "Resume — upload failed",
      }),
    ]);
  });

  test("a refused upload stops after two tries and says what was refused", async () => {
    // Workable: every storage POST was held back, and the run kept
    // uploading the same file until it was stopped by hand.
    const source = page({
      controls: [nameControl(), resumeFile("Resume", { value: "" })],
    });
    const suppliedResume = {
      id: "resume_document",
      fileName: "resume.txt",
      mimeType: "text/plain",
      label: "Your CV",
      kind: "resume" as const,
      loadBytes: () => Promise.resolve(new TextEncoder().encode("Resume")),
    };
    const uploadFile = vi.fn((_ref: string, upload: { name: string }) => {
      // The widget empties its input and the storage request is refused.
      source.controls[1] = resumeFile("Resume", {
        value: "",
        upload: {
          described: "",
          nearby: "Resume",
          shown: false,
          fileName: upload.name,
          network: "rejected",
        },
      });
      return Promise.resolve({ ok: true as const, observedValue: upload.name });
    });
    const input = config(source, {
      intermediateWritesAuthorized: false,
      sources: { ...config(source).sources, documents: [suppliedResume] },
    });
    input.hands.uploadFile = uploadFile;
    const result = await runApplyAgent(
      input,
      repeatingModel("upload", { ref: "c1", documentId: suppliedResume.id }),
    );
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe("paused");
    expect(result.readyToSend).toBeNull();
    expect(result.reason).toContain("resume.txt");
    expect(result.reason).toContain("after 2 tries: its upload was refused");
    expect(fileQuestions(result)).toEqual([
      expect.objectContaining({
        id: "upload_repair",
        prompt: "Resume — upload failed",
      }),
    ]);
  });

  test("an upload that never finishes is handed over instead of waited on forever", async () => {
    const source = page({
      controls: [nameControl(), resumeFile("Resume Uploading…")],
    });
    const result = await runApplyAgent(
      config(source, { uploadWaitMs: 0 }),
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(result.readyToSend).toBeNull();
    expect(fileQuestions(result)).toEqual([
      expect.objectContaining({
        id: "upload_repair",
        prompt: "Resume — upload not confirmed",
      }),
    ]);
  });

  test("the person's word settles stale upload text, but not a server refusal", async () => {
    const stale = page({
      controls: [nameControl(), resumeFile("Resume Upload failed")],
    });
    const settled = await runApplyAgent(
      config(stale, { uploadsConfirmedByPerson: ["Resume"] }),
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(fileQuestions(settled)).toEqual([]);
    expect(settled.outcome).toBe("prepared");
    // The word covers only the field the person named.
    const otherField = await runApplyAgent(
      config(stale, { uploadsConfirmedByPerson: ["Cover letter"] }),
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(fileQuestions(otherField)).toEqual([
      expect.objectContaining({ id: "upload_repair" }),
    ]);
    const refused = page({
      controls: [
        nameControl(),
        resumeFile("Resume resume.txt", {
          upload: {
            described: "",
            nearby: "Resume resume.txt",
            shown: false,
            network: "rejected",
          },
        }),
      ],
    });
    const result = await runApplyAgent(
      config(refused, { uploadsConfirmedByPerson: ["Resume"] }),
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(fileQuestions(result)).toEqual([
      expect.objectContaining({ id: "upload_repair" }),
    ]);
  });

  test("hands an unmatched required upload to the person even when a resume is available", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Academic transcript",
          visible: false,
          value: "",
        },
      ],
    });
    const suppliedResume = {
      id: "resume_document",
      fileName: "resume.txt",
      mimeType: "text/plain",
      label: "Resume",
      kind: "resume" as const,
      loadBytes: () => Promise.resolve(new TextEncoder().encode("Resume")),
    };

    const result = await runApplyAgent(
      config(source, {
        sources: {
          ...config(source).sources,
          documents: [suppliedResume],
        },
      }),
      repeatingModel("finish", {
        reason: "The required Academic transcript upload is unavailable",
        stuck: true,
      }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.pauses[0]?.questions).toHaveLength(1);
    expect(result.pauses[0]?.questions?.[0]?.prompt).toBe(
      "Academic transcript",
    );
    expect(result.pauses[0]?.questions?.[0]?.answerControlType).toBe("file");
  });

  test("preserves an unrelated structural failure when a file also happens to be empty", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Academic transcript",
          visible: false,
          value: "",
        },
      ],
    });

    const result = await runApplyAgent(
      config(source),
      repeatingModel("finish", {
        reason: "The application page navigation failed",
        stuck: true,
      }),
    );

    expect(result.outcome).toBe("stuck");
    expect(result.pauses).toEqual([]);
  });

  test("keeps a required letter with the person when saved settings say never", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Cover letter",
          value: "",
        },
      ],
    });
    const provide = vi.fn();
    const result = await runApplyAgent(
      config(source, {
        writing: {
          coverLetterPolicy: "never",
          writtenAnswerLength: "full",
          preApprovedDeclarations: [],
        },
        letters: {
          preference: {
            tone: "plain_professional",
            length: "short",
            language: null,
            sample: null,
          },
          provide,
        },
      }),
      repeatingModel("finish", { reason: "The rest of the form is ready" }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.pauses[0]?.code).toBe("document_needs_you");
    expect(result.reason).toContain("settings say Job Finder should not write");
    expect(provide).not.toHaveBeenCalled();
  });

  test("hands unknown required eligibility to the person instead of inventing it", async () => {
    const result = await runApplyAgent(
      config(
        page({
          controls: [
            workAuthorizationRadio(0, "Yes"),
            workAuthorizationRadio(1, "No"),
          ],
        }),
      ),
      repeatingModel("finish", { reason: "The form is ready" }),
    );

    expect(result.outcome).toBe("paused");
    const questions = result.pauses.flatMap((pause) => pause.questions ?? []);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      prompt: "Are you legally authorized to work in this country?",
      answerOptions: ["Yes", "No"],
    });
  });

  test("keeps equal-worded radio groups with different DOM names separate", async () => {
    const result = await runApplyAgent(
      config(
        page({
          controls: [
            ...["Yes", "No"].map((label, index) => ({
              ...workAuthorizationRadio(index, label as "Yes" | "No"),
              name: "authorized-primary",
            })),
            ...["Yes", "No"].map((label, index) => ({
              ...workAuthorizationRadio(index + 2, label as "Yes" | "No"),
              name: "authorized-secondary",
            })),
          ],
        }),
      ),
      repeatingModel("finish", { reason: "The form is ready" }),
    );

    expect(
      result.pauses.flatMap((pause) => pause.questions ?? []),
    ).toHaveLength(2);
  });

  test("one failed first read is given to the model and can recover", async () => {
    const source = page();
    const base = hands(source);
    let reads = 0;
    const result = await runApplyAgent(
      config(source, {
        hands: {
          ...base,
          observe: () => {
            reads += 1;
            return reads === 1
              ? Promise.reject(
                  new Error("The page was replaced while it loaded."),
                )
              : base.observe();
          },
        },
      }),
      scriptedModel([
        { name: "observe", args: {} },
        { name: "finish", args: { reason: "The form recovered and is ready" } },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(result.reason).toContain("It is filled in and waiting");
    expect(result.notes.join("\n")).toContain("application page did not open");
  });

  test("a sign-in wall is a fact the model is told, not an automatic stop", async () => {
    // The model is trusted to decide what to do about it — often there is a
    // guest route, and when there is not it finishes and says so.
    const result = await runApplyAgent(
      config(page({ bodyText: "You must be signed in to apply" })),
      repeatingModel("finish", {
        reason: "This site wants you signed in before it will show the form",
        needsPerson: true,
      }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.reason).toContain("wants you signed in");
  });

  test("a credential gate never becomes a persisted password question", async () => {
    const passwordControl: RawApplyControl = {
      ...nameControl(),
      id: "password",
      name: "password",
      inputType: "password",
      label: "Password *",
      value: "",
    };
    const result = await runApplyAgent(
      config(
        page({
          url: "https://apply.example.test/signin",
          bodyText: "Sign in to continue",
          controls: [passwordControl],
          actions: [
            { index: 0, label: "Sign in", visible: true, disabled: false },
          ],
        }),
      ),
      scriptedModel([
        { name: "observe", args: {} },
        {
          name: "finish",
          args: { reason: "The site requires a password", needsPerson: true },
        },
      ]),
    );

    expect(result.outcome).toBe("paused");
    expect(result.pauses).toHaveLength(1);
    expect(result.pauses[0]?.blocker?.code).toBe("site_login_required");
    expect(result.pauses[0]?.question).toBeNull();
    expect(result.pauses[0]?.questions).toBeUndefined();
  });

  test("a visible CAPTCHA stays with the person even when the model calls the form finished", async () => {
    const result = await runApplyAgent(
      config(
        page({
          bodyText: "Apply for the role. I am not a robot. Local fake CAPTCHA.",
        }),
      ),
      repeatingModel("finish", { reason: "The form is ready for review" }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.reason).toBe("The site is running a security check.");
    expect(result.pauses[0]?.blocker?.requiresPerson).toBe(true);
  });

  const solvedCheckPage = () =>
    page({
      bodyText: "Apply for the role. I am not a robot. Local fake CAPTCHA.",
      controls: [
        nameControl(),
        {
          ...nameControl(),
          index: 1,
          id: "human",
          name: "human",
          inputType: "checkbox",
          role: "checkbox",
          label: "I am not a robot",
          required: false,
          checked: true,
          value: "yes",
        },
      ],
    });
  const confirmFirst = {
    authority: {
      mode: "confirm_before_submit" as const,
      submitAuthorized: true,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user" as const,
      allowedOrigins: ["https://apply.example.test"],
    },
  };
  const solvedCheckReason =
    "Form filled, but Submit is blocked by the 'I am not a robot' CAPTCHA which only you can tick.";

  test("a security check the person already ticked is not reported as waiting on them", async () => {
    // Asked once to name its items, the model sees the form is complete.
    const result = await runApplyAgent(
      config(solvedCheckPage(), confirmFirst),
      scriptedModel([
        {
          name: "finish",
          args: { reason: solvedCheckReason, needsPerson: true },
        },
        {
          name: "finish",
          args: { reason: "The form is complete.", needsPerson: false },
        },
      ]),
    );

    expect(result.pauses).toEqual([]);
    expect(result.outcome).toBe("awaiting_your_review");
  });

  test("a finish that still says needsPerson beside a ticked check hands the form back, not a security check", async () => {
    const result = await runApplyAgent(
      config(solvedCheckPage(), confirmFirst),
      repeatingModel("finish", {
        reason: solvedCheckReason,
        needsPerson: true,
      }),
    );

    expect(result.outcome).toBe("paused");
    expect(result.readyToSend).toBeNull();
    expect(result.pauses.some((pause) => pause.blocker)).toBe(false);
  });

  test("a run set to confirm first ends waiting for the person", async () => {
    const result = await runApplyAgent(
      config(page(), {
        authority: {
          mode: "confirm_before_submit",
          submitAuthorized: true,
          preApprovedAttestationKinds: [],
          salaryDisclosure: "pause_for_user",
          allowedOrigins: ["https://apply.example.test"],
        },
      }),
      repeatingModel("finish", {
        reason: "Send application not pressed per fill-only mode",
      }),
    );

    expect(result.outcome).toBe("awaiting_your_review");
    expect(result.reason).toContain("ready for you to look over");
  });
});

/**
 * Asking once instead of once per field.
 *
 * A form with several questions nobody's profile answers used to stop at the
 * first one; the person answered, waited for a retry, and met the next. The
 * run now works the whole form and comes back with all of them together.
 */

/**
 * The form as a live board actually renders it.
 *
 * Read off a real posting: a phone country picker beside a phone number field,
 * both labelled Phone; a file field labelled "Attach"; yes/no questions drawn
 * as comboboxes; country lists; and hidden inputs that belong to the widgets
 * rather than to the person. Ten of these are answered from the person's own
 * profile, so the model is asked about the rest and nothing else.
 */

/**
 * A run says where its minutes went.
 *
 * Six minutes on a single-page form is the difference between a person using
 * this and not, and it cannot be diagnosed from a record that says only
 * "Filling in the form…".
 */
describe("the run records its own timing", () => {
  test("the trail ends with the phases and the number of model turns", async () => {
    const result = await runApplyAgent(
      config(page()),
      repeatingModel("finish", {
        reason: "Send application not pressed per fill-only mode",
      }),
    );

    const timing = result.notes.at(-1) ?? "";
    expect(timing.startsWith("[apply] timing ")).toBe(true);
    expect(timing).toContain("read=");
    expect(timing).toContain("fill=");
    expect(timing).toMatch(/model=\d+ turns/u);
    expect(timing).toContain("total=");
  });
});

/**
 * Who gets asked what.
 *
 * Equal-opportunity and other voluntary declarations are the person's own and
 * optional by the site: they are left blank and said so, never put in front of
 * the person as a question they have to clear.
 */

/**
 * A field is written once.
 *
 * Thirty-three writes for fourteen fields is the run re-doing work it has
 * already done, and every one of those costs the person a second.
 */
describe("no field is written twice", () => {
  test("a control already holding its sourced answer is left alone", async () => {
    const already = {
      ...nameControl(),
      index: 0,
      label: "First Name",
      value: "Robin",
    };
    const result = await runApplyAgent(
      config(page({ controls: [already] })),
      repeatingModel("finish", {
        reason: "Send application not pressed per fill-only mode",
      }),
    );

    expect(result.filled).toHaveLength(0);
  });

  test("each turn the model takes is written down", async () => {
    const result = await runApplyAgent(
      config(page()),
      repeatingModel("finish", {
        reason: "Send application not pressed per fill-only mode",
      }),
    );

    expect(result.notes.some((note) => note.startsWith("turn 1: "))).toBe(true);
  });

  test("blocks a second successful write to the same control on the same page", async () => {
    const result = await runApplyAgent(
      config(page()),
      scriptedModel([
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "finish", args: { reason: "The form is prepared" } },
      ]),
    );

    expect(result.filled).toHaveLength(1);
    expect(result.notes.join("\n")).toContain(
      "That exact field was already completed",
    );
  });
});

describe("only meaningful page movement counts as progress", () => {
  test("repeated scrolling cannot keep a stuck run alive", async () => {
    const result = await runApplyAgent(
      config(page(), {
        runControl: { noProgressStepLimit: 3, maxSteps: 20 },
      }),
      repeatingModel("scroll", { direction: "down" }),
    );

    expect(result.outcome).toBe("stuck");
    expect(result.reason).toContain("nothing new happened");
    expect(result.steps).toBeLessThan(20);
  });
});

describe("the browser failing underneath a step", () => {
  test("one failure is handed back to the model as a fact, and the run carries on", async () => {
    const source = page();
    const base = hands(source);
    let reads = 0;
    const flakyHands: ApplyPageHands = {
      ...base,
      // The very first read after the click dies the way a navigation kills
      // it; the read after that sees the new page.
      observe: () => {
        reads += 1;
        if (reads === 2) {
          return Promise.reject(
            new Error(
              "The page moved to a new address while Job Finder was reading it.",
            ),
          );
        }
        return base.observe();
      },
    };
    const result = await runApplyAgent(
      config(source, { hands: flakyHands }),
      scriptedModel([
        { name: "observe", args: {} },
        {
          name: "finish",
          args: { reason: "The page moved on and the form is here now" },
        },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(result.notes.join("\n")).toContain("browser failure");
    expect(result.notes.join("\n")).toContain("moved to a new address");
  });

  test("the browser failing three times in a row ends the run in plain words", async () => {
    const source = page();
    const base = hands(source);
    let reads = 0;
    const deadHands: ApplyPageHands = {
      ...base,
      observe: () => {
        reads += 1;
        return reads === 1
          ? base.observe()
          : Promise.reject(
              new Error(
                "The browser tab Job Finder was working in was closed.",
              ),
            );
      },
    };
    const result = await runApplyAgent(
      config(source, { hands: deadHands }),
      repeatingModel("observe", {}),
    );

    expect(result.outcome).toBe("stuck");
    expect(result.reason).toContain("the browser page stopped responding");
    expect(result.reason).toContain("was closed");
    expect(result.reason).not.toContain("locator");
  });
});

describe("shared navigation and Apply safety stay in one state", () => {
  test("a send allowlist does not block an employer handoff approved by the move reviewer", async () => {
    const source = page();
    const base = hands(source);
    let navigations = 0;
    let reviews = 0;
    const result = await runApplyAgent(
      config(source, {
        hands: {
          ...base,
          navigate: (url) => {
            navigations += 1;
            return Promise.resolve({ ok: true, url });
          },
        },
        authority: {
          mode: "prepare_only",
          submitAuthorized: false,
          preApprovedAttestationKinds: [],
          salaryDisclosure: "pause_for_user",
          allowedOrigins: ["https://apply.example.test"],
        },
        reviewMove: () => {
          reviews += 1;
          return Promise.resolve({ allowed: true, verdict: "Looks relevant." });
        },
      }),
      scriptedModel([
        {
          name: "navigate",
          args: {
            url: "https://forbidden.example/form",
            reason: "The form is there.",
          },
        },
        { name: "finish", args: { reason: "Stayed on the allowed site" } },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(navigations).toBe(1);
    expect(reviews).toBe(1);
  });

  test("navigate then type uses the page the model just saw and reviews the move once", async () => {
    let current = page({ controls: [] });
    let reviews = 0;
    const base = hands(current);
    const dynamicHands: ApplyPageHands = {
      ...base,
      observe: () =>
        Promise.resolve(
          buildApplyFormObservation(current, "2026-09-14T10:00:00.000Z"),
        ),
      navigate: (url) => {
        current = page({ url, title: "External application" });
        return Promise.resolve({ ok: true, url });
      },
    };
    const result = await runApplyAgent(
      config(current, {
        hands: dynamicHands,
        reviewMove: () => {
          reviews += 1;
          return Promise.resolve({
            allowed: true,
            verdict: "This is the employer form.",
          });
        },
      }),
      scriptedModel([
        {
          name: "navigate",
          args: {
            url: "https://employer.example/form",
            reason: "The listing points to the employer application form.",
          },
        },
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "finish", args: { reason: "The form is prepared" } },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(result.filled).toHaveLength(1);
    expect(result.notes.join("\n")).not.toContain(
      "page changed since you last looked",
    );
    expect(reviews).toBe(1);
  });

  test("a move approved by a guarded click is reused by shared navigation", async () => {
    let current = page({
      actions: [{ index: 0, label: "Apply", visible: true, disabled: false }],
    });
    let reviews = 0;
    const base = hands(current);
    const dynamicHands: ApplyPageHands = {
      ...base,
      observe: () =>
        Promise.resolve(
          buildApplyFormObservation(current, "2026-09-14T10:00:00.000Z"),
        ),
      clickElement: () => {
        current = page({ url: "https://employer.example/form" });
        return Promise.resolve({ ok: true, observedValue: "clicked" });
      },
      navigate: (url) => {
        current = page({ url });
        return Promise.resolve({ ok: true, url });
      },
    };
    const result = await runApplyAgent(
      config(current, {
        hands: dynamicHands,
        reviewMove: () => {
          reviews += 1;
          return Promise.resolve({
            allowed: true,
            verdict: "This is the employer form.",
          });
        },
      }),
      scriptedModel([
        {
          name: "click",
          args: {
            ref: "a0",
            reason: "The listing's Apply button leads to the employer form.",
          },
        },
        {
          name: "navigate",
          args: {
            url: "https://employer.example/form/step-two",
            reason: "The next application step is on the same employer site.",
          },
        },
        { name: "finish", args: { reason: "The employer form is prepared" } },
      ]),
    );

    expect(result.outcome).toBe("prepared");
    expect(reviews).toBe(1);
  });
});

describe("answers and structured history on a retained form", () => {
  function withExperience(source: RawApplyPage) {
    const input = config(source);
    input.sources.profile = CandidateProfileSchema.parse({
      ...input.sources.profile,
      experiences: [
        {
          id: "signal",
          companyName: "Signal Systems",
          title: "Engineer",
          startDate: "January 2014",
          isCurrent: true,
        },
      ],
    });
    return input;
  }

  function experiencePage() {
    return page({
      controls: [],
      headings: [{ level: 2, text: "My Experience" }],
      actions: [
        { index: 0, label: "Add", visible: true, disabled: false },
        {
          index: 1,
          label: "Save and continue",
          visible: true,
          disabled: false,
        },
      ],
      stepLabel: "Step 2 of 4",
    });
  }

  test("gives the model current saved roles and exact answers as data", async () => {
    const input = withExperience(page());
    input.sources.reusableAnswers = [
      {
        id: "remote",
        kind: "other",
        label: "Remote",
        question: "Are you open to remote work?",
        answer: "Yes",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const chatWithTools = vi.fn(
      scriptedModel([{ name: "finish", args: { reason: "Prepared" } }])
        .chatWithTools,
    );
    await runApplyAgent(input, { chatWithTools });
    const facts = chatWithTools.mock.calls[0][0].find((message) =>
      message.content?.startsWith("The person's facts"),
    );
    expect(facts?.content).toContain('"startDate":"January 2014"');
    expect(facts?.content).toContain('"isCurrent":true');
    expect(facts?.content).toContain(
      '"question":"Are you open to remote work?","answer":"Yes"',
    );
    expect(facts?.content).not.toContain("storagePath");
  });

  test("fills saved remote and notice answers and reaches Review on the same page", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          index: 0,
          label: "Remote work",
          inputType: "",
          tagName: "select",
          value: "",
          options: ["Yes", "No"],
        },
        {
          ...nameControl(),
          index: 1,
          label: "",
          placeholder: "What is your notice period?",
          value: "",
        },
      ],
      stepLabel: "Step 3 of 4",
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const input = config(source);
    input.application.continuation = { sourceUrls: [source.url!] };
    input.sources.reusableAnswers = [
      {
        id: "remote",
        kind: "other",
        label: "Remote work",
        question: "Remote work",
        answer: "Yes",
        roleFamilies: [],
        proofEntryIds: [],
      },
      {
        id: "notice",
        kind: "notice_period",
        label: "Notice",
        question: "What is your notice period?",
        answer: "Two weeks",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    input.hands.chooseOption = vi.fn((_ref: string, option: string) => {
      source.controls[0].value = option;
      source.controls[0].selectedOptionLabel = option;
      return Promise.resolve({ ok: true as const, observedValue: option });
    });
    input.hands.fillText = vi.fn((_ref: string, value: string) => {
      source.controls[1].value = value;
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    input.hands.clickElement = vi.fn(() => {
      source.stepLabel = "Step 4 of 4";
      source.actions = [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ];
      return Promise.resolve({ ok: true as const, observedValue: "Review" });
    });
    input.hands.navigate = vi.fn(input.hands.navigate);
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "select", args: { ref: "c0", option: "Yes" } },
        { name: "type", args: { ref: "c1", text: "Two weeks" } },
        { name: "finish", args: { reason: "Answers saved" } },
        { name: "click", args: { ref: "a0" } },
        { name: "finish", args: { reason: "At Review" } },
      ]),
    );
    expect(result.outcome).toBe("prepared");
    expect(source.controls.map((control) => control.value)).toEqual([
      "Yes",
      "Two weeks",
    ]);
    expect(source.stepLabel).toBe("Step 4 of 4");
    expect(input.hands.navigate).not.toHaveBeenCalled();
    expect(input.hands.clickElement).toHaveBeenCalledTimes(1);
  });

  test("allows another fill when a receipt succeeded but the live field cleared", async () => {
    const source = page({ controls: [{ ...nameControl(), value: "" }] });
    const input = config(source);
    let writes = 0;
    input.hands.fillText = vi.fn((_ref: string, value: string) => {
      if (++writes === 2) source.controls[0].value = value;
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "finish", args: { reason: "Ready" } },
        { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
        { name: "finish", args: { reason: "Ready" } },
      ]),
    );
    expect(writes).toBe(2);
    expect(result.outcome).toBe("prepared");
  });

  test("a repeated finish on an early step remains a resumable blocker", async () => {
    const source = page({ stepLabel: "Step 3 of 4" });
    const modelReason = "I stopped on the saved questions page as requested.";
    const chatWithTools = vi.fn(
      scriptedModel([
        { name: "finish", args: { reason: "The current step is filled" } },
        { name: "finish", args: { reason: modelReason } },
      ]).chatWithTools,
    );
    const result = await runApplyAgent(config(source), { chatWithTools });
    expect(result.outcome).toBe("paused");
    expect(result.readyToSend).toBeNull();
    expect(result.reason).toContain("another step");
    expect(result.modelTurns).toBe(2);
    expect(
      chatWithTools.mock.calls
        .at(-1)![0]
        .filter(
          (message) =>
            message.role === "tool" &&
            message.content?.startsWith("This form has another step"),
        ),
    ).toHaveLength(1);
  });

  test("adds and fills a known role using the approved month before continuing to Review", async () => {
    const source = experiencePage();
    const input = withExperience(source);
    input.hands.clickElement = (ref) => {
      if (ref === "a0")
        source.controls = [
          {
            ...nameControl(),
            index: 0,
            label: "Job title",
            groupLabel: "Work experience 2",
            value: "",
          },
          {
            ...nameControl(),
            index: 1,
            label: "Company",
            groupLabel: "Work experience 2",
            value: "",
          },
          {
            ...nameControl(),
            index: 2,
            label: "From",
            groupLabel: "Work experience 2",
            inputType: "month",
            value: "",
          },
        ];
      else {
        source.controls = [];
        source.headings = [{ level: 2, text: "Review" }];
        source.stepLabel = "Step 4 of 4";
        source.actions = [
          {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
          },
        ];
      }
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    };
    const filled: string[] = [];
    input.hands.fillText = (ref, value) => {
      source.controls[Number(ref.slice(1))].value = value;
      filled.push(value);
      return Promise.resolve({ ok: true as const, observedValue: value });
    };
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "finish", args: { reason: "PDF attached" } },
        { name: "click", args: { ref: "a0" } },
        { name: "type", args: { ref: "c0", text: "Engineer" } },
        { name: "type", args: { ref: "c1", text: "Signal Systems" } },
        { name: "type", args: { ref: "c2", text: "2014-01" } },
        { name: "click", args: { ref: "a1" } },
        { name: "finish", args: { reason: "At Review" } },
      ]),
    );
    expect(filled).toEqual(["Engineer", "Signal Systems", "2014-01"]);
    expect(result.outcome).toBe("prepared");
  });
});

test.each(["Yes", "No"])(
  "the review retains contacts across steps and records the selected radio (%s)",
  async (answer) => {
    const source = page({
      actions: [{ index: 0, label: "Next", visible: true, disabled: false }],
      stepLabel: "Step 1 of 2",
    });
    const runConfig = config(source);
    runConfig.sources.reusableAnswers = [
      {
        id: "one_use",
        kind: "other",
        roleFamilies: [],
        proofEntryIds: [],
        question: "Are you legally authorized to work in Germany?",
        answer,
        label: "Authorization",
      },
    ];
    runConfig.hands.clickElement = () => {
      source.controls = [
        {
          ...workAuthorizationRadio(0, "Yes"),
          groupLabel: "Are you legally authorized to work in Germany?",
        },
        {
          ...workAuthorizationRadio(1, "No"),
          groupLabel: "Are you legally authorized to work in Germany?",
        },
      ];
      source.stepLabel = "Step 2 of 2";
      source.actions = [];
      return Promise.resolve({ ok: true, observedValue: "next" });
    };
    runConfig.hands.setToggle = (ref, checked) => {
      source.controls[ref === "c0" ? 0 : 1].checked = checked;
      return Promise.resolve({ ok: true, observedValue: "checked" });
    };
    const result = await runApplyAgent(
      runConfig,
      scriptedModel([
        { name: "click", args: { ref: "a0" } },
        {
          name: "set_checkbox",
          args: { ref: answer === "Yes" ? "c0" : "c1", checked: true },
        },
        { name: "finish", args: { reason: "Ready for review." } },
      ]),
    );
    expect(
      result.reviewFilled?.find((entry) => entry.label === "Full name")?.answer
        .value,
    ).toBe("Robin Ashford");
    expect(
      result.reviewFilled?.find(
        (entry) =>
          entry.label === "Are you legally authorized to work in Germany?",
      )?.answer,
    ).toMatchObject({
      value: answer,
      provenanceLabel: "your answer to this question",
    });
  },
);

test("whenever there is room cannot finish with an empty optional cover-letter upload", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        inputType: "file",
        label: "Cover letter",
        value: "",
        required: false,
      },
    ],
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
  });
  const runConfig = config(source, {
    writing: {
      coverLetterPolicy: "when_possible",
      writtenAnswerLength: "short",
      preApprovedDeclarations: [],
    },
  });
  let provided = 0;
  runConfig.letters = {
    preference: {
      tone: "plain_professional",
      length: "standard",
      language: null,
      sample: null,
    },
    provide: () => {
      provided += 1;
      return Promise.resolve({
        ok: true,
        text: "Dear Hiring Team, I am applying for this role. My experience building dependable platforms and internal tools would support your team. I would welcome the opportunity to discuss the role and learn more about your priorities. Thank you for your consideration.",
        document: {
          id: "letter",
          kind: "cover_letter",
          label: "Cover letter",
          fileName: "letter.pdf",
          mimeType: "application/pdf",
          loadBytes: () => Promise.resolve(new Uint8Array([1])),
        },
      });
    },
  };
  runConfig.hands.uploadFile = (_ref, file) => {
    source.controls[0].value = file.name;
    return Promise.resolve({ ok: true, observedValue: file.name });
  };
  const result = await runApplyAgent(
    runConfig,
    scriptedModel([
      { name: "finish", args: { reason: "Done." } },
      { name: "upload", args: { ref: "c0", documentId: "letter" } },
      { name: "finish", args: { reason: "Done." } },
    ]),
  );
  expect(provided).toBe(1);
  expect(result.reviewAttachments).toHaveLength(1);
  expect(result.reviewAttachments?.[0]?.fileName).toBe("letter.pdf");
  expect(result.reviewAttachments?.[0]?.reviewText?.text).toContain(
    "Dear Hiring Team",
  );
  expect(result.outcome).toBe("prepared");
});

test("a retry replaces the retained original before handing back missing files", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        inputType: "file",
        label: "Resume",
        value: "original.docx",
      },
      {
        ...nameControl(),
        index: 1,
        inputType: "file",
        label: "Transcript",
        value: "",
      },
    ],
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
  });
  const runConfig = config(source);
  runConfig.sources.documents = [
    {
      id: "approved-resume",
      kind: "resume",
      label: "Your CV",
      fileName: "approved.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    },
  ];
  runConfig.hands.uploadFile = (_ref, file) => {
    source.controls[0].value = file.name;
    return Promise.resolve({ ok: true, observedValue: file.name });
  };
  const result = await runApplyAgent(
    runConfig,
    scriptedModel([
      {
        name: "finish",
        args: {
          reason: "The transcript needs the person.",
          needsPerson: true,
          stuck: true,
        },
      },
      { name: "upload", args: { ref: "c0", documentId: "approved-resume" } },
      {
        name: "finish",
        args: { reason: "The transcript needs the person.", needsPerson: true },
      },
    ]),
  );
  expect(source.controls[0].value).toBe("approved.pdf");
  expect(
    result.reviewAttachments?.map((attachment) => attachment.fileName),
  ).toEqual(["approved.pdf"]);
  expect(result.outcome).toBe("paused");
  expect(
    result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .map((question) => question.prompt),
  ).toContain("Transcript");
});

test("a resume a widget took and emptied stays on the Ready card once the storage confirmed it", async () => {
  const source = page({
    controls: [
      { ...nameControl(), inputType: "file", label: "Resume", value: "" },
    ],
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
  });
  const runConfig = config(source);
  runConfig.sources.documents = [
    {
      id: "approved-resume",
      kind: "resume",
      label: "Your CV",
      fileName: "approved.pdf",
      mimeType: "application/pdf",
      loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    },
  ];
  let reads = 0;
  const observe = runConfig.hands.observe;
  runConfig.hands.observe = () => {
    // The storage answers a moment after the upload: pending, then its
    // receipt.
    reads += 1;
    if (source.controls[0].upload && reads > 2)
      source.controls[0].upload.network = "accepted";
    return observe();
  };
  runConfig.hands.uploadFile = (_ref, file) => {
    // Greenhouse: the input is emptied, the page shows no chip, and the
    // storage's receipt is all that says the file arrived.
    reads = 0;
    source.controls[0].value = "";
    source.controls[0].upload = {
      described: "",
      nearby: "",
      shown: false,
      network: "pending",
    };
    return Promise.resolve({ ok: true, observedValue: file.name });
  };
  const result = await runApplyAgent(
    runConfig,
    scriptedModel([
      { name: "upload", args: { ref: "c0", documentId: "approved-resume" } },
      { name: "finish", args: { reason: "Filled in." } },
    ]),
  );
  expect(
    result.reviewAttachments?.map((attachment) => attachment.fileName),
  ).toEqual(["approved.pdf"]);
  expect(result.pauses).toEqual([]);
});

test("an optional letter the run cannot attach is noted, never a stop", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        inputType: "file",
        label: "Cover letter",
        value: "",
        required: false,
      },
    ],
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
  });
  const result = await runApplyAgent(
    config(source, {
      writing: {
        coverLetterPolicy: "when_possible",
        writtenAnswerLength: "short",
        preApprovedDeclarations: [],
      },
    }),
    scriptedModel([
      { name: "finish", args: { reason: "Done." } },
      { name: "finish", args: { reason: "Done." } },
    ]),
  );
  expect(result.outcome).not.toBe("paused");
  expect(result.pauses).toHaveLength(0);
  expect(result.notes.join(" ")).toContain(
    'Left "Cover letter" empty: Job Finder could not attach a letter there.',
  );
});

test.each([
  ["Summary", "summary"],
  ["Headline", "headline"],
] as const)(
  "the literal %s field still uses its exact Profile text without a writing check",
  async (label, key) => {
    const source = page({
      controls: [{ ...nameControl(), label, groupLabel: label, value: "" }],
    });
    const input = config(source);
    const text = input.sources.profile[key];
    if (!text) throw new Error("The synthetic Profile text is missing.");
    const model = scriptedModel([
      {
        name: "fill_fields",
        args: { fields: [{ tool: "type", ref: "c0", text }] },
      },
      {
        name: "finish",
        args: { reason: "The literal Profile field is filled." },
      },
    ]);
    const calls = vi.spyOn(model, "chatWithTools");
    const fill = vi.spyOn(input.hands, "fillText");
    const finalPress = vi.spyOn(input.hands, "clickAction");
    const result = await runApplyAgent(input, model);
    expect(result.outcome).toBe("prepared");
    expect(fill).toHaveBeenCalledExactlyOnceWith("c0", text);
    expect(
      calls.mock.calls.some(
        ([, definitions]) =>
          definitions[0]?.function.name === "report_answer_checks",
      ),
    ).toBe(false);
    expect(finalPress).not.toHaveBeenCalled();
  },
);

test("fill_fields fills a page in one step with one fact check for the answers that need it", async () => {
  const text = (index: number, label: string): RawApplyControl => ({
    ...nameControl(),
    index,
    id: `f${index}`,
    name: `f${index}`,
    label,
    value: "",
  });
  const source = page({
    controls: [
      text(0, "Full name"),
      text(1, "Describe your platform experience"),
      {
        ...text(2, "Country"),
        tagName: "select",
        inputType: "select-one",
        options: ["Germany", "United Kingdom"],
      },
    ],
  });
  const written = new Map<string, string>();
  const base = hands(source);
  const answered = (ref: string, value: string) => {
    written.set(ref, value);
    const index = Number(ref.slice(1));
    source.controls = source.controls.map((control) =>
      control.index === index
        ? {
            ...control,
            value,
            selectedOptionLabel: control.options.length ? value : "",
          }
        : control,
    );
    return Promise.resolve({ ok: true as const, observedValue: value });
  };
  let checkCalls = 0;
  let checkedAnswers: unknown[] = [];
  const input = config(source, {
    hands: { ...base, fillText: answered, chooseOption: answered },
  });
  input.sources.profile.summary = "I build dependable internal tools.";
  let turns = 0;
  const model: LLMClient = {
    chatWithTools: (messages, definitions) => {
      if (definitions[0]?.function.name === "report_answer_checks") {
        checkCalls += 1;
        checkedAnswers = (
          JSON.parse(String(messages[1]?.content)) as { answers: unknown[] }
        ).answers;
        return Promise.resolve({
          toolCalls: [
            {
              id: "check",
              type: "function" as const,
              function: {
                name: "report_answer_checks",
                arguments: JSON.stringify({
                  checks: checkedAnswers.map((raw, index) => ({
                    index,
                    supported: true,
                    reason: "Supported.",
                    evidence: flowEvidence(
                      (
                        JSON.parse(String(messages[1]?.content)) as {
                          applicant: Record<string, unknown>;
                        }
                      ).applicant,
                      raw as { question: string; proposedAnswer: string },
                    ),
                  })),
                }),
              },
            },
          ],
        });
      }
      turns += 1;
      const call =
        turns === 1
          ? {
              name: "fill_fields",
              args: {
                fields: [
                  { tool: "type", ref: "c0", text: "Robin Ashford" },
                  {
                    tool: "type",
                    ref: "c1",
                    text: "I build dependable internal tools.",
                  },
                  { tool: "select", ref: "c2", option: "united kingdom" },
                ],
              },
            }
          : { name: "finish", args: { reason: "Filled in." } };
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${turns}`,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ],
      });
    },
  };

  const result = await runApplyAgent(input, model);

  expect(turns).toBe(2);
  // The stored name needs no check; the prose and the country are checked
  // together in one call.
  expect(checkCalls).toBe(1);
  expect(checkedAnswers).toHaveLength(2);
  expect(written.get("c0")).toBe("Robin Ashford");
  expect(written.get("c2")).toBe("United Kingdom");
  expect(result.filled.map((entry) => entry.label)).toEqual([
    "Full name",
    "Describe your platform experience",
    "Country",
  ]);
  expect(result.outcome).toBe("prepared");
});

describe("apply readiness regressions", () => {
  test("collects every visible required eligibility question in one handoff", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          label: "Will you need visa sponsorship?",
          value: "",
          index: 0,
        },
        {
          ...nameControl(),
          label: "Are you willing to relocate?",
          value: "",
          index: 1,
        },
      ],
    });
    const result = await runApplyAgent(
      config(source),
      scriptedModel([
        { name: "finish", args: { reason: "Needs answers" } },
        { name: "finish", args: { reason: "Needs answers" } },
      ]),
    );
    expect(result.outcome).toBe("paused");
    expect(
      result.pauses[0]?.questions?.map((question) => question.prompt),
    ).toEqual([
      "Will you need visa sponsorship?",
      "Are you willing to relocate?",
    ]);
    expect(result.readyToSend).toBeNull();
  });

  test("a skills group marked required in its legend appears as one multi-choice question", async () => {
    const source = page({
      controls: ["Analysis", "Coordination"].map((label, index) => ({
        ...nameControl(),
        index,
        inputType: "checkbox",
        name: "skills",
        label,
        groupLabel: "Select your skills *",
        required: false,
        value: label,
      })),
    });
    const model = scriptedModel([
      { name: "finish", args: { reason: "Done" } },
      { name: "finish", args: { reason: "Done" } },
    ]);
    const result = await runApplyAgent(
      config(source, { modelQuestionClassification: true }),
      {
        chatWithTools: (messages, tools, options) =>
          tools[0]?.function.name === "report_question_kinds"
            ? Promise.resolve({
                toolCalls: [
                  {
                    id: "kinds",
                    type: "function" as const,
                    function: {
                      name: "report_question_kinds",
                      arguments: JSON.stringify({
                        tags: [
                          {
                            index: 0,
                            kind: "other",
                            country: null,
                            sourceId: null,
                          },
                        ],
                        questions: [
                          {
                            index: 0,
                            required: true,
                            asksAboutPay: false,
                            asksCurrentPay: false,
                            declarationKind: null,
                          },
                        ],
                      }),
                    },
                  },
                ],
              })
            : model.chatWithTools(messages, tools, options),
      },
    );
    expect(result.outcome).toBe("paused");
    // One question reading plus the one last-chance answer match.
    expect(result.timing?.auxiliaryModelCalls).toBe(2);
    expect(result.pauses[0]?.questions).toHaveLength(1);
    expect(result.pauses[0]?.question).toMatchObject({
      prompt: "Select your skills *",
      answerControlType: "multi_choice",
      answerOptions: ["Analysis", "Coordination"],
    });
  });

  test("a refused required declaration waits for its answer before another wizard step", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "checkbox",
          label: "I consent to a background check",
          value: "",
          checked: false,
        },
      ],
    });
    const input = config(source);
    input.hands.clickElement = vi.fn(() => {
      source.controls = [
        { ...nameControl(), label: "Are you willing to relocate?", value: "" },
      ];
      return Promise.resolve({ ok: true as const, observedValue: "next" });
    });
    source.actions = [
      { index: 0, label: "Next", visible: true, disabled: false },
    ];
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "set_checkbox", args: { ref: "c0", checked: true } },
        { name: "click", args: { ref: "a0" } },
        { name: "finish", args: { reason: "Needs relocation" } },
        { name: "finish", args: { reason: "Needs relocation" } },
      ]),
    );
    expect(
      result.pauses
        .flatMap((pause) => pause.questions ?? [])
        .map((question) => question.prompt),
    ).toEqual(["I consent to a background check"]);
    expect(input.hands.clickElement).not.toHaveBeenCalled();
  });

  test("missing candidate facts remain a resumable handoff after the model reports stuck", async () => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          label: "Coordination experience",
          value: "",
          invalid: true,
          validationMessage: "Please fill out this field.",
        },
      ],
    });
    const result = await runApplyAgent(
      config(source),
      scriptedModel([
        {
          name: "finish",
          args: {
            reason: "I cannot answer coordination experience",
            stuck: true,
          },
        },
        {
          name: "finish",
          args: {
            reason: "I cannot answer coordination experience",
            stuck: true,
          },
        },
      ]),
    );
    expect(result.outcome).toBe("paused");
    expect(result.pauses[0]?.question?.prompt).toBe("Coordination experience");
    expect(result.pauses[0]?.question?.note).toBeUndefined();
  });
});

test("the final form read preserves a person's edited answer and newly filled portfolio", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        label: "Motivation",
        inputType: "text",
        value: "Old English answer",
        required: true,
      },
      {
        ...nameControl(),
        index: 1,
        label: "Portfolio",
        inputType: "url",
        value: "",
        required: true,
      },
    ],
  });
  const input = config(source);
  input.hands.scroll = () => {
    source.controls[0].value =
      "Je souhaite contribuer à cette équipe avec mon expérience.";
    source.controls[1].value = "https://synthetic.example/portfolio";
    return Promise.resolve({ ok: true, observedValue: "down" });
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "scroll", args: { direction: "down" } },
      { name: "finish", args: { reason: "Reviewed" } },
    ]),
  );
  expect(result.outcome).toBe("prepared");
  expect(
    result.reviewFilled?.find((entry) => entry.label === "Motivation")?.answer
      .value,
  ).toBe(source.controls[0].value);
  expect(
    result.reviewFilled?.find((entry) => entry.label === "Portfolio")?.answer
      .value,
  ).toBe("https://synthetic.example/portfolio");
  expect(result.pauses).toEqual([]);
});

test("the current form review names every selected skill in a checkbox group", async () => {
  const source = page({
    controls: ["Analysis", "Coordination"].map((label, index) => ({
      ...nameControl(),
      index,
      inputType: "checkbox",
      name: "skills",
      groupLabel: "Select your skills",
      label,
      value: label,
      checked: true,
      required: false,
    })),
  });
  const result = await runApplyAgent(
    config(source),
    scriptedModel([{ name: "finish", args: { reason: "Reviewed" } }]),
  );
  expect(
    result.reviewFilled?.filter(
      (entry) => entry.label === "Select your skills",
    ),
  ).toHaveLength(1);
  expect(
    result.reviewFilled?.find((entry) => entry.label === "Select your skills")
      ?.answer.value,
  ).toBe("Analysis, Coordination");
});

test("a required letter pause collects the other visible questions and explains Never", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        index: 0,
        inputType: "file",
        label: "Cover letter upload *",
        groupLabel: "Application",
        value: "",
      },
      { ...nameControl(), index: 1, label: "Portfolio URL", value: "" },
      {
        ...nameControl(),
        index: 2,
        inputType: "checkbox",
        label: "I consent to a background check",
        value: "",
        checked: false,
      },
    ],
  });
  const input = config(source);
  input.writing = {
    coverLetterPolicy: "never",
    writtenAnswerLength: "full",
    preApprovedDeclarations: [],
  };
  input.letters = {
    preference: {
      tone: "plain_professional",
      length: "short",
      language: null,
      sample: null,
    },
    provide: () => Promise.resolve({ ok: false, reason: "Disabled" }),
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "upload", args: { ref: "c0", documentId: "letter" } },
    ]),
  );
  const questions = result.pauses.flatMap(
    (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
  );
  expect(questions.map((question) => question.prompt)).toEqual([
    "Cover letter",
    "Portfolio URL",
    "I consent to a background check",
  ]);
  expect(questions[0]?.note).toContain("Never");
});

test("the answer provenance instructions name plain sources for the send review", () => {
  const prompt = createApplySystemPrompt(config(page()));
  expect(prompt).toContain("your saved expected salary");
  expect(prompt).toContain("your resume");
  expect(prompt).toContain(
    "Do not put fact keys, record IDs, arrows, or extraction steps there.",
  );
});

test("finish accepts the unchanged TXT copy of the selected Markdown resume", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        inputType: "file",
        label: "Resume",
        value: "resume.txt",
      },
    ],
  });
  const input = config(source);
  input.sources.documents = [
    {
      id: "original",
      kind: "resume",
      label: "Original resume",
      fileName: "resume.md",
      mimeType: "text/markdown",
      loadBytes: () => Promise.resolve(new Uint8Array([1])),
    },
  ];
  const result = await runApplyAgent(
    input,
    repeatingModel("finish", { reason: "Complete" }),
  );
  expect(result.pauses).toEqual([]);
  expect(result.outcome).toBe("prepared");
});
test("a filled invalid answer gets plain guidance instead of the browser validation string", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        label: "Years",
        inputType: "number",
        value: "99",
        invalid: true,
        validationMessage: "Range overflow",
      },
    ],
  });
  const result = await runApplyAgent(
    config(source),
    repeatingModel("finish", {
      reason: "Cannot settle the years",
      stuck: true,
    }),
  );
  expect(result.pauses[0]?.question?.note).toBe(
    "The site did not accept this value. Check it and try again.",
  );
});

test("Full written answers ask for supported specifics within the available limit", () => {
  const input = config(page());
  input.writing = {
    coverLetterPolicy: "when_required",
    writtenAnswerLength: "full",
    preApprovedDeclarations: [],
  };
  const full = createApplySystemPrompt(input);
  input.writing.writtenAnswerLength = "short";
  const short = createApplySystemPrompt(input);
  expect(full).toContain("70–90%");
  expect(full).toContain("no character limit");
  expect(full).toContain("four to six developed sentences");
  expect(full).toContain("100–160 words");
  expect(full).toContain("meaningfully more developed");
  expect(short).toContain("one or two direct sentences");
  expect(full).toContain("concrete supported achievement");
  expect(full).toContain("specific need in this job");
  expect(full).toContain("Never invent a metric");
  expect(short).not.toContain("70–90%");
});

describe("response batches", () => {
  const textField = (index: number, label: string): RawApplyControl => ({
    ...nameControl(),
    index,
    id: `f${index}`,
    name: `f${index}`,
    label,
    value: "",
  });
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });

  test("executes all writes in order through policy, then supplies one page update", async () => {
    const source = page({
      controls: [textField(0, "Full name"), textField(1, "Email")],
    });
    const input = config(source);
    input.sources.profile.email = "robin@example.test";
    const writes: string[] = [];
    input.hands.fillText = (ref, value) => {
      writes.push(ref);
      source.controls[Number(ref.slice(1))].value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    let turns = 0;
    let nextMessages: Parameters<LLMClient["chatWithTools"]>[0] = [];
    const result = await runApplyAgent(input, {
      chatWithTools: (messages, _tools, options) => {
        expect(options?.parallelToolCalls).toBe(true);
        turns += 1;
        if (turns === 1)
          return Promise.resolve({
            toolCalls: [
              call("name", "type", { ref: "c0", text: "Robin Ashford" }),
              call("email", "type", { ref: "c1", text: "robin@example.test" }),
            ],
          });
        nextMessages = structuredClone(messages);
        return Promise.resolve({
          toolCalls: [call("done", "finish", { reason: "Filled in." })],
        });
      },
    });
    expect(writes).toEqual(["c0", "c1"]);
    const results = nextMessages.filter((message) => message.role === "tool");
    expect(results).toHaveLength(2);
    expect(
      results.every((message) => !String(message.content).includes("Fields:")),
    ).toBe(true);
    expect(
      nextMessages.filter((message) =>
        String(message.content).includes("The page after your batch:"),
      ),
    ).toHaveLength(1);
    expect(result.filled).toHaveLength(2);
    expect(result.timing?.modelTurns).toBe(2);
    expect(result.timing?.pageReads).toBe(7); // initial, two safety reads per write, batch, finish
  });

  test("a refusal stops later calls and never bypasses the executor", async () => {
    const source = page({
      controls: [textField(0, "Full name"), textField(1, "Email")],
    });
    const input = config(source);
    input.hands.fillText = vi.fn(input.hands.fillText);
    let turn = 0;
    const result = await runApplyAgent(input, {
      chatWithTools: () => {
        turn += 1;
        return Promise.resolve({
          toolCalls:
            turn === 1
              ? [
                  call("bad", "type", {
                    ref: "missing",
                    text: "Robin Ashford",
                  }),
                  call("later", "type", {
                    ref: "c1",
                    text: "robin@example.test",
                  }),
                ]
              : [call("done", "finish", { reason: "Blocked.", stuck: true })],
        });
      },
    });
    expect(input.hands.fillText).not.toHaveBeenCalled();
    expect(result.filled).toHaveLength(0);
    expect(result.timing?.modelTurns).toBeGreaterThanOrEqual(2);
  });

  test("fill_fields stops at a refusal before later entries", async () => {
    const source = page({ controls: [textField(0, "Full name")] });
    const input = config(source);
    input.hands.fillText = vi.fn(input.hands.fillText);
    let turn = 0;
    await runApplyAgent(input, {
      chatWithTools: () =>
        Promise.resolve({
          toolCalls:
            ++turn === 1
              ? [
                  call("fields", "fill_fields", {
                    fields: [
                      { tool: "type", ref: "missing", text: "Robin Ashford" },
                      { tool: "type", ref: "c0", text: "Robin Ashford" },
                    ],
                  }),
                ]
              : [call("done", "finish", { reason: "Blocked.", stuck: true })],
        }),
    });
    expect(input.hands.fillText).not.toHaveBeenCalled();
  });

  test("a revealed field stops the remaining calls until the model sees it", async () => {
    const source = page({
      controls: [textField(0, "Full name"), textField(1, "Email")],
    });
    const input = config(source);
    input.sources.profile.email = "robin@example.test";
    const writes: string[] = [];
    input.hands.fillText = (ref, value) => {
      writes.push(ref);
      source.controls[Number(ref.slice(1))].value = value;
      source.controls.push(textField(2, "New required question"));
      return Promise.resolve({ ok: true, observedValue: value });
    };
    let turn = 0;
    await runApplyAgent(input, {
      chatWithTools: () =>
        Promise.resolve({
          toolCalls:
            ++turn === 1
              ? [
                  call("name", "type", { ref: "c0", text: "Robin Ashford" }),
                  call("later", "type", {
                    ref: "c1",
                    text: "robin@example.test",
                  }),
                ]
              : [
                  call("done", "finish", {
                    reason: "Needs answers.",
                    stuck: true,
                  }),
                ],
        }),
    });
    expect(writes).toEqual(["c0"]);
  });

  test("persists measurements even when the provider throws", async () => {
    const onTiming = vi.fn();
    await expect(
      runApplyAgent(config(page(), { onTiming }), {
        chatWithTools: () => {
          return Promise.reject(new Error("Unavailable"));
        },
      }),
    ).rejects.toThrow("Unavailable");
    expect(onTiming).toHaveBeenCalledWith(
      expect.objectContaining({ modelTurns: 1, pageReads: 1 }),
    );
  });
});

test("one response can enter contact facts, tick an approved declaration and attach the selected resume", async () => {
  const source = page({
    controls: [
      { ...nameControl(), value: "" },
      {
        ...nameControl(),
        index: 1,
        id: "truth",
        name: "truth",
        inputType: "checkbox",
        label: "I certify that the information is true",
        value: "on",
        checked: false,
      },
      {
        ...nameControl(),
        index: 2,
        id: "resume",
        name: "resume",
        inputType: "file",
        label: "Resume / CV",
        value: "",
      },
    ],
  });
  const input = config(source);
  input.authority.preApprovedAttestationKinds = ["truthfulness_certification"];
  input.sources.documents = [
    {
      id: "synthetic_resume",
      fileName: "synthetic.pdf",
      mimeType: "application/pdf",
      label: "Synthetic CV",
      kind: "resume",
      loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    },
  ];
  const writes: string[] = [];
  input.hands.fillText = (ref, value) => {
    writes.push(ref);
    source.controls[0].value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  };
  input.hands.setToggle = (ref, checked) => {
    writes.push(ref);
    source.controls[1].checked = checked;
    return Promise.resolve({
      ok: true,
      observedValue: checked ? "checked" : "unchecked",
    });
  };
  input.hands.uploadFile = (ref, file) => {
    writes.push(ref);
    source.controls[2].value = file.name;
    return Promise.resolve({ ok: true, observedValue: file.name });
  };
  let turns = 0;
  let updates = 0;
  const result = await runApplyAgent(input, {
    chatWithTools: (messages) => {
      turns += 1;
      if (turns > 1)
        updates = messages.filter((message) =>
          String(message.content).startsWith("The page after your batch:"),
        ).length;
      const entries =
        turns === 1
          ? [
              { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
              { name: "set_checkbox", args: { ref: "c1", checked: true } },
              {
                name: "upload",
                args: { ref: "c2", documentId: "synthetic_resume" },
              },
            ]
          : [{ name: "finish", args: { reason: "Filled in." } }];
      return Promise.resolve({
        toolCalls: entries.map((entry, index) => ({
          id: `${turns}_${index}`,
          type: "function" as const,
          function: { name: entry.name, arguments: JSON.stringify(entry.args) },
        })),
      });
    },
  });
  expect(writes).toEqual(["c0", "c1", "c2"]);
  expect(result.filled).toHaveLength(2);
  expect(result.attachments).toHaveLength(1);
  expect(turns).toBe(2);
  expect(updates).toBe(1);
});

test("in Fill a Continue link is handed to the person, never followed; the form's own address opens", async () => {
  const source = page({
    links: [
      {
        index: 0,
        label: "Continue",
        href: "https://apply.example.test/api/submit?applicationId=42",
        target: "",
        visible: true,
        topOffset: 10,
      },
    ],
  });
  const input = config(source, { intermediateWritesAuthorized: false });
  const followLink = vi.fn(input.hands.followLink);
  const navigate = vi.fn(input.hands.navigate);
  input.hands.followLink = followLink;
  input.hands.navigate = navigate;
  const result = await runApplyAgent(
    input,
    scriptedModel([
      {
        name: "navigate",
        args: { url: "https://apply.example.test/form" },
      },
      { name: "follow_link", args: { ref: "l0" } },
      { name: "finish", args: { reason: "Filled." } },
    ]),
  );
  expect(navigate).toHaveBeenCalledOnce();
  expect(followLink).not.toHaveBeenCalled();
  expect(result.pauses[0]?.summary).toContain('Press "Continue" on the site');
});

describe("fill_fields visible steps", () => {
  const field = (index: number, label: string): RawApplyControl => ({
    ...nameControl(),
    index,
    id: `f${index}`,
    name: `f${index}`,
    label,
    value: "",
    required: false,
  });
  const call = (name: string, args: Record<string, unknown>, id = name) => ({
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  function writable(source: RawApplyPage) {
    const input = config(source);
    const writes: string[] = [];
    const write = (ref: string, value: string) => {
      writes.push(ref);
      const target = source.controls[Number(ref.slice(1))];
      target.value = value;
      if (target.options.length) target.selectedOptionLabel = value;
      return Promise.resolve({ ok: true as const, observedValue: value });
    };
    input.hands.fillText = write;
    input.hands.chooseOption = write;
    input.hands.setToggle = (ref, checked) => {
      writes.push(ref);
      source.controls[Number(ref.slice(1))].checked = checked;
      return Promise.resolve({
        ok: true,
        observedValue: checked ? "checked" : "unchecked",
      });
    };
    return { input, writes };
  }
  function modelFor(
    fields: FillFieldsEntry[],
    onNext: (
      messages: Parameters<LLMClient["chatWithTools"]>[0],
    ) => void = () => {},
    thenContinue?: string,
  ) {
    let turn = 0;
    return {
      chatWithTools: (messages, definitions) => {
        const check = supportedChecks(messages, definitions);
        if (check) return check;
        turn += 1;
        if (turn > 1) onNext(messages);
        return Promise.resolve({
          toolCalls: [
            turn === 1
              ? call("fill_fields", {
                  fields,
                  ...(thenContinue ? { thenContinue } : {}),
                })
              : call(
                  "finish",
                  { reason: "Finished the fields I could answer." },
                  `done_${turn}`,
                ),
          ],
        });
      },
    } satisfies LLMClient;
  }

  test("Workday in Fill: fills My Information, hands Save and continue to the person, and sends nothing", async () => {
    const source = page({
      stepLabel: "1. My Information",
      controls: [
        field(0, "First name"),
        field(1, "Last name"),
        field(2, "City"),
      ],
      actions: [
        {
          index: 0,
          label: "Save and continue",
          visible: true,
          disabled: false,
        },
      ],
    });
    const { input, writes } = writable(source);
    input.intermediateWritesAuthorized = false;
    let pressed = 0;
    input.hands.clickElement = () => {
      // The site saves the page before it moves on; the fence refuses the
      // save, so the page stays where it is.
      pressed += 1;
      return Promise.resolve({ ok: true, observedValue: "clicked" });
    };
    let attempt: {
      kind: "network_request";
      method: string;
      url: string;
      at: string;
      carriedPreparedValue: boolean;
    } | null = null;
    const click = input.hands.clickElement;
    input.hands.clickElement = async (ref) => {
      const result = await click(ref);
      attempt = {
        kind: "network_request",
        method: "POST",
        url: "https://apply.example.test/workday/api/save",
        at: `2026-10-26T10:00:0${pressed}.000Z`,
        carriedPreparedValue: true,
      };
      return result;
    };
    input.safety = {
      readBlockedAttempt: () => {
        const next = attempt;
        attempt = null;
        return Promise.resolve(next);
      },
      registerPreparedValue: () => Promise.resolve(),
      openIntermediateWriteWindow: () => Promise.resolve(),
      closeIntermediateWriteWindow: () => Promise.resolve(),
      closeUploadWindow: () => Promise.resolve(),
      checkServiceWorker: () => Promise.resolve(null),
    };
    // A model that would press "Save and continue" forever if let.
    let calls = 0;
    const model = {
      chatWithTools: (messages, definitions) => {
        const check = supportedChecks(messages, definitions);
        if (check) return check;
        calls += 1;
        return Promise.resolve({
          toolCalls: [
            call(
              "fill_fields",
              {
                fields: [
                  { tool: "type", ref: "c0", text: "Robin" },
                  { tool: "type", ref: "c1", text: "Ashford" },
                  // The profile's own city: the answer gate needs a source.
                  { tool: "type", ref: "c2", text: "Manchester" },
                ],
                thenContinue: "a0",
              },
              `fill_${calls}`,
            ),
          ],
        });
      },
    } satisfies LLMClient;
    const result = await runApplyAgent(input, model);
    expect(writes.slice(0, 3)).toEqual(["c0", "c1", "c2"]);
    // Fill never presses the form's own buttons; the person does.
    expect(pressed).toBe(0);
    expect(calls).toBeLessThanOrEqual(8);
    expect(result.pauses).toHaveLength(1);
    expect(result.pauses[0]?.blocker?.code).toBe("site_saves_as_you_go");
    expect(result.pauses[0]?.summary).toBe(
      'Job Finder filled what it could on this page. Press "Save and continue" on the site yourself, then continue and Job Finder fills the next page.',
    );
    // One Needs you item for this application: press it, then continue.
    expect(
      result.pauses[0]?.questions?.map((question) => question.prompt),
    ).toEqual(['Press "Save and continue" on the site, then continue']);
  });

  test.each([false, true])(
    "text batches settle once and retain only kept answers (clearing=%s)",
    async (clearing) => {
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
      });
      try {
        const source = page({
          controls: Array.from({ length: 6 }, (_, index) =>
            field(index, `Answer ${index}`),
          ),
          actions: [
            { index: 0, label: "Continue", visible: true, disabled: false },
          ],
        });
        const { input } = writable(source);
        const write = input.hands.fillText;
        input.hands.fillText = async (ref, value) => {
          const result = await write(ref, value);
          if (clearing && (ref === "c0" || ref === "c3"))
            setTimeout(
              () => {
                source.controls[Number(ref.slice(1))].value = "";
              },
              ref === "c0" ? 100 : 250,
            );
          return result;
        };
        const wait = vi.fn(
          (ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms)),
        );
        input.hands.wait = wait;
        const click = vi.fn(input.hands.clickElement);
        input.hands.clickElement = click;
        let report = "";
        const run = runApplyAgent(
          input,
          modelFor(
            source.controls.map((control) => ({
              tool: "type",
              ref: `c${control.index}`,
              text: "Robin Ashford",
            })),
            (messages) => {
              report = messages
                .filter((message) => message.role === "tool")
                .map((message) => message.content)
                .join("\n");
            },
            clearing ? "a0" : undefined,
          ),
        );
        await vi.runAllTimersAsync();
        const result = await run;
        expect(wait).toHaveBeenCalledTimes(1);
        expect(result.timing?.requests[0]?.fieldsFilled).toBe(clearing ? 4 : 6);
        expect(result.reviewFilled?.map((entry) => entry.ref).sort()).toEqual(
          clearing
            ? ["c1", "c2", "c4", "c5"]
            : ["c0", "c1", "c2", "c3", "c4", "c5"],
        );
        expect(result.filled.map((entry) => entry.ref).sort()).toEqual(
          clearing
            ? ["c1", "c2", "c4", "c5"]
            : ["c0", "c1", "c2", "c3", "c4", "c5"],
        );
        if (clearing) {
          expect(report).toContain('c0: "Answer 0": The field cleared');
          expect(report).toContain('c3: "Answer 3": The field cleared');
          expect(report).not.toContain('Filled in "Answer 0"');
          expect(report).not.toContain('Filled in "Answer 3"');
          expect(report).toContain("Continue was not pressed");
          expect(click).not.toHaveBeenCalled();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("single-field type still waits and rejects a delayed clear", async () => {
    vi.useFakeTimers();
    try {
      const source = page({ controls: [field(0, "Full name")] });
      const { input } = writable(source);
      const write = input.hands.fillText;
      input.hands.fillText = async (ref, value) => {
        const result = await write(ref, value);
        setTimeout(() => {
          source.controls[0].value = "";
        }, 250);
        return result;
      };
      input.hands.wait = vi.fn(
        (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      );
      const run = runApplyAgent(
        input,
        scriptedModel([
          { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
          {
            name: "finish",
            args: { reason: "The field needs a person.", needsPerson: true },
          },
        ]),
      );
      await vi.runAllTimersAsync();
      const result = await run;
      expect(input.hands.wait).toHaveBeenCalledExactlyOnceWith(300);
      expect(result.filled).toHaveLength(0);
      expect(result.timing?.requests[0]?.fieldsFilled).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("batch retention overlaps other value writes", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
    });
    try {
      const source = page({
        controls: [
          field(0, "Full name"),
          {
            ...field(1, "Country"),
            tagName: "select",
            options: ["United Kingdom"],
          },
        ],
      });
      const { input } = writable(source);
      const select = input.hands.chooseOption;
      input.hands.chooseOption = async (ref, value) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return select(ref, value);
      };
      input.hands.wait = vi.fn(
        (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      );
      const run = runApplyAgent(
        input,
        modelFor([
          { tool: "type", ref: "c0", text: "Robin Ashford" },
          { tool: "select", ref: "c1", option: "United Kingdom" },
        ]),
      );
      await vi.runAllTimersAsync();
      expect((await run).filled).toHaveLength(2);
      expect(input.hands.wait).toHaveBeenCalledExactlyOnceWith(100);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a send attempted during batch settling still triggers the existing guard before Continue", async () => {
    vi.useFakeTimers();
    try {
      const source = page({
        controls: [field(0, "Full name"), field(1, "Email")],
        actions: [
          { index: 0, label: "Continue", visible: true, disabled: false },
        ],
      });
      const { input } = writable(source);
      const write = input.hands.fillText;
      let attempted = false;
      input.hands.fillText = async (ref, value) => {
        const result = await write(ref, value);
        setTimeout(() => {
          attempted = true;
        }, 100);
        return result;
      };
      input.hands.wait = (ms) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms));
      input.safety = {
        readBlockedAttempt: () =>
          Promise.resolve(
            attempted
              ? {
                  kind: "dom_submit",
                  method: "POST",
                  url: source.url,
                  at: "2026-10-21T10:00:00.000Z",
                }
              : null,
          ),
        registerPreparedValue: () => Promise.resolve(),
        openIntermediateWriteWindow: () => Promise.resolve(),
        closeIntermediateWriteWindow: () => Promise.resolve(),
        checkServiceWorker: () => Promise.resolve(null),
      };
      const click = vi.fn(input.hands.clickElement);
      input.hands.clickElement = click;
      const run = runApplyAgent(
        input,
        modelFor(
          [
            { tool: "type", ref: "c0", text: "Robin Ashford" },
            { tool: "type", ref: "c1", text: "Robin Ashford" },
          ],
          undefined,
          "a0",
        ),
      );
      await vi.runAllTimersAsync();
      const result = await run;
      expect(result.pauses[0]?.code).toBe("site_tried_to_send");
      expect(click).not.toHaveBeenCalled();
      expect(result.filled).toHaveLength(0);
      expect(result.timing?.requests[0]?.fieldsFilled).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("six answerable steps including a first-step resume take six fill decisions and a finish", async () => {
    const source = page();
    let step = 1;
    const showStep = () => {
      source.stepLabel = `Step ${step} of 6`;
      source.controls = [
        field(0, "Full name"),
        field(1, "Email"),
        field(2, "City"),
      ].map((control) => ({ ...control, groupLabel: `Contact set ${step}` }));
      source.actions = [
        {
          index: 0,
          label: step < 6 ? "Continue" : "Submit application",
          visible: true,
          disabled: false,
        },
      ];
    };
    showStep();
    source.controls.push({
      ...field(3, "Resume / CV"),
      inputType: "file",
      required: true,
    });
    source.actions[0].disabled = true; // Upload enables this same Continue control.
    const { input, writes } = writable(source);
    input.sources.documents = [
      {
        id: "synthetic_resume",
        fileName: "synthetic.pdf",
        mimeType: "application/pdf",
        label: "Synthetic resume",
        kind: "resume",
        loadBytes: () => Promise.resolve(new Uint8Array([1, 2, 3])),
      },
    ];
    input.hands.uploadFile = vi.fn(
      (ref: string, file: Parameters<ApplyPageHands["uploadFile"]>[1]) => {
        expect(ref).toBe("c3");
        source.controls[3].value = file.name;
        source.actions[0].disabled = false;
        // A real upload commonly reveals a Remove button on the same step.
        source.actions.push({
          index: 1,
          label: "Remove file",
          visible: true,
          disabled: false,
        });
        return Promise.resolve({ ok: true as const, observedValue: file.name });
      },
    );
    input.sources.profile.email = "robin@example.test";
    const click = vi.fn(() => {
      step += 1;
      showStep();
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    });
    input.hands.clickElement = click;
    let turns = 0;
    const result = await runApplyAgent(input, {
      chatWithTools: (messages, definitions) => {
        const check = supportedChecks(messages, definitions);
        if (check) return check;
        turns += 1;
        if (turns === 1) {
          const firstPage = messages.at(-1)?.content;
          expect(firstPage).toContain("Step 1 of 6");
          expect(firstPage).toContain(
            "synthetic_resume: Synthetic resume (synthetic.pdf, application/pdf)",
          );
          expect(firstPage).toContain("no list call is needed");
        }
        if (turns > 1 && turns <= 6) {
          const report = messages
            .filter((message) => message.role === "tool")
            .at(-1)?.content;
          expect(report).toContain("Continue advanced to the next step.");
          expect(report).toContain(`Step ${step} of 6`);
          expect(report).toContain("The page after Continue:");
        }
        return Promise.resolve({
          toolCalls: [
            turns <= 6
              ? call(
                  "fill_fields",
                  {
                    fields: [
                      { tool: "type", ref: "c0", text: "Robin Ashford" },
                      { tool: "type", ref: "c1", text: "robin@example.test" },
                      { tool: "type", ref: "c2", text: "Manchester" },
                      ...(step === 1
                        ? [
                            {
                              tool: "upload",
                              ref: "c3",
                              documentId: "synthetic_resume",
                            },
                          ]
                        : []),
                    ],
                    ...(step < 6 ? { thenContinue: "a0" } : {}),
                  },
                  `step_${turns}`,
                )
              : call("finish", { reason: "All six steps are filled." }),
          ],
        });
      },
    });
    expect(result.outcome).toBe("prepared");
    expect(writes).toHaveLength(18);
    expect(click).toHaveBeenCalledTimes(5);
    expect(result.timing?.modelTurns).toBe(7);
    expect(input.hands.uploadFile).toHaveBeenCalledTimes(1);
    expect(result.attachments).toHaveLength(1);
    expect(
      result.timing?.requests.map((request) => request.uploadsAttached),
    ).toEqual([1, 0, 0, 0, 0, 0, 0]);
    expect(result.notes.at(-1)).toContain(
      "uploads_attached_per_turn=[1,0,0,0,0,0,0]",
    );
    expect(
      result.timing?.requests.map((request) => request.stepsAdvanced),
    ).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(result.notes.at(-1)).toContain(
      "steps_advanced_per_turn=[1,1,1,1,1,0,0]",
    );
  });

  test("cookie and add-row clicks run in order with fields and Continue on the first turn", async () => {
    const source = page({
      stepLabel: "Step 1 of 2",
      controls: [
        field(0, "Full name"),
        { ...field(1, "City"), visible: false, required: true },
      ],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
        {
          index: 1,
          label: "Add work history row",
          visible: true,
          disabled: false,
        },
      ],
      clickables: [
        {
          index: 0,
          label: "Reject cookies",
          tagName: "button",
          role: "button",
          visible: true,
          topOffset: 0,
        },
      ],
    });
    const { input, writes } = writable(source);
    const order: string[] = [];
    const fill = input.hands.fillText;
    input.hands.fillText = (ref, value) => {
      order.push(ref);
      return fill(ref, value);
    };
    input.hands.clickElement = vi.fn((ref: string) => {
      order.push(ref);
      if (ref === "e0") source.clickables = [];
      if (ref === "a1") source.controls[1].visible = true;
      if (ref === "a0") {
        source.stepLabel = "Step 2 of 2";
        source.controls = [nameControl()];
        source.actions = [
          {
            index: 0,
            label: "Submit application",
            visible: true,
            disabled: false,
          },
        ];
      }
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    });
    const result = await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "click", ref: "e0" },
          { tool: "click", ref: "a1" },
          { tool: "type", ref: "c0", text: "Robin Ashford" },
          { tool: "type", ref: "c1", text: "Manchester" },
        ],
        () => {},
        "a0",
      ),
    );
    expect(order).toEqual(["e0", "a1", "c0", "c1", "a0"]);
    expect(writes).toEqual(["c0", "c1"]);
    expect(result.outcome).toBe("prepared");
    expect(result.timing?.modelTurns).toBe(2);
    expect(result.timing?.requests[0]).toMatchObject({
      fieldsFilled: 2,
      fieldsAttempted: 2,
      stepsAdvanced: 1,
      uploadsAttached: 0,
    });
  });

  test.each([
    "navigation",
    "step",
    "refused",
    "new required row",
    "reused field handle",
    "reused Continue handle",
  ])("a %s chore stops or blocks Continue", async (barrier) => {
    const source = page({
      stepLabel: "Step 1 of 2",
      controls: [field(0, "Full name")],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
        {
          index: 1,
          label: "Add work history row",
          visible: true,
          disabled: false,
        },
      ],
    });
    const { input, writes } = writable(source);
    const click = vi.fn((ref: string) => {
      expect(ref).toBe("a1");
      if (barrier === "navigation")
        source.url = "https://apply.example.test/other";
      if (barrier === "step") source.stepLabel = "Step 2 of 2";
      if (barrier === "reused field handle")
        source.controls[0].label = "Notice period";
      if (barrier === "reused Continue handle")
        source.actions[0].label = "Remove row";
      if (barrier === "new required row")
        source.controls.push({ ...field(1, "City"), required: true });
      return Promise.resolve(
        barrier === "refused"
          ? { ok: false as const, error: "Click failed" }
          : { ok: true as const, observedValue: "clicked" },
      );
    });
    input.hands.clickElement = click;
    await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "click", ref: "a1" },
          { tool: "type", ref: "c0", text: "Robin Ashford" },
        ],
        () => {},
        "a0",
      ),
    );
    expect(click).toHaveBeenCalledTimes(1);
    expect(writes).toEqual(barrier === "new required row" ? ["c0"] : []);
  });

  test("one finish hands back all required questions after filling and uploading without Continue", async () => {
    const source = page({
      stepLabel: "Step 1 of 6",
      controls: [
        field(0, "Full name"),
        { ...field(1, "Resume / CV"), inputType: "file", required: true },
        {
          ...field(2, "I agree to marketing contact"),
          inputType: "checkbox",
          required: true,
          value: "on",
        },
        { ...field(3, "Notice period"), required: true },
      ],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const { input, writes } = writable(source);
    input.sources.documents = [
      {
        id: "cv",
        kind: "resume",
        label: "Synthetic CV",
        fileName: "synthetic.pdf",
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(new Uint8Array([1])),
      },
    ];
    input.hands.uploadFile = vi.fn(
      (_ref: string, file: Parameters<ApplyPageHands["uploadFile"]>[1]) => {
        source.controls[1].value = file.name;
        return Promise.resolve({ ok: true as const, observedValue: file.name });
      },
    );
    const click = vi.fn(input.hands.clickElement);
    input.hands.clickElement = click;
    const result = await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "type", ref: "c0", text: "Robin Ashford" },
          { tool: "upload", ref: "c1", documentId: "cv" },
          { tool: "set_checkbox", ref: "c2", checked: true },
        ],
        () => {},
        "a0",
      ),
    );
    expect(writes).toEqual(["c0"]);
    expect(input.hands.uploadFile).toHaveBeenCalledTimes(1);
    expect(click).not.toHaveBeenCalled();
    expect(result.outcome).toBe("paused");
    expect(result.timing?.modelTurns).toBe(2); // fill+upload, exactly one finish
    expect(result.timing?.requests[0]).toMatchObject({
      fieldsAttempted: 2,
      fieldsFilled: 1,
      uploadsAttached: 1,
      stepsAdvanced: 0,
    });
    expect(
      result.pauses[0]?.questions?.map((question) => question.prompt),
    ).toEqual(["I agree to marketing contact", "Notice period"]);
  });

  test("a model's explicit person handoff finishes once without an empty-field reminder", async () => {
    const source = page({
      stepLabel: "Step 1 of 6",
      controls: [{ ...field(0, "Notice period"), required: true }],
    });
    const result = await runApplyAgent(
      config(source),
      scriptedModel([
        {
          name: "finish",
          args: {
            reason: "Please provide your notice period.",
            needsPerson: true,
          },
        },
      ]),
    );
    expect(result.outcome).toBe("paused");
    expect(result.timing?.modelTurns).toBe(1);
    expect(result.pauses[0]?.question?.prompt).toBe("Notice period");
  });

  test("an approved certificate uploads with the fields and Continue through the normal path", async () => {
    const source = page({
      stepLabel: "Step 1 of 2",
      controls: [
        field(0, "Full name"),
        {
          ...field(1, "Certificate"),
          inputType: "file",
          required: true,
          accept: ".pdf",
        },
      ],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const { input } = writable(source);
    const bytes = new Uint8Array([1, 2, 3]);
    input.sources.documents = [
      {
        id: "certificate",
        kind: "certificate",
        label: "Synthetic certificate",
        fileName: "certificate.pdf",
        mimeType: "application/pdf",
        loadBytes: () => Promise.resolve(bytes),
      },
    ];
    input.hands.uploadFile = vi.fn(
      (_ref: string, file: Parameters<ApplyPageHands["uploadFile"]>[1]) => {
        expect(file).toEqual({
          name: "certificate.pdf",
          mimeType: "application/pdf",
          bytes,
        });
        source.controls[1].value = file.name;
        return Promise.resolve({ ok: true as const, observedValue: file.name });
      },
    );
    input.hands.clickElement = vi.fn(() => {
      source.stepLabel = "Step 2 of 2";
      source.controls = [nameControl()];
      source.actions = [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ];
      return Promise.resolve({ ok: true as const, observedValue: "clicked" });
    });
    const result = await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "type", ref: "c0", text: "Robin Ashford" },
          { tool: "upload", ref: "c1", documentId: "certificate" },
        ],
        () => {},
        "a0",
      ),
    );
    expect(result.outcome).toBe("prepared");
    expect(result.attachments[0]).toMatchObject({
      documentId: "certificate",
      fileName: "certificate.pdf",
    });
    expect(result.timing?.modelTurns).toBe(2);
    expect(result.timing?.requests[0]).toMatchObject({
      fieldsFilled: 1,
      uploadsAttached: 1,
      stepsAdvanced: 1,
    });
  });

  test.each([
    "missing document",
    "wrong kind",
    "wrong format",
    "write refused",
    "navigation",
    "new field",
  ])(
    "a %s upload preserves executor checks and stops remaining actions",
    async (barrier) => {
      const source = page({
        stepLabel: "Step 1 of 2",
        controls: [
          {
            ...field(
              0,
              barrier === "wrong kind" ? "Academic transcript" : "Resume / CV",
            ),
            inputType: "file",
            required: true,
            ...(barrier === "wrong format" ? { accept: ".docx" } : {}),
          },
          field(1, "Full name"),
        ],
        actions: [
          { index: 0, label: "Continue", visible: true, disabled: false },
        ],
      });
      const { input, writes } = writable(source);
      input.sources.documents = [
        {
          id: "cv",
          kind: "resume",
          label: "Synthetic CV",
          fileName: "synthetic.pdf",
          mimeType: "application/pdf",
          loadBytes: () => Promise.resolve(new Uint8Array([1])),
        },
      ];
      const upload = vi.fn((_ref: string, file: { name: string }) => {
        if (barrier === "write refused")
          return Promise.resolve({
            ok: false as const,
            error: "Upload failed",
          });
        source.controls[0].value = file.name;
        if (barrier === "navigation")
          source.url = "https://apply.example.test/next";
        if (barrier === "new field")
          source.controls.push({
            ...field(2, "Another question"),
            required: true,
          });
        return Promise.resolve({ ok: true as const, observedValue: file.name });
      });
      input.hands.uploadFile = upload;
      const click = vi.fn(input.hands.clickElement);
      input.hands.clickElement = click;
      let report = "";
      const result = await runApplyAgent(
        input,
        modelFor(
          [
            {
              tool: "upload",
              ref: "c0",
              documentId: barrier === "missing document" ? "absent" : "cv",
            },
            { tool: "type", ref: "c1", text: "Robin Ashford" },
          ],
          (messages) => {
            report =
              messages.find((message) => message.role === "tool")?.content ??
              "";
          },
          "a0",
        ),
      );
      expect(writes).toEqual([]);
      expect(click).not.toHaveBeenCalled();
      if (barrier === "wrong format") {
        expect(result.outcome).toBe("paused");
        expect(result.timing?.modelTurns).toBe(1);
        expect(result.pauses[0]?.code).toBe("document_needs_you");
      } else expect(report).toContain("c1: not attempted");
      expect(upload).toHaveBeenCalledTimes(
        ["write refused", "navigation", "new field"].includes(barrier) ? 1 : 0,
      );
      expect(result.timing?.requests[0]?.uploadsAttached).toBe(
        ["navigation", "new field"].includes(barrier) ? 1 : 0,
      );
    },
  );

  test.each(["send guard", "Stop"])(
    "an upload batch respects %s before later fields or Continue",
    async (barrier) => {
      const source = page({
        controls: [
          { ...field(0, "Resume / CV"), inputType: "file" },
          field(1, "Full name"),
        ],
        actions: [
          { index: 0, label: "Continue", visible: true, disabled: false },
        ],
      });
      const controller = new AbortController();
      const { input, writes } = writable(source);
      input.signal = controller.signal;
      input.sources.documents = [
        {
          id: "cv",
          kind: "resume",
          label: "Synthetic CV",
          fileName: "synthetic.pdf",
          mimeType: "application/pdf",
          loadBytes: () => Promise.resolve(new Uint8Array([1])),
        },
      ];
      let uploaded = false;
      input.hands.uploadFile = vi.fn(
        (_ref: string, file: Parameters<ApplyPageHands["uploadFile"]>[1]) => {
          uploaded = true;
          source.controls[0].value = file.name;
          if (barrier === "Stop") controller.abort();
          return Promise.resolve({
            ok: true as const,
            observedValue: file.name,
          });
        },
      );
      input.hands.clickElement = vi.fn(input.hands.clickElement);
      input.safety = {
        readBlockedAttempt: () =>
          Promise.resolve(
            uploaded && barrier === "send guard"
              ? {
                  kind: "form_submit",
                  method: "POST",
                  url: "https://apply.example.test/send",
                  at: "2026-09-14T10:00:01.000Z",
                }
              : null,
          ),
        registerPreparedValue: () => Promise.resolve(),
        openIntermediateWriteWindow: () => Promise.resolve(),
        closeIntermediateWriteWindow: () => Promise.resolve(),
        checkServiceWorker: () => Promise.resolve(null),
      };
      const result = await runApplyAgent(
        input,
        modelFor(
          [
            { tool: "upload", ref: "c0", documentId: "cv" },
            { tool: "type", ref: "c1", text: "Robin Ashford" },
          ],
          () => {},
          "a0",
        ),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(input.hands.uploadFile).toHaveBeenCalledTimes(1);
      expect(writes).toEqual([]);
      expect(input.hands.clickElement).not.toHaveBeenCalled();
      expect(result.timing?.modelTurns).toBe(1);
      if (barrier === "send guard") {
        expect(result.outcome).toBe("paused");
        expect(result.pauses[0]?.code).toBe("site_tried_to_send");
        expect(result.timing?.requests[0]?.uploadsAttached).toBe(0);
      }
    },
  );

  test.each([
    "prepare_only",
    "confirm_before_submit",
    "autonomous_submit",
  ] as const)(
    "a batch click on final send keeps the %s executor guard",
    async (mode) => {
      const source = page({ controls: [nameControl()] });
      const { input, writes } = writable(source);
      input.authority.mode = mode;
      input.authority.submitAuthorized = mode === "autonomous_submit";
      input.authority.allowedOrigins = ["https://apply.example.test"];
      const click = vi.fn(input.hands.clickElement);
      input.hands.clickElement = click;
      const result = await runApplyAgent(
        input,
        modelFor([
          { tool: "click", ref: "a0" },
          { tool: "type", ref: "c0", text: "Robin Ashford" },
        ]),
      );
      expect(click).not.toHaveBeenCalled();
      expect(writes).toEqual([]);
      expect(result.filled).toHaveLength(0);
      expect(result.timing?.requests[0]?.stepsAdvanced).toBe(0);
    },
  );

  test("an answer left for the person does not stop the rest of the batch", async () => {
    const source = page({
      controls: [
        {
          ...field(0, "I certify that the information is true"),
          inputType: "checkbox",
          value: "on",
        },
        field(1, "Full name"),
        field(2, "Email"),
      ],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const { input, writes } = writable(source);
    input.sources.profile.email = "robin@example.test";
    const click = vi.fn(input.hands.clickElement);
    input.hands.clickElement = click;
    let report = "";
    const result = await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "set_checkbox", ref: "c0", checked: true },
          { tool: "type", ref: "c1", text: "Robin Ashford" },
          { tool: "type", ref: "c2", text: "robin@example.test" },
        ],
        (messages) => {
          report =
            messages.find((message) => message.role === "tool")?.content ?? "";
        },
        "a0",
      ),
    );
    // The declaration nobody approved stays unticked; the two answers after
    // it go in during the same turn, and Continue waits for the model.
    expect(writes).toEqual(["c1", "c2"]);
    expect(report).toContain('c1: Filled in "Full name".');
    expect(report).toContain('c2: Filled in "Email".');
    expect(report).not.toContain("not attempted");
    expect(report).toContain("Continue was not pressed");
    expect(click).not.toHaveBeenCalled();
    expect(result.timing?.requests[0]).toMatchObject({ fieldsFilled: 2 });
  });

  test.each([
    "refused",
    "person",
    "omitted required",
    "step changed",
    "navigation",
    "new field",
  ])("%s field prevents thenContinue", async (barrier) => {
    const source = page({
      controls: [field(0, "Full name")],
      actions: [
        { index: 0, label: "Continue", visible: true, disabled: false },
      ],
    });
    const { input } = writable(source);
    const click = vi.fn(input.hands.clickElement);
    input.hands.clickElement = click;
    let fields: FillFieldsEntry[] = [
      { tool: "type", ref: "c0", text: "Robin Ashford" },
    ];
    if (barrier === "refused")
      fields = [{ tool: "type", ref: "missing", text: "Robin Ashford" }];
    if (barrier === "person") {
      source.controls[0] = {
        ...field(0, "I certify that the information is true"),
        inputType: "checkbox",
        value: "on",
      };
      fields = [{ tool: "set_checkbox", ref: "c0", checked: true }];
    }
    if (barrier === "omitted required")
      source.controls.push({ ...field(1, "Email"), required: true });
    if (["step changed", "navigation", "new field"].includes(barrier)) {
      const fill = input.hands.fillText;
      input.hands.fillText = async (ref, value) => {
        const result = await fill(ref, value);
        if (barrier === "step changed") source.stepLabel = "Step 2 of 6";
        if (barrier === "navigation")
          source.url = "https://apply.example.test/other";
        if (barrier === "new field") source.controls.push(field(1, "Email"));
        return result;
      };
    }
    let report = "";
    await runApplyAgent(
      input,
      modelFor(
        fields,
        (messages) => {
          report =
            messages.find((message) => message.role === "tool")?.content ?? "";
        },
        "a0",
      ),
    );
    expect(click).not.toHaveBeenCalled();
    expect(report).toContain("Continue was not pressed");
  });

  test.each([true, false])(
    "Continue reports unchanged step and validation errors (%s) to the next decision",
    async (invalid) => {
      const source = page({
        controls: [field(0, "Full name")],
        stepLabel: "Step 1 of 6",
        actions: [
          { index: 0, label: "Continue", visible: true, disabled: false },
        ],
      });
      const { input, writes } = writable(source);
      const fill = input.hands.fillText;
      input.hands.fillText = async (ref, value) => {
        const result = await fill(ref, value);
        source.controls[0].invalid = false;
        source.controls[0].validationMessage = "";
        source.validationErrors = [];
        return result;
      };
      let clicks = 0;
      input.hands.clickElement = vi.fn(() => {
        if (++clicks === 1) {
          if (invalid) {
            source.validationErrors = ["Use your full legal name."];
            source.controls[0].invalid = true;
            source.controls[0].validationMessage = "Enter both names.";
            source.controls.push(field(1, "Optional additional name"));
          }
        } else {
          source.stepLabel = "Step 2 of 2";
          source.actions[0].label = "Submit application";
        }
        return Promise.resolve({ ok: true as const, observedValue: "clicked" });
      });
      let turn = 0;
      const result = await runApplyAgent(input, {
        chatWithTools: (messages, definitions) => {
          const check = supportedChecks(messages, definitions);
          if (check) return check;
          turn += 1;
          if (turn === 2) {
            const report = messages
              .filter((message) => message.role === "tool")
              .at(-1)?.content;
            expect(report).toContain("Continue did not advance the step");
            expect(report).toContain("The page after Continue:");
            if (invalid) {
              expect(report).toContain("Continue returned validation errors");
              expect(report).toContain("Use your full legal name.");
              expect(report).toContain("Full name: Enter both names.");
            }
          }
          return Promise.resolve({
            toolCalls: [
              turn === 1
                ? call("fill_fields", {
                    fields: [{ tool: "type", ref: "c0", text: "Robin" }],
                    thenContinue: "a0",
                  })
                : turn === 2
                  ? invalid
                    ? call(
                        "fill_fields",
                        {
                          fields: [
                            { tool: "type", ref: "c0", text: "Robin Ashford" },
                          ],
                          thenContinue: "a0",
                        },
                        "correction",
                      )
                    : call("click", { ref: "a0" })
                  : call("finish", { reason: "The corrected form is ready." }),
            ],
          });
        },
      });
      expect(input.hands.clickElement).toHaveBeenCalledTimes(2);
      expect(writes).toHaveLength(invalid ? 2 : 1);
      expect(source.controls[0].value).toBe(
        invalid ? "Robin Ashford" : "Robin",
      );
      expect(result.outcome).toBe("prepared");
      expect(
        result.timing?.requests.map((request) => request.stepsAdvanced),
      ).toEqual([0, 1, 0]);
    },
  );

  test.each([
    "prepare_only",
    "confirm_before_submit",
    "autonomous_submit",
  ] as const)(
    "thenContinue final submit matches a separate click in %s",
    async (mode) => {
      const source = page({ controls: [field(0, "Full name")] });
      const { input } = writable(source);
      input.authority.mode = mode;
      input.authority.allowedOrigins = ["https://apply.example.test"];
      input.authority.submitAuthorized = mode === "autonomous_submit";
      input.hands.clickElement = vi.fn(input.hands.clickElement);
      let report = "";
      const result = await runApplyAgent(
        input,
        modelFor(
          [{ tool: "type", ref: "c0", text: "Robin Ashford" }],
          (messages) => {
            report =
              messages.find((message) => message.role === "tool")?.content ??
              "";
          },
          "a0",
        ),
      );
      const observation = await input.hands.observe();
      const separate = await executeApplyProposal(
        { tool: "click", ref: "a0" },
        observation.signature,
        { config: input, now: input.now!, guardState: createApplyGuardState() },
      );
      expect(input.hands.clickElement).not.toHaveBeenCalled();
      if (separate.kind === "refused") {
        expect(mode).toBe("prepare_only");
        expect(report).toContain(separate.reason);
      } else {
        // The press is the form's finish: the run ends ready for the send
        // path, with nothing pressed and no further model turn.
        expect(separate.kind).toBe("ready_to_send");
        expect(result.readyToSend).toEqual({
          actionRef: "a0",
          actionLabel:
            separate.kind === "ready_to_send"
              ? separate.finalActionLabel
              : null,
        });
        expect(result.timing?.modelTurns).toBe(1);
      }
      expect(result.timing?.requests[0]?.stepsAdvanced).toBe(0);
    },
  );

  test("five mixed fields fill in one decision turn with one fresh observation", async () => {
    const source = page({
      controls: [
        field(0, "Full name"),
        field(1, "Email"),
        {
          ...field(2, "City"),
          tagName: "select",
          inputType: "select-one",
          options: ["Manchester", "London"],
        },
        {
          ...field(3, "I certify that the information is true"),
          inputType: "checkbox",
          value: "on",
        },
        {
          ...field(4, "Yes"),
          inputType: "radio",
          groupLabel: "Open to remote work?",
          value: "Yes",
        },
      ],
    });
    const { input, writes } = writable(source);
    input.sources.profile.email = "robin@example.test";
    input.authority.preApprovedAttestationKinds = [
      "truthfulness_certification",
    ];
    input.sources.reusableAnswers = [
      {
        id: "remote",
        kind: "other",
        label: "Remote",
        question: "Open to remote work?",
        answer: "Yes",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    let nextMessages: Parameters<LLMClient["chatWithTools"]>[0] = [];
    const result = await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "type", ref: "c0", text: "Robin Ashford" },
          { tool: "type", ref: "c1", text: "robin@example.test" },
          { tool: "select", ref: "c2", option: "Manchester" },
          { tool: "set_checkbox", ref: "c3", checked: true },
          { tool: "set_checkbox", ref: "c4", checked: true },
        ],
        (messages) => {
          nextMessages = structuredClone(messages);
        },
      ),
    );
    expect(writes).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    expect(result.filled).toHaveLength(5);
    expect(result.timing?.requests).toMatchObject([
      { turn: 1, fieldsAttempted: 5, fieldsFilled: 5 },
      { turn: 2, fieldsAttempted: 0, fieldsFilled: 0 },
    ]);
    expect(result.timing?.modelTurns).toBe(2); // one fill decision, then finish
    const toolResults = nextMessages.filter(
      (message) => message.role === "tool",
    );
    expect(toolResults).toHaveLength(1);
    for (let i = 0; i < 5; i++)
      expect(toolResults[0].content).toContain(`c${i}: Filled in`);
    expect(toolResults[0].content).not.toContain("Fields:");
    expect(
      nextMessages.filter((message) =>
        message.content?.startsWith("The page after your batch:"),
      ),
    ).toHaveLength(1);
    expect(result.notes.at(-1)).toContain(
      "fields_per_turn(filled/attempted)=[5/5,0/0]",
    );
    expect(result.timing?.pageReads).toBe(14); // safety reads plus the shared retention read
  });

  test("a refusal in the middle names both attempted and unattempted fields", async () => {
    const source = page({
      controls: [field(0, "Full name"), field(1, "Email"), field(2, "City")],
    });
    const { input, writes } = writable(source);
    input.sources.profile.email = "robin@example.test";
    const fill = input.hands.fillText;
    input.hands.fillText = (ref, value) =>
      ref === "c1"
        ? Promise.resolve({ ok: false, error: "The field refused the write." })
        : fill(ref, value);
    let report = "";
    const result = await runApplyAgent(
      input,
      modelFor(
        [
          { tool: "type", ref: "c0", text: "Robin Ashford" },
          { tool: "type", ref: "c1", text: "robin@example.test" },
          { tool: "type", ref: "c2", text: "Manchester" },
        ],
        (messages) => {
          report =
            messages.find((message) => message.role === "tool")?.content ?? "";
        },
      ),
    );
    expect(writes).toEqual(["c0"]);
    expect(report).toContain('c0: Filled in "Full name".');
    expect(report).toContain('c1: "Email": The field refused the write.');
    expect(report).toContain("c2: not attempted (batch stopped).");
    expect(result.timing?.requests[0]).toMatchObject({
      fieldsAttempted: 2,
      fieldsFilled: 1,
    });
  });

  test.each(["navigation", "new field", "step"])(
    "%s stops the remaining fields",
    async (change) => {
      const source = page({
        controls: [field(0, "Full name"), field(1, "Email")],
      });
      const { input, writes } = writable(source);
      input.sources.profile.email = "robin@example.test";
      const fill = input.hands.fillText;
      input.hands.fillText = async (ref, value) => {
        const result = await fill(ref, value);
        if (change === "navigation")
          source.url = "https://apply.example.test/next";
        if (change === "new field")
          source.controls.push(field(2, "Another question"));
        if (change === "step") source.stepLabel = "Step 2 of 6";
        return result;
      };
      let report = "";
      const result = await runApplyAgent(
        input,
        modelFor(
          [
            { tool: "type", ref: "c0", text: "Robin Ashford" },
            { tool: "type", ref: "c1", text: "robin@example.test" },
          ],
          (messages) => {
            report =
              messages.find((message) => message.role === "tool")?.content ??
              "";
          },
        ),
      );
      expect(writes).toEqual(["c0"]);
      expect(report).toContain("c1: not attempted (batch stopped).");
      expect(result.timing?.requests[0]).toMatchObject({
        fieldsAttempted: 1,
        fieldsFilled: change === "new field" ? 1 : 0,
      });
    },
  );

  test.each([
    {
      label: "I certify that the information is true",
      tool: "set_checkbox" as const,
      value: "Yes",
      allowed: true,
    },
    {
      label: "I certify that the information is true",
      tool: "set_checkbox" as const,
      value: "Yes",
      allowed: false,
    },
    {
      label: "Current salary",
      tool: "type" as const,
      value: "60000",
      allowed: false,
    },
    {
      label: "Are you legally authorized to work in this country?",
      tool: "select" as const,
      value: "Yes",
      allowed: true,
    },
    {
      label: "What is your notice period?",
      tool: "type" as const,
      value: "Two weeks",
      allowed: true,
    },
  ])(
    "$label (allowed=$allowed) has the same result as a single call",
    async ({ label, tool, value, allowed }) => {
      const source = page({
        controls: [
          {
            ...field(0, label),
            ...(tool === "set_checkbox"
              ? { inputType: "checkbox", value: "on" }
              : {}),
            ...(tool === "select"
              ? {
                  tagName: "select",
                  inputType: "select-one",
                  options: ["Yes", "No"],
                }
              : {}),
          },
        ],
      });
      const prepare = () => {
        const state = writable(structuredClone(source));
        if (allowed && tool === "set_checkbox")
          state.input.authority.preApprovedAttestationKinds = [
            "truthfulness_certification",
          ];
        if (tool !== "set_checkbox")
          state.input.sources.reusableAnswers = [
            {
              id: "person_answer",
              kind: "other",
              label,
              question: label,
              answer: value,
              roleFamilies: [],
              proofEntryIds: [],
            },
          ];
        return state;
      };
      const proposal: FillFieldsEntry =
        tool === "type"
          ? { tool, ref: "c0", text: value }
          : tool === "select"
            ? { tool, ref: "c0", option: value }
            : { tool, ref: "c0", checked: true };
      const single = prepare();
      const before = await single.input.hands.observe();
      const outcome = await executeApplyProposal(proposal, before.signature, {
        config: single.input,
        now: single.input.now!,
        guardState: createApplyGuardState(),
        checkWrittenAnswer: () =>
          Promise.resolve({
            supported: true,
            reason: "Synthetic supported answer.",
          }),
      });
      const batch = prepare();
      const result = await runApplyAgent(batch.input, modelFor([proposal]));
      expect(batch.writes).toEqual(single.writes);
      expect(batch.writes).toHaveLength(allowed ? 1 : 0);
      if (outcome.kind === "filled")
        expect(result.filled[0]).toEqual(outcome.filled);
      else expect(result.filled).toHaveLength(0);
    },
  );
});

test.each([false, true])(
  "a batch stops at the send guard even if its final read fails (%s)",
  async (readFails) => {
    const source = page({
      controls: [
        { ...nameControl(), value: "" },
        {
          ...nameControl(),
          index: 1,
          id: "email",
          name: "email",
          label: "Email",
          value: "",
        },
      ],
    });
    const input = config(source);
    input.sources.profile.email = "robin@example.test";
    const writes: string[] = [];
    input.hands.fillText = (ref, value) => {
      writes.push(ref);
      source.controls[Number(ref.slice(1))].value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    input.hands.clickAction = vi.fn(input.hands.clickAction);
    input.hands.clickElement = vi.fn(input.hands.clickElement);
    const observe = input.hands.observe;
    input.hands.observe = () =>
      readFails && writes.length > 0
        ? Promise.reject(new Error("Synthetic read failure"))
        : observe();
    input.safety = {
      readBlockedAttempt: () =>
        Promise.resolve(
          writes.length > 0
            ? {
                kind: "form_submit",
                method: "POST",
                url: "https://apply.example.test/send",
                at: "2026-09-14T10:00:01.000Z",
              }
            : null,
        ),
      registerPreparedValue: () => Promise.resolve(),
      openIntermediateWriteWindow: () => Promise.resolve(),
      closeIntermediateWriteWindow: () => Promise.resolve(),
      checkServiceWorker: () => Promise.resolve(null),
    };
    let turns = 0;
    const result = await runApplyAgent(input, {
      chatWithTools: () => {
        turns += 1;
        return Promise.resolve({
          toolCalls: [
            {
              id: "fields",
              type: "function",
              function: {
                name: "fill_fields",
                arguments: JSON.stringify({
                  thenContinue: "a0",
                  fields: [
                    { tool: "type", ref: "c0", text: "Robin Ashford" },
                    { tool: "type", ref: "c1", text: "robin@example.test" },
                  ],
                }),
              },
            },
          ],
        });
      },
    });
    expect(turns).toBe(1);
    expect(writes).toEqual(["c0"]);
    expect(input.hands.clickAction).not.toHaveBeenCalled();
    expect(input.hands.clickElement).not.toHaveBeenCalled();
    expect(result.outcome).toBe("paused");
    expect(result.pauses[0].code).toBe("site_tried_to_send");
    expect(result.timing?.requests[0]).toMatchObject({
      fieldsAttempted: 1,
      fieldsFilled: 0,
    });
    expect(result.timing?.pageReads).toBe(3); // initial, executor pre-write, pause observation
  },
);

test.each([1, 2])(
  "Stop during a %s-field batch fences later fields and Continue",
  async (count) => {
    const source = page({
      controls: [
        { ...nameControl(), value: "" },
        {
          ...nameControl(),
          index: 1,
          id: "email",
          name: "email",
          label: "Email",
          value: "",
        },
      ],
    });
    const controller = new AbortController();
    const input = config(source, { signal: controller.signal });
    input.sources.profile.email = "robin@example.test";
    input.hands.clickElement = vi.fn(input.hands.clickElement);
    const writes: string[] = [];
    input.hands.fillText = (ref, value) => {
      writes.push(ref);
      source.controls[Number(ref.slice(1))].value = value;
      controller.abort();
      return Promise.resolve({ ok: true, observedValue: value });
    };
    await runApplyAgent(input, {
      chatWithTools: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: "fields",
              type: "function",
              function: {
                name: "fill_fields",
                arguments: JSON.stringify({
                  thenContinue: "a0",
                  fields: [
                    { tool: "type", ref: "c0", text: "Robin Ashford" },
                    { tool: "type", ref: "c1", text: "robin@example.test" },
                  ].slice(0, count),
                }),
              },
            },
          ],
        }),
    });
    // Let the already-started tool settle, so this catches late writes too.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(writes).toEqual(["c0"]);
    expect(input.hands.clickElement).not.toHaveBeenCalled();
  },
);

test("renumbered handles keep current answers and two equal-worded questions distinct", async () => {
  const source = page({
    controls: [
      { ...nameControl(), index: 0, label: "Email", value: "old@example.test" },
      { ...nameControl(), index: 1, label: "Description", value: "First role" },
      {
        ...nameControl(),
        index: 2,
        label: "Description",
        value: "Second role",
      },
    ],
  });
  const input = config(source);
  input.hands.scroll = () => {
    source.controls.forEach((control, index) => {
      control.index = index + 10;
    });
    source.controls[0].value = "new@example.test";
    source.controls[2].value = "Changed second role";
    return Promise.resolve({ ok: true, observedValue: "down" });
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "scroll", args: { direction: "down" } },
      { name: "finish", args: { reason: "Reviewed" } },
    ]),
  );
  expect(
    result.reviewFilled?.map((entry) => [entry.label, entry.answer.value]),
  ).toEqual([
    ["Email", "new@example.test"],
    ["Description", "First role"],
    ["Description", "Changed second role"],
  ]);
});

test.each([
  { mode: "confirm_before_submit", handover: "none" },
  { mode: "autonomous_submit", handover: "none" },
  { mode: "confirm_before_submit", handover: "stale email" },
  { mode: "confirm_before_submit", handover: "still needs person" },
  { mode: "autonomous_submit", handover: "still needs person" },
  { mode: "autonomous_submit", handover: "implicit finish" },
  { mode: "autonomous_submit", handover: "text reply" },
  { mode: "confirm_before_submit", handover: "invalid email" },
  { mode: "confirm_before_submit", handover: "changed question" },
  { mode: "confirm_before_submit", handover: "stale email plus MFA" },
] as const)(
  "the Greenhouse replica's plain identity fields fill from Profile in $mode ($handover)",
  async ({ mode, handover }) => {
    const identity = [
      ["First Name *", "Robin", "profile.firstName"],
      ["Last Name *", "Ashford", "profile.lastName"],
      ["Email *", "robin@example.test", "profile.email"],
    ] as const;
    const source = page({
      // Same labels, input types and empty groups as /greenhouse-shape/apply/1.
      controls: identity.map(([label], index) => ({
        ...nameControl(),
        index,
        label,
        inputType: index === 2 ? "email" : "text",
        value: "",
      })),
    });
    const input = config(source, {
      modelQuestionClassification: true,
      intermediateWritesAuthorized: false,
    });
    input.authority.mode = mode;
    input.authority.submitAuthorized = mode === "autonomous_submit";
    input.authority.allowedOrigins = ["https://apply.example.test"];
    input.sources.profile.email = identity[2][1];
    const email = source.controls[2];
    if (!email) throw new Error("The replica email input is missing.");
    if (handover !== "none") {
      // The site briefly reports a validation error after filling. By the
      // model's stale handover, its asynchronous check has accepted the email.
      input.hands.wait = () => {
        email.invalid = true;
        email.validationMessage = "Checking email";
        return Promise.resolve();
      };
    }
    const finalClick = vi.spyOn(input.hands, "clickAction");
    const batch = {
      fields: identity.map(([, text, storedFactId], index) => ({
        tool: "type",
        ref: `c${index}`,
        text,
        storedFactId,
      })),
      finishWhenReady: handover === "none",
    };
    const model =
      handover === "none"
        ? repeatingModel("fill_fields", batch)
        : scriptedModel([
            { name: "fill_fields", args: batch },
            {
              name: "finish",
              args: {
                reason: "Email still needs the person's answer.",
                needsPerson: true,
                forPerson: [
                  "c2",
                  ...(handover === "stale email plus MFA"
                    ? ["Enter the MFA code the site sent to your phone."]
                    : []),
                ],
              },
            },
            {
              name: "finish",
              args:
                handover === "stale email"
                  ? {
                      reason: "The checked fields answer everything.",
                      needsPerson: false,
                    }
                  : handover === "implicit finish"
                    ? { reason: "The form is complete." }
                    : {
                        reason: "Email still needs the person's answer.",
                        needsPerson: true,
                        forPerson: ["c2"],
                      },
            },
          ]);
    let formTurns = 0;
    const client: LLMClient = {
      chatWithTools: (messages, tools, options) => {
        if (tools[0]?.function.name === "report_question_kinds")
          return Promise.resolve({
            toolCalls: [
              {
                id: "reading",
                type: "function",
                function: {
                  name: "report_question_kinds",
                  arguments: JSON.stringify({
                    plainIndexes: [0, 1, 2],
                    flagged: [],
                    tags: identity.map((_, index) => ({
                      index,
                      kind: "other",
                      country: null,
                      sourceId: null,
                    })),
                  }),
                },
              },
            ],
          });
        if (++formTurns > 1 && handover !== "invalid email") {
          email.invalid = false;
          email.validationMessage = "";
          if (handover === "changed question")
            email.hint = "Your professional reference's email address.";
        }
        if (handover === "text reply" && formTurns > 2)
          return Promise.resolve({
            content: "Everything is complete.",
            toolCalls: [],
          });
        return model.chatWithTools(messages, tools, options);
      },
    };
    const calls = vi.spyOn(client, "chatWithTools");
    const result = await runApplyAgent(input, client);
    expect(source.controls.map((control) => control.value)).toEqual(
      identity.map(([, value]) => value),
    );
    expect(result.filled.map((field) => field.answer.sourceId)).toEqual(
      identity.map(([, , sourceId]) => sourceId),
    );
    const questions = result.pauses.flatMap(
      (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
    );
    expect(questions.map((question) => question.prompt)).toEqual(
      handover === "invalid email" || handover === "changed question"
        ? ["Email *"]
        : handover === "stale email plus MFA"
          ? ["Enter the MFA code the site sent to your phone."]
          : handover === "still needs person"
            ? ["Review this application before sending."]
            : handover === "implicit finish" || handover === "text reply"
              ? [
                  "Job Finder still needs you to review this application before it can finish.",
                ]
              : [],
    );
    expect(result.outcome).toBe(
      handover === "invalid email" ||
        handover === "changed question" ||
        handover === "stale email plus MFA" ||
        handover === "still needs person" ||
        handover === "implicit finish" ||
        handover === "text reply"
        ? "paused"
        : mode === "autonomous_submit"
          ? "ready_to_send"
          : "awaiting_your_review",
    );
    expect(finalClick).not.toHaveBeenCalled();
    expect(calls).toHaveBeenCalledTimes(
      handover === "none"
        ? 2
        : handover === "changed question" ||
            [
              "stale email",
              "still needs person",
              "implicit finish",
              "text reply",
            ].includes(handover)
          ? 4
          : 3,
    );
    if (
      [
        "stale email",
        "still needs person",
        "implicit finish",
        "text reply",
      ].includes(handover)
    ) {
      const nudges = calls.mock.calls
        .flatMap(([messages]) => messages)
        .filter(
          (message) =>
            message.role === "tool" &&
            String(message.content).includes(
              "These fields already have checked, still-valid answers",
            ),
        );
      expect(nudges).toHaveLength(1);
      expect(nudges[0]?.content).toContain(
        '"question":"Email *","value":"robin@example.test"',
      );
      expect(nudges[0]?.content).toContain("finish with needsPerson: false");
    }
    if (
      ["still needs person", "implicit finish", "text reply"].includes(handover)
    ) {
      expect(result.readyToSend).toBeNull();
      expect(questions.some((question) => question.prompt === "Email *")).toBe(
        false,
      );
    }
  },
);

test("a site-prefilled Email is not a checked write that can clear a handover", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        label: "Email *",
        inputType: "email",
        value: "robin@example.test",
      },
    ],
  });
  const input = config(source, { intermediateWritesAuthorized: false });
  input.authority.mode = "confirm_before_submit";
  input.sources.profile.email = "robin@example.test";
  const result = await runApplyAgent(
    input,
    repeatingModel("finish", {
      reason: "Email needs the person's answer.",
      needsPerson: true,
      forPerson: ["c0"],
    }),
  );
  expect(result.filled).toEqual([]);
  expect(result.outcome).toBe("paused");
  expect(
    result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .map((question) => question.prompt),
  ).toEqual(["Email *"]);
});

test("classification settles before starting a sourced writing check and before any write", async () => {
  const source = page({
    controls: [{ ...nameControl(), label: "Why this role?", value: "" }],
  });
  const input = config(source);
  input.modelQuestionClassification = true;
  const events: string[] = [];
  let releaseKinds!: () => void;
  let releaseAnswers!: () => void;
  const kindsGate = new Promise<void>((resolve) => {
    releaseKinds = resolve;
  });
  const answersGate = new Promise<void>((resolve) => {
    releaseAnswers = resolve;
  });
  const observe = input.hands.observe;
  input.hands.observe = () => {
    events.push("read");
    return observe();
  };
  input.hands.fillText = (_ref, value) => {
    events.push("write");
    source.controls[0].value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  };
  let turns = 0;
  const resultPromise = runApplyAgent(input, {
    chatWithTools: async (messages, definitions) => {
      const name = definitions[0]?.function.name;
      if (name === "report_question_kinds") {
        events.push("classification");
        await kindsGate;
        return {
          toolCalls: [
            {
              id: "kinds",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({
                  tags: [
                    {
                      index: 0,
                      kind: "motivation",
                      country: null,
                      sourceId: "posting.description",
                    },
                  ],
                  questions: [
                    { index: 0, asksAboutPay: false, declarationKind: null },
                  ],
                }),
              },
            },
          ],
        };
      }
      if (name === "report_answer_checks") {
        events.push("answers");
        await answersGate;
        return (await supportedChecks(messages, definitions))!;
      }
      return {
        toolCalls: [
          {
            id: "decision",
            type: "function",
            function: {
              name: ++turns === 1 ? "fill_fields" : "finish",
              arguments: JSON.stringify(
                turns === 1
                  ? {
                      fields: [
                        {
                          tool: "type",
                          ref: "c0",
                          text: "The role is to own the internal platform.",
                        },
                      ],
                    }
                  : { reason: "Done." },
              ),
            },
          },
        ],
      };
    },
  });
  for (let i = 0; i < 20 && !events.includes("answers"); i += 1)
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(events).toContain("classification");
  expect(events).not.toContain("answers");
  expect(
    events.filter((event) => event === "read").length,
  ).toBeGreaterThanOrEqual(1);
  expect(events).not.toContain("write");
  releaseKinds();
  await vi.waitFor(() => expect(events).toContain("answers"));
  expect(events).not.toContain("write");
  releaseAnswers();
  const result = await resultPromise;
  expect(result.filled).toHaveLength(1);
  expect(events.filter((event) => event === "classification")).toHaveLength(1);
  expect(events.filter((event) => event === "answers")).toHaveLength(1);
});

test("form turns and question reading are apply work; answer checks are fact checks", async () => {
  const source = page({
    controls: [{ ...nameControl(), label: "Why this role?", value: "" }],
  });
  const input = config(source);
  input.modelQuestionClassification = true;
  input.hands.fillText = (_ref, value) => {
    source.controls[0].value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  };
  const tasks: Array<[string, string | undefined]> = [];
  let turns = 0;
  await runApplyAgent(input, {
    chatWithTools: async (messages, definitions, options) => {
      const name = definitions[0]?.function.name;
      if (name === "report_question_kinds") {
        tasks.push(["questions", options?.reasoningTask]);
        return {
          toolCalls: [
            {
              id: "kinds",
              type: "function",
              function: {
                name,
                arguments: JSON.stringify({
                  tags: [
                    {
                      index: 0,
                      kind: "motivation",
                      country: null,
                      sourceId: "posting.description",
                    },
                  ],
                  questions: [
                    { index: 0, asksAboutPay: false, declarationKind: null },
                  ],
                }),
              },
            },
          ],
        };
      }
      if (name === "report_answer_checks") {
        tasks.push(["answers", options?.reasoningTask]);
        return (await supportedChecks(messages, definitions))!;
      }
      tasks.push(["turn", options?.reasoningTask]);
      return {
        toolCalls: [
          {
            id: "decision",
            type: "function",
            function: {
              name: ++turns === 1 ? "fill_fields" : "finish",
              arguments: JSON.stringify(
                turns === 1
                  ? {
                      fields: [
                        {
                          tool: "type",
                          ref: "c0",
                          text: "I would welcome the opportunity to own the internal platform.",
                        },
                      ],
                    }
                  : { reason: "Done." },
              ),
            },
          },
        ],
      };
    },
  });
  expect(new Set(tasks.map((entry) => entry.join(":")))).toEqual(
    new Set(["turn:apply", "questions:apply", "answers:claim_check"]),
  );
});

test.each([
  {
    label: "Years of professional experience",
    answer: "8 years",
    tasks: [],
  },
  {
    label: "Why this role?",
    answer: "My platform experience fits this role.",
    tasks: [],
  },
  {
    label: "Are you legally authorized to work in this country?",
    answer: "Yes",
    tasks: [],
  },
  {
    label: "Available start date",
    answer: "2026-11-20",
    tasks: [],
    unread: true,
  },
  {
    label: "Workplace country",
    answer: "London",
    tasks: [],
    unread: true,
    flagged: { asksHiringCountry: true },
  },
])(
  "a question without typed source tags pauses without a speculative checker call: $label",
  async ({
    label,
    answer,
    tasks,
    unread,
    flagged,
  }: {
    label: string;
    answer: string;
    tasks: string[];
    unread?: boolean;
    flagged?: Record<string, unknown>;
  }) => {
    const source = page({
      controls: [{ ...nameControl(), label, value: "" }],
    });
    const input = config(source);
    input.modelQuestionClassification = true;
    input.hands.fillText = (_ref, value) => {
      source.controls[0].value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    const checkTasks: Array<string | undefined> = [];
    let turns = 0;
    await runApplyAgent(input, {
      chatWithTools: async (messages, definitions, options) => {
        const name = definitions[0]?.function.name;
        if (name === "report_question_kinds") {
          // The writer waits for this reading instead of launching a
          // speculative answer check while the page remains unread.
          if (unread)
            await new Promise<void>((resolve) => setTimeout(resolve, 5));
          return {
            toolCalls: [
              {
                id: "kinds",
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(
                    flagged
                      ? {
                          plainIndexes: [],
                          flagged: [
                            {
                              index: 0,
                              eligibilityKind: null,
                              asksAboutPay: false,
                              asksCurrentPay: false,
                              asksHiringCountry: false,
                              required: true,
                              declarationKind: null,
                              ...flagged,
                            },
                          ],
                        }
                      : { plainIndexes: [0], flagged: [] },
                  ),
                },
              },
            ],
          };
        }
        if (name === "report_answer_checks") {
          checkTasks.push(options?.reasoningTask);
          return (await supportedChecks(messages, definitions))!;
        }
        // Every writer turn already has the page's reading.
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return {
          toolCalls: [
            {
              id: "decision",
              type: "function",
              function: {
                name: ++turns === 1 ? "fill_fields" : "finish",
                arguments: JSON.stringify(
                  turns === 1
                    ? { fields: [{ tool: "type", ref: "c0", text: answer }] }
                    : { reason: "Done." },
                ),
              },
            },
          ],
        };
      },
    });
    expect(checkTasks).toEqual(tasks);
  },
);

test("progress names the form's own step on a multi-step form", async () => {
  const source = page({ stepLabel: "Step 2 of 5" });
  const notes: string[] = [];
  await runApplyAgent(
    config(source, {
      onProgress: ({ note }) => {
        notes.push(note);
      },
    }),
    scriptedModel([{ name: "finish", args: { reason: "Done." } }]),
  );
  expect(notes).toContain(
    "form step 2 of 5: asking the assistant what to do next",
  );
  expect(notes.join("\n")).not.toContain("Robin");
});

test.each(["upload", "create_application_document"])(
  "a rejected file letter offers its draft and conflict through %s",
  async (tool) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Cover letter",
          value: "",
        },
      ],
    });
    const input = config(source);
    const wording =
      "I enjoy building dependable platforms. I can work 20 hours a week from Manchester.";
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide: () =>
        Promise.resolve({
          ok: false,
          draftText: wording,
          reason: "Your available hours differ from this full-time role.",
        }),
    };
    const result = await runApplyAgent(
      input,
      scriptedModel([
        {
          name: tool,
          args:
            tool === "upload"
              ? { ref: "c0", documentId: "letter" }
              : {
                  ref: "c0",
                  purpose: "cover_letter",
                  fileType: "pdf",
                  instructions: "Write the requested letter.",
                },
        },
      ]),
    );
    const question =
      result.pauses[0]?.questions?.[0] ?? result.pauses[0]?.question;
    expect(result.outcome).toBe("paused");
    expect(question).toMatchObject({
      kind: "cover_letter",
      answerControlType: "text",
      suggestedAnswers: [expect.objectContaining({ text: wording })],
    });
    expect(question?.note).toContain("Your available hours differ");
    expect(question?.note).toContain(
      "The form wants a letter file. Your answer will be attached as that file.",
    );
    expect(question?.note).not.toContain("Review the wording here");
    expect(result.attachments).toEqual([]);
  },
);

test.each([true, false])(
  "create-document attaches the approved letter without a second question (explicit ref: %s)",
  async (explicitRef) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          inputType: "file",
          label: "Cover letter",
          value: "",
        },
      ],
    });
    const input = config(source);
    input.application.applicationRecordId = "app";
    const approvedText =
      "I enjoy building dependable platforms.\nI can work 20 hours a week from Manchester.\n";
    input.sources.reusableAnswers = [
      {
        id: "application_letter",
        kind: "other",
        label: "Cover letter",
        question: "Cover letter",
        answer: approvedText,
        roleFamilies: [],
        proofEntryIds: [],
        applicationScope: {
          applicationRecordId: "app",
          resultId: "old_result",
          location: null,
        },
      },
    ];
    input.writing = {
      coverLetterPolicy: "never",
      writtenAnswerLength: "short",
      preApprovedDeclarations: [],
    };
    const provide = vi.fn(
      (
        request: Parameters<
          NonNullable<ApplyAgentConfig["letters"]>["provide"]
        >[0],
      ) =>
        Promise.resolve({
          ok: true as const,
          text: request.approvedText ?? "Wrong rewritten text",
          document: {
            id: "approved_letter",
            kind: "cover_letter" as const,
            label: "Your letter",
            fileName: "letter.pdf",
            mimeType: "application/pdf",
            loadBytes: () =>
              Promise.resolve(new TextEncoder().encode(request.approvedText)),
          },
        }),
    );
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    const uploadFile = vi.fn(
      (_ref: string, file: { name: string; bytes: Uint8Array }) => {
        source.controls[0].value = file.name;
        return Promise.resolve({ ok: true as const, observedValue: file.name });
      },
    );
    input.hands = { ...input.hands, uploadFile };
    const result = await runApplyAgent(
      input,
      scriptedModel([
        {
          name: "create_application_document",
          args: {
            purpose: "cover_letter",
            fileType: "pdf",
            instructions: "Attach my reviewed letter.",
            ...(explicitRef ? { ref: "c0" } : {}),
          },
        },
        { name: "upload", args: { ref: "c0", documentId: "approved_letter" } },
        { name: "finish", args: { reason: "The letter is attached." } },
      ]),
    );
    expect(provide).toHaveBeenCalledOnce();
    expect(provide).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedText,
        delivery: "file",
        fileType: "pdf",
      }),
    );
    expect(new TextDecoder().decode(uploadFile.mock.calls[0][1].bytes)).toBe(
      approvedText,
    );
    expect(result.pauses).toEqual([]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        fileName: "letter.pdf",
        reviewText: {
          text: approvedText,
          groundedIn: ["your letter for this application"],
        },
      }),
    ]);
  },
);

test.each(["type", "fill_fields", "create_application_document"])(
  "a classified letter uses its actual form field through %s",
  async (tool) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          tagName: "textarea",
          label: "Cover letter",
          value: "",
        },
      ],
    });
    const input = config(source, { modelQuestionClassification: true });
    const wording =
      "I am excited about this opportunity. I would like to join your team and contribute to this work. I would welcome the chance to contribute in this role. I am interested in working with your team and would welcome the opportunity to help.";
    const provide = vi.fn<NonNullable<ApplyAgentConfig["letters"]>["provide"]>(
      () =>
        Promise.resolve({
          ok: true as const,
          text: wording,
          document:
            tool === "create_application_document"
              ? {
                  id: "letter",
                  kind: "cover_letter" as const,
                  label: "Your letter",
                  fileName: "letter.pdf",
                  mimeType: "application/pdf",
                  loadBytes: () =>
                    Promise.resolve(new TextEncoder().encode(wording)),
                }
              : null,
        }),
    );
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    const flow = scriptedModel([
      {
        name: tool,
        args:
          tool === "fill_fields"
            ? { fields: [{ tool: "type", ref: "c0", text: "ignored draft" }] }
            : tool === "type"
              ? { ref: "c0", text: "ignored draft" }
              : {
                  ref: "c0",
                  instructions: "Write the requested cover letter.",
                },
      },
      { name: "finish", args: { reason: "Done." } },
    ]);
    await runApplyAgent(input, {
      chatWithTools: (messages, definitions, options) =>
        definitions[0]?.function.name === "report_question_kinds"
          ? Promise.resolve({
              toolCalls: [
                {
                  id: "read",
                  type: "function",
                  function: {
                    name: "report_question_kinds",
                    arguments: JSON.stringify({
                      plainIndexes: [0],
                      flagged: [],
                      tags: [
                        {
                          index: 0,
                          kind: "motivation",
                          country: null,
                          sourceId: "resume.text",
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          : flow.chatWithTools(messages, definitions, options),
    });
    expect(provide).toHaveBeenCalledOnce();
    expect(provide).toHaveBeenCalledWith(
      expect.objectContaining({
        formControl: { ref: "c0", question: "Cover letter" },
      }),
    );
    expect(provide.mock.calls[0]?.[0]?.prompt).not.toBe("Cover letter");
    if (tool !== "create_application_document")
      expect(source.controls[0].value).toBe(wording);
  },
);

test.each(["own words", "wrong ref", "not a letter"])(
  "letter generation refuses %s despite a willing writer",
  async (shape) => {
    const source = page({
      bodyText: shape === "own words" ? "Write this yourself" : "Apply",
      controls: [
        {
          ...nameControl(),
          tagName: "textarea",
          label: shape === "not a letter" ? "Personal story" : "Cover letter",
          value: "",
        },
      ],
    });
    const input = config(source, { modelQuestionClassification: true });
    const provide = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        text: "I am excited about this opportunity.",
        document: null,
      }),
    );
    input.letters = {
      preference: {
        tone: "direct",
        length: "short",
        language: null,
        sample: null,
      },
      provide,
    };
    const flow = scriptedModel([
      {
        name: "create_application_document",
        args: {
          ref: shape === "wrong ref" ? "c999" : "c0",
          instructions: "Write a letter.",
        },
      },
      {
        name: "finish",
        args: { reason: "Needs your answer", needsPerson: true },
      },
    ]);
    await runApplyAgent(input, {
      chatWithTools: (messages, definitions, options) =>
        definitions[0]?.function.name === "report_question_kinds"
          ? Promise.resolve({
              toolCalls: [
                {
                  id: "read",
                  type: "function",
                  function: {
                    name: "report_question_kinds",
                    arguments: JSON.stringify({
                      plainIndexes: [0],
                      flagged: [],
                      tags: [
                        {
                          index: 0,
                          kind:
                            shape === "own words" ? "own_words" : "motivation",
                          country: null,
                          sourceId: "resume.text",
                        },
                      ],
                    }),
                  },
                },
              ],
            })
          : flow.chatWithTools(messages, definitions, options),
    });
    expect(provide).not.toHaveBeenCalled();
    expect(source.controls[0].value).toBe("");
  },
);

test("stored facts fill while earlier written and eligibility answers wait for their check", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        index: 0,
        label: "Describe your platform work",
        value: "",
      },
      {
        ...nameControl(),
        index: 1,
        label: "Are you authorized to work here?",
        value: "",
      },
      { ...nameControl(), index: 2, label: "Job title", value: "" },
    ],
  });
  const input = config(source);
  input.sources.profile.experiences = [
    {
      id: "role",
      title: "Platform engineer",
      companyName: "Fixture Tools",
      companyUrl: null,
      employmentType: null,
      location: null,
      workMode: [],
      startDate: null,
      endDate: null,
      isCurrent: true,
      isDraft: false,
      summary: null,
      achievements: [],
      skills: [],
      domainTags: [],
      peopleManagementScope: null,
      ownershipScope: null,
    },
  ];
  input.sources.profile.summary = "I build dependable platforms.";
  const writes: string[] = [];
  input.hands.fillText = (ref, value) => {
    writes.push(ref);
    source.controls[Number(ref.slice(1))].value = value;
    return Promise.resolve({ ok: true, observedValue: value });
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  let turns = 0;
  const run = runApplyAgent(input, {
    chatWithTools: async (messages, definitions) => {
      if (definitions[0]?.function.name === "report_answer_checks") {
        checks += 1;
        await gate;
        return (await supportedChecks(messages, definitions))!;
      }
      const name = ++turns === 1 ? "fill_fields" : "finish";
      return {
        toolCalls: [
          {
            id: `turn-${turns}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(
                name === "fill_fields"
                  ? {
                      fields: [
                        {
                          tool: "type",
                          ref: "c0",
                          text: "I build dependable platforms.",
                        },
                        { tool: "type", ref: "c1", text: "Yes" },
                        {
                          tool: "type",
                          ref: "c2",
                          text: "Platform engineer",
                          storedFactId: "profile.experiences.role.title",
                        },
                      ],
                    }
                  : { reason: "Done." },
              ),
            },
          },
        ],
      };
    },
  });
  try {
    await vi.waitFor(() => expect(writes).toEqual(["c2"]));
    expect(checks).toBe(1);
  } finally {
    release();
  }
  const result = await run;
  expect(writes).toEqual(["c2", "c0", "c1"]);
  expect(result.notes.at(-1)).toContain("stored_fact_fills_per_turn=[1,0]");
  expect(result.notes.at(-1)).toContain("answers_waited_per_turn=[2,0]");
});

test("an explicit stored-fact reference with a changed value still gets checked", async () => {
  const source = page({
    controls: [{ ...nameControl(), label: "Full name", value: "" }],
  });
  const input = config(source);
  const fill = vi.spyOn(input.hands, "fillText");
  let checkCalls = 0;
  let turns = 0;
  const result = await runApplyAgent(input, {
    chatWithTools: (_messages, definitions) => {
      const checking = definitions[0]?.function.name === "report_answer_checks";
      if (checking) checkCalls += 1;
      else turns += 1;
      const name = checking
        ? "report_answer_checks"
        : turns === 1
          ? "fill_fields"
          : "finish";
      const args = checking
        ? {
            checks: [
              {
                index: 0,
                supported: false,
                reason: "This name differs from your saved name.",
              },
            ],
          }
        : turns === 1
          ? {
              fields: [
                {
                  tool: "type",
                  ref: "c0",
                  text: "Robin Ashworth",
                  storedFactId: "profile.fullName",
                },
              ],
            }
          : { reason: "Confirm your name.", needsPerson: true };
      return Promise.resolve({
        toolCalls: [
          {
            id: `call-${turns}-${checkCalls}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
    },
  });
  expect(checkCalls).toBe(1);
  expect(fill).not.toHaveBeenCalled();
  expect(result.outcome).toBe("paused");
});

test.each(["fill_fields", "separate tools"])(
  "a refused source question is handed over once while the rest fills (%s)",
  async (mode) => {
    const source = page({
      controls: [
        {
          ...nameControl(),
          label: "How did you hear about this job?",
          groupLabel: "My Information",
          tagName: "select",
          value: "",
          options: ["Referral"],
        },
        { ...nameControl(), index: 1, id: "name", name: "name", value: "" },
      ],
    });
    const input = config(source);
    input.sources.listingDiscovery = {
      label: "Local job board",
      url: "https://listing.example.test/board/",
    };
    const choose = vi.spyOn(input.hands, "chooseOption"),
      fill = vi.spyOn(input.hands, "fillText");
    const fields: FillFieldsEntry[] = [
      { tool: "select", ref: "c0", option: "Referral" },
      { tool: "type", ref: "c1", text: "Robin Ashford" },
    ];
    const model: LLMClient =
      mode === "fill_fields"
        ? repeatingModel("fill_fields", { fields })
        : {
            chatWithTools: () =>
              Promise.resolve({
                toolCalls: fields.map(({ tool, ...args }, index) => ({
                  id: `call${index}`,
                  type: "function",
                  function: { name: tool, arguments: JSON.stringify(args) },
                })),
              }),
          };
    const result = await runApplyAgent(input, model);
    expect(result.outcome).toBe("paused");
    expect(result.modelTurns).toBeLessThanOrEqual(2);
    expect(choose).not.toHaveBeenCalled();
    expect(fill).toHaveBeenCalledExactlyOnceWith("c1", "Robin Ashford");
    const questions = result.pauses.flatMap((pause) => pause.questions ?? []);
    expect(questions).toHaveLength(1);
    expect(questions[0].answerOptions).toEqual(["Referral"]);
  },
);

test.each([false, true])(
  "a rejected name typo can be corrected from Profile (typed gate: %s)",
  async (typed) => {
    const source = page({ controls: [{ ...nameControl(), value: "" }] });
    const input = config(source, { modelQuestionClassification: typed });
    const fill = vi.spyOn(input.hands, "fillText");
    const flow = scriptedModel([
      { name: "type", args: { ref: "c0", text: "Robin Ashworth" } },
      { name: "type", args: { ref: "c0", text: "Robin Ashford" } },
      { name: "finish", args: { reason: "The recorded name is filled." } },
    ]);
    const result = await runApplyAgent(input, {
      chatWithTools: (messages, definitions, options) => {
        if (definitions[0]?.function.name !== "report_question_kinds")
          return flow.chatWithTools(messages, definitions, options);
        return Promise.resolve({
          toolCalls: [
            {
              id: "read",
              type: "function",
              function: {
                name: "report_question_kinds",
                arguments: JSON.stringify({
                  plainIndexes: [0],
                  flagged: [],
                  tags: [
                    {
                      index: 0,
                      kind: "other",
                      country: null,
                      sourceId: "profile.fullName",
                    },
                  ],
                }),
              },
            },
          ],
        });
      },
    });
    expect(fill).toHaveBeenCalledExactlyOnceWith("c0", "Robin Ashford");
    expect(result.outcome).toBe("prepared");
    expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toEqual([]);
  },
);

test("held questions do not hide a required invalid email from correction", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        tagName: "select",
        label: "How did you hear about this job?",
        value: "",
        options: ["Referral"],
      },
      {
        ...nameControl(),
        index: 1,
        id: "email",
        name: "email",
        inputType: "email",
        label: "Email",
        value: "invalid@",
        invalid: true,
      },
    ],
  });
  const input = config(source);
  input.sources.profile.email = "robin.replay@example.test";
  input.sources.listingDiscovery = {
    label: "Local job board",
    url: "https://listing.example.test/jobs/1",
  };
  const original = input.hands.fillText;
  input.hands.fillText = (ref, value) => {
    source.controls[1].invalid = false;
    return original(ref, value);
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "select", args: { ref: "c0", option: "Referral" } },
      { name: "type", args: { ref: "c1", text: "robin.replay@example.test" } },
      {
        name: "finish",
        args: {
          reason: "One source question needs the person.",
          needsPerson: true,
        },
      },
    ]),
  );
  expect(source.controls[1].value).toBe("robin.replay@example.test");
  expect(result.outcome).toBe("paused");
  expect(
    result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .map((question) => question.prompt),
  ).toEqual(["How did you hear about this job?"]);
});

test("a changed proposal for a refused field costs no second fact check while another field fills", async () => {
  const source = page({
    controls: [
      { ...nameControl(), label: "Why this role?", value: "" },
      { ...nameControl(), index: 1, id: "name", name: "name", value: "" },
    ],
  });
  const input = config(source),
    fill = vi.spyOn(input.hands, "fillText");
  const flow = scriptedModel([
    { name: "type", args: { ref: "c0", text: "I have led space missions." } },
    {
      name: "fill_fields",
      args: {
        fields: [
          { tool: "type", ref: "c0", text: "I have piloted spacecraft." },
          { tool: "type", ref: "c1", text: "Robin Ashford" },
        ],
      },
    },
  ]);
  let checks = 0;
  const result = await runApplyAgent(input, {
    chatWithTools: (messages, definitions, options) => {
      if (definitions[0]?.function.name !== "report_answer_checks")
        return flow.chatWithTools(messages, definitions, options);
      checks++;
      return Promise.resolve({
        toolCalls: [
          {
            id: "check",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: [
                  {
                    index: 0,
                    supported: false,
                    reason: "No applicant evidence.",
                  },
                ],
              }),
            },
          },
        ],
      });
    },
  });
  expect(checks).toBe(1);
  expect(result.modelTurns).toBe(3); // Two form turns and one independent check.
  expect(result.outcome).toBe("paused");
  expect(fill).toHaveBeenCalledExactlyOnceWith("c1", "Robin Ashford");
  expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toHaveLength(
    1,
  );
});

test("the same question and value are checked only once across batch and single-field retries", async () => {
  const source = page({
    controls: [{ ...nameControl(), label: "Why this role?", value: "" }],
  });
  const input = config(source);
  const fill = vi.spyOn(input.hands, "fillText");
  let checkCalls = 0;
  let turns = 0;
  await runApplyAgent(input, {
    chatWithTools: (_messages, definitions) => {
      if (definitions[0]?.function.name === "report_answer_checks") {
        checkCalls += 1;
        return Promise.resolve({
          toolCalls: [
            {
              id: "check",
              type: "function",
              function: {
                name: "report_answer_checks",
                arguments: JSON.stringify({
                  checks: [
                    {
                      index: 0,
                      supported: false,
                      reason: "This experience is not recorded.",
                    },
                  ],
                }),
              },
            },
          ],
        });
      }
      turns += 1;
      const name =
        turns === 1 ? "fill_fields" : turns === 2 ? "type" : "finish";
      const field = {
        tool: "type",
        ref: "c0",
        text: "I have led space missions.",
      };
      return Promise.resolve({
        toolCalls: [
          {
            id: `turn-${turns}`,
            type: "function",
            function: {
              name,
              arguments: JSON.stringify(
                turns === 1
                  ? { fields: [field, field] }
                  : turns === 2
                    ? field
                    : { reason: "Needs your answer.", needsPerson: true },
              ),
            },
          },
        ],
      });
    },
  });
  expect(checkCalls).toBe(1);
  expect(fill).not.toHaveBeenCalled();
});

test("an unsupported eligibility answer waits once instead of navigating to another form", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        label: "Are you authorized to work here?",
        value: "",
      },
    ],
  });
  const input = config(source);
  input.hands.navigate = (url) => {
    source.url = url;
    source.bodyText = "This form hires in a different country.";
    return Promise.resolve({ ok: true, url });
  };
  let checks = 0;
  let turns = 0;
  const result = await runApplyAgent(input, {
    chatWithTools: (_messages, definitions) => {
      if (definitions[0]?.function.name === "report_answer_checks") {
        checks += 1;
        return Promise.resolve({
          toolCalls: [
            {
              id: `check-${checks}`,
              type: "function",
              function: {
                name: "report_answer_checks",
                arguments: JSON.stringify({
                  checks: [
                    {
                      index: 0,
                      supported: false,
                      reason: "Confirm this form's hiring country.",
                    },
                  ],
                }),
              },
            },
          ],
        });
      }
      turns += 1;
      const name =
        turns === 1
          ? "fill_fields"
          : turns === 2
            ? "navigate"
            : turns === 3
              ? "type"
              : "finish";
      const field = { tool: "type", ref: "c0", text: "Yes" };
      const args =
        turns === 1
          ? { fields: [field] }
          : turns === 2
            ? {
                url: "https://apply.example.test/other-form",
                reason: "Read the second application form.",
              }
            : turns === 3
              ? field
              : { reason: "Confirm the hiring country.", needsPerson: true };
      return Promise.resolve({
        toolCalls: [
          {
            id: `turn-${turns}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      });
    },
  });
  expect(checks).toBe(1);
  expect(result.outcome).toBe("paused");
  expect(
    result.pauses
      .flatMap(
        (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
      )
      .map((question) => question.prompt),
  ).toEqual(["Are you authorized to work here?"]);
  expect(source.url).toBe("https://apply.example.test/form");
  expect(turns).toBe(1);
});

test("a letter that needs review joins the other questions while the run fills the rest", async () => {
  const source = page({
    controls: [
      { ...nameControl(), value: "" },
      {
        ...nameControl(),
        index: 1,
        id: "f1",
        name: "f1",
        inputType: "file",
        label: "Cover letter",
        value: "",
      },
    ],
  });
  const baseHands = hands(source);
  const input = config(source, {
    hands: {
      ...baseHands,
      // Typed values stay on the page, as on a real form.
      fillText: (ref, value) => {
        source.controls = source.controls.map((control) =>
          `c${control.index}` === ref ? { ...control, value } : control,
        );
        return Promise.resolve({ ok: true as const, observedValue: value });
      },
    },
  });
  const wording =
    "I enjoy building dependable platforms. I am looking for 20 hours a week from Manchester.";
  input.letters = {
    preference: {
      tone: "direct",
      length: "short",
      language: null,
      sample: null,
    },
    provide: () =>
      Promise.resolve({
        ok: false,
        draftText: wording,
        reason: "Your available hours differ from this full-time role.",
      }),
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      {
        name: "create_application_document",
        args: {
          ref: "c1",
          purpose: "cover_letter",
          fileType: "pdf",
          instructions: "Write the requested letter.",
        },
      },
      {
        name: "type",
        args: {
          ref: "c0",
          text: "Robin Ashford",
          storedFactId: "profile.fullName",
        },
      },
      {
        name: "finish",
        args: { reason: "Only the letter is left.", needsPerson: true },
      },
    ]),
  );
  // The person is asked about the letter only, never their own name.
  expect(result.outcome).toBe("paused");
  expect(result.filled.map((entry) => entry.label)).toContain("Full name");
  const questions = result.pauses[0]?.questions ?? [];
  expect(questions.map((question) => question.kind)).toEqual(["cover_letter"]);
  expect(questions[0]?.suggestedAnswers?.[0]?.text).toBe(wording);
  expect(result.attachments).toEqual([]);
});

describe("a model that reports in words instead of calling finish", () => {
  function wordsModel(
    turns: Array<{ content?: string; name?: string; args?: object }>,
  ) {
    const seen: string[] = [];
    let turn = 0;
    const model: LLMClient = {
      chatWithTools: (messages, definitions) => {
        const check = supportedChecks(messages, definitions);
        if (check) return check;
        seen.push(messages.at(-1)?.content ?? "");
        const next = turns[Math.min(turn, turns.length - 1)];
        turn += 1;
        return Promise.resolve(
          next.name
            ? {
                toolCalls: [
                  {
                    id: `call_${turn}`,
                    type: "function" as const,
                    function: {
                      name: next.name,
                      arguments: JSON.stringify(next.args ?? {}),
                    },
                  },
                ],
              }
            : { content: next.content ?? "" },
        );
      },
    };
    return { model, seen, turns: () => turn };
  }

  test("a filled form that is ready ends on those words, with no further turn", async () => {
    const source = page({
      controls: [{ ...nameControl(), value: "" }],
    });
    const input = config(source, {
      authority: {
        mode: "confirm_before_submit",
        submitAuthorized: false,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "pause_for_user",
        allowedOrigins: ["https://apply.example.test"],
      },
    });
    input.hands.fillText = (_ref, value) => {
      source.controls[0].value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    const { model, turns } = wordsModel([
      {
        name: "fill_fields",
        args: { fields: [{ tool: "type", ref: "c0", text: "Robin Ashford" }] },
      },
      { content: "Everything is filled in and ready for review." },
      { name: "finish", args: { reason: "Should not be needed." } },
    ]);
    const result = await runApplyAgent(input, model);
    expect(turns()).toBe(2);
    expect(result.outcome).toBe("awaiting_your_review");
    expect(result.readyToSend).toEqual({
      actionRef: "a0",
      actionLabel: "Submit application",
    });
  });

  test("words before anything is filled get the usual reminder", async () => {
    const source = page({
      controls: [{ ...nameControl(), value: "" }],
    });
    const input = config(source);
    input.hands.fillText = (_ref, value) => {
      source.controls[0].value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    const { model, seen, turns } = wordsModel([
      { content: "Let me look at the form first." },
      {
        name: "fill_fields",
        args: { fields: [{ tool: "type", ref: "c0", text: "Robin Ashford" }] },
      },
      { name: "finish", args: { reason: "Filled in." } },
    ]);
    const result = await runApplyAgent(input, model);
    expect(turns()).toBe(3);
    expect(seen[1]).toContain("Answer with one of the tools");
    expect(result.outcome).toBe("prepared");
  });
});

test("repeated-step replay pauses at the second entry, including after resumption, and uses its own answer", async () => {
  const source = page({
    stepLabel: "Step 1 of 2",
    controls: [
      {
        ...nameControl(),
        label: repeatedStep.question,
        groupLabel: repeatedStep.section,
        inputType: "month",
        value: "",
      },
    ],
    actions: [{ index: 0, label: "Next", visible: true, disabled: false }],
  });
  const input = config(source);
  input.sources.reusableAnswers = [
    {
      id: "first-date",
      kind: "other",
      question: `${repeatedStep.section} � ${repeatedStep.question}`,
      label: "First employment entry",
      answer: repeatedStep.firstAnswer,
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  input.hands.clickElement = () => {
    source.stepLabel = "Step 2 of 2";
    source.controls[0].value = "";
    source.actions = [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ];
    return Promise.resolve({ ok: true, observedValue: "Step 2" });
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "type", args: { ref: "c0", text: repeatedStep.firstAnswer } },
      { name: "click", args: { ref: "a0" } },
      { name: "type", args: { ref: "c0", text: repeatedStep.firstAnswer } },
      {
        name: "finish",
        args: { reason: "This entry needs the person.", needsPerson: true },
      },
    ]),
  );
  expect(result.filled).toHaveLength(1);
  expect(result.outcome).toBe("paused");
  expect(source.controls[0].value).toBe("");
  const question = result.pauses.flatMap(
    (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
  )[0];
  expect(question?.repeatedAtDifferentStep).toBe(true);
  input.initialQuestionContexts = result.questionContexts;
  const resumed = await runApplyAgent(
    input,
    scriptedModel([
      { name: "type", args: { ref: "c0", text: repeatedStep.firstAnswer } },
      {
        name: "finish",
        args: { reason: "This entry needs the person.", needsPerson: true },
      },
    ]),
  );
  expect(resumed.filled).toHaveLength(0);
  expect(resumed.outcome).toBe("paused");
  input.sources.reusableAnswers = [
    ...input.sources.reusableAnswers,
    {
      id: "application_second-date",
      kind: "other",
      question: question.prompt,
      label: "Second employment entry",
      answer: repeatedStep.secondAnswer,
      roleFamilies: [],
      proofEntryIds: [],
    },
  ];
  const answered = await runApplyAgent(
    input,
    scriptedModel([
      { name: "type", args: { ref: "c0", text: repeatedStep.secondAnswer } },
      { name: "finish", args: { reason: "The second entry is filled." } },
    ]),
  );
  expect(answered.filled).toHaveLength(1);
  expect(source.controls[0].value).toBe(repeatedStep.secondAnswer);
  expect(answered.outcome).toBe("prepared");
});

test("picker replay: two attempts end in Needs you with offered options, even when search text remains", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        label: pickerReplay.question,
        role: "combobox",
        value: "",
        options: [],
      },
    ],
  });
  const input = config(source);
  input.sources.profile.currentCountry = pickerReplay.primary;
  const chooseOption = vi.fn((_ref: string, option: string) => {
    source.controls[0].value = option;
    source.controls[0].options = pickerReplay.snapshotOptions;
    return Promise.resolve({
      ok: false as const,
      reason: "option_not_offered" as const,
      offeredOptions: pickerReplay.options,
      error: "No matching option",
    });
  });
  input.hands.chooseOption = chooseOption;
  const model = repeatingModel("select", {
    ref: "c0",
    option: pickerReplay.primary,
  });
  const result = await runApplyAgent(input, model);
  expect(result.outcome).toBe("paused");
  expect(result.readyToSend).toBeNull();
  expect(result.modelTurns).toBe(2);
  expect(chooseOption).toHaveBeenCalledTimes(1);
  const questions = result.pauses.flatMap(
    (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
  );
  // The form's own list, not the part of it read with the page.
  expect(questions[0].answerOptions).toEqual(pickerReplay.options);
  expect(result.pickerAttempts).toEqual([
    expect.objectContaining({
      tried: [pickerReplay.primary.toLowerCase()],
      offeredOptions: pickerReplay.options,
    }),
  ]);

  // A rerun of the same application does not spend the picker again.
  const rerunSource = page({
    controls: [
      {
        ...nameControl(),
        label: pickerReplay.question,
        role: "combobox",
        value: "",
        options: [],
      },
    ],
  });
  const rerun = config(rerunSource, {
    initialPickerAttempts: result.pickerAttempts,
  });
  rerun.sources.profile.currentCountry = pickerReplay.primary;
  const rerunChoose = vi.fn(chooseOption);
  rerun.hands.chooseOption = rerunChoose;
  const again = await runApplyAgent(
    rerun,
    repeatingModel("select", { ref: "c0", option: pickerReplay.primary }),
  );
  expect(again.outcome).toBe("paused");
  expect(rerunChoose).not.toHaveBeenCalled();
  expect(again.modelTurns).toBe(1);
});

test("picker replay: an optional picker that refuses its choice is left blank and the form still finishes", async () => {
  const source = page({
    controls: [
      nameControl(),
      {
        ...nameControl(),
        index: 1,
        id: "f1",
        name: "f1",
        label: pickerReplay.question,
        role: "combobox",
        required: false,
        value: "",
        options: [],
      },
    ],
  });
  const input = config(source);
  input.sources.profile.currentCountry = pickerReplay.primary;
  const chooseOption = vi.fn(() =>
    Promise.resolve({
      ok: false as const,
      reason: "option_not_offered" as const,
      offeredOptions: pickerReplay.options,
      error: "No matching option",
    }),
  );
  input.hands.chooseOption = chooseOption;
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "select", args: { ref: "c1", option: pickerReplay.primary } },
      { name: "select", args: { ref: "c1", option: pickerReplay.primary } },
      { name: "finish", args: { reason: "Filled the form." } },
    ]),
  );
  expect(chooseOption).toHaveBeenCalledTimes(1);
  expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toEqual([]);
  expect(result.outcome).toBe("prepared");
});

describe("saved picker fallback replay", () => {
  const rule = {
    primary: fallbackReplay.primary,
    fallback: fallbackReplay.fallback,
    whenNeitherOffered: "skip_application" as const,
  };
  const savedRule = (overrides: Record<string, unknown> = {}) => ({
    id: "saved-rule",
    kind: "other" as const,
    label: fallbackReplay.question,
    question: fallbackReplay.question,
    answer: fallbackReplay.primary,
    roleFamilies: [],
    proofEntryIds: [],
    optionFallback: rule,
    ...overrides,
  });
  const picker = (
    options: string[],
    overrides: Partial<RawApplyControl> = {},
  ) =>
    page({
      controls: [
        {
          ...nameControl(),
          role: "combobox",
          label: fallbackReplay.question,
          value: "",
          options,
          ...overrides,
        },
      ],
    });
  /** A list that takes only what it offers, and says what it offers otherwise. */
  const list = (source: RawApplyPage, options: string[]) =>
    vi.fn((_ref: string, value: string) => {
      if (options.includes(value)) {
        source.controls[0].value = value;
        source.controls[0].selectedOptionLabel = value;
        return Promise.resolve({ ok: true as const, observedValue: value });
      }
      return Promise.resolve({
        ok: false as const,
        error: `The list did not offer "${value}".`,
        reason: "option_not_offered" as const,
        offeredOptions: options,
      });
    });

  test.each(fallbackReplay.cases)(
    "$name: the picker is asked, in the rule's order",
    async ({ options, chosen, expected }) => {
      // The page read shows only part of the list; the picker has it all.
      const source = picker(options.slice(0, 1));
      const input = config(source);
      input.sources.reusableAnswers = [savedRule()];
      const choose = list(source, options);
      input.hands.chooseOption = choose;
      const result = await runApplyAgent(
        input,
        scriptedModel([
          {
            name: "select",
            args: { ref: "c0", option: fallbackReplay.primary },
          },
          { name: "finish", args: { reason: "Filled." } },
        ]),
      );
      expect(choose.mock.calls.map((call) => call[1])).toEqual(chosen);
      if (expected) {
        expect(source.controls[0].value).toBe(expected);
        expect(result.filled[0]?.answer.sourceKind).toBe("answer_library");
        expect(result.skipReason).toBeUndefined();
      } else {
        expect(result.skipReason).toContain(
          `neither ${fallbackReplay.primary} nor ${fallbackReplay.fallback}`,
        );
        expect(result.readyToSend).toBeNull();
        expect(result.pauses).toHaveLength(0);
      }
    },
  );

  test.each([
    {
      name: "the same name in its own language is that choice",
      primary: "Albania",
      options: ["Albania (Shqipëri)", "Kosovo"],
      filled: "Albania (Shqipëri)",
    },
    {
      name: "a narrower place in brackets is not, and goes to the person",
      primary: "China",
      options: ["China (Hong Kong SAR)", "Japan"],
      filled: null,
    },
  ])("$name", async ({ primary, options, filled }) => {
    const source = picker(options);
    const input = config(source);
    input.sources.reusableAnswers = [
      savedRule({
        answer: primary,
        optionFallback: { ...rule, primary, fallback: "Elsewhere" },
      }),
    ];
    input.hands.chooseOption = list(source, options);
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(result.skipReason).toBeUndefined();
    if (filled) expect(source.controls[0].value).toBe(filled);
    else {
      expect(source.controls[0].value).toBe("");
      expect(
        result.pauses.flatMap((pause) => pause.questions ?? [])[0]?.prompt,
      ).toBe(fallbackReplay.question);
    }
  });

  test("a choice refused while missing, then listed after the other refusal, is never skipped", async () => {
    const source = picker([]);
    const input = config(source);
    input.sources.reusableAnswers = [
      savedRule({
        answer: "Kosovo",
        optionFallback: { ...rule, primary: "Kosovo", fallback: "Albania" },
      }),
    ];
    // The list loads in stages: without Kosovo first, with it a moment later.
    let calls = 0;
    input.hands.chooseOption = vi.fn((_ref: string, value: string) => {
      calls += 1;
      return Promise.resolve({
        ok: false as const,
        error: `The list did not offer "${value}".`,
        reason: "option_not_offered" as const,
        offeredOptions: calls === 1 ? ["Serbia"] : ["Kosovo", "Serbia"],
      });
    });
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(result.skipReason).toBeUndefined();
  });

  test("a native list is asked too, never skipped from the page read alone", async () => {
    const source = picker(["Other region"], {
      tagName: "select",
      role: "",
      inputType: "select-one",
    });
    const input = config(source);
    input.sources.reusableAnswers = [savedRule()];
    // The real list finished loading later and does offer the fallback.
    const choose = list(source, ["Other region", fallbackReplay.fallback]);
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(choose).toHaveBeenCalledTimes(2);
    expect(result.skipReason).toBeUndefined();
    expect(source.controls[0].value).toBe(fallbackReplay.fallback);
  });

  test("a name that only resembles the answer is left to the person, not skipped", async () => {
    const options = [fallbackReplay.nearName, "Other region"];
    const source = picker(options);
    const input = config(source);
    input.sources.reusableAnswers = [savedRule()];
    const choose = list(source, options);
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    // Asked once by its own name, then left to the person.
    expect(choose.mock.calls.map((call) => call[1])).toEqual([
      fallbackReplay.primary,
    ]);
    expect(result.skipReason).toBeUndefined();
    const questions = result.pauses.flatMap(
      (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
    );
    expect(questions[0]?.prompt).toBe(fallbackReplay.question);
  });

  test("a list that cannot confirm its choices is never a reason to skip", async () => {
    const source = picker([]);
    const input = config(source);
    input.sources.reusableAnswers = [savedRule()];
    const choose = vi.fn(() =>
      Promise.resolve({
        ok: false as const,
        error: "The option list did not finish loading.",
      }),
    );
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(result.skipReason).toBeUndefined();
    expect(result.outcome).toBe("paused");
  });

  test.each([
    {
      name: "a State picker grouped under the saved question",
      control: fallbackReplay.groupedQuestion,
    },
    { name: "an optional picker", control: { required: false } },
    {
      name: "a picker that already has an answer",
      control: { value: "Other region", selectedOptionLabel: "Other region" },
    },
  ])("the rule does not decide $name", async ({ control }) => {
    const source = picker(["Other region"], control);
    const input = config(source);
    input.sources.reusableAnswers = [savedRule()];
    const choose = list(source, ["Other region"]);
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(result.skipReason).toBeUndefined();
    expect(choose).not.toHaveBeenCalled();
  });

  test("a refusal that shows no list is not proof of absence", async () => {
    const source = picker(["Other region"]);
    const input = config(source);
    input.sources.reusableAnswers = [savedRule()];
    const choose = vi.fn((_ref: string, value: string) =>
      Promise.resolve({
        ok: false as const,
        error: `The list did not offer "${value}".`,
        reason: "option_not_offered" as const,
        offeredOptions: [],
      }),
    );
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(choose).toHaveBeenCalledTimes(2);
    expect(result.skipReason).toBeUndefined();
    expect(result.outcome).toBe("paused");
  });

  test("a rerun skips only on what this run's list says; earlier refusals send it to the person", async () => {
    // Run 1: the list offers neither, so the rule skips.
    const first = picker(["Other region"]);
    const input = config(first);
    input.sources.reusableAnswers = [savedRule()];
    input.hands.chooseOption = list(first, ["Other region"]);
    const skipped = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(skipped.skipReason).toContain("neither");
    // Run 2 continues with run 1's refusals; the list has changed since.
    const second = picker(["Other region"]);
    const rerun = config(second, {
      initialPickerAttempts: skipped.pickerAttempts,
    });
    rerun.sources.reusableAnswers = [savedRule()];
    const choose = list(second, ["Other region", fallbackReplay.fallback]);
    rerun.hands.chooseOption = choose;
    const result = await runApplyAgent(
      rerun,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(choose).not.toHaveBeenCalled();
    expect(result.skipReason).toBeUndefined();
    expect(result.outcome).toBe("paused");
  });

  test("the model's reading never makes an optional picker's rule skip", async () => {
    const source = picker(["Other region"], { required: false });
    const input = config(source);
    input.sources.reusableAnswers = [savedRule()];
    input.modelQuestionClassification = true;
    const choose = list(source, ["Other region"]);
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(input, {
      chatWithTools: (_messages, definitions) => {
        const name = definitions[0]?.function.name ?? "finish";
        return Promise.resolve({
          toolCalls: [
            {
              id: name,
              type: "function" as const,
              function:
                name === "report_question_kinds"
                  ? {
                      name,
                      arguments: JSON.stringify({
                        questions: [
                          {
                            index: 0,
                            asksAboutPay: false,
                            declarationKind: null,
                            required: true,
                          },
                        ],
                      }),
                    }
                  : {
                      name: "finish",
                      arguments: JSON.stringify({ reason: "Filled." }),
                    },
            },
          ],
        });
      },
    });
    expect(choose).not.toHaveBeenCalled();
    expect(result.skipReason).toBeUndefined();
  });

  test("both answers of a rule are checked like any answer: a pay picker stays the person's", async () => {
    const question = "Expected salary range";
    const source = picker(["Other region"], { label: question });
    const input = config(source);
    input.sources.reusableAnswers = [savedRule({ question, label: question })];
    const choose = list(source, ["Other region", fallbackReplay.fallback]);
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(result.skipReason).toBeUndefined();
    expect(choose).not.toHaveBeenCalled();
  });

  test("a rule saved for another application stays with it", async () => {
    const source = picker(["Other region"]);
    const input = config(source);
    input.sources.reusableAnswers = [
      savedRule({
        applicationScope: { applicationRecordId: "another-application" },
      }),
    ];
    const choose = list(source, ["Other region"]);
    input.hands.chooseOption = choose;
    const result = await runApplyAgent(
      input,
      scriptedModel([{ name: "finish", args: { reason: "Filled." } }]),
    );
    expect(result.skipReason).toBeUndefined();
    expect(choose).not.toHaveBeenCalled();
  });
});

test("resumed picker replay never counts leftover search text as a confirmed answer", async () => {
  const source = page({
    controls: [
      {
        ...nameControl(),
        role: "combobox",
        label: pickerReplay.question,
        value: pickerReplay.primary,
        options: [],
      },
    ],
  });
  const makeInput = () =>
    config(source, {
      initialUnansweredPickerQuestions: [
        { prompt: pickerReplay.question, options: pickerReplay.options },
      ],
    });
  const waiting = await runApplyAgent(
    makeInput(),
    repeatingModel("finish", { reason: "Looks complete" }),
  );
  expect(waiting.outcome).toBe("paused");
  expect(waiting.readyToSend).toBeNull();
  expect(
    waiting.pauses.flatMap(
      (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
    )[0]?.answerOptions,
  ).toEqual(pickerReplay.options);
  const selected = pickerReplay.options[0];
  for (const tool of ["select", "type"] as const) {
    source.controls[0].value = pickerReplay.primary;
    source.controls[0].selectedOptionLabel = "";
    const input = makeInput();
    input.sources.reusableAnswers = [
      {
        id: "application-country",
        kind: "other",
        label: pickerReplay.question,
        question: pickerReplay.question,
        answer: selected,
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    input.hands.chooseOption = (_ref, value) => {
      source.controls[0].value = value;
      source.controls[0].selectedOptionLabel = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    // A combobox answered through type is confirmed the same way.
    const answered = await runApplyAgent(
      input,
      scriptedModel([
        tool === "select"
          ? { name: "select", args: { ref: "c0", option: selected } }
          : { name: "type", args: { ref: "c0", text: selected } },
        { name: "finish", args: { reason: "Confirmed choice." } },
      ]),
    );
    expect(answered.outcome).toBe("prepared");
    expect(source.controls[0].value).toBe(selected);
  }
});

test("a browser refusal hands over before any model call or browser action", async () => {
  const input = config(
    page({
      bodyText: "Access denied. You have been blocked.",
      controls: [],
      actions: [],
    }),
  );
  const model = { chatWithTools: vi.fn() } as unknown as LLMClient;
  const result = await runApplyAgent(input, model);
  expect(result.outcome).toBe("paused");
  expect(result.pauses[0]?.blocker?.code).toBe("browser_blocked");
  expect(result.modelTurns).toBe(0);
  expect(result.readyToSend).toBeNull();
});

describe("Ashby's Yes/No buttons are a question, not the form's buttons", () => {
  const question = "Are you over the age of 18?";
  const yesNo = (pressed: "yes" | "no" | null) =>
    page({
      url: "https://jobs.example.test/acme/1/application",
      controls: [nameControl()],
      actions: [
        {
          index: 0,
          label: "Yes",
          visible: true,
          disabled: false,
          section: question,
          pressed: pressed === "yes",
        },
        {
          index: 1,
          label: "No",
          visible: true,
          disabled: false,
          section: question,
          pressed: pressed === "no",
        },
        {
          index: 2,
          label: "Submit Application",
          visible: true,
          disabled: false,
        },
      ],
    });

  test("the page reads them as one choice under the question, by their own handles", () => {
    const observation = buildApplyFormObservation(
      yesNo("yes"),
      "2026-09-14T10:00:00.000Z",
    );
    expect(observation.actions.map((action) => action.label)).toEqual([
      "Submit Application",
    ]);
    const choices = observation.controls.filter(
      (control) => control.kind === "radio",
    );
    expect(
      choices.map((control) => [
        control.ref,
        control.label,
        control.groupLabel,
        control.checked,
      ]),
    ).toEqual([
      ["a0", "Yes", question, true],
      ["a1", "No", question, false],
    ]);
    expect(choices[0]?.options).toEqual(["Yes", "No"]);
    expect(choices.every((control) => control.answered)).toBe(true);
  });

  test("in Fill a saved answer presses the matching option, and nothing is handed over", async () => {
    const source = yesNo(null);
    const pressed: Array<[string, boolean]> = [];
    const input = config(source, { intermediateWritesAuthorized: false });
    input.hands.setToggle = (ref, checked) => {
      pressed.push([ref, checked]);
      for (const action of source.actions)
        if (action.pressed !== undefined)
          action.pressed = (action.ref ?? `a${action.index}`) === ref;
      return Promise.resolve({ ok: true, observedValue: "pressed" });
    };
    input.sources.reusableAnswers = [
      {
        id: "adult",
        kind: "other",
        label: question,
        question,
        answer: "Yes",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "set_checkbox", args: { ref: "a0", checked: true } },
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(pressed).toEqual([["a0", true]]);
    expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toEqual([]);
  });

  test("Ashby marks the question required only with a class: without an answer the person still gets it", async () => {
    // As on real Ashby in Send for me: the run filled the rest and finished
    // saying the person must answer; that has to become a Needs-you item.
    const source = yesNo(null);
    source.actions = source.actions
      .slice(0, 2)
      .map((action) => ({ ...action, sectionRequired: true }));
    const result = await runApplyAgent(
      config(source),
      repeatingModel("finish", {
        reason:
          "Needs you to answer 'Are you over the age of 18?' before submitting.",
        needsPerson: true,
      }),
    );
    const asked = result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .find((entry) => entry.prompt === question);
    expect(asked?.isRequired).toBe(true);
    expect(asked?.answerOptions).toEqual(["Yes", "No"]);
  });

  test("without an answer the person gets the question with Yes and No to pick", async () => {
    const source = yesNo(null);
    source.actions = source.actions
      .slice(0, 2)
      .map((action) => ({ ...action, section: `${question} *` }));
    const input = config(source, { intermediateWritesAuthorized: false });
    const result = await runApplyAgent(
      input,
      repeatingModel("finish", {
        reason: "The age question needs the person.",
        needsPerson: true,
      }),
    );
    const asked = result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .find((entry) => entry.prompt.startsWith(question));
    expect(asked?.answerControlType).toBe("single_choice");
    expect(asked?.answerOptions).toEqual(["Yes", "No"]);
  });
});

test("a file field the widget removed once storage took the file is attached, not a question", async () => {
  // Greenhouse replaces its resume input with the file's name once the
  // upload lands; the page read still reports the storage's word.
  const source = page({
    controls: [
      nameControl(),
      {
        ...nameControl(),
        index: 1,
        id: "resume",
        name: "resume",
        inputType: "file",
        label: "Attach",
        hint: "Resume/CV *",
        required: true,
        value: "",
        upload: {
          described: "Resume/CV *",
          nearby: "Resume/CV * Attach",
          shown: false,
        },
      },
    ],
  });
  const suppliedResume = {
    id: "resume_document",
    fileName: "resume.txt",
    mimeType: "text/plain",
    label: "Your CV",
    kind: "resume" as const,
    loadBytes: () => Promise.resolve(new TextEncoder().encode("Resume")),
  };
  const input = config(source, {
    intermediateWritesAuthorized: false,
    sources: { ...config(source).sources, documents: [suppliedResume] },
  });
  let uploaded = 0;
  input.hands.uploadFile = (_ref, file) => {
    uploaded = 1;
    // The upload is on its way: the field shows the file, the server has
    // not answered yet.
    source.controls[1] = {
      ...source.controls[1],
      value: `fakepath/${file.name}`,
      upload: {
        described: "Resume/CV *",
        nearby: "Resume/CV * Attach",
        shown: false,
        fileName: file.name,
        network: "pending",
      },
    };
    return Promise.resolve({ ok: true as const, observedValue: file.name });
  };
  const observe = input.hands.observe;
  input.hands.observe = () => {
    // A read later the widget has removed the field, and storage answered.
    if (uploaded > 0 && uploaded++ > 1 && source.controls.length > 1) {
      source.controls = [source.controls[0]];
      source.uploads = [{ fileName: "resume.txt", network: "accepted" }];
    }
    return observe();
  };
  const result = await runApplyAgent(
    input,
    scriptedModel([
      { name: "upload", args: { ref: "c1", documentId: suppliedResume.id } },
      { name: "finish", args: { reason: "The form is ready" } },
      { name: "finish", args: { reason: "The form is ready" } },
    ]),
  );
  expect(
    result.pauses
      .flatMap((pause) => pause.questions ?? [])
      .filter((question) => question.answerControlType === "file"),
  ).toEqual([]);
  expect(result.outcome).toBe("prepared");
});

describe("a finish that says needsPerson always ends paused", () => {
  const sendForMe = {
    authority: {
      mode: "autonomous_submit" as const,
      submitAuthorized: true,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user" as const,
      allowedOrigins: ["https://apply.example.test"],
    },
  };
  const confirmFirst = {
    authority: {
      mode: "confirm_before_submit" as const,
      submitAuthorized: true,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user" as const,
      allowedOrigins: ["https://apply.example.test"],
    },
  };
  const handedOver = (result: ApplyAgentResult) =>
    result.pauses.flatMap((pause) =>
      (pause.questions ?? (pause.question ? [pause.question] : [])).map(
        (question) => question.prompt,
      ),
    );
  const field = (
    index: number,
    label: string,
    required = false,
  ): RawApplyControl => ({
    ...nameControl(),
    index,
    id: `field${index}`,
    name: `field${index}`,
    label,
    required,
    value: "",
  });
  const solvedCheck = (): RawApplyControl => ({
    ...nameControl(),
    index: 1,
    id: "human",
    name: "human",
    inputType: "checkbox",
    role: "checkbox",
    label: "I am not a robot",
    required: false,
    checked: true,
    value: "yes",
  });
  const captchaPage = (...controls: RawApplyControl[]) =>
    page({
      bodyText: "Apply for the role. I am not a robot. Local fake CAPTCHA.",
      controls: [nameControl(), solvedCheck(), ...controls],
    });
  const polar =
    "Product Engineering application is fully filled — Full name Robin Ashford — please review before submitting.";
  const relocationTerms =
    "The person's relocation terms aren't in their profile. Please review before submitting.";
  const relocate =
    "Before sending, can you confirm you agree to relocate to Berlin?";
  const mfa = "Enter the MFA code the site sent to your phone.";
  const captchaItem = "Tick the 'I am not a robot' CAPTCHA.";
  const yesNoQuestion = "Are you based in a EU or equivalent timezone?";
  const longStart =
    "Please describe, in your own words and with as much detail as you can, ";
  const optionals = Array.from(
    { length: 20 },
    (_, index) => `Optional question ${index + 1}`,
  );
  const plain = () => page({ controls: [nameControl()] });

  // The three reviews' probes: a model that ignores the nudge, named items
  // that look like optional fields or a solved check, more items than fit,
  // long items, questions the page left, and a form with another step.
  const scenarios: Array<{
    name: string;
    page: RawApplyPage;
    confirmFirst?: boolean;
    reason?: string;
    forPerson?: string[];
    handed?: string[];
  }> = [
    { name: "Polar's review request", page: plain(), reason: polar },
    {
      name: "a wrapped question about a different technology is a separate task",
      page: page({
        controls: [nameControl(), field(1, "Describe your C# work.", true)],
      }),
      forPerson: ["Please answer: Describe your C++ work."],
      handed: [
        "Describe your C# work.",
        "Please answer: Describe your C++ work.",
      ],
    },
    {
      name: "a Yes/No suffix cannot change a text question's format",
      page: page({
        controls: [
          nameControl(),
          field(1, "Describe your async practices.", true),
        ],
      }),
      forPerson: ["Please answer: Describe your async practices. (Yes/No)"],
      handed: [
        "Describe your async practices.",
        "Please answer: Describe your async practices. (Yes/No)",
      ],
    },
    {
      name: "Polar's review request in Fill in for me",
      page: plain(),
      confirmFirst: true,
      reason: polar,
    },
    {
      name: "relocation terms, reason only",
      page: plain(),
      reason: relocationTerms,
    },
    { name: "agree to relocate, reason only", page: plain(), reason: relocate },
    {
      name: "sign in, reason only",
      page: plain(),
      reason:
        "The site asks the person to sign in before the form can be sent.",
    },
    { name: "MFA code, reason only", page: plain(), reason: mfa },
    {
      name: "human check, reason only",
      page: plain(),
      reason: "Please verify you are human before submitting.",
    },
    {
      name: "relocation terms as an item",
      page: plain(),
      forPerson: [relocationTerms],
      handed: [relocationTerms],
    },
    {
      name: "agree to relocate as an item",
      page: plain(),
      forPerson: [relocate],
      handed: [relocate],
    },
    {
      name: "relocate beside an empty optional Location",
      page: page({ controls: [nameControl(), field(1, "Location")] }),
      forPerson: [relocate],
      handed: [relocate],
    },
    {
      name: "MFA beside an empty optional Phone",
      page: page({ controls: [nameControl(), field(1, "Phone")] }),
      forPerson: [mfa],
      handed: [mfa],
    },
    {
      name: "a verification code is not the phone field's value",
      page: page({ controls: [nameControl(), field(1, "Phone", true)] }),
      forPerson: ["What code should I enter in the required Phone field?"],
      handed: [
        "Phone",
        "What code should I enter in the required Phone field?",
      ],
    },
    {
      name: "a named field with an extra condition stays a separate task",
      page: page({ controls: [nameControl(), field(1, "Phone", true)] }),
      forPerson: [
        "What phone number should I enter in the required Phone field, and do you consent to marketing texts?",
      ],
      handed: [
        "Phone",
        "What phone number should I enter in the required Phone field, and do you consent to marketing texts?",
      ],
    },
    {
      name: "two people's phone fields cannot be identified by label alone",
      page: page({
        controls: [
          nameControl(),
          field(1, "Phone", true),
          { ...field(2, "Phone", true), groupLabel: "Professional reference" },
        ],
      }),
      forPerson: [
        "What phone number should I enter in the required Phone field?",
      ],
      handed: ["What phone number should I enter in the required Phone field?"],
    },
    {
      name: "an optional Yes/No question named exactly",
      page: page({
        controls: [nameControl()],
        actions: [
          {
            index: 0,
            label: "Yes",
            visible: true,
            disabled: false,
            section: yesNoQuestion,
            pressed: false,
          },
          {
            index: 1,
            label: "No",
            visible: true,
            disabled: false,
            section: yesNoQuestion,
            pressed: false,
          },
        ],
      }),
      forPerson: [yesNoQuestion],
    },
    {
      name: "an optional Pronouns field named exactly",
      page: page({ controls: [nameControl(), field(1, "Pronouns")] }),
      forPerson: ["Pronouns"],
      handed: ["Pronouns"],
    },
    {
      name: "a solved check beside a relocation item",
      page: captchaPage(),
      forPerson: [captchaItem, relocate],
      handed: [captchaItem, relocate],
    },
    {
      name: "a solved check and a relocation, reason only",
      page: captchaPage(),
      reason: "CAPTCHA done; confirm relocation to Berlin.",
      handed: ["CAPTCHA done; confirm relocation to Berlin."],
    },
    {
      name: "a solved check, an MFA item and an optional Pronouns",
      page: captchaPage(field(2, "Pronouns")),
      forPerson: [mfa, "Pronouns"],
      handed: [mfa, "Pronouns"],
    },
    {
      name: "only the solved check, named as an item",
      page: captchaPage(),
      forPerson: [captchaItem],
      handed: [captchaItem],
    },
    {
      name: "twenty optional fields named, and a relocation item past them",
      page: page({
        controls: [
          nameControl(),
          ...optionals.map((label, index) => field(index + 1, label)),
        ],
      }),
      forPerson: [...optionals, relocate],
      handed: [relocate],
    },
    {
      name: "a relocation item beside an unanswered required office field",
      page: page({
        controls: [
          nameControl(),
          field(1, "Which office would you work from?", true),
        ],
      }),
      forPerson: [relocate],
      handed: ["Which office would you work from?", relocate],
    },
    {
      name: "two long questions that start the same",
      page: plain(),
      forPerson: [
        `${longStart}why you want to relocate.`,
        `${longStart}your notice period.`,
      ],
      handed: [
        `${longStart}why you want to relocate.`,
        `${longStart}your notice period.`,
      ],
    },
    {
      name: "optional items only, on step 1 of 2",
      page: page({
        stepLabel: "Step 1 of 2",
        controls: [nameControl(), field(1, "Pronouns")],
        actions: [
          { index: 0, label: "Continue", visible: true, disabled: false },
        ],
      }),
      forPerson: ["Pronouns"],
      handed: ["Pronouns"],
    },
    {
      name: "a quoted question the page doesn't show",
      page: plain(),
      reason:
        'The form asks "Which office would you work from?" and only the person knows.',
      handed: ["Which office would you work from?"],
    },
    {
      name: "relocation as an item in Fill in for me",
      page: plain(),
      confirmFirst: true,
      forPerson: [relocate],
      handed: [relocate],
    },
  ];

  test.each([
    { extraTask: false, decorated: false },
    { extraTask: true, decorated: false },
    { extraTask: false, decorated: true },
  ])(
    "finish instruction wrappers reuse the native handover across rereads ($extraTask / $decorated)",
    async ({ extraTask, decorated }) => {
      const narrative = "Describe your async project practices and challenges.";
      const age = "Are you over the age of 21?";
      const manual =
        "Please confirm: you agree to relocate without restrictions.";
      let previousIds: string[] | undefined;
      for (const stepLabel of ["Step 1 of 2", "Step 2 of 2"]) {
        const form = page({
          stepLabel,
          controls: [
            nameControl(),
            {
              ...field(1, narrative, true),
              tagName: "textarea",
              inputType: "textarea",
            },
            ...["Yes", "No"].map((value, i) => ({
              ...field(i + 2, value, true),
              inputType: "radio",
              name: "age",
              groupLabel: age,
              value,
            })),
          ],
        });
        const input = config(form, sendForMe);
        const finalPress = vi.spyOn(input.hands, "clickAction");
        const result = await runApplyAgent(
          input,
          repeatingModel("finish", {
            needsPerson: true,
            reason: "Two form questions need the person.",
            forPerson: [
              decorated
                ? `Please provide your answer for: ${narrative} — required.`
                : `Please answer: ${narrative}`,
              decorated
                ? `${age} Please choose Yes or No — required.`
                : `Please confirm: ${age} (Yes/No)`,
              ...(extraTask ? [manual] : []),
            ],
          }),
        );
        expect(result.outcome).toBe("paused");
        expect(result.readyToSend).toBeNull();
        const questions = result.pauses.flatMap(
          (pause) =>
            pause.questions ?? (pause.question ? [pause.question] : []),
        );
        expect(questions.map((question) => question.prompt)).toEqual([
          narrative,
          age,
          ...(extraTask ? [manual] : []),
        ]);
        expect(
          questions.find((question) => question.prompt === age)?.answerOptions,
        ).toEqual(["Yes", "No"]);
        const ids = questions.map((question) => question.id);
        if (previousIds) expect(ids).toEqual(previousIds);
        previousIds = ids;
        expect(finalPress).not.toHaveBeenCalled();
      }
    },
  );

  test.each([
    "What phone number should I enter in the required Phone field for your Platform Engineer application to Northwind Tools?",
    "What phone number should I enter in the required Phone field?",
    "c1",
  ])("a field handover reuses Phone's native item: %s", async (item) => {
    const phone = { ...field(1, "Phone *", true), inputType: "tel" };
    const form = page({ controls: [nameControl(), phone] });
    const input = config(form, confirmFirst);
    const finalPress = vi.spyOn(input.hands, "clickAction");
    const result = await runApplyAgent(
      input,
      repeatingModel("finish", {
        needsPerson: true,
        reason: "The required phone field needs the person's answer.",
        forPerson: [item],
      }),
    );
    expect(handedOver(result)).toEqual(["Phone *"]);
    expect(result.outcome).toBe("paused");
    expect(result.readyToSend).toBeNull();
    expect(finalPress).not.toHaveBeenCalled();
    const answer = "+44 7700 900123";
    input.sources.reusableAnswers = [
      {
        id: "application_phone",
        kind: "other",
        label: "Phone *",
        question: "Phone *",
        answer,
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const continued = await runApplyAgent(
      input,
      scriptedModel([
        { name: "type", args: { ref: "c1", text: answer } },
        {
          name: "finish",
          args: { reason: "The phone is filled; the form is ready." },
        },
      ]),
    );
    expect(phone.value).toBe(answer);
    expect(continued.outcome).toBe("awaiting_your_review");
    expect(continued.pauses).toEqual([]);
    expect(finalPress).not.toHaveBeenCalled();
  });

  test("finish binds the field before its fresh read renumbers controls", async () => {
    const phone = { ...field(1, "Phone *", true), inputType: "tel" };
    const form = page({ controls: [nameControl(), phone] });
    const model = repeatingModel("finish", {
      needsPerson: true,
      reason: "The phone field needs the person.",
      forPerson: ["c1"],
    });
    const result = await runApplyAgent(config(form, confirmFirst), {
      chatWithTools: async (...args) => {
        const response = await model.chatWithTools(...args);
        phone.index = 2;
        form.controls = [nameControl(), field(1, "Pronouns"), phone];
        return response;
      },
    });
    expect(handedOver(result)).toEqual(["Phone *"]);
    expect(result.outcome).toBe("paused");
  });

  test.each([false, true])(
    "field refs past twenty keep native questions and separate manual steps (%s)",
    async (manualStep) => {
      const labels = Array.from(
        { length: 23 },
        (_, index) => `Form question ${index + 1}`,
      );
      const result = await runApplyAgent(
        config(
          page({
            controls: [
              nameControl(),
              ...labels.map((label, index) => field(index + 1, label)),
            ],
          }),
          confirmFirst,
        ),
        repeatingModel("finish", {
          reason: "These fields need the person.",
          needsPerson: true,
          forPerson: [
            ...labels.map((_, index) => `c${index + 1}`),
            ...(manualStep ? [mfa] : []),
          ],
        }),
      );
      expect(handedOver(result)).toEqual([
        ...labels,
        ...(manualStep ? [mfa] : []),
      ]);
      expect(result.outcome).toBe("paused");
      expect(result.readyToSend).toBeNull();
    },
  );

  test("a wrapped confirmation keeps a filled choice field's native question key and options", async () => {
    const question = "Are you over the age of 21?";
    const form = page({
      controls: [
        nameControl(),
        {
          ...field(1, question),
          tagName: "select",
          inputType: "select-one",
          options: ["Yes", "No"],
          value: "Yes",
          selectedOptionLabel: "Yes",
        },
      ],
    });
    const input = config(form, sendForMe);
    const finalPress = vi.spyOn(input.hands, "clickAction");
    const result = await runApplyAgent(
      input,
      repeatingModel("finish", {
        reason: "Confirm the selected age answer.",
        needsPerson: true,
        forPerson: [`Please confirm: ${question} (Yes/No)`],
      }),
    );
    expect(handedOver(result)).toEqual([question]);
    expect(result.pauses[0]?.questions?.[0]?.answerOptions).toEqual([
      "Yes",
      "No",
    ]);
    expect(result.readyToSend).toBeNull();
    expect(finalPress).not.toHaveBeenCalled();
  });

  test.each(scenarios)(
    "$name: paused, nothing ready to send",
    async (scenario) => {
      const result = await runApplyAgent(
        config(scenario.page, scenario.confirmFirst ? confirmFirst : sendForMe),
        repeatingModel("finish", {
          reason: scenario.reason ?? "Something needs the person.",
          needsPerson: true,
          ...(scenario.forPerson ? { forPerson: scenario.forPerson } : {}),
        }),
      );
      expect(result.outcome).toBe("paused");
      expect(result.readyToSend).toBeNull();
      expect(handedOver(result).length).toBeGreaterThan(0);
      for (const prompt of scenario.handed ?? [])
        expect(handedOver(result)).toContain(prompt);
    },
  );

  test("past twenty items, the rest go together as one more item", async () => {
    const items = Array.from(
      { length: 23 },
      (_, index) => `Question ${index + 1}?`,
    );
    const result = await runApplyAgent(
      config(plain(), sendForMe),
      repeatingModel("finish", {
        reason: "Questions for the person.",
        needsPerson: true,
        forPerson: items,
      }),
    );
    expect(result.outcome).toBe("paused");
    expect(handedOver(result)).toEqual(
      expect.arrayContaining([
        ...items.slice(0, 20),
        "Question 21?; Question 22?; Question 23?",
      ]),
    );
  });

  test("Polar in Send for me: asked once, the model says the form is complete, and it goes out", async () => {
    const contents: string[] = [];
    const model = scriptedModel([
      { name: "finish", args: { reason: polar, needsPerson: true } },
      { name: "finish", args: { reason: polar, needsPerson: false } },
    ]);
    const result = await runApplyAgent(config(plain(), sendForMe), {
      chatWithTools: (messages, definitions) => {
        const last = messages.at(-1);
        if (last?.role === "tool") contents.push(String(last.content));
        return model.chatWithTools(messages, definitions);
      },
    });
    expect(
      contents.some((content) => content.includes("needsPerson false")),
    ).toBe(true);
    expect(result.pauses).toEqual([]);
    expect(result.outcome).toBe("ready_to_send");
    expect(result.readyToSend).toMatchObject({
      actionLabel: "Submit application",
    });
  });
});

describe("a continue keeps the file an earlier attempt attached on the same page", () => {
  const earlier = [
    { label: "Resume", fileName: "resume.txt", field: "Resume/CV" },
  ];
  test("the storage's word on that file puts it on the card", async () => {
    // The widget replaced its resume field with the file's name.
    const source = page({ controls: [nameControl()] });
    source.uploads = [{ fileName: "resume.txt", network: "accepted" }];
    const input = config(source);
    input.earlierAttachments = earlier;
    const result = await runApplyAgent(
      input,
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(
      result.reviewAttachments?.map((entry) => [
        entry.controlLabel,
        entry.fileName,
      ]),
    ).toEqual([["Resume/CV", "resume.txt"]]);
  });

  test("without that word, or with a fresh page, nothing is claimed", async () => {
    const result = await runApplyAgent(
      {
        ...config(page({ controls: [nameControl()] })),
        earlierAttachments: earlier,
      },
      repeatingModel("finish", { reason: "The form is ready" }),
    );
    expect(result.reviewAttachments ?? []).toEqual([]);
  });
});

describe("a closed form comes back without the model", () => {
  /** Answers only a check; any real turn is counted, and finishes stuck. */
  const countingModel = () => {
    let turns = 0;
    const client: LLMClient = {
      chatWithTools: (messages, definitions) => {
        const check = supportedChecks(messages, definitions);
        if (check) return check;
        turns += 1;
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${turns}`,
              type: "function" as const,
              function: {
                name: "finish",
                arguments: JSON.stringify({
                  reason: "The model was asked.",
                  stuck: true,
                }),
              },
            },
          ],
        });
      },
    };
    return { client, turns: () => turns };
  };
  const field = (
    index: number,
    label: string,
    extra: Partial<RawApplyControl> = {},
  ): RawApplyControl => ({
    ...nameControl(),
    index,
    id: `f${index}`,
    name: `f${index}`,
    label,
    value: "",
    ...extra,
  });
  /** Hands that change the page the way a site does. */
  const liveHands = (source: RawApplyPage, input: ApplyAgentConfig) => {
    const find = (ref: string) =>
      source.controls.find((entry) => (entry.ref ?? `c${entry.index}`) === ref);
    const writes: string[] = [];
    input.hands.fillText = (ref, value) => {
      writes.push(`${ref}=${value}`);
      find(ref)!.value = value;
      return Promise.resolve({ ok: true, observedValue: value });
    };
    input.hands.chooseOption = (ref, option) => {
      writes.push(`${ref}=${option}`);
      Object.assign(find(ref)!, { value: option, selectedOptionLabel: option });
      return Promise.resolve({ ok: true, observedValue: option });
    };
    input.hands.setToggle = (ref, checked) => {
      writes.push(`${ref}=${String(checked)}`);
      find(ref)!.checked = checked;
      return Promise.resolve({ ok: true, observedValue: "checked" });
    };
    input.hands.uploadFile = (ref, file) => {
      writes.push(`${ref}=${file.name}`);
      find(ref)!.value = `C:\\fakepath\\${file.name}`;
      return Promise.resolve({ ok: true, observedValue: file.name });
    };
    return writes;
  };
  const resumeDocument = {
    id: "doc_resume",
    fileName: "resume.txt",
    mimeType: "text/plain",
    label: "Your CV",
    kind: "resume" as const,
    loadBytes: () => Promise.resolve(new TextEncoder().encode("resume")),
  };
  const stored = (question: string, answer: string, fieldKey?: string) => ({
    ...(fieldKey ? { fieldKey } : {}),
    question,
    answer,
    source: "your matching saved answer or profile fact",
    sourceId: "profile.fullName",
    written: false,
    groundedIn: ["profile.fullName"],
  });

  test("every stored answer and the file go back by field, and the run finishes with no model call", async () => {
    const source = page({
      controls: [
        field(0, "Full name"),
        field(1, "Email", { inputType: "email" }),
        field(2, "Country", {
          tagName: "select",
          inputType: "select-one",
          options: ["Germany", "United Kingdom"],
        }),
        workAuthorizationRadio(3, "Yes"),
        workAuthorizationRadio(4, "No"),
        field(5, "Pronouns", { required: false, value: "they/them" }),
        field(6, "Resume", { inputType: "file" }),
      ],
    });
    const input = config(source, { intermediateWritesAuthorized: false });
    input.sources.documents = [resumeDocument];
    const writes = liveHands(source, input);
    input.replay = {
      answers: [
        stored("Full name", "Robin Ashford"),
        stored("Email", "robin@example.test"),
        stored("Country", "United Kingdom"),
        stored("Are you legally authorized to work in this country?", "Yes"),
        // The page holds another value: the site's draft or the person's.
        stored("Pronouns", "she/her"),
      ],
      attachments: [
        { field: "Resume", fileName: "resume.txt", label: "Your CV" },
      ],
      path: [],
    };
    const model = countingModel();
    const result = await runApplyAgent(input, model.client);
    expect(model.turns()).toBe(0);
    expect(result.outcome).toBe("prepared");
    expect(writes).toEqual([
      "c6=resume.txt",
      "c0=Robin Ashford",
      "c1=robin@example.test",
      "c2=United Kingdom",
      "c3=true",
    ]);
    expect(source.controls.at(5)?.value).toBe("they/them");
    expect(
      (result.reviewFilled ?? []).find((entry) => entry.label === "Full name")
        ?.answer.provenanceLabel,
    ).toBe("your matching saved answer or profile fact");
  });

  test.each(["radio", "checkbox"] as const)(
    "newly answered Needs-you %s groups replay through the executor",
    async (kind) => {
      const question =
        kind === "radio"
          ? "Are you legally authorized to work in this country?"
          : "Select your skills";
      const source = page({
        controls:
          kind === "radio"
            ? [
                workAuthorizationRadio(0, "Yes"),
                workAuthorizationRadio(1, "No"),
              ]
            : [
                field(0, "TypeScript", {
                  inputType: "checkbox",
                  name: "skills",
                  groupLabel: question,
                  required: false,
                }),
                field(1, "SQL", {
                  inputType: "checkbox",
                  name: "skills",
                  groupLabel: question,
                  required: false,
                }),
              ],
      });
      const input = config(source, { intermediateWritesAuthorized: false });
      input.replay = { answers: [], attachments: [], path: [] };
      input.readReusableAnswers = () =>
        Promise.resolve([
          {
            id: "application_31",
            kind: "other",
            label: question,
            question,
            answer: kind === "radio" ? "Yes" : '["TypeScript","SQL"]',
            roleFamilies: [],
            proofEntryIds: [],
          },
        ]);
      const writes = liveHands(source, input);
      const model = countingModel();
      const result = await runApplyAgent(input, model.client);
      expect(writes).toEqual(
        kind === "radio" ? ["c0=true"] : ["c0=true", "c1=true"],
      );
      expect(model.turns()).toBe(0);
      expect(result.outcome).toBe("prepared");
      expect(result.pauses).toEqual([]);
    },
  );

  test("a saved radio answer the page refuses carries the attempted-write reason", async () => {
    const question = "Are you legally authorized to work in this country?";
    const source = page({
      controls: [
        workAuthorizationRadio(0, "Yes"),
        workAuthorizationRadio(1, "No"),
      ],
    });
    const input = config(source, { intermediateWritesAuthorized: false });
    input.replay = { answers: [], attachments: [], path: [] };
    input.initialUnansweredPickerQuestions = [
      { prompt: question, options: ["Yes", "No"] },
    ];
    input.readReusableAnswers = () =>
      Promise.resolve([
        {
          id: "application_31",
          kind: "other",
          label: question,
          question,
          answer: "Yes",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ]);
    input.hands.setToggle = vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "checked" }),
    );
    const result = await runApplyAgent(input, countingModel().client);
    expect(input.hands.setToggle).toHaveBeenCalled();
    expect(
      result.pauses
        .flatMap((pause) => pause.questions ?? [])
        .some((question) => question.askReason?.kind === "page_refused"),
    ).toBe(true);
  });

  test("a multi-step form: each step's answers go back, and its Next stays the person's", async () => {
    const stepOne = page({
      stepLabel: "Step 1 of 2: Contact",
      controls: [
        field(0, "Full name"),
        field(1, "Email", { inputType: "email" }),
      ],
      actions: [
        {
          index: 0,
          label: "Save and continue",
          visible: true,
          disabled: false,
        },
      ],
    });
    const stepTwo = page({
      stepLabel: "Step 2 of 2: Experience",
      controls: [field(0, "Years of experience")],
    });
    const key = (raw: RawApplyPage, index: number) => {
      const observation = buildApplyFormObservation(
        raw,
        "2026-09-14T10:00:00.000Z",
      );
      const control = observation.controls.at(index);
      if (!control) throw new Error("No such field on the step.");
      return reviewFieldKey(observation, control);
    };
    const replay = {
      answers: [
        stored("Full name", "Robin Ashford", key(stepOne, 0)),
        stored("Email", "robin@example.test", key(stepOne, 1)),
        stored("Years of experience", "8", key(stepTwo, 0)),
      ],
      attachments: [],
      path: [],
    };
    // The page comes back on its first step.
    const first = config(stepOne, { intermediateWritesAuthorized: false });
    const firstWrites = liveHands(stepOne, first);
    first.replay = replay;
    const firstModel = countingModel();
    const handedOver = await runApplyAgent(first, firstModel.client);
    expect(firstModel.turns()).toBe(0);
    expect(firstWrites).toEqual(["c0=Robin Ashford", "c1=robin@example.test"]);
    expect(handedOver.outcome).toBe("paused");
    expect(
      handedOver.pauses.flatMap((pause) => pause.questions ?? [pause.question]),
    ).toContainEqual(
      expect.objectContaining({ id: STEP_HANDOVER_QUESTION_ID }),
    );
    // The person pressed it; the continue fills the second step.
    const second = config(stepTwo, { intermediateWritesAuthorized: false });
    const secondWrites = liveHands(stepTwo, second);
    second.replay = replay;
    const secondModel = countingModel();
    const finished = await runApplyAgent(second, secondModel.client);
    expect(secondModel.turns()).toBe(0);
    expect(secondWrites).toEqual(["c0=8"]);
    expect(finished.outcome).toBe("prepared");
  });

  test("the recorded way in is taken again: the open-form button, then the answers", async () => {
    const listing = page({
      url: "https://apply.example.test/jobs/1",
      controls: [],
      actions: [
        {
          index: 0,
          label: "Apply for this job",
          visible: true,
          disabled: false,
        },
      ],
    });
    const form = page({ controls: [field(0, "Full name")] });
    const source: RawApplyPage = { ...listing };
    const input = config(source, { intermediateWritesAuthorized: false });
    const writes = liveHands(source, input);
    input.hands.clickElement = () => {
      Object.assign(source, form, { controls: form.controls });
      return Promise.resolve({ ok: true, observedValue: "clicked" });
    };
    const listingScreen = screenKey(
      buildApplyFormObservation(listing, "2026-09-14T10:00:00.000Z"),
    );
    input.replay = {
      answers: [stored("Full name", "Robin Ashford")],
      attachments: [],
      path: [
        { from: listingScreen, tool: "click", label: "Apply for this job" },
      ],
    };
    const model = countingModel();
    const result = await runApplyAgent(input, model.client);
    expect(model.turns()).toBe(0);
    expect(writes).toEqual(["c0=Robin Ashford"]);
    expect(result.outcome).toBe("prepared");
    expect(result.formPath).toEqual(input.replay.path);
  });

  test.each([
    ["the model asks for it", "model"],
    ["the earlier run's path has it", "path"],
  ] as const)(
    "in Fill in for me, the link to the page the earlier run's form was on is followed (%s)",
    async (_case, how) => {
      // Workable: the refill starts on the job page, whose Application tab is
      // a link to /apply/. Fill follows no other link: it handed it over.
      const formUrl = "https://apply.example.test/jobs/1/apply/";
      const overview = page({
        url: "https://apply.example.test/jobs/1",
        controls: [],
        actions: [],
        links: [
          {
            index: 0,
            label: "Application",
            href: formUrl,
            target: "",
            visible: true,
            topOffset: 0,
          },
        ],
      });
      const form = page({ url: formUrl, controls: [field(0, "Full name")] });
      const source: RawApplyPage = { ...overview };
      const input = config(source, {
        intermediateWritesAuthorized: false,
        application: {
          ...config(source).application,
          startingUrl: "https://apply.example.test/jobs/1",
        },
      });
      const writes = liveHands(source, input);
      const followed: string[] = [];
      input.hands.followLink = (ref) => {
        followed.push(ref);
        Object.assign(source, form, { controls: form.controls, links: [] });
        return Promise.resolve({ ok: true, url: formUrl });
      };
      input.replay = {
        answers: [stored("Full name", "Robin Ashford")],
        attachments: [],
        formUrl,
        path:
          how === "path"
            ? [
                {
                  from: screenKey(
                    buildApplyFormObservation(
                      overview,
                      "2026-09-14T10:00:00.000Z",
                    ),
                  ),
                  tool: "follow_link",
                  label: "Application",
                  href: formUrl,
                },
              ]
            : [],
      };
      const result = await runApplyAgent(
        input,
        scriptedModel([
          { name: "follow_link", args: { ref: "l0" } },
          { name: "finish", args: { reason: "The form is filled." } },
        ]),
      );
      expect(followed).toHaveLength(1);
      expect(writes).toEqual(["c0=Robin Ashford"]);
      expect(result.outcome).toBe("prepared");
      expect(result.pauses.flatMap((pause) => pause.questions ?? [])).toEqual(
        [],
      );
    },
  );

  test("a field the form no longer has goes to the model, with the rest already back", async () => {
    const source = page({
      controls: [field(0, "Full name"), field(1, "Notice period")],
    });
    const input = config(source, { intermediateWritesAuthorized: false });
    const writes = liveHands(source, input);
    input.replay = {
      answers: [
        stored("Full name", "Robin Ashford"),
        stored("Start date", "Soon"),
      ],
      attachments: [],
      path: [],
    };
    const model = countingModel();
    await runApplyAgent(input, model.client);
    expect(writes[0]).toBe("c0=Robin Ashford");
    // "Notice period" is new and empty: only it needed the model.
    expect(model.turns()).toBeGreaterThan(0);
  });
});

describe("a picker the person filled on the page survives the continue", () => {
  const question = "What country are you based in?";
  const pickerPage = (value: string) =>
    page({
      controls: [
        {
          ...nameControl(),
          role: "combobox",
          label: question,
          value,
          options: [],
        },
      ],
    });
  const continueWith = (source: RawApplyPage, tried = ["kosovo"]) => {
    const chosen: string[] = [];
    const input = config(source, {
      intermediateWritesAuthorized: false,
      initialUnansweredPickerQuestions: [{ prompt: question, options: [] }],
      // The run before typed "Kosovo" and the list did not take it.
      initialPickerAttempts: [
        {
          question: normalizeFormQuestionPrompt(question),
          tried,
          notOffered: [],
          offeredOptions: [],
        },
      ],
    });
    input.hands.chooseOption = (_ref, option) => {
      chosen.push(option);
      return Promise.resolve({ ok: true, observedValue: option });
    };
    return { input, chosen };
  };

  test("a choice the run never typed is the person's: it is kept, not chosen again", async () => {
    const { input, chosen } = continueWith(pickerPage("Albania"));
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(chosen).toEqual([]);
    expect(result.outcome).toBe("prepared");
  });

  test("once the person answered in Needs you, the pick the page shows is theirs and is kept", async () => {
    // The service clears the run's refusals for a question the person answered.
    const { input, chosen } = continueWith(pickerPage("Kosovo"), []);
    const result = await runApplyAgent(
      input,
      scriptedModel([
        { name: "finish", args: { reason: "The form is ready" } },
      ]),
    );
    expect(chosen).toEqual([]);
    expect(result.outcome).toBe("prepared");
    expect(
      (result.reviewFilled ?? []).map((entry) => entry.answer.value),
    ).toContain("Kosovo");
  });

  test("the run's own leftover search is still not an answer", async () => {
    const { input } = continueWith(pickerPage("Kosovo"));
    const result = await runApplyAgent(
      input,
      repeatingModel("finish", { reason: "Looks complete" }),
    );
    expect(result.outcome).toBe("paused");
  });
});

describe("a button that submits its form but reads as neither a step nor its send is the person's", () => {
  // Askable: a contact-only role form whose one button, "Apply", submits
  // the form; its handler posts the answers with fetch.
  const sendForMe = {
    authority: {
      mode: "autonomous_submit" as const,
      submitAuthorized: true,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user" as const,
      allowedOrigins: ["https://apply.example.test"],
    },
  };
  const fillInForMe = {
    authority: {
      ...sendForMe.authority,
      mode: "confirm_before_submit" as const,
    },
  };
  const apply = (index = 0, label = "Apply"): RawApplyAction => ({
    index,
    label,
    visible: true,
    disabled: false,
    formAction: "https://apply.example.test/roles/engineer",
    formMethod: "GET",
    submitsForm: true,
  });
  const email = (): RawApplyControl => ({
    ...nameControl(),
    index: 1,
    id: "email",
    name: "email",
    inputType: "email",
    label: "Email",
    value: "robin@example.test",
  });
  const handedOver = (result: ApplyAgentResult) =>
    result.pauses.flatMap((pause) =>
      (pause.questions ?? []).map((question) => question.prompt),
    );
  const pages: Array<[string, () => RawApplyPage]> = [
    [
      "Askable's role form",
      () => page({ controls: [nameControl(), email()], actions: [apply()] }),
    ],
    [
      "a newsletter box with an email and Apply",
      () => page({ controls: [email()], actions: [apply()] }),
    ],
  ];
  const modes = [
    ["Send for me", sendForMe],
    ["Fill in for me", fillInForMe],
  ] as const;

  for (const [mode, authority] of modes)
    test.each(pages)(
      `${mode}: %s is handed over, and Apply is never pressed`,
      async (_case, source) => {
        for (const model of [
          repeatingModel("click", { ref: "a0" }),
          repeatingModel("finish", { reason: "The form is complete." }),
        ]) {
          const input = config(source(), authority);
          const pressed = vi.fn(input.hands.clickAction);
          const clicked = vi.fn(input.hands.clickElement);
          input.hands.clickAction = pressed;
          input.hands.clickElement = clicked;
          const result = await runApplyAgent(input, model);
          expect(pressed).not.toHaveBeenCalled();
          expect(clicked).not.toHaveBeenCalled();
          expect(result.outcome).toBe("paused");
          expect(result.readyToSend).toBeNull();
          expect(result.reason).toBe(
            `This form's button "Apply" may send your application; press it yourself when you're ready.`,
          );
          expect(handedOver(result)).toContain(
            `Press "Apply" on the site yourself when you're ready`,
          );
        }
      },
    );

  test("a submit button that reads as the send stays the send", async () => {
    const result = await runApplyAgent(
      config(
        page({
          controls: [nameControl()],
          actions: [apply(0, "Submit application")],
        }),
        sendForMe,
      ),
      repeatingModel("finish", { reason: "The form is complete." }),
    );
    expect(result.outcome).toBe("ready_to_send");
  });
});

test("a custom checkbox the page draws itself is a checkbox, and its answer is its state", async () => {
  // Workable's consent box: a div with the checkbox role reads as
  // "contenteditable"; its text was three icons' SVG fallbacks.
  const consent =
    "I have read, understand and accept the content of the Privacy Notice.";
  const result = await runApplyAgent(
    config(
      page({
        controls: [
          nameControl(),
          {
            ...nameControl(),
            index: 1,
            id: "consent",
            name: "",
            tagName: "contenteditable",
            inputType: "checkbox",
            role: "checkbox",
            label: consent,
            required: true,
            checked: true,
            value: "",
          },
        ],
      }),
    ),
    repeatingModel("finish", { reason: "The form is complete." }),
  );
  const answer = result.reviewFilled?.find((entry) => entry.label === consent);
  expect(answer?.answer.value).toBe("Yes");
  expect(answer?.fieldKey).toContain("field:checkbox:");
});
