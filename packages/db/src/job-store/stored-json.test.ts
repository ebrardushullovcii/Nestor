import {
  ApplicationResumeArtifactSchema,
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  JobListingFactsSchema,
  JobSearchSettingsSchema,
  ResumeDraftSchema,
  SubmissionOutcomeRecordSchema,
  TrackerFilterSchema,
} from "@nestor/contracts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * JSON the store keeps and reads back with a contracts schema changes
 * additively only: a new field is optional or has a default, and no field
 * that stored rows have is removed, renamed or tightened. `stored-json/`
 * holds rows written by each schema as it was on 2026-10-26: `full` fills
 * every optional field, `minimal` leaves out everything that may be absent.
 * Never edit a fixture to make a schema change pass; a new shape gets new
 * fixtures beside the old ones.
 */
interface StoredJsonSchema {
  safeParse(
    value: unknown,
  ): { success: true } | { success: false; error: { issues: unknown[] } };
}

const STORED_JSON: Record<string, StoredJsonSchema> = {
  ResumeDraftSchema,
  JobSearchSettingsSchema,
  TrackerFilterSchema,
  JobListingFactsSchema,
  ApplicationReviewCardSchema,
  SubmissionOutcomeRecordSchema,
  ApplicationResumeArtifactSchema,
  ApplyExecutionResultSchema,
};

const FIXTURES: Record<string, string> = {
  ResumeDraftSchema: "resume-draft",
  JobSearchSettingsSchema: "job-search-settings",
  TrackerFilterSchema: "tracker-filter",
  JobListingFactsSchema: "job-listing-facts",
  ApplicationReviewCardSchema: "application-review-card",
  SubmissionOutcomeRecordSchema: "submission-outcome-record",
  ApplicationResumeArtifactSchema: "application-resume-artifact",
  ApplyExecutionResultSchema: "apply-execution-result",
};

const fixtureDir = path.join(__dirname, "stored-json");

describe("JSON the job store keeps", () => {
  it("covers every schema the store parses stored JSON with", () => {
    const parsed = new Set<string>();
    for (const file of readdirSync(__dirname)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const source = readFileSync(path.join(__dirname, file), "utf8");
      for (const match of source.matchAll(
        /([A-Za-z]+Schema)(?:\.[a-z]+\(\))*\s*\.\s*(?:parse|safeParse)\(\s*JSON\.parse\(/g,
      ))
        parsed.add(match[1]!);
    }
    expect([...parsed].sort()).toEqual(Object.keys(STORED_JSON).sort());
  });

  for (const [name, schema] of Object.entries(STORED_JSON))
    for (const shape of ["full", "minimal"])
      it(`reads ${FIXTURES[name]} rows written on 2026-10-26 (${shape})`, () => {
        const row = JSON.parse(
          readFileSync(
            path.join(fixtureDir, `${FIXTURES[name]}.${shape}.json`),
            "utf8",
          ),
        ) as unknown;
        const result = schema.safeParse(row);
        expect(result.success ? [] : result.error.issues).toEqual([]);
      });
});
