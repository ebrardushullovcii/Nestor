import replay from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/invented-personal-answers.json";
import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import { checkWrittenApplicationAnswers } from "./written-answer-grounding";
import { applicationFacts, plainAnswerCheckFacts } from "./application-facts";
import type { LLMClient } from "../agent/contracts";
import ownWords from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/own-words.json";
import k1 from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/answer-evidence-k1.json";
import discovery from "../../../../apps/desktop/test-fixtures/job-finder/apply-replays/listing-discovery.json";
import { classifyAnswerPermission } from "./answer-source-catalog";
import type { ApplyFormControl } from "./types";

const sources = {
  profile: CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Synthetic Applicant",
    yearsExperience: replay.applicant.yearsExperience,
    skills: replay.applicant.skills,
    workEligibility: { requiresVisaSponsorship: false },
    baseResume: {
      id: "synthetic-resume",
      fileName: "synthetic.txt",
      uploadedAt: "2026-10-01T00:00:00.000Z",
      textContent:
        "Seven years overall in software engineering. Skills include JavaScript and TypeScript.",
    },
  }),
  resumeText: null,
  reusableAnswers: [],
  documents: [],
  posting: {
    title: "Engineer",
    company: "Example Workshop",
    location: "Remote",
    description: "Engineering workflow tools",
  },
};

test.each([
  {
    name: "recorded remote work",
    answer: "I worked remotely with a distributed team.",
    supported: true,
  },
  {
    name: "recorded Profile work practices",
    answer: "I worked remotely with a distributed team.",
    supported: true,
    fromProfile: true,
  },
  {
    name: "invented work practice",
    answer: "I ran daily video standups with the distributed team.",
    supported: false,
  },
  {
    name: "invented product story",
    answer: "I resolved a pricing incident by interviewing twelve customers.",
    supported: false,
  },
])(
  "factual summary still checks every claim: $name",
  async ({ answer, supported, fromProfile }) => {
    const resume =
      "I worked remotely with a distributed team. I documented decisions asynchronously.";
    const control: ApplyFormControl = {
      ref: "c0",
      kind: "long_text",
      label: "Describe your remote work experience",
      groupLabel: "",
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
    };
    const inputSources = {
      ...sources,
      resumeText: resume,
      profile: CandidateProfileSchema.parse({
        ...sources.profile,
        professionalSummary: { fullSummary: resume },
      }),
    };
    const tags = {
      kind: "factual_summary",
      country: null,
      sourceId: fromProfile
        ? "profile.professionalSummary.fullSummary"
        : "resume.text",
    } as const;
    const permission = (
      sourceId: string | null = tags.sourceId,
      groupLabel = "",
      pageInstructions = "",
    ) => {
      const field = { ...control, groupLabel };
      return classifyAnswerPermission({
        sources: inputSources,
        control: field,
        controls: [field],
        tags: { ...tags, sourceId },
        answer,
        pageInstructions,
      });
    };
    // Permission to check a summary is separate from support for its claims.
    expect(permission().kind).toBe("writing");
    expect(permission(null).kind).toBe("needs_you");
    expect(permission("posting.description").kind).toBe("needs_you");
    expect(permission("profile.fullName").kind).toBe("needs_you");
    expect(permission(tags.sourceId, "Professional reference").kind).toBe(
      "needs_you",
    );
    expect(permission(tags.sourceId, "", "Write this yourself").kind).toBe(
      "needs_you",
    );
    for (const [field, proposed, kind] of [
      [control, "Yes", "factual_summary"],
      [control, "Ja", "factual_summary"],
      [
        { ...control, questionKind: "work_authorization" as const },
        answer,
        "factual_summary",
      ],
      [control, answer, "preference"],
    ] as const)
      expect(
        classifyAnswerPermission({
          sources: inputSources,
          control: field,
          controls: [field],
          tags: { ...tags, kind },
          answer: proposed,
          pageInstructions: "",
        }).kind,
      ).toBe("needs_you");
    const client: LLMClient = {
      chatWithTools: vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
        toolCalls: [
          {
            id: "lie",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: [
                  {
                    index: 0,
                    supported,
                    reason: supported
                      ? "Recorded facts support this answer."
                      : "This claim is not recorded.",
                    evidence: [
                      {
                        kind: "applicant_fact",
                        source: fromProfile ? "applicant" : "resume",
                        path: fromProfile
                          ? "/professionalSummary/fullSummary"
                          : "",
                        quote: resume,
                        claim: answer,
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      }),
    };
    const checked = await checkWrittenApplicationAnswers({
      client,
      sources: inputSources,
      payDisclosed: false,
      answers: [
        { question: control.label, answer, evidencePolicy: "factual_summary" },
      ],
    });
    expect(checked[0]?.supported).toBe(supported);
  },
);

test.each(["A friend referred me", discovery.label])(
  "listing source is checked deterministically: %s",
  async (answer) => {
    const chatWithTools = vi.fn<LLMClient["chatWithTools"]>();
    const result = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources: {
        ...sources,
        listingDiscovery: { label: discovery.label, url: discovery.url },
      },
      payDisclosed: false,
      answers: [{ question: discovery.question, answer }],
    });
    expect(result[0]?.supported).toBe(answer === discovery.label);
    expect(chatWithTools).not.toHaveBeenCalled();
  },
);

test.each(k1.cases)(
  "the fact checker decides source support: $name",
  async (entry) => {
    const chatWithTools = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValue({
        toolCalls: [
          {
            id: "lie",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: [
                  {
                    index: 0,
                    supported: entry.supported,
                    reason: entry.supported
                      ? "Supported"
                      : "This claim is not supported.",
                    evidence: entry.evidence.map((evidence) => ({
                      ...evidence,
                      kind:
                        evidence.source === "posting"
                          ? "role_motivation"
                          : "applicant_fact",
                      claim: entry.answer,
                    })),
                  },
                ],
              }),
            },
          },
        ],
      });
    const result = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources: {
        ...sources,
        resumeText: k1.resume,
        profile: CandidateProfileSchema.parse({
          ...sources.profile,
          currentRegion: "Germany",
          experiences: [
            {
              id: "synthetic-employment",
              companyName: "Example Workshop",
              title: "Engineer",
              startDate: "January 2014",
              isCurrent: true,
            },
          ],
          workEligibility: {
            ...sources.profile.workEligibility,
            authorizedWorkCountries: ["Germany", "France"],
          },
        }),
      },
      payDisclosed: false,
      answers: [entry],
    });
    expect(result[0]?.supported).toBe(entry.supported);
    for (const evidence of entry.evidence) {
      if (evidence.source === "resume")
        expect(k1.resume).toContain(evidence.quote);
      if (evidence.path === "/location/region")
        expect("Germany").toBe(evidence.quote);
    }
  },
);

test.each(ownWords.rules)(
  "Apply replay: the site's writing rule requires the person without a checker call: %s",
  async (rule) => {
    const chatWithTools = vi
      .fn<LLMClient["chatWithTools"]>()
      .mockResolvedValue({
        toolCalls: [
          {
            id: "lying-checker",
            type: "function",
            function: {
              name: "report_answer_checks",
              arguments: JSON.stringify({
                checks: [
                  {
                    index: 0,
                    supported: true,
                    reason: "Supported",
                    evidence: [
                      {
                        source: "posting",
                        path: "/description",
                        quote: sources.posting.description,
                        claim: ownWords.proposed,
                        kind: "role_motivation",
                      },
                    ],
                  },
                ],
              }),
            },
          },
        ],
      });
    const result = await checkWrittenApplicationAnswers({
      client: { chatWithTools },
      sources,
      payDisclosed: false,
      formContext: { pageText: rule, fields: [] },
      answers: [{ question: ownWords.question, answer: ownWords.proposed }],
    });
    expect(result[0].supported).toBe(false);
    expect(result[0].reason).toContain("your own words");
    expect(chatWithTools).not.toHaveBeenCalled();
  },
);
test("the whole applicant object cannot serve as a quote even with a lying checker", async () => {
  const applicant = plainAnswerCheckFacts(
    applicationFacts(sources, { payDisclosed: false }),
  );
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>().mockResolvedValue({
    toolCalls: [
      {
        id: "lie",
        type: "function",
        function: {
          name: "report_answer_checks",
          arguments: JSON.stringify({
            checks: [
              {
                index: 0,
                supported: true,
                reason: "Supported",
                evidence: [
                  {
                    source: "applicant",
                    path: "",
                    quote: JSON.stringify(applicant),
                    claim: "A personal claim",
                    kind: "applicant_fact",
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  });
  const result = await checkWrittenApplicationAnswers({
    client: { chatWithTools },
    sources,
    payDisclosed: false,
    answers: [
      { question: "Describe your work", answer: "I built a space station." },
    ],
  });
  expect(result[0]?.supported).toBe(false);
});
