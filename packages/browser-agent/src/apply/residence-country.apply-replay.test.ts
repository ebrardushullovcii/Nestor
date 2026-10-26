import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { buildApplyFormObservation } from "./page-hands";
import { createApplyGuardState, executeApplyProposal } from "./policy-executor";
import type { ApplyAgentConfig } from "./types";

const now = () => new Date("2026-10-26T00:00:00.000Z");

async function replay(
  label: string,
  kind: "text" | "select",
  groupLabel = "",
  sourceId: string | null = "profile.currentCountry",
  options = ["Germany", "France"],
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
                answerTags: { kind: "other" as const, country: null, sourceId },
              },
            ],
          ]),
        ),
    },
  );
  return { outcome, write, checkWrittenAnswer };
}

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
