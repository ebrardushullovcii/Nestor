import {
  CandidateProfileSchema,
  type CandidateReusableAnswer,
} from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { savedAnswerForQuestion } from "./application-facts";
import { checkClassifiedApplicationAnswers } from "./classified-answer-check";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import type {
  ApplyAgentConfig,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyPageHands,
} from "./types";

const question = "How/when did you start coding?";
const answer =
  "My first recorded engineering role began at Fictional Tools in March 2020. I built internal services.";
const saved: CandidateReusableAnswer = {
  id: "application_approved-response",
  kind: "other",
  label: question,
  question,
  answer,
  roleFamilies: [],
  proofEntryIds: [],
  applicationScope: {
    applicationRecordId: "application_1",
    resultId: null,
    location: null,
  },
};
const field = (ref: string, groupLabel = question): ApplyFormControl => ({
  ref,
  kind: "long_text",
  label: question,
  groupLabel,
  placeholder: "",
  required: true,
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  checked: false,
  options: [],
  selectedOptionLabel: "",
  invalid: false,
  validationMessage: "",
  questionKind: "other",
  answerControlType: "text",
  attestationKind: null,
  answered: false,
});
const tags = { kind: "own_words", country: null, sourceId: null } as const;
const sources: ApplyAgentConfig["sources"] = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: 0,
    baseResume: {
      id: "synthetic-resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      textContent: "Synthetic applicant.",
    },
  }),
  resumeText: null,
  documents: [],
  reusableAnswers: [saved],
  posting: {
    title: "Engineer",
    company: "Fictional Tools",
    location: "Remote",
    description: "",
  },
};
const application = {
  jobId: "1",
  applicationId: "application_1_attempt_2",
  applicationRecordId: "application_1",
  startingUrl: "https://application.example.test/form",
};

test("an approved written answer survives continue, an empty refill and the Send check", async () => {
  const checkWrittenAnswer = vi.fn().mockResolvedValue({
    supported: false,
    reason: "Do not regenerate the person's answer.",
  });
  // The field wrapper repeats its label as a group. Refilling replaces the DOM handles.
  for (const ref of [
    "continued-textarea",
    "refilled-textarea",
    "later-continue-textarea",
  ]) {
    const control = field(ref);
    const observation: ApplyFormObservation = {
      url: application.startingUrl,
      origin: "https://application.example.test",
      title: "Apply",
      bodyTextExcerpt: "Application questions",
      signature: ref,
      observedAt: "2026-10-27T00:00:00.000Z",
      controls: [control],
      actions: [],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      blocker: null,
      loading: false,
      validationErrors: [],
      step: { label: null, index: null, total: null },
    };
    const fillText = vi.fn((_ref: string, value: string) => {
      control.value = value;
      control.answered = true;
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    const unexpectedWrite = () =>
      Promise.reject(new Error("Only the approved text should be written."));
    const hands: ApplyPageHands = {
      observe: () => Promise.resolve(observation),
      fillText,
      wait: () => Promise.resolve(),
      navigate: unexpectedWrite,
      clickElement: unexpectedWrite,
      scroll: unexpectedWrite,
      goBack: unexpectedWrite,
      readText: () => Promise.resolve("Application questions"),
      chooseOption: unexpectedWrite,
      setToggle: unexpectedWrite,
      uploadFile: unexpectedWrite,
      clickAction: unexpectedWrite,
      followLink: unexpectedWrite,
    };
    const config: ApplyAgentConfig = {
      hands,
      sources,
      application,
      siteLabel: "Synthetic careers site",
      authority: {
        mode: "prepare_only",
        submitAuthorized: false,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "pause_for_user",
        allowedOrigins: [],
      },
    };
    const result = await executeApplyProposal(
      { tool: "type", ref, text: answer },
      observation.signature,
      {
        config,
        guardState: createApplyGuardState(),
        now: () => new Date("2026-10-27T00:00:00.000Z"),
        classifyQuestions: () =>
          Promise.resolve(
            new Map([
              [
                question,
                {
                  asksAboutPay: false,
                  declarationKind: null,
                  answerTags: tags,
                },
              ],
            ]),
          ),
        checkWrittenAnswer,
      },
    );
    expect(result).toMatchObject({
      kind: "filled",
      filled: { answer: { value: answer, sourceKind: "answer_library" } },
    });
    expect(fillText).toHaveBeenCalledExactlyOnceWith(ref, answer);
    const client = {
      chatWithTools: vi.fn().mockResolvedValue({
        content: "",
        toolCalls: [
          {
            id: "classification",
            type: "function",
            function: {
              name: "report_question_kinds",
              arguments: JSON.stringify({
                plainIndexes: [0],
                flagged: [],
                tags: [{ index: 0, ...tags, declarationPurpose: null }],
              }),
            },
          },
        ],
      }),
    } as unknown as LLMClient;
    expect(
      await checkClassifiedApplicationAnswers({
        client,
        sources,
        application,
        payDisclosed: false,
        answers: [{ question, answer }],
        formControls: [control],
        formContext: { pageText: "Application questions", fields: [] },
      }),
    ).toMatchObject([{ supported: true }]);
    expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  }
  expect(checkWrittenAnswer).not.toHaveBeenCalled();
});

test("only the same question reuses the approval; a distinct section or duplicate target stays ambiguous", () => {
  const current = field("current");
  expect(savedAnswerForQuestion(current, [saved], [current])).toBe(saved);
  const otherSection = field("reference", "Professional reference");
  expect(
    savedAnswerForQuestion(otherSection, [saved], [otherSection]),
  ).toBeNull();
  const second = field("second");
  expect(
    savedAnswerForQuestion(current, [saved], [current, second]),
  ).toBeNull();
  expect(
    savedAnswerForQuestion(
      current,
      [{ ...saved, needsConfirmation: true }],
      [current],
    ),
  ).toBeNull();
});
