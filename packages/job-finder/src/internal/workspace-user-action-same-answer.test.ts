import { describe, expect, it } from "vitest";
import {
  ApplicationAuthorityEnvelopeSchema,
  type CandidateProfile,
  type UserActionRequest,
} from "@nordri/contracts";
import { onlySavedAnswersWereAdded } from "./workspace-application-methods";
import { findManualAnswerStepsCoveredBy } from "./workspace-user-action-methods";

function request(
  id: string,
  runId: string,
  resultId: string,
): UserActionRequest {
  return {
    id,
    kind: "manual_answer",
    state: "pending",
    revision: 1,
    scope: {
      type: "application",
      runId,
      jobId: `job_${resultId}`,
      resultId,
      applicationRecordId: `record_${resultId}`,
      source: "target_site",
    },
  } as unknown as UserActionRequest;
}

function fakeRepository(input: {
  requests: UserActionRequest[];
  questions: Record<
    string,
    {
      id: string;
      prompt: string;
      isRequired?: boolean;
      status?: string;
      note?: string;
    }[]
  >;
  userAnswered?: Record<string, string[]>;
}) {
  return {
    listUserActionRequests: () => Promise.resolve(input.requests),
    listSavedJobs: () => Promise.resolve([]),
    listSavedJobsByIds: () => Promise.resolve([]),
    listApplyJobResults: () => Promise.resolve([]),
    listApplicationQuestionRecords: (scope: { resultId: string }) =>
      Promise.resolve(
        (input.questions[scope.resultId] ?? []).map((question) => ({
          status: "detected",
          isRequired: true,
          ...question,
        })),
      ),
    listApplicationAnswerRecords: (scope: { resultId: string }) =>
      Promise.resolve(
        (input.userAnswered?.[scope.resultId] ?? []).map((questionId) => ({
          questionId,
          sourceKind: "user",
        })),
      ),
  };
}

const authorization = "Are you legally authorized to work in Germany?";

describe("one answer covers the same question across a batch", () => {
  it("answers the other applications of the batch that wait on the same question", async () => {
    const answered = request("a", "run_1", "r_a");
    const sameBatch = request("b", "run_1", "r_b");
    const otherQuestion = request("c", "run_1", "r_c");
    const otherBatch = request("d", "run_2", "r_d");
    const repository = fakeRepository({
      requests: [answered, sameBatch, otherQuestion, otherBatch],
      questions: {
        r_b: [{ id: "q_b", prompt: `  ${authorization.toUpperCase()} ` }],
        r_c: [
          { id: "q_c1", prompt: authorization },
          { id: "q_c2", prompt: "Why do you want this job?" },
        ],
        r_d: [{ id: "q_d", prompt: authorization }],
      },
    });

    const covered = await findManualAnswerStepsCoveredBy({
      ctx: { repository } as never,
      answered: [{ prompt: authorization, answer: "Yes" }],
      request: answered,
      savedForFuture: false,
    });

    // A step with another required question still waits on the person, and
    // a one-off answer stays inside its own batch.
    expect(covered.map((entry) => entry.request.id)).toEqual(["b"]);
    expect(covered[0]?.answers).toEqual([{ questionId: "q_b", answer: "Yes" }]);
  });

  it("reaches other batches once the answer is saved for next time", async () => {
    const answered = request("a", "run_1", "r_a");
    const otherBatch = request("d", "run_2", "r_d");
    const repository = fakeRepository({
      requests: [answered, otherBatch],
      questions: {
        r_d: [
          { id: "q_d", prompt: authorization },
          { id: "q_opt", prompt: "Pronouns", isRequired: false },
          { id: "q_done", prompt: "Phone" },
        ],
      },
      userAnswered: { r_d: ["q_done"] },
    });

    const covered = await findManualAnswerStepsCoveredBy({
      ctx: { repository } as never,
      answered: [{ prompt: authorization, answer: "Yes" }],
      request: answered,
      savedForFuture: true,
    });

    expect(covered).toHaveLength(1);
    expect(covered[0]?.answers).toEqual([{ questionId: "q_d", answer: "Yes" }]);
  });
});

describe("a step asked after the answer was saved", () => {
  it("is covered by the saved answer in any batch", async () => {
    const late = request("late", "run_9", "r_late");
    const repository = fakeRepository({
      requests: [late],
      questions: { r_late: [{ id: "q_late", prompt: authorization }] },
    });

    const covered = await findManualAnswerStepsCoveredBy({
      ctx: { repository } as never,
      answered: [{ prompt: authorization, answer: "Yes" }],
      request: null,
      savedForFuture: true,
      states: ["pending"],
    });

    expect(covered.map((entry) => entry.request.id)).toEqual(["late"]);
  });
});

describe("an answer saved while a batch runs", () => {
  const profile = {
    fullName: "Jamie Rivers",
    answerBank: {
      workAuthorization: null,
      customAnswers: [{ id: "a1", question: "Phone?", answer: "+49" }],
    },
  } as unknown as CandidateProfile;

  it("does not count as a profile change for the application being filled in", () => {
    const after = {
      ...profile,
      answerBank: {
        ...profile.answerBank,
        customAnswers: [
          ...profile.answerBank.customAnswers,
          { id: "a2", question: "Authorized?", answer: "Yes" },
        ],
      },
    } as unknown as CandidateProfile;
    expect(onlySavedAnswersWereAdded(profile, after)).toBe(true);
  });

  it("still counts any other edit", () => {
    expect(
      onlySavedAnswersWereAdded(profile, {
        ...profile,
        fullName: "Someone Else",
      } as CandidateProfile),
    ).toBe(false);
    expect(
      onlySavedAnswersWereAdded(profile, {
        ...profile,
        answerBank: { ...profile.answerBank, customAnswers: [] },
      } as unknown as CandidateProfile),
    ).toBe(false);
  });
});

it.each([false, true])(
  "a background-check answer crosses applications only when deliberately saved (%s)",
  async (savedForFuture) => {
    const answered = request("a", "run_1", "r_a");
    const other = request("b", "run_1", "r_b");
    const prompt = "I consent to a background check";
    const repository = fakeRepository({
      requests: [answered, other],
      questions: { r_b: [{ id: "q_b", prompt }] },
    });
    const covered = await findManualAnswerStepsCoveredBy({
      ctx: { repository } as never,
      answered: [{ prompt, answer: "Yes" }],
      request: answered,
      savedForFuture,
    });
    expect(covered).toHaveLength(savedForFuture ? 1 : 0);
  },
);

it("a one-use answer to an unnamed-country question stays on its application", async () => {
  const answered = request("a", "run_1", "r_a");
  const other = request("b", "run_1", "r_b");
  const prompt = "Are you authorized to work in this country?";
  const repository = fakeRepository({
    requests: [answered, other],
    questions: {
      r_b: [
        {
          id: "q_b",
          prompt,
          note: "Neither the question nor the posting names the country.",
        },
      ],
    },
  });
  expect(
    await findManualAnswerStepsCoveredBy({
      ctx: { repository } as never,
      answered: [{ prompt, answer: "No" }],
      request: answered,
      savedForFuture: false,
    }),
  ).toEqual([]);
});

it.each([
  "Expected salary",
  "Current pay",
  "Past pay",
  "Pay history",
  "Salary currency",
  "Currency",
])(
  "keeps %s on its application when pay disclosure is off, including library answers",
  async (prompt) => {
    const answered = request("a", "run_1", "r_a");
    const other = request("b", "run_1", "r_b");
    const repository = fakeRepository({
      requests: [answered, other],
      questions: { r_b: [{ id: "q_b", prompt }] },
    });
    for (const savedForFuture of [false, true]) {
      for (const source of [answered, null]) {
        expect(
          await findManualAnswerStepsCoveredBy({
            ctx: { repository } as never,
            answered: [{ prompt, answer: "42000 EUR" }],
            request: source,
            savedForFuture,
          }),
        ).toEqual([]);
      }
    }
  },
);

it.each(["pause_for_user", "answer_from_profile"] as const)(
  "pay fan-out follows the person's pay setting, carried over from an older permission (%s)",
  async (salaryDisclosure) => {
    const answered = request("a", "run_1", "r_a");
    const other = request("b", "run_1", "r_b");
    const sha256 = "a".repeat(64);
    const envelope = ApplicationAuthorityEnvelopeSchema.parse({
      id: "pay_permission",
      mode: "confirm_before_submit",
      status: "active",
      revision: 1,
      scope: { campaignId: null, jobIds: ["job_r_b"] },
      maxApplicationsPerRun: 2,
      maxApplicationsPerLocalDay: 2,
      intermediateMutationsAuthorized: false,
      accountCreationAuthorized: false,
      allowedResumeSha256: [sha256],
      allowedOrigins: ["https://replica.test"],
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      revokedAt: null,
      decisionPolicy: {
        version: 1,
        revision: 1,
        digest: "b".repeat(64),
        answerPolicy: {
          approvedAnswerSnapshot: { revision: 1, digest: "c".repeat(64) },
          unknownRequiredQuestion: "pause_for_user",
          unknownEligibility: "pause_for_user",
          unknownLegalRequirement: "pause_for_user",
          preApprovedAttestationKinds: [],
          salaryDisclosure,
        },
        stopConditions: {
          unavailableCredentials: "pause_for_user",
          loginRequired: "pause_for_user",
          mfaRequired: "pause_for_user",
          captcha: "pause_for_user",
          antiBot: "pause_for_user",
          accountCreation: "pause_for_user",
          staleObservation: "pause_for_user",
          ambiguousFinalControl: "pause_for_user",
          originDrift: "pause_for_user",
          outcomeUncertain: "stop_no_retry",
        },
      },
    });
    const repository = {
      ...fakeRepository({
        requests: [answered, other],
        questions: {
          r_b: [
            { id: "q_pay", prompt: "Expected salary" },
            { id: "q_currency", prompt: "Currency" },
          ],
        },
      }),
      listSavedJobs: () =>
        Promise.resolve([
          {
            id: "job_r_b",
            canonicalUrl: "https://replica.test/job",
            applicationUrl: "https://replica.test/apply",
          },
        ]),
      listSavedJobsByIds: (ids: readonly string[]) =>
        Promise.resolve(
          [
            {
              id: "job_r_b",
              canonicalUrl: "https://replica.test/job",
              applicationUrl: "https://replica.test/apply",
            },
          ].filter((job) => ids.includes(job.id)),
        ),
      listApplyJobResults: () =>
        Promise.resolve([
          { id: "r_b", privacyReceipt: { resume: { sha256 } } },
        ]),
      listApplicationAuthorityEnvelopes: () => Promise.resolve([envelope]),
      // No pay choice saved yet: the older permission's choice is carried over.
      getSettings: () => Promise.resolve(settings),
      commitSettingsUpdate: (update: (current: object) => object) => {
        settings = update(settings);
        return Promise.resolve(settings);
      },
    };
    let settings: object = {};
    const covered = await findManualAnswerStepsCoveredBy({
      ctx: { repository } as never,
      answered: [
        { prompt: "Expected salary", answer: "42000" },
        { prompt: "Currency", answer: "EUR" },
      ],
      request: answered,
      savedForFuture: true,
    });
    expect(covered).toHaveLength(
      salaryDisclosure === "answer_from_profile" ? 1 : 0,
    );
    if (salaryDisclosure === "answer_from_profile")
      expect(covered[0]?.answers).toEqual([
        { questionId: "q_pay", answer: "42000" },
        { questionId: "q_currency", answer: "EUR" },
      ]);
    expect(settings).toEqual({ salaryDisclosure });
  },
);
