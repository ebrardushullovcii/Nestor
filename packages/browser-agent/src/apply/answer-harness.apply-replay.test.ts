import { CandidateProfileSchema } from "@nestor/contracts";
import type { RawApplyControl, RawApplyPage } from "@nestor/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

// Public question shapes from R1, with an entirely fictional applicant.
const cases = [
  ["Are you over the age of 18?", "Yes"],
  [
    "How do you use AI tools in your daily work?",
    "I use Claude Code, Codex, Cursor and GitHub Copilot for implementation, review and tests.",
  ],
  ["Main technologies you use", "TypeScript / JavaScript"],
  ["Salary expectation (net / month)", "2,000–4,000 EUR net/month"],
  ["Highest degree", "Bachelor’s"],
  ["Earliest start date", "2026-11-06"],
  [
    "Tell us about your experience working in an async and/or remote environment. What practices or approaches have worked well for you? What challenges have you faced?",
    "I work remotely using written playbooks, architecture decision records and scheduled pairing. Written handovers help keep decisions visible across time zones.",
  ],
] as const;

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "the model fills derivable R1 answers and asks only for missing citizenship (reader: %s, resumed: %s)",
  async (modelQuestionClassification, resumed) => {
    const controls: RawApplyControl[] = [
      ...cases.map(([label]) => label),
      "Passport Country",
    ].map((label, index) => ({
      index,
      ref: `c${index}`,
      tagName: "input",
      inputType: "text",
      role: "",
      id: `q${index}`,
      name: `q${index}`,
      label,
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
    }));
    for (const index of [0, 4]) {
      controls[index].tagName = "select";
      controls[index].inputType = "select-one";
      controls[index].options =
        index === 0
          ? ["Yes", "No"]
          : ["Bachelor’s", "Master’s", "PhD", "Other"];
    }
    controls[2].inputType = "checkbox";
    controls[2].label = "TypeScript / JavaScript";
    controls[2].groupLabel = "Main technologies you use";
    controls[2].value = "TypeScript / JavaScript";
    controls[5].inputType = "date";
    const page: RawApplyPage = {
      url: "https://employer.example.test/apply",
      title: "Application",
      bodyText: "Application questions",
      controls,
      actions: [],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    };
    const unexpected = () =>
      Promise.reject(new Error("Unexpected browser action"));
    const fillText = vi.fn((ref: string, value: string) => {
      controls.find((control) => control.ref === ref)!.value = value;
      return Promise.resolve({ ok: true as const, observedValue: value });
    });
    const chooseOption = vi.fn((ref: string, option: string) => {
      const control = controls.find((entry) => entry.ref === ref)!;
      control.value = option;
      control.selectedOptionLabel = option;
      return Promise.resolve({ ok: true as const, observedValue: option });
    });
    const setToggle = vi.fn((ref: string, checked: boolean) => {
      controls.find((entry) => entry.ref === ref)!.checked = checked;
      return Promise.resolve({
        ok: true as const,
        observedValue: String(checked),
      });
    });
    const hands: ApplyPageHands = {
      observe: () =>
        Promise.resolve(
          buildApplyFormObservation(page, "2026-11-06T10:00:00Z"),
        ),
      readText: () => Promise.resolve(page.bodyText),
      fillText,
      wait: () => Promise.resolve(),
      navigate: unexpected,
      goBack: unexpected,
      followLink: unexpected,
      chooseOption,
      setToggle,
      clickElement: unexpected,
      clickAction: unexpected,
      uploadFile: unexpected,
      scroll: unexpected,
    };
    const config: ApplyAgentConfig = {
      hands,
      siteLabel: "Fictional employer",
      modelQuestionClassification,
      now: () => new Date(2026, 10, 6, 10),
      application: {
        jobId: "synthetic",
        applicationId: "synthetic",
        startingUrl: page.url!,
      },
      authority: {
        mode: "autonomous_submit",
        submitAuthorized: true,
        salaryDisclosure: "answer_from_profile",
        preApprovedAttestationKinds: [],
        allowedOrigins: ["https://employer.example.test"],
      },
      sources: {
        profile: CandidateProfileSchema.parse({
          id: "synthetic",
          fullName: "Alex Example",
          yearsExperience: 7,
          skills: [
            "TypeScript / JavaScript",
            "Claude Code",
            "Codex",
            "Cursor",
            "GitHub Copilot",
          ],
          workEligibility: { noticePeriodDays: 0 },
          baseResume: {
            id: "synthetic",
            fileName: "synthetic.txt",
            uploadedAt: "2026-11-06T00:00:00Z",
            textContent:
              "Alex Example has seven years of remote software work and a BSc. Uses written playbooks, architecture decision records and scheduled pairing.",
          },
        }),
        resumeText: null,
        documents: [],
        posting: {
          title: "Engineer",
          company: "Fictional employer",
          location: "Remote",
          description: "Build tools for remote teams.",
        },
        reusableAnswers: [
          {
            id: "expected-pay",
            question: "Expected monthly pay",
            label: "Expected pay",
            answer: "2,000–4,000 EUR net/month",
            kind: "salary_expectation",
            roleFamilies: [],
            proofEntryIds: [],
          },
        ],
      },
    };
    if (resumed) {
      config.replay = {
        answers: [],
        attachments: [],
        path: [],
        formUrl: page.url!,
      };
      config.initialUnansweredPickerQuestions = controls.map((control) => ({
        prompt: control.groupLabel || control.label,
        options: control.options,
      }));
    }
    let actor = 0;
    const requested: string[] = [];
    const client: LLMClient = {
      chatWithTools: (messages, tools) => {
        const reply = (name: string, args: unknown) =>
          Promise.resolve({
            toolCalls: [
              {
                id: `${name}-${actor}`,
                type: "function" as const,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
        if (tools[0]?.function.name === "report_question_kinds") {
          const questions = JSON.parse(messages[1].content) as {
            index: number;
          }[];
          return reply("report_question_kinds", {
            plainIndexes: questions.map(({ index }) => index),
            flagged: [],
            tags: questions.map(({ index }) => ({
              index,
              kind: "other",
              country: null,
              sourceId: null,
              declarationPurpose: null,
            })),
          });
        }
        requested.push(tools[0]?.function.name ?? "actor");
        const context = messages.map((message) => message.content).join("\n");
        expect(context).toContain("noticePeriodDays");
        expect(context).toContain("GitHub Copilot");
        expect(context).toContain("Current local date: 2026-11-06");
        if (actor++ === 0)
          return reply("fill_fields", {
            fields: cases.map(([, text], index) =>
              index === 0 || index === 4
                ? { tool: "select", ref: `c${index}`, option: text }
                : index === 2
                  ? { tool: "set_checkbox", ref: `c${index}`, checked: true }
                  : { tool: "type", ref: `c${index}`, text },
            ),
          });
        return reply("finish", {
          reason: "Citizenship is absent from the supplied record.",
          needsPerson: true,
          forPerson: ["c7"],
        });
      },
    };
    const result = await runApplyAgent(config, client);
    expect(controls.slice(0, 7).map((control) => control.value)).toEqual(
      cases.map(([, value]) => value),
    );
    expect(fillText).toHaveBeenCalledTimes(4);
    expect(chooseOption).toHaveBeenCalledTimes(2);
    expect(setToggle).toHaveBeenCalledTimes(1);
    expect(controls[2].checked).toBe(true);
    const questions = result.pauses.flatMap(
      (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
    );
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      prompt: "Passport Country",
      askReason: { kind: "no_source" },
    });
    expect(requested).not.toContain("report_answer_checks");
    expect(actor).toBe(2);
  },
);
