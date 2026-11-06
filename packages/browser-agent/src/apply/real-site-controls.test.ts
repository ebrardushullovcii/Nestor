import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";

import { buildApplyFormObservation } from "./page-hands";
import {
  buildPendingQuestion,
  createApplyGuardState,
  executeApplyProposal,
} from "./policy-executor";
import type { ApplyAgentConfig } from "./types";

const now = () => new Date("2026-11-06T00:00:00Z");
function field(overrides: Partial<RawApplyControl> = {}): RawApplyControl {
  return {
    index: 0,
    tagName: "input",
    inputType: "text",
    role: "",
    id: "name",
    name: "name",
    scopeKey: "form0",
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
    value: "",
    checked: false,
    multiple: false,
    options: [],
    selectedOptionLabel: "",
    ...overrides,
  };
}
function page(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    networkMutationCount: 0,
    url: "https://employer.example.test/jobs/1",
    title: "Engineer",
    bodyText: "Apply for Engineer",
    headings: [],
    controls: [],
    actions: [],
    clickables: [],
    links: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
    ...overrides,
  };
}
function config(raw: RawApplyPage): ApplyAgentConfig {
  const write = (ref: string, value: string) => {
    const c = raw.controls.find((c) => (c.ref ?? `c${c.index}`) === ref)!;
    c.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  };
  return {
    sources: {
      profile: CandidateProfileSchema.parse({
        id: "synthetic",
        fullName: "Jamie Example",
        currentCountry: "Germany",
        summary: "Twelve years building React and TypeScript.",
        yearsExperience: 12,
        workEligibility: {
          authorizedWorkCountries: ["Germany"],
          requiresVisaSponsorship: false,
        },
        baseResume: {
          id: "synthetic",
          fileName: "synthetic.txt",
          uploadedAt: now().toISOString(),
        },
      }),
      resumeText: null,
      documents: [],
      reusableAnswers: [],
      posting: {
        title: "Engineer",
        company: "Synthetic Workshop",
        location: "Germany",
        resolvedCountry: "DE",
        description: "Build software.",
      },
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
    siteLabel: "Synthetic Workshop",
    now,
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, now().toISOString())),
      fillText: write,
      chooseOption: write,
      setToggle: (ref, checked) => {
        raw.controls.find((c) => (c.ref ?? `c${c.index}`) === ref)!.checked =
          checked;
        return Promise.resolve({
          ok: true as const,
          observedValue: String(checked),
        });
      },
      navigate: (url) => Promise.resolve({ ok: true, url }),
      goBack: () => Promise.resolve({ ok: true, url: raw.url! }),
      followLink: () => Promise.resolve({ ok: true, url: raw.url! }),
      clickAction: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      clickElement: () =>
        Promise.resolve({ ok: true, observedValue: "clicked" }),
      scroll: () => Promise.resolve({ ok: true, observedValue: "scrolled" }),
      wait: () => Promise.resolve(),
      readText: () => Promise.resolve(raw.bodyText),
      uploadFile: () =>
        Promise.resolve({ ok: false, error: "No file supplied" }),
    },
  };
}
function finishModel(
  forPerson: string[],
  reason = "The remaining questions need you.",
): LLMClient {
  return {
    chatWithTools: () =>
      Promise.resolve({
        toolCalls: [
          {
            id: "finish",
            type: "function",
            function: {
              name: "finish",
              arguments: JSON.stringify({
                reason,
                needsPerson: true,
                forPerson,
              }),
            },
          },
        ],
      }),
  };
}
function radios(question: string, options: string[]): RawApplyControl[] {
  return options.map((label, index) =>
    field({
      index,
      tagName: "contenteditable",
      inputType: "radio",
      role: "radio",
      name: "",
      id: `choice-${index}`,
      label: `${question} ${label}`,
      groupLabel: question,
      sectionPath: [question],
      value: "",
    }),
  );
}

test("a five-option ARIA radio field produces one question with all five options", async () => {
  const question = "What is your level of proficiency in English?";
  const options = [
    "Native/Fluent",
    "Advanced",
    "Intermediate",
    "Basic",
    "Beginner",
  ];
  const raw = page({ controls: radios(question, options) });
  const observation = buildApplyFormObservation(raw, now().toISOString());
  const questions = observation.controls.map((control) =>
    buildPendingQuestion({
      control,
      jobId: "synthetic",
      detectedAt: now().toISOString(),
      suggestion: null,
      siblings: observation.controls,
    }),
  );
  expect(new Set(questions.map((q) => q.id)).size).toBe(1);
  expect(questions[0].answerOptions).toEqual(options);
  const result = await runApplyAgent(
    config(raw),
    finishModel(observation.controls.map((c) => c.ref)),
  );
  const pending = result.pauses.flatMap(
    (p) => p.questions ?? (p.question ? [p.question] : []),
  );
  expect(new Set(pending.map((q) => q.id)).size).toBe(1);
  expect(pending[0].prompt).toBe(question);
});

test.each([true, false])(
  "a deferred file shown beside Add file is accepted without an upload request (input retained: %s)",
  async (retained) => {
    const raw = page({
      bodyText:
        "Your application\nError submitting application\nThere was an error submitting your application. Please try again.\nDocuments\nPlease upload your application documents here (in total max. 20 MB).\nCV*\nAdd file",
      actions: [
        {
          index: 0,
          label: "Submit application",
          visible: true,
          disabled: false,
        },
      ],
      controls: [
        field({
          inputType: "file",
          name: "documents.cv",
          label: "Upload CV",
          visible: false,
        }),
      ],
    });
    const input = config(raw);
    input.sources.documents = [
      {
        id: "resume",
        kind: "resume",
        label: "Synthetic CV",
        fileName: "synthetic.pdf",
        mimeType: "application/pdf",
        loadBytes: () =>
          Promise.resolve(new TextEncoder().encode("Synthetic CV")),
      },
    ];
    const upload = vi.fn((_ref: string, file: { name: string }) => {
      raw.controls[0].value = retained ? file.name : "";
      raw.controls[0].upload = {
        described: "",
        nearby: `Documents\nPlease upload your application documents here (in total max. 20 MB).\nCV*\n${file.name}\n×\nAdd file`,
        shown: false,
        selectedFileName: file.name,
        ...(retained ? { fileName: file.name } : {}),
      };
      return Promise.resolve({ ok: true as const, observedValue: file.name });
    });
    input.hands.uploadFile = upload;
    let calls = 0;
    const model: LLMClient = {
      chatWithTools: () =>
        Promise.resolve({
          toolCalls: [
            {
              id: `call-${calls}`,
              type: "function",
              function:
                calls++ === 0
                  ? {
                      name: "upload",
                      arguments: JSON.stringify({
                        ref: "c0",
                        documentId: "resume",
                      }),
                    }
                  : {
                      name: "finish",
                      arguments: JSON.stringify({
                        reason: "The selected CV is kept for final Send.",
                      }),
                    },
            },
          ],
        }),
    };
    const result = await runApplyAgent(input, model);
    expect(upload).toHaveBeenCalledOnce();
    expect(raw.networkMutationCount).toBe(0);
    expect(result.outcome, result.notes.join("\n")).toBe("prepared");
    expect(result.pauses).toEqual([]);
    expect(result.reviewAttachments?.map((file) => file.fileName)).toContain(
      "synthetic.pdf",
    );
  },
);

test("a native tab opens a panel without becoming a write or a final Send", async () => {
  const raw = page({
    actions: [
      {
        index: 0,
        label: "Submit application",
        role: "tab",
        visible: true,
        disabled: false,
        inForm: true,
        formAction: page().url!,
        formMethod: "POST",
        submitsForm: false,
      },
    ],
  });
  const input = config(raw),
    observation = await input.hands.observe(),
    guardState = createApplyGuardState();
  const click = vi.spyOn(input.hands, "clickElement");
  expect(observation.actions[0]).toMatchObject({
    role: "tab",
    kind: "other",
    submitsForm: false,
  });
  const outcome = await executeApplyProposal(
    { tool: "click", ref: "a0" },
    observation.signature,
    { config: input, now, guardState },
  );
  expect(outcome.kind).toBe("moved");
  expect(click).toHaveBeenCalledOnce();
  expect(guardState.hasWritten).toBe(false);

  const submit = await executeApplyProposal(
    { tool: "submit_application", ref: "a0" },
    observation.signature,
    { config: input, now, guardState },
  );
  expect(submit.kind).toBe("ready_to_send");
  expect(click).toHaveBeenCalledOnce();
});
