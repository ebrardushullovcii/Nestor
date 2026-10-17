import {
  CandidateProfileSchema,
  ApplicationAnswerRecordSchema,
  ApplicationQuestionRecordSchema,
} from "@nestor/contracts";
import { expect, test } from "vitest";
import { createSeed } from "./test-fixtures";
import { quarantineAgentAnswers } from "./agent-answer-migration";

test.each(["profile", "user"] as const)(
  "agent-chosen zero (%s) needs confirmation while a person's answer and unknown provenance stay intact",
  (agentKind) => {
    const profile = createSeed().profile;
    profile.answerBank.customAnswers = ["agent", "person", "unknown"].map(
      (id) => ({
        id,
        label: id,
        question: `${id} experience`,
        answer: "0",
        kind: "other",
        roleFamilies: [],
        proofEntryIds: [],
      }),
    );
    const at = "2026-10-01T10:00:00.000Z";
    const questions = ["agent", "person"].map((id) =>
      ApplicationQuestionRecordSchema.parse({
        id,
        prompt: `${id} experience`,
        runId: "run",
        jobId: "job",
        detectedAt: at,
      }),
    );
    const answers = ["agent", "person"].map((id) =>
      ApplicationAnswerRecordSchema.parse({
        id,
        questionId: id,
        runId: "run",
        jobId: "job",
        text: "0",
        sourceKind: id === "person" ? "user" : agentKind,
        sourceId: id === "person" ? id : "chosen.c0",
        createdAt: at,
      }),
    );
    const repaired = quarantineAgentAnswers(profile, questions, answers);
    expect(
      repaired.answerBank.customAnswers.map(
        (answer) => answer.needsConfirmation,
      ),
    ).toEqual([true, undefined, undefined]);
    expect(quarantineAgentAnswers(repaired, questions, answers)).toEqual(
      repaired,
    );
    expect(
      profile.answerBank.customAnswers[0]?.needsConfirmation,
    ).toBeUndefined();
  },
);

test("the persisted repair runs once and retains later person confirmation", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { runMigrations } = await import("./internal/migrations");
  const database = new DatabaseSync(":memory:");
  try {
    runMigrations(database);
    const profile = createSeed().profile;
    profile.answerBank.customAnswers = [
      {
        id: "old",
        label: "Experience",
        question: "Years?",
        answer: "0",
        kind: "other",
        roleFamilies: [],
        proofEntryIds: [],
      },
    ];
    const at = "2026-10-01T10:00:00.000Z";
    const question = ApplicationQuestionRecordSchema.parse({
      id: "question",
      runId: "run",
      jobId: "job",
      prompt: "Years?",
      detectedAt: at,
    });
    const answer = ApplicationAnswerRecordSchema.parse({
      id: "answer",
      questionId: "question",
      runId: "run",
      jobId: "job",
      text: "0",
      sourceKind: "profile",
      sourceId: "written.c0",
      createdAt: at,
    });
    database
      .prepare("INSERT INTO singleton_state (key, value) VALUES ('profile', ?)")
      .run(JSON.stringify(CandidateProfileSchema.parse(profile)));
    database
      .prepare(
        "INSERT INTO application_question_records (id, run_id, job_id, detected_at, value) VALUES (?, ?, ?, ?, ?)",
      )
      .run(question.id, "run", "job", at, JSON.stringify(question));
    database
      .prepare(
        "INSERT INTO application_answer_records (id, run_id, job_id, question_id, created_at, value) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(answer.id, "run", "job", question.id, at, JSON.stringify(answer));
    database.exec("DELETE FROM schema_migrations WHERE version = 19");
    runMigrations(database);
    const read = () =>
      JSON.parse(
        (
          database
            .prepare("SELECT value FROM singleton_state WHERE key = 'profile'")
            .get() as { value: string }
        ).value,
      ) as typeof profile;
    const repaired = read();
    expect(repaired.answerBank.customAnswers[0]?.needsConfirmation).toBe(true);
    repaired.answerBank.customAnswers[0]!.needsConfirmation = false;
    database
      .prepare("UPDATE singleton_state SET value = ? WHERE key = 'profile'")
      .run(JSON.stringify(repaired));
    runMigrations(database);
    expect(read().answerBank.customAnswers[0]?.needsConfirmation).toBe(false);
  } finally {
    database.close();
  }
});
