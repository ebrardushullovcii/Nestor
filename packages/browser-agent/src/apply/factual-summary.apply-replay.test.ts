import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { buildApplyFormObservation } from "./page-hands";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { checkWrittenApplicationAnswer } from "./written-answer-grounding";
import type { ApplyAgentConfig } from "./types";

const remote = "I worked remotely with a distributed team.";
test.each([
  {
    name: "separate training and Docker work never become Kubernetes production experience",
    resume:
      "Completed Kubernetes training. Supported production deployments using Docker.",
    answer: "Working with Kubernetes on production deployments.",
    question: "Describe your experience with Kubernetes in production.",
    postingEvidence: false,
    accepted: false,
  },
  {
    name: "posting-only Kubernetes experience is refused",
    resume: remote,
    answer: "The team uses Kubernetes for production deployments.",
    question: "Describe your experience with Kubernetes in production.",
    postingEvidence: true,
    accepted: false,
  },
  {
    name: "posting evidence grants nothing even when the text is also in the resume",
    resume: remote,
    answer: remote,
    question: "Describe your remote work experience.",
    postingEvidence: true,
    accepted: false,
  },
  {
    name: "a complete recorded applicant statement reaches Fill and Send",
    resume: remote,
    answer: remote,
    question: "Describe your remote work experience.",
    postingEvidence: false,
    accepted: true,
  },
  {
    name: "a negative source never becomes a positive fragment",
    resume: "Never worked with Kubernetes in production.",
    answer: "Worked with Kubernetes in production.",
    question: "Describe your experience with Kubernetes in production.",
    postingEvidence: false,
    accepted: false,
  },
  {
    name: "a specific story cannot be replaced by an unrelated true fact",
    resume: remote,
    answer: remote,
    question:
      "Tell us about a time you had to put your PM hat on to solve a complex product problem.",
    postingEvidence: false,
    accepted: false,
  },
  {
    name: "a situation question in the group still needs the person's story",
    resume: remote,
    answer: remote,
    question: "Your answer",
    group: "Describe a situation where you solved a complex product problem.",
    postingEvidence: false,
    accepted: false,
  },
  {
    name: "a motivation misreading cannot skip a clear story request",
    resume: remote,
    answer: "I am excited about this opportunity.",
    question: "Tell us about a time you solved a complex product problem.",
    postingEvidence: false,
    accepted: false,
    motivation: true,
  },
])("factual-summary Fill and Send: $name", async (entry) => {
  const now = () => new Date("2026-10-27T00:00:00Z");
  const observation = buildApplyFormObservation(
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
          tagName: "textarea",
          inputType: "",
          role: "",
          id: "answer",
          name: "answer",
          label: entry.question,
          groupLabel: entry.group ?? "",
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
        },
      ],
    },
    now().toISOString(),
  );
  const field = observation.controls[0],
    question = questionPrompt(field);
  const sources: ApplyAgentConfig["sources"] = {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      yearsExperience: 2,
      baseResume: {
        id: "resume",
        fileName: "synthetic.txt",
        uploadedAt: now().toISOString(),
        textContent: entry.resume,
      },
    }),
    resumeText: entry.resume,
    reusableAnswers: [],
    documents: [],
    posting: {
      title: "Engineer",
      company: "Example Workshop",
      location: "Remote",
      description: entry.answer,
    },
  };
  const tags = {
    kind: entry.motivation
      ? ("motivation" as const)
      : ("factual_summary" as const),
    country: null,
    sourceId: entry.motivation ? null : "resume.text",
  };
  const client: LLMClient = {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((_, tools) =>
      Promise.resolve({
        toolCalls: [
          {
            id: "read",
            type: "function",
            function: {
              name: tools[0].function.name,
              arguments: JSON.stringify(
                tools[0].function.name === "report_question_kinds"
                  ? {
                      plainIndexes: [0],
                      flagged: [],
                      tags: [{ index: 0, ...tags }],
                    }
                  : {
                      checks: [
                        {
                          index: 0,
                          supported: true,
                          reason: "Lying checker",
                          evidence: [
                            {
                              kind: entry.postingEvidence
                                ? "role_motivation"
                                : "applicant_fact",
                              source: entry.postingEvidence
                                ? "posting"
                                : "resume",
                              path: entry.postingEvidence ? "/description" : "",
                              quote: entry.postingEvidence
                                ? entry.answer
                                : entry.resume,
                              claim: entry.answer,
                            },
                          ],
                        },
                      ],
                    },
              ),
            },
          },
        ],
      }),
    ),
  };
  const fillText = vi.fn((_ref: string, value: string) => {
    field.value = value;
    return Promise.resolve({ ok: true as const, observedValue: value });
  });
  const config = {
    sources,
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
      fillText,
      wait: () => Promise.resolve(),
    },
    siteLabel: "Synthetic employer",
  } as unknown as ApplyAgentConfig;
  const check = vi.fn(
    (question: string, answer: string, evidencePolicy?: "factual_summary") =>
      checkWrittenApplicationAnswer({
        client,
        sources,
        payDisclosed: false,
        question,
        answer,
        ...(evidencePolicy ? { evidencePolicy } : {}),
      }),
  );
  const result = await executeApplyProposal(
    { tool: "type", ref: field.ref, text: entry.answer },
    observation.signature,
    {
      config,
      now,
      guardState: createApplyGuardState(),
      classifyQuestions: () =>
        Promise.resolve(
          new Map([
            [
              question,
              { asksAboutPay: false, declarationKind: null, answerTags: tags },
            ],
          ]),
        ),
      checkWrittenAnswer: check,
    },
  );
  expect(result.kind === "filled").toBe(entry.accepted);
  expect(fillText).toHaveBeenCalledTimes(entry.accepted ? 1 : 0);
  if (entry.motivation) expect(check).not.toHaveBeenCalled();
  if (check.mock.calls.length)
    expect(check).toHaveBeenCalledWith(
      question,
      entry.answer,
      "factual_summary",
    );
  const [send] = await checkClassifiedApplicationAnswers({
    client,
    sources,
    payDisclosed: false,
    answers: [{ question, answer: entry.answer }],
    formControls: observation.controls,
    formContext: { pageText: "Apply", fields: [] },
  });
  expect(send?.supported).toBe(entry.accepted);
});
