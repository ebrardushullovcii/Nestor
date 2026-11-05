import { CandidateProfileSchema } from "@nestor/contracts";
import { expect, test } from "vitest";
import { classifyAnswerPermission } from "./answer-source-catalog";
import {
  factualSummaryIsSourced,
  labelledStatementFor,
} from "./factual-summary";
import { buildApplyFormObservation } from "./page-hands";
import type { ApplyAnswerSources } from "./types";

// Council D4: a source line "Label: statement" counts by its statement only
// when the label is decoration the question already restates.
const QUESTION = "Describe your reporting routine";
const ANSWER = "I submit weekly reports";

test.each([
  [
    "the label the question restates",
    "Reporting routine: I submit weekly reports",
    true,
  ],
  [
    "an article in the label",
    "The reporting routine: I submit weekly reports",
    true,
  ],
  [
    "a condition word in the label",
    "Previously reporting routine: I submit weekly reports",
    false,
  ],
  [
    "an employer the question does not name",
    "Acme reporting routine: I submit weekly reports",
    false,
  ],
  [
    "a digit in the label",
    "2019 reporting routine: I submit weekly reports",
    false,
  ],
  [
    "a negation in the label",
    "No reporting routine: I submit weekly reports",
    false,
  ],
  ["a nested label", "Reporting routine: Note: I submit weekly reports", false],
  [
    "a label of five words",
    "My own personal reporting routine: I submit weekly reports",
    false,
  ],
  [
    "a negation in the remainder",
    "Reporting routine: I do not submit weekly reports",
    false,
  ],
  [
    "a condition in the remainder",
    "Reporting routine: I submit weekly reports only under supervision",
    false,
  ],
])("%s", (_name, source, accepted) => {
  expect(factualSummaryIsSourced(ANSWER, [source], QUESTION)).toBe(accepted);
});

test("without the question a labelled line is only its whole statement", () => {
  expect(
    factualSummaryIsSourced(ANSWER, [
      "Reporting routine: I submit weekly reports",
    ]),
  ).toBe(false);
});

test("the remainder keeps its negation when the answer keeps it", () => {
  expect(
    factualSummaryIsSourced(
      "I do not submit weekly reports",
      ["Reporting routine: I do not submit weekly reports"],
      QUESTION,
    ),
  ).toBe(true);
});

test("two labelled lines are never joined into one claim", () => {
  const sources = [
    "Reporting routine: I submit weekly reports\nReporting tools: Jira and Confluence",
  ];
  expect(
    factualSummaryIsSourced(
      "I submit weekly reports in Jira and Confluence",
      sources,
      "Describe your reporting routine and reporting tools",
    ),
  ).toBe(false);
});

test("recovery finds one statement in its own words, never two", () => {
  expect(
    labelledStatementFor(QUESTION, [
      "Jamie Example\nReporting routine: I submit weekly reports\n",
    ]),
  ).toBe(ANSWER);
  expect(
    labelledStatementFor(QUESTION, [
      "Reporting routine: I submit weekly reports",
      "Reporting routine: I submit weekly reports.",
    ]),
  ).toBe(ANSWER);
  expect(
    labelledStatementFor(QUESTION, [
      "Reporting routine: I submit weekly reports\nReporting routine: I submit monthly reports",
    ]),
  ).toBeNull();
  expect(
    labelledStatementFor(QUESTION, ["Acme reporting: I submit weekly reports"]),
  ).toBeNull();
});

function sources(
  resume: string,
  postingDescription: string,
): ApplyAnswerSources {
  return {
    profile: CandidateProfileSchema.parse({
      id: "synthetic",
      firstName: "Jamie",
      lastName: "Example",
      fullName: "Jamie Example",
      email: "jamie@clientnest.example",
      yearsExperience: 6,
      baseResume: {
        id: "resume",
        fileName: "jamie-synthetic-resume.txt",
        uploadedAt: "2026-11-01T00:00:00.000Z",
        extractionStatus: "ready",
        textContent: resume,
      },
    }),
    resumeText: resume,
    posting: {
      title: "Frontend Engineer",
      company: "Clientnest Replica",
      location: "Berlin, Germany",
      description: postingDescription,
    },
    reusableAnswers: [],
    documents: [],
  };
}

function decide(source: ApplyAnswerSources) {
  const observation = buildApplyFormObservation(
    {
      url: "http://127.0.0.1:47950/case1/apply",
      title: "Application",
      bodyText: `Step 2 of 3\n${QUESTION}`,
      controls: [
        {
          index: 0,
          tagName: "textarea",
          inputType: "",
          role: "",
          id: "routine",
          name: "routine",
          label: QUESTION,
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
        },
      ],
      actions: [],
      links: [],
      headings: [],
      clickables: [],
      openedTabs: [],
      loading: false,
      validationErrors: [],
      stepLabel: null,
    },
    "2026-11-04T01:00:00.000Z",
  );
  const control = observation.controls[0];
  return classifyAnswerPermission({
    control,
    controls: observation.controls,
    tags: { kind: "factual_summary", country: null, sourceId: "resume.text" },
    sources: source,
    answer: ANSWER,
    pageInstructions: observation.bodyTextExcerpt,
  });
}

test("the resume's labelled line is a written answer to check, not a question", () => {
  const decision = decide(
    sources("Jamie Example\nReporting routine: I submit weekly reports\n", ""),
  );
  expect(decision.kind).toBe("writing");
});

test("an unsupported proposed summary still requires independent applicant evidence", () => {
  const decision = decide(
    sources(
      "Jamie Example\nBuilt accessible forms.\n",
      "Reporting routine: I submit weekly reports",
    ),
  );
  expect(decision).toMatchObject({
    kind: "writing",
    evidencePolicy: "factual_summary",
  });
});
