import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { buildApplyFormObservation } from "./page-hands";
import { classifyAnswerPermission } from "./answer-source-catalog";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import { listingDiscoveryAnswer } from "./listing-discovery-answer";
import type { ApplyAgentConfig } from "./types";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";

const now = () => new Date("2026-10-26T00:00:00.000Z");
const field = buildApplyFormObservation(
  {
    url: "https://employer.example.test/apply",
    title: "Apply",
    bodyText: "My Information",
    headings: [],
    controls: [
      {
        index: 0,
        tagName: "select",
        inputType: "",
        role: "",
        id: "source",
        name: "source",
        label: "How did you hear about this job?",
        groupLabel: "My Information",
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
        options: ["Job board", "Company website", "Referral", "Other"],
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
function sources(label: string, url: string): ApplyAgentConfig["sources"] {
  return {
    listingDiscovery: { label, url },
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      yearsExperience: 2,
      baseResume: {
        id: "resume",
        fileName: "resume.txt",
        uploadedAt: now().toISOString(),
        extractionStatus: "ready",
      },
    }),
    resumeText: null,
    posting: {
      title: "Engineer",
      company: "Example",
      location: "United Kingdom",
      description: "Build tools",
    },
    reusableAnswers: [
      {
        id: "saved",
        kind: "other",
        label: "Source",
        question: "My Information — How did you hear about this job?",
        answer: "Job board",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ],
    documents: [],
  };
}

test.each([
  ["Local job board", "https://listing.example.test/jobs/1", "Job board"],
  [
    "Company careers page",
    "https://employer.example.test/roles/1",
    "Company website",
  ],
  ["Unclassified source", "https://listing.example.test/board/", "Other"],
  ["Unclassified source", "https://employer.example.test/careers/", "Other"],
  [
    "Regional opportunities",
    "https://regional-jobs.example.test/careers/",
    "Other",
  ],
  ["Unclassified source", "https://listing.example.test/jobs/1", "Other"],
])(
  "source categories are grounded in discovery, not a saved referral: %s",
  (label, url, expected) => {
    const src = sources(label, url),
      control = field.controls[0];
    expect(listingDiscoveryAnswer(control, src)?.value).toBe(expected);
    expect(
      classifyAnswerPermission({
        control,
        controls: field.controls,
        tags: { kind: "other", country: null, sourceId: "listingDiscovery" },
        sources: src,
        answer: expected,
        pageInstructions: "",
      }).kind,
    ).toBe("literal");
    expect(
      classifyAnswerPermission({
        control,
        controls: field.controls,
        tags: { kind: "other", country: null, sourceId: "listingDiscovery" },
        sources: src,
        answer: "Referral",
        pageInstructions: "",
      }).kind,
    ).toBe("needs_you");
    expect(
      listingDiscoveryAnswer({ ...control, options: ["Referral"] }, src),
    ).toBeNull();
  },
);

test("Workday source reaches the picker once after the typed gate, with the saved agreeing answer", async () => {
  const src = sources("Local job board", "https://listing.example.test/board/");
  const control = {
    ...field.controls[0],
    answerTags: {
      kind: "other",
      country: null,
      sourceId: "answerLibrary.saved",
    } as const,
  };
  const observation = { ...field, controls: [control] };
  const chooseOption = vi.fn((_ref: string, option: string) =>
    Promise.resolve({
      ok: true as const,
      observedValue: option,
    }),
  );
  const config = {
    sources: src,
    application: { jobId: "1", applicationId: "1", startingUrl: field.url! },
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
      allowedOrigins: [],
    },
    hands: { observe: () => Promise.resolve(observation), chooseOption },
    siteLabel: "Synthetic employer",
  } as unknown as ApplyAgentConfig;
  const outcome = await executeApplyProposal(
    { tool: "select", ref: control.ref, option: "Job board" },
    field.signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              "My Information — How did you hear about this job?",
              {
                answerTags: control.answerTags,
                asksAboutPay: false,
                declarationKind: null,
              },
            ],
          ]),
        ),
    },
  );
  expect(outcome.kind).toBe("filled");
  expect(chooseOption).toHaveBeenCalledExactlyOnceWith(
    control.ref,
    "Job board",
  );
});

test("Send rechecks the source category against the actual options, without accepting a saved referral", async () => {
  const question = "My Information — How did you hear about this job?";
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        toolCalls: [
          {
            id: "read",
            type: "function" as const,
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
                    sourceId: "listingDiscovery",
                  },
                ],
              }),
            },
          },
        ],
      }),
    ),
  };
  for (const answer of ["Job board", "Referral"]) {
    const result = await checkClassifiedApplicationAnswers({
      client,
      sources: sources(
        "Local job board",
        "https://listing.example.test/board/",
      ),
      payDisclosed: false,
      answers: [{ question, answer }],
      formControls: field.controls,
      formContext: {
        pageText: "My Information",
        fields: [{ question, value: answer }],
      },
    });
    expect(result[0]?.supported).toBe(answer === "Job board");
  }
});

test.each([false, true])(
  "a source radio selects only the approved option (typed gate: %s)",
  async (typed) => {
    const src = sources(
      "Local job board",
      "https://listing.example.test/jobs/1",
    );
    const controls = ["Job board", "Referral", "Other"].map((label, index) => ({
      ...field.controls[0],
      ref: `r${index}`,
      kind: "radio" as const,
      groupLabel: "How did you hear about this job?",
      label,
      value: label,
      options: [],
      choiceGroupKey: "source",
      answerControlType: "single_choice" as const,
    }));
    const observation = { ...field, controls };
    const setToggle = vi.fn((ref: string, checked: boolean) => {
      controls.find((control) => control.ref === ref)!.checked = checked;
      return Promise.resolve({
        ok: true as const,
        observedValue: checked ? "checked" : "unchecked",
      });
    });
    const config = {
      sources: src,
      application: { jobId: "1", applicationId: "1", startingUrl: field.url! },
      authority: {
        mode: "prepare_only",
        submitAuthorized: false,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "pause_for_user",
        allowedOrigins: [],
      },
      hands: { observe: () => Promise.resolve(observation), setToggle },
      siteLabel: "Synthetic employer",
    } as unknown as ApplyAgentConfig;
    const deps = {
      config,
      now,
      guardState: createApplyGuardState(),
      ...(typed
        ? {
            classifyQuestions: () =>
              Promise.resolve(
                new Map([
                  [
                    "How did you hear about this job?",
                    {
                      asksAboutPay: false,
                      declarationKind: null,
                      answerTags: {
                        kind: "other" as const,
                        country: null,
                        sourceId: "listingDiscovery",
                      },
                    },
                  ],
                ]),
              ),
          }
        : {}),
    };
    const wrong = await executeApplyProposal(
      { tool: "set_checkbox", ref: "r1", checked: true },
      field.signature,
      deps,
    );
    expect(wrong.kind).toBe("suggestion");
    expect(setToggle).not.toHaveBeenCalled();
    const correct = await executeApplyProposal(
      { tool: "set_checkbox", ref: "r0", checked: true },
      field.signature,
      deps,
    );
    expect(correct).toMatchObject({
      kind: "filled",
      filled: { ref: "r0", answer: { value: "Job board" } },
    });
    expect(setToggle).toHaveBeenCalledExactlyOnceWith("r0", true);
    expect(controls[1].checked).toBe(false);
  },
);
