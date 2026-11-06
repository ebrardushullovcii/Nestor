import assert from "node:assert/strict";
import { test } from "vitest";
import {
  auditQuestions,
  genuineQuestion,
  markDuplicates,
  markdown,
  profileAnswer,
} from "./report.ts";
import type { Question, Run } from "./types.ts";

test("profile audit flags known facts without inventing sensitive or foreign-country answers", () => {
  for (const question of [
    "Will you require sponsorship?",
    "What is your notice period?",
    "Can you work remotely?",
    "Your email",
    "Years of professional experience",
    "My Experience — Work experience 1 — Job title",
    "My Experience — Work experience 1 — Company",
  ])
    assert.ok(profileAnswer(question), question);
  assert.ok(
    profileAnswer(
      "Are you legally authorized to work in this country?",
      "",
      "Germany",
    ),
  );
  assert.ok(
    profileAnswer(
      "Are you legally authorized to work in this country?",
      "",
      "Portugal",
    ),
  );
  assert.equal(profileAnswer("Will you require sponsorship?", "", "US"), null);
  assert.equal(
    profileAnswer("Are you legally authorized to work in this country?"),
    null,
  );
  assert.equal(
    profileAnswer("Are you authorized to work in Northern Ireland?"),
    null,
  );
  assert.ok(profileAnswer("Are you authorized to work in Germany?"));
  for (const [question, country] of [
    ["Are you legally authorized to work in this country?", "US"],
    ["Are you authorized to work in the United Kingdom?", ""],
    ["What is your citizenship?", ""],
    ["Notice period and current pay", ""],
    ["Do you consent to a background check?", ""],
    ["What is your postal address?", ""],
    ["Are you willing to relocate?", ""],
    ["What is your salary expectation?", ""],
    ["What is your earliest start date?", ""],
    ["My Experience — Work experience 1 — From", ""],
    ["My Experience — Work experience 2 — Company", ""],
  ])
    assert.equal(profileAnswer(question, "", country), null, question);
});

test("question repeats are counted after punctuation/case normalization", () => {
  const q: Question = {
    id: 1,
    kind: "question",
    text: "Will you need sponsorship?",
    answerKey: "sponsor",
    country: "Germany",
    instance: "test",
    firstSeenAt: "2026-11-05T00:00:00Z",
    profileAnswers: true,
    profileFact: "false",
    duplicate: false,
    applicationIds: [1],
  };
  const questions = markDuplicates([
    q,
    { ...q, id: 2, text: "WILL YOU NEED SPONSORSHIP" },
    { ...q, id: 3, text: "Notice period?" },
  ]);
  assert.deepEqual(
    questions.map((q) => q.duplicate),
    [false, true, false],
  );
  assert.deepEqual(
    markDuplicates([q, { ...q, instance: "fresh-instance" }]).map(
      (q) => q.duplicate,
    ),
    [false, false],
    "a fresh app has no prior session or saved answer to reuse",
  );
});

test("report keeps failures, unrun scenarios and unmeasured rows distinct from passes", () => {
  const run: Run = {
    version: 1,
    startedAt: "2026-11-05T00:00:00Z",
    source: { head: "abcd", dirty: null },
    ai: "live",
    driver: "driver",
    persona: {},
    preconditions: [],
    output: "/tmp/example",
    results: [
      {
        id: "standard",
        name: "Standard",
        status: "fail",
        seconds: 1,
        questions: [],
        metrics: { summary: "site | failed" },
        failure: {
          step: "check",
          happened: "Checker failed",
          likelyPackage: "browser-agent",
        },
      },
      {
        id: "search",
        name: "Search",
        status: "not run",
        seconds: 0,
        questions: [],
        metrics: {},
      },
      {
        id: "google",
        name: "Google",
        status: "not run",
        seconds: 0,
        questions: [],
        metrics: { summary: "not built yet" },
      },
    ],
  };
  const report = markdown(run);
  assert.match(report, /Standard \| FAIL/);
  assert.match(report, /Search \| NOT RUN/);
  assert.match(report, /Google \| NOT RUN/);
  assert.match(report, /site \\\| failed/);
  assert.match(report, /Checker failed.*Step: check.*browser-agent/);
  assert.doesNotMatch(report, /\| PASS \|/);
  run.results.push({
    id: "needs-you",
    name: "Needs you quality",
    status: "pass",
    seconds: 0,
    questions: [],
    metrics: {},
  });
  // A setup failure is not a scenario with zero questions and full coverage.
  run.results[0].failure!.step = "setup / search";
  auditQuestions(run);
  const quality = run.results.at(-1)!;
  assert.equal(quality.status, "fail");
  assert.deepEqual(quality.metrics.coverage, []);
  assert.deepEqual(quality.metrics.unmeasured, ["standard"]);
  assert.match(
    quality.failure!.happened,
    /No product measurement for: standard/,
  );
  run.results[0].failure = undefined;
  run.results[0].status = "pass";
  auditQuestions(run);
  assert.equal(quality.status, "pass");
  assert.equal(quality.failure, undefined, "a new audit clears stale failures");
  assert.deepEqual(quality.metrics.coverage, ["standard"]);
});

test("standard allows genuine decisions once, but rejects known facts, step handoffs and unexplained holds", () => {
  for (const text of [
    "Are you authorized to work in this country?",
    "Explain in your own words why this role interests you",
    "Do you consent to this check?",
    "Expected pay?",
  ])
    assert.ok(
      genuineQuestion({
        kind: "question",
        text,
        country: "",
        profileAnswers: false,
      }),
      text,
    );
  for (const q of [
    {
      kind: "question",
      text: "Your email?",
      country: "",
      profileAnswers: true,
    },
    {
      kind: "question",
      text: "Click Save and continue",
      country: "",
      profileAnswers: false,
    },
    { kind: "sign_in", text: "Sign in", country: "", profileAnswers: false },
    {
      kind: "question",
      text: "Something went wrong",
      country: "",
      profileAnswers: false,
    },
  ])
    assert.equal(genuineQuestion(q), false);
});

test("eligibility repeats share a resolved country or the same unresolved location, never different locations", () => {
  const q: Question = {
    id: 1,
    kind: "question",
    text: "Are you legally authorized to work in this country?",
    answerKey: "question:first",
    country: "",
    locations: ["Remote, Worldwide"],
    instance: "batch",
    firstSeenAt: "2026-11-06T00:00:00Z",
    profileAnswers: false,
    profileFact: null,
    duplicate: false,
    applicationIds: [3],
  };
  assert.deepEqual(
    markDuplicates([
      q,
      {
        ...q,
        id: 2,
        answerKey: "question:second",
        locations: ["Remote, Europe"],
        applicationIds: [4],
      },
      { ...q, id: 3, locations: [" remote,  WORLDWIDE "], applicationIds: [5] },
    ]).map((q) => q.duplicate),
    [false, false, true],
  );
  assert.deepEqual(
    markDuplicates([
      { ...q, country: "Germany", locations: ["Berlin, Germany"] },
      {
        ...q,
        id: 2,
        country: "Germany",
        locations: ["Hamburg, Germany"],
        applicationIds: [4],
      },
    ]).map((q) => q.duplicate),
    [false, true],
  );
  assert.deepEqual(
    markDuplicates([
      { ...q, locations: [] },
      { ...q, id: 2, locations: [], applicationIds: [4] },
      { ...q, id: 3, locations: [] },
    ]).map((q) => q.duplicate),
    [false, false, true],
  );
  assert.deepEqual(
    markDuplicates([
      { ...q, kind: "sign_in", text: "Sign in first" },
      {
        ...q,
        id: 2,
        kind: "sign_in",
        text: "Sign in first",
        locations: ["Remote, Europe"],
      },
    ]).map((q) => q.duplicate),
    [false, true],
    "ordinary sign-in repeats do not depend on the job location",
  );
});
