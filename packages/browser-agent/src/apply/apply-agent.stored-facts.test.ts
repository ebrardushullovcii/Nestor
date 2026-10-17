import * as questionClassification from "./question-classification";
import { questionPrompt } from "./policy-executor";
import { readFileSync } from "node:fs";
import {
  CandidateProfileSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nordri/contracts";
import { expect, test, vi } from "vitest";
import type { LLMClient } from "../agent/contracts";
import { runApplyAgent } from "./apply-agent";
import { buildApplyFormObservation } from "./page-hands";
import { storedFactFor } from "./application-facts";
import type { ApplyAgentConfig, ApplyPageHands } from "./types";

type FixtureField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  groupLabel?: string;
  choiceValue?: string;
};
type FixtureGroup = { label: string; repeat?: string; fields: FixtureField[] };

async function ledgerleafRun(conditionalContact = false) {
  const fixtureRoot = new URL(
    "../../../../apps/desktop/test-fixtures/",
    import.meta.url,
  );
  const catalogUrl = new URL("job-sites/sites/catalog.mjs", fixtureRoot).href;
  const formsUrl = new URL("job-sites/sites/forms.mjs", fixtureRoot).href;
  const { moreSites } = (await import(/* @vite-ignore */ catalogUrl)) as {
    moreSites: Array<{ slug: string; steps: number; groups: string[] }>;
  };
  const { fieldGroups } = (await import(/* @vite-ignore */ formsUrl)) as {
    fieldGroups: (site: unknown) => FixtureGroup[];
  };
  const site = moreSites.find((entry) => entry.slug === "ledgerleaf")!;
  const groups = fieldGroups(site);
  const resume = readFileSync(
    new URL(
      "job-finder/blind-personas/resumes/experienced-technical.txt",
      fixtureRoot,
    ),
    "utf8",
  );
  // Materialized structured facts from the existing synthetic resume persona.
  const profile = CandidateProfileSchema.parse({
    id: "speed-persona",
    fullName: "Casey Rowan",
    firstName: "Casey",
    lastName: "Rowan",
    email: "casey.rowan@example.test",
    phone: "+12025550123",
    yearsExperience: 15,
    currentLocation: "Portland, Oregon",
    skills: [
      "React",
      "TypeScript",
      "JavaScript",
      "accessibility",
      "design systems",
      "testing",
      "performance",
      "technical leadership",
      "Mentoring",
    ],
    answerBank: { salaryExpectations: "120000", noticePeriod: "Immediate" },
    experiences: [
      {
        id: "current-role",
        companyName: "Northstar Parcel Software",
        title: "Principal Frontend Engineer",
        startDate: "2021-03",
        isCurrent: true,
      },
    ],
    baseResume: {
      id: "speed-resume",
      fileName: "experienced-technical.txt",
      uploadedAt: "2026-10-05T10:00:00.000Z",
      textContent: resume,
    },
  });
  const steps: FixtureGroup[][] = Array.from({ length: site.steps }, () => []);
  groups.forEach((group, index) => {
    const target =
      index === groups.length - 1
        ? site.steps - 1
        : Math.min(
            site.steps - 2,
            Math.floor((index * (site.steps - 1)) / (groups.length - 1)),
          );
    steps[target].push(group);
  });
  let step = 0;
  let addedHistory = false;
  const values = new Map<string, string>();
  const rawControl = (field: FixtureField, index: number): RawApplyControl => ({
    index,
    tagName: field.type === "select" ? "select" : "input",
    inputType: field.type === "select" ? "select-one" : field.type,
    role: "",
    id: field.name,
    name: field.name,
    label: field.label,
    groupLabel: field.groupLabel ?? "",
    placeholder: "",
    autocomplete: "",
    required: field.required,
    invalid: false,
    validationMessage: "",
    disabled: false,
    readOnly: false,
    visible: true,
    value: field.choiceValue ?? values.get(field.name) ?? "",
    checked: values.get(field.name) === field.choiceValue,
    multiple: false,
    options: field.options ?? [],
    selectedOptionLabel: values.get(field.name) ?? "",
  });
  const currentFields = () => [
    ...steps[step].flatMap((group) =>
      group.repeat === "work" && addedHistory
        ? [
            {
              name: "workTitle",
              label: "Job title",
              type: "text",
              required: true,
            },
            {
              name: "workCompany",
              label: "Company",
              type: "text",
              required: true,
            },
            { name: "workFrom", label: "From", type: "month", required: true },
            {
              name: "workTo",
              label: "To (optional)",
              type: "month",
              required: false,
            },
          ]
        : group.fields.flatMap((field) =>
            field.type === "multi" || field.type === "radio"
              ? (field.type === "radio"
                  ? ["Yes", "No"]
                  : (field.options ?? [])
                ).map((choice) => ({
                  ...field,
                  groupLabel: field.label,
                  label: choice,
                  choiceValue: choice,
                  type: field.type === "radio" ? "radio" : "checkbox",
                  required: field.type === "radio",
                  options: [],
                }))
              : [field],
          ),
    ),
    ...(conditionalContact &&
    step === 0 &&
    values.get("email") &&
    !values.get("phone")
      ? [
          {
            name: "contactNote",
            label: "Contact note (optional)",
            type: "text",
            required: false,
          },
        ]
      : []),
  ];
  const source = (): RawApplyPage => ({
    url: "http://127.0.0.1:47950/ledgerleaf/apply/1",
    title: "Apply",
    bodyText: steps[step].map((group) => group.label).join("\n"),
    controls: currentFields().map(rawControl),
    headings: [],
    links: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    clickables: steps[step].some((group) => group.repeat === "work")
      ? [
          {
            index: 0,
            label: "Add another work history entry",
            visible: true,
            topOffset: 0,
            role: "button",
            tagName: "button",
          },
        ]
      : [],
    actions: [
      {
        index: 0,
        label: step < site.steps - 1 ? "Next" : "Send application",
        visible: true,
        disabled: false,
      },
    ],
    stepLabel: `Step ${step + 1}`,
  });
  const observe = () =>
    buildApplyFormObservation(source(), "2026-10-05T10:00:00.000Z");
  const write = (ref: string, value: string) => {
    values.set(currentFields()[Number(ref.slice(1))].name, value);
    return Promise.resolve({ ok: true as const, observedValue: value });
  };
  const click = (ref: string) => {
    if (ref === "a0") step += 1;
    else addedHistory = true;
    return Promise.resolve({ ok: true as const, observedValue: "clicked" });
  };
  const hands: ApplyPageHands = {
    observe: () => Promise.resolve(observe()),
    fillText: write,
    chooseOption: write,
    setToggle: (ref, checked) =>
      write(
        ref,
        checked
          ? (currentFields()[Number(ref.slice(1))].choiceValue ?? "Yes")
          : "",
      ),
    uploadFile: (ref, file) => write(ref, file.name),
    clickElement: click,
    clickAction: click,
    readText: () => Promise.resolve(source().bodyText),
    scroll: () => Promise.resolve({ ok: true, observedValue: "" }),
    wait: () => Promise.resolve(),
    navigate: () => Promise.resolve({ ok: true, url: source().url! }),
    goBack: () => Promise.resolve({ ok: true, url: source().url! }),
    followLink: () => Promise.resolve({ ok: true, url: source().url! }),
  };
  const input: ApplyAgentConfig = {
    hands,
    modelQuestionClassification: true,
    authority: {
      mode: "prepare_only",
      submitAuthorized: false,
      preApprovedAttestationKinds: [],
      salaryDisclosure: "answer_from_profile",
      allowedOrigins: [],
    },
    sources: {
      profile,
      resumeText: resume,
      posting: {
        title: "Software Engineer",
        company: "Fixture employer",
        location: "Remote, United States",
        description: "Build web applications.",
      },
      reusableAnswers: [
        {
          id: "analysis",
          kind: "other",
          label: "Analysis years",
          question: "Years of analysis experience",
          answer: "0",
          roleFamilies: [],
          proofEntryIds: [],
        },
        {
          id: "coordination",
          kind: "other",
          label: "Coordination years",
          question: "Years of coordination experience",
          answer: "0",
          roleFamilies: [],
          proofEntryIds: [],
        },
        {
          id: "currency",
          kind: "salary_expectation",
          label: "Currency",
          question: "Salary currency",
          answer: "USD",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ],
      documents: [
        {
          id: "resume",
          fileName: "experienced-technical.txt",
          label: "Your resume",
          kind: "resume",
          mimeType: "text/plain",
          loadBytes: () => Promise.resolve(new TextEncoder().encode(resume)),
        },
      ],
    },
    application: {
      jobId: "speed-job",
      applicationId: "speed-application",
      startingUrl: source().url!,
    },
    siteLabel: "Ledgerleaf replica",
  };
  const calls = {
    turns: 0,
    classifications: 0,
    questionsRead: [] as string[][],
    checks: [] as Array<Array<{ question: string; proposedAnswer: string }>>,
    misses: [] as string[],
  };
  const reply = (name: string, args: unknown) => ({
    toolCalls: [
      {
        id: `${name}-${calls.turns}-${calls.classifications}-${calls.checks.length}`,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  const model: LLMClient = {
    chatWithTools: (messages, definitions) => {
      const name = definitions[0]?.function.name;
      if (name === "report_question_kinds") {
        calls.classifications += 1;
        const questions = JSON.parse(String(messages[1].content)) as Array<{
          index: number;
          question: string;
          nativeRequired: boolean;
        }>;
        calls.questionsRead.push(
          questions.map((question) => question.question),
        );
        return Promise.resolve(
          reply(name, {
            questions: questions.map((question) => ({
              index: question.index,
              required: question.nativeRequired,
              asksAboutPay:
                question.question.includes("salary") ||
                question.question === "Salary currency",
              declarationKind: null,
              eligibilityKind: question.question.includes("authorized")
                ? "work_authorization"
                : question.question.includes("sponsorship")
                  ? "visa_sponsorship"
                  : null,
            })),
          }),
        );
      }
      if (name === "report_answer_checks") {
        const answers = (
          JSON.parse(String(messages[1].content)) as {
            answers: Array<{ question: string; proposedAnswer: string }>;
          }
        ).answers;
        calls.checks.push(answers);
        return Promise.resolve(
          reply(name, {
            checks: answers.map((answer, index) => ({
              index,
              supported:
                !answer.question.includes("authorized") &&
                !answer.question.includes("sponsorship"),
              reason: "Eligibility is not recorded for this synthetic persona.",
            })),
          }),
        );
      }
      calls.turns += 1;
      if (step === 0) {
        const fields = [
          { tool: "type", ref: "c0", text: profile.fullName },
          { tool: "type", ref: "c1", text: profile.email },
          { tool: "type", ref: "c2", text: profile.phone },
          { tool: "upload", ref: "c3", documentId: "resume" },
        ].filter(
          (field) =>
            !values.has(currentFields()[Number(field.ref.slice(1))].name),
        );
        return Promise.resolve(
          fields.length
            ? reply("fill_fields", { fields, thenContinue: "a0" })
            : reply("click", { ref: "a0" }),
        );
      }
      if (step === 1 && !addedHistory)
        return Promise.resolve(reply("click", { ref: "e0" }));
      if (step === 1) {
        const fields = [
          { tool: "type", ref: "c0", text: "Principal Frontend Engineer" },
          { tool: "type", ref: "c1", text: "Northstar Parcel Software" },
          {
            tool: "type",
            ref: "c2",
            text: "2021-03",
            storedFactId: "profile.experiences.current-role.startDate",
          },
        ];
        for (const field of fields)
          if (
            !storedFactFor({
              sources: input.sources,
              payDisclosed: false,
              control: observe().controls.find(
                (control) => control.ref === field.ref,
              )!,
              value: field.text,
              storedFactId:
                "storedFactId" in field ? field.storedFactId : undefined,
            })
          )
            calls.misses.push(field.text);
        return Promise.resolve(
          reply("fill_fields", { fields, thenContinue: "a0" }),
        );
      }
      if (step === 2)
        return Promise.resolve(
          reply("fill_fields", {
            fields: [
              {
                tool: "type",
                ref: "c0",
                text: "120000",
                storedFactId: "profile.answerBank.salaryExpectations",
              },
              { tool: "select", ref: "c1", option: "USD" },
              { tool: "select", ref: "c2", option: "Immediate" },
              {
                tool: "set_checkbox",
                ref: "c6",
                checked: true,
                storedFactId: "profile.skills.8",
              },
              { tool: "type", ref: "c7", text: "0" },
              { tool: "type", ref: "c8", text: "0" },
            ],
            thenContinue: "a0",
          }),
        );
      if (
        step === 3 &&
        !calls.checks.some((batch) =>
          batch.some((answer) => answer.question.includes("authorized")),
        )
      )
        return Promise.resolve(
          reply("fill_fields", {
            fields: [
              { tool: "set_checkbox", ref: "c0", checked: true },
              { tool: "set_checkbox", ref: "c2", checked: true },
            ],
          }),
        );
      // Four eligibility/personal questions remain on the first handoff step.
      return Promise.resolve(
        reply("finish", {
          reason: "The remaining questions need your answers.",
          needsPerson: true,
        }),
      );
    },
  };
  return { result: await runApplyAgent(input, model), calls, values };
}

test("Ledgerleaf stored history does not need an answer check before the first handoff", async () => {
  const { result, calls, values } = await ledgerleafRun();
  console.log("Ledgerleaf recording", JSON.stringify(calls));
  expect(result.outcome).toBe("paused");
  expect(values.get("workCompany")).toBe("Northstar Parcel Software");
  expect(values.get("workTitle")).toBe("Principal Frontend Engineer");
  expect(values.get("workFrom")).toBe("2021-03");
  expect(calls.turns).toBe(6);
  expect(calls.classifications).toBe(4);
  expect(result.timing?.questionReadingCalls).toBe(4);
  expect(result.timing?.answerCheckCalls).toBe(1);
  expect(
    result.timing?.requests.map((request) => request.storedFactFills),
  ).toEqual([3, 0, 3, 6, 0, 0]);
  expect(
    result.timing?.requests.map((request) => request.answersWaited),
  ).toEqual([0, 0, 0, 0, 1, 0]);
  expect(calls.checks).toHaveLength(1);
  expect(calls.checks[0].map((answer) => answer.question)).toEqual([
    "Are you authorized to work in the job's country?",
    "Will you need visa sponsorship?",
  ]);
  expect(calls.misses).toEqual([]);
  expect(
    result.pauses.flatMap(
      (pause) => pause.questions ?? (pause.question ? [pause.question] : []),
    ),
  ).toHaveLength(4);
  expect(result.notes.at(-1)).toContain(
    "stored_fact_fills_per_turn=[3,0,3,6,0,0]",
  );
  expect(result.notes.at(-1)).toContain(
    "answers_waited_per_turn=[0,0,0,0,1,0]",
  );
});

test("Ledgerleaf recording compares the previous whole-step cache with per-question reuse", async () => {
  const previousCache = vi
    .spyOn(questionClassification, "createQuestionClassifier")
    .mockImplementation((input) => {
      const byStep = new Map<
        string,
        {
          key: string;
          result: ReturnType<
            typeof questionClassification.classifyApplicationQuestions
          >;
        }
      >();
      return (controls, step = "") => {
        const questions = [
          ...new Map(
            controls
              .filter((control) => control.visible && questionPrompt(control))
              .map(
                (control) =>
                  [
                    questionPrompt(control),
                    {
                      prompt: questionPrompt(control),
                      kind: control.kind,
                      options: [...control.options],
                      required: control.required,
                    },
                  ] as const,
              ),
          ).values(),
        ];
        const key = JSON.stringify({ step, questions });
        const cached = byStep.get(step);
        if (cached?.key === key) return cached.result;
        const result = questionClassification.classifyApplicationQuestions({
          ...input,
          questions,
        });
        byStep.set(step, { key, result });
        return result;
      };
    });
  const before = await ledgerleafRun(true).finally(() =>
    previousCache.mockRestore(),
  );
  const after = await ledgerleafRun(true);
  const readCount = (run: typeof after) =>
    run.calls.questionsRead.reduce(
      (sum, questions) => sum + questions.length,
      0,
    );
  console.log(
    "Ledgerleaf cache comparison",
    JSON.stringify({
      before: {
        calls: before.calls.classifications,
        questions: readCount(before),
        answerChecks: before.calls.checks.length,
      },
      after: {
        calls: after.calls.classifications,
        questions: readCount(after),
        answerChecks: after.calls.checks.length,
      },
    }),
  );
  expect(after.calls.classifications).toBeLessThan(
    before.calls.classifications,
  );
  expect(readCount(after)).toBeLessThan(readCount(before));
  expect(before.calls.checks).toHaveLength(1);
  expect(after.calls.checks).toHaveLength(1);
  expect(after.values).toEqual(before.values);
});
