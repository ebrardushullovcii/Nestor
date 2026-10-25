import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { ProfileCopilotMessageSchema, SavedJobSchema } from "@nestor/contracts";

import { listCollectionValues, listValues, stateTableNames } from "./state";
import { ensureSavedJobRelations } from "./saved-job-storage";

describe("state collection pagination", () => {
  test("supports complete reads, exact windows, and offset-only traversal", () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE ${stateTableNames.saved_jobs} (
        id TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE ${stateTableNames.profile_copilot_messages} (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        value TEXT NOT NULL
      );
    `);

    ensureSavedJobRelations(database);
    const jobs = Array.from({ length: 7 }, (_, index) =>
      SavedJobSchema.parse({
        id: `job_${index}`,
        source: "target_site",
        sourceJobId: `source_${index}`,
        discoveryMethod: "catalog_seed",
        canonicalUrl: `https://jobs.example.com/${index}`,
        applicationUrl: `https://jobs.example.com/${index}/apply`,
        title: `Role ${index}`,
        company: "Example",
        location: "Remote",
        workMode: ["remote"],
        applyPath: "easy_apply",
        easyApplyEligible: true,
        postedAt: "2026-01-01T00:00:00.000Z",
        postedAtText: null,
        discoveredAt: "2026-01-01T00:00:00.000Z",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z",
        lastVerifiedActiveAt: "2026-01-01T00:00:00.000Z",
        salaryText: null,
        normalizedCompensation: {
          currency: "USD",
          interval: "year",
          minAmount: 100000,
          maxAmount: 100000,
          minAnnualUsd: 100000,
          maxAnnualUsd: 100000,
        },
        summary: "Example role",
        description: "Example role",
        keySkills: [],
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
        seniority: null,
        employmentType: null,
        department: null,
        team: null,
        employerWebsiteUrl: null,
        employerDomain: null,
        atsProvider: null,
        screeningHints: {
          sponsorshipText: null,
          requiresSecurityClearance: null,
          relocationText: null,
          travelText: null,
          remoteGeographies: [],
        },
        keywordSignals: [],
        benefits: [],
        status: "ready_for_review",
        matchAssessment: { score: 1, reasons: [], gaps: [] },
        provenance: [],
      }),
    );
    const messages = Array.from({ length: 7 }, (_, index) =>
      ProfileCopilotMessageSchema.parse({
        id: `message_${index}`,
        role: "assistant",
        content: `Message ${index}`,
        context: { surface: "general" },
        patchGroups: [],
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      }),
    );

    const insertJob = database.prepare(
      `INSERT INTO ${stateTableNames.saved_jobs} (id, value) VALUES (?, ?)`,
    );
    for (const job of jobs) {
      insertJob.run(job.id, JSON.stringify(job));
    }
    const insertMessage = database.prepare(
      `INSERT INTO ${stateTableNames.profile_copilot_messages} (id, created_at, value) VALUES (?, ?, ?)`,
    );
    for (const message of messages) {
      insertMessage.run(message.id, message.createdAt, JSON.stringify(message));
    }

    expect(listValues(database, "saved_jobs", SavedJobSchema)).toHaveLength(7);
    expect(
      listValues(database, "saved_jobs", SavedJobSchema, {
        limit: 3,
        offset: 2,
      }).map((job) => job.id),
    ).toEqual(["job_2", "job_3", "job_4"]);
    expect(
      listValues(database, "saved_jobs", SavedJobSchema, { offset: 5 }).map(
        (job) => job.id,
      ),
    ).toEqual(["job_5", "job_6"]);

    expect(
      listCollectionValues(
        database,
        "profile_copilot_messages",
        ProfileCopilotMessageSchema,
        { orderBySql: "created_at ASC, id ASC", limit: 2, offset: 3 },
      ).map((message) => message.id),
    ).toEqual(["message_3", "message_4"]);
    expect(
      listCollectionValues(
        database,
        "profile_copilot_messages",
        ProfileCopilotMessageSchema,
        { orderBySql: "created_at ASC, id ASC", offset: 6 },
      ).map((message) => message.id),
    ).toEqual(["message_6"]);

    database.close();
  });
});
