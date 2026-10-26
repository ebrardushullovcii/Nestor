import { expect, test } from "vitest";
import { CandidateProfileSchema } from "./profile";
import { createFreshStartCandidateProfile } from "./profile-setup";
import { JobSearchPreferencesSchema } from "./discovery";
import { ProfileCopilotPatchOperationSchema } from "./profile-copilot";

test("stored Profile JSON retains retired answer fields and saved proposal operations", () => {
  const old = {
    ...createFreshStartCandidateProfile(),
    answerBank: {
      selfIntroduction: "A synthetic introduction.",
      customAnswers: [
        {
          id: "old-answer",
          label: "Old answer",
          question: "Synthetic question?",
          answer: "Synthetic answer.",
        },
      ],
    },
  };
  const parsed = CandidateProfileSchema.parse(old);
  expect(parsed.answerBank.selfIntroduction).toBe(
    old.answerBank.selfIntroduction,
  );
  expect(parsed.answerBank.customAnswers[0]?.answer).toBe("Synthetic answer.");
  expect(
    CandidateProfileSchema.parse(JSON.parse(JSON.stringify(parsed))),
  ).toEqual(parsed);
  for (const operation of [
    {
      operation: "replace_answer_bank_fields",
      value: { selfIntroduction: "A synthetic introduction." },
    },
    {
      operation: "upsert_reusable_answer",
      record: old.answerBank.customAnswers[0],
    },
    { operation: "remove_reusable_answer", recordId: "old-answer" },
  ])
    expect(
      ProfileCopilotPatchOperationSchema.safeParse(operation).success,
    ).toBe(true);
});

test("stored search-preferences JSON retains retired discovery data", () => {
  const preferences = JobSearchPreferencesSchema.parse({
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    minimumSalaryUsd: null,
    discovery: {
      targets: [
        {
          id: "old-source",
          label: "Legacy source",
          startingUrl: "https://synthetic.test/jobs",
        },
      ],
      remoteCountsAsAnyLocation: false,
    },
  });
  expect(preferences.discovery.targets[0]?.id).toBe("old-source");
  expect(preferences.discovery.remoteCountsAsAnyLocation).toBe(false);
  expect(
    JobSearchPreferencesSchema.parse(JSON.parse(JSON.stringify(preferences))),
  ).toEqual(preferences);
});
