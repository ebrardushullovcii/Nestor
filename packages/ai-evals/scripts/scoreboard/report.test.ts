import assert from "node:assert/strict";
import { test } from "vitest";
import { markDuplicates, markdown, profileAnswer } from "./report.ts";
import type { Question, Run } from "./types.ts";

test("profile audit flags known facts without inventing sensitive or foreign-country answers", () => {
  for (const question of [
    "Will you require sponsorship?",
    "What is your notice period?",
    "Can you work remotely?",
    "Your email",
    "Years of professional experience",
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

test("report keeps failures, unrun scenarios and v2 distinct from passes", () => {
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
        id: "v2",
        name: "v2",
        status: "not built",
        seconds: 0,
        questions: [],
        metrics: { summary: "not built yet" },
      },
    ],
  };
  const report = markdown(run);
  assert.match(report, /Standard \| FAIL/);
  assert.match(report, /Search \| NOT RUN/);
  assert.match(report, /v2 \| NOT BUILT/);
  assert.match(report, /site \\\| failed/);
  assert.match(report, /Checker failed.*Step: check.*browser-agent/);
  assert.doesNotMatch(report, /\| PASS \|/);
});
