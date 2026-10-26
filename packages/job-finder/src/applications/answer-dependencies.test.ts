import { afterAll, afterEach, expect, it } from "vitest";
import { openJobStore } from "@nestor/db/job-store";
import {
  createApplicationStore,
  readSavedApplicationAnswers,
} from "@nestor/db/applications";
import {
  applicationAnswerDependencies,
  applicationAnswersUnchanged,
} from "./answer-dependencies";

const jobs = openJobStore(":memory:");
const memory = createApplicationStore(jobs).needsYou;
afterAll(() => jobs.close());
afterEach(() => memory.forgetAnswers({ filter: { text: "" }, except: [] }));
const origin = "https://replica.test";
const question = {
  key: "adult",
  prompt: "Are you over 18?",
  reusePrompt: true,
};
const adult = {
  key: "adult",
  prompt: "Application — Are you over 18? *",
  answer: "Yes",
  input: "boolean" as const,
  scope: {},
  options: [],
};

it("vetoes a prepared answer when its saved fallback changes", () => {
  const rule = {
    primary: "Primary territory",
    fallback: "Fallback region",
    whenNeitherOffered: "skip_application" as const,
  };
  const saved = memory.remember({
    ...adult,
    key: "country",
    prompt: "Country of residence",
    input: "text",
    answer: rule.primary,
    optionFallback: rule,
  });
  const facts = applicationAnswerDependencies(memory, 1, origin, []);
  facts.read([
    { key: "country", prompt: "Country of residence", reusePrompt: true },
  ]);
  const proof = facts.snapshot();
  expect(applicationAnswersUnchanged(memory, 1, origin, proof)).toBe(true);
  memory.saveAnswer({
    id: saved.id,
    answer: rule.primary,
    optionFallback: { ...rule, fallback: "Another region" },
  });
  expect(applicationAnswersUnchanged(memory, 1, origin, proof)).toBe(false);
});

it("ignores renamed questions and newly saved pay answers, but rejects a changed answer on this form", () => {
  memory.remember(adult);
  const facts = applicationAnswerDependencies(memory, 1, origin, []);
  expect(facts.read([question])[0]?.answer).toBe("Yes");
  const proof = facts.snapshot();
  memory.remember({ ...adult, prompt: "Are you over 18?", label: "Age" });
  memory.remember({
    key: "salary",
    prompt: "Expected salary",
    answer: "50000",
    kind: "salary_expectation",
    scope: {},
    input: "number",
    options: [],
  });
  memory.remember({
    key: "notice",
    prompt: "Notice period",
    answer: "One month",
    kind: "notice_period",
    scope: {},
    input: "text",
    options: [],
  });
  expect(applicationAnswersUnchanged(memory, 1, origin, proof)).toBe(true);
  memory.remember({ ...adult, answer: "No" });
  expect(applicationAnswersUnchanged(memory, 1, origin, proof)).toBe(false);
});

it("checks the existing facts offered to letter writing without hashing later additions or labels", () => {
  memory.remember({
    ...adult,
    key: "intro",
    prompt: "Introduction",
    answer: "I build tools.",
    input: "text",
    kind: "self_intro",
  });
  const facts = applicationAnswerDependencies(
    memory,
    1,
    origin,
    readSavedApplicationAnswers(jobs, ["self_intro"]),
  );
  const proof = facts.snapshot();
  memory.remember({
    ...adult,
    key: "notice",
    prompt: "Notice",
    answer: "One month",
    input: "text",
    kind: "notice_period",
  });
  memory.remember({
    ...adult,
    key: "intro",
    prompt: "About me",
    label: "Introduction",
    answer: "I build tools.",
    input: "text",
    kind: "self_intro",
  });
  expect(applicationAnswersUnchanged(memory, 1, origin, proof)).toBe(true);
  memory.saveAnswer({
    id: proof.context[0]!.id,
    answer: "I build different tools.",
  });
  expect(applicationAnswersUnchanged(memory, 1, origin, proof)).toBe(false);
});

it("cannot bless a changed answer by reading it again, or send without a saved fact check", () => {
  memory.remember(adult);
  const facts = applicationAnswerDependencies(memory, 1, origin, []);
  facts.read([question]);
  memory.remember({ ...adult, answer: "No" });
  facts.read([question]);
  expect(applicationAnswersUnchanged(memory, 1, origin, facts.snapshot())).toBe(
    false,
  );
  expect(applicationAnswersUnchanged(memory, 1, origin, undefined)).toBe(false);
});
