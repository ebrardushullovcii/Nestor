import { writeFileSync } from "node:fs";
import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig } from "./types";

// Public question shapes only; all profile, resume, URL and answer data is synthetic.
test("an Ashby-sized form fills known facts and hands unknown facts over once", async () => {
  const labels = [
    "",
    "Name",
    "Email",
    "Resume",
    "Passport Country",
    "Country of Residence",
    "",
    "Twitter / X profile",
    "Github Profile",
    "Linkedin",
    "Tell us about your experience working in an async and/or remote environment. What practices or approaches have worked well for you? What challenges have you faced?",
    "Have you made any open source contributions in the past that you'd like to share with us?",
    "Where did you hear about this vacancy?",
    "",
  ];
  const controls: RawApplyControl[] = labels.map((label, index) => ({
    index,
    tagName: [10, 11, 13].includes(index) ? "textarea" : "input",
    inputType: [0, 3].includes(index) ? "file" : index === 2 ? "email" : "text",
    role: "",
    id: `field-${index}`,
    name: `field-${index}`,
    label,
    groupLabel: "",
    placeholder: "",
    autocomplete: "",
    required: [1, 2, 3, 4, 5, 8, 9, 10].includes(index),
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: ![0, 6, 13].includes(index),
    checked: false,
    multiple: false,
    value: [7, 11, 12].includes(index)
      ? "Previously supplied by the person"
      : index === 3
        ? "resume.pdf"
        : "",
    options: [],
    selectedOptionLabel: "",
    ...(index === 3
      ? {
          upload: {
            described: "",
            nearby: "Resume attached",
            shown: true,
            network: "accepted" as const,
          },
        }
      : {}),
  }));
  const body =
    "Apply for Platform Engineer. Answer the questions below. ".repeat(24);
  const raw: RawApplyPage = {
    url: "https://employer.example.test/form",
    title: "Apply",
    bodyText: body,
    controls,
    actions: [
      { index: 0, label: "Submit application", visible: true, disabled: false },
    ],
    headings: [],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    loading: false,
    stepLabel: null,
  };
  const profile = CandidateProfileSchema.parse({
    id: "synthetic",
    fullName: "Robin Example",
    firstName: "Robin",
    lastName: "Example",
    email: "robin@example.test",
    currentCountry: "Germany",
    githubUrl: "https://github.com/robin-example",
    linkedinUrl: "https://www.linkedin.com/in/robin-example",
    summary: "Maintained internal deployment documentation. ".repeat(65),
    yearsExperience: 4,
    baseResume: {
      id: "synthetic-resume",
      fileName: "resume.pdf",
      uploadedAt: "2026-10-27T00:00:00Z",
      textContent: "Maintained internal deployment documentation.",
      textUpdatedAt: "2026-10-27T00:00:00Z",
      extractionStatus: "ready",
    },
  });
  const config: ApplyAgentConfig = {
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      allowedOrigins: [],
      preApprovedAttestationKinds: [],
      salaryDisclosure: "pause_for_user",
    },
    application: {
      jobId: "synthetic",
      applicationId: "synthetic",
      startingUrl: raw.url!,
    },
    siteLabel: "Synthetic careers site",
    modelQuestionClassification: true,
    sources: {
      profile,
      resumeText: "Maintained internal deployment documentation. ".repeat(65),
      posting: {
        title: "Platform Engineer",
        company: "Example Workshop",
        location: "Germany",
        description: "Maintain internal platform services. ".repeat(30),
      },
      reusableAnswers: [],
      documents: [],
    },
    hands: {
      observe: () =>
        Promise.resolve(buildApplyFormObservation(raw, "2026-10-27T00:00:00Z")),
      fillText: (ref, value) => {
        const control = controls.find((entry) => `c${entry.index}` === ref)!;
        control.value = value;
        return Promise.resolve({ ok: true, observedValue: value });
      },
      navigate: () => Promise.resolve({ ok: true }),
      goBack: () => Promise.resolve({ ok: true }),
      clickElement: () => Promise.resolve({ ok: true }),
      clickAction: () => Promise.resolve({ ok: true }),
      followLink: () => Promise.resolve({ ok: true }),
      chooseOption: () => Promise.resolve({ ok: true }),
      setToggle: () => Promise.resolve({ ok: true }),
      uploadFile: () => Promise.resolve({ ok: true }),
      scroll: () => Promise.resolve({ ok: true }),
      wait: () => Promise.resolve(),
      readText: () => Promise.resolve(body),
    },
  };
  const requests: string[] = [];
  let turns = 0,
    reads = 0;
  const sourceIds: Record<string, string> = {
    Name: "profile.fullName",
    Email: "profile.email",
    "Country of Residence": "profile.currentCountry",
    "Github Profile": "profile.githubUrl",
    Linkedin: "profile.linkedinUrl",
  };
  const client: LLMClient = {
    chatWithTools: (messages, tools) => {
      requests.push(JSON.stringify({ messages, tools }));
      if (tools[0]?.function.name === "report_question_kinds") {
        reads++;
        const asked = JSON.parse(messages[1].content) as { question: string }[];
        return Promise.resolve({
          toolCalls: [
            {
              id: "read",
              type: "function",
              function: {
                name: "report_question_kinds",
                arguments: JSON.stringify({
                  plainIndexes: asked.map((_, index) => index),
                  flagged: [],
                  tags: asked.map((row, index) => ({
                    index,
                    kind:
                      row.question === "Passport Country"
                        ? "passport"
                        : "other",
                    country: null,
                    sourceId: sourceIds[row.question] ?? null,
                  })),
                }),
              },
            },
          ],
        });
      }
      turns++;
      const text = messages.map((message) => message.content).join("\n");
      expect(text.split(`Page: ${raw.url}`).length - 1).toBe(1);
      if (turns === 2) {
        expect(text).toContain(
          "Already waiting for the person; do not retry these fields",
        );
        expect(text).toContain("Passport Country");
        expect(text).toContain('answered: "Robin Example"');
      }
      const fields =
        turns === 1
          ? [
              { tool: "type", ref: "c1", text: profile.fullName },
              { tool: "type", ref: "c4", text: "Germany" },
              { tool: "type", ref: "c5", text: "Germany" },
              {
                tool: "type",
                ref: "c10",
                text: "I overcame every remote-work challenge.",
              },
            ]
          : [
              { tool: "type", ref: "c2", text: profile.email },
              { tool: "type", ref: "c8", text: profile.githubUrl },
              { tool: "type", ref: "c9", text: profile.linkedinUrl },
            ];
      return Promise.resolve({
        toolCalls: [
          {
            id: `fill-${turns}`,
            type: "function",
            function: {
              name: "fill_fields",
              arguments: JSON.stringify({ fields }),
            },
          },
        ],
      });
    },
  };
  const result = await runApplyAgent(config, client);
  expect(reads).toBe(1);
  expect(turns).toBe(2);
  expect(requests).toHaveLength(3);
  expect(result.outcome).toBe("paused");
  expect(result.filled).toHaveLength(5);
  expect(controls[4]?.value).toBe("");
  expect(controls[10]?.value).toBe("");
  const questions = result.pauses.flatMap((pause) => pause.questions ?? []);
  expect(questions.map((question) => question.prompt)).toEqual(
    expect.arrayContaining([labels[4], labels[10]]),
  );
  expect(new Set(questions.map((question) => question.prompt)).size).toBe(
    questions.length,
  );
  // A serialization-size ceiling, not a substitute for provider-reported tokens.
  expect(
    requests.reduce((sum, request) => sum + Buffer.byteLength(request), 0),
  ).toBeLessThan(160_000);
  if (process.env.NESTOR_APPLY_COST_CAPTURE)
    writeFileSync(
      process.env.NESTOR_APPLY_COST_CAPTURE,
      JSON.stringify({ requests, calls: requests.length }),
    );
});
