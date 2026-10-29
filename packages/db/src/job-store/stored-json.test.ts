import {
  ApplicationResumeArtifactSchema,
  ApplicationReviewCardSchema,
  ApplyExecutionResultSchema,
  JobListingFactsSchema,
  JobSearchSettingsSchema,
  ResumeDraftSchema,
  SavedOptionFallbackSchema,
  SubmissionOutcomeRecordSchema,
  TrackerFilterSchema,
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  ProfileEditsDraftSchema,
  ProfileSetupStateSchema,
  SourceInstructionArtifactSchema,
  ApplicationAuthorityEnvelopeSchema,
  SubmissionPreflightRecordSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionArmedMarkerSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  PreparedApplicationFormSchema,
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
 * fixtures beside the old ones. The one exception is a field the product no
 * longer reads or writes: list it in `RETIRED_FIELDS`, and the old row must
 * still parse with the field dropped.
 */
interface StoredJsonSchema {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: unknown[] } };
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
  ProfileCopilotMessageSchema,
  ProfileRevisionSchema,
  ResumeDocumentBundleSchema,
  ResumeImportFieldCandidateSchema,
  ResumeImportRunSchema,
  ProfileEditsDraftSchema,
  ProfileSetupStateSchema,
  SourceInstructionArtifactSchema,
  ApplicationAuthorityEnvelopeSchema,
  SubmissionPreflightRecordSchema,
  SubmissionExecutionGrantSchema,
  SubmissionIdempotencyRecordSchema,
  SubmissionArmedMarkerSchema,
  ApprovedApplicationAnswerSnapshotSchema,
  PreparedApplicationFormSchema,
  SavedOptionFallbackSchema,
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
  ProfileCopilotMessageSchema: "profile-copilot-message",
  ProfileRevisionSchema: "profile-revision",
  ResumeDocumentBundleSchema: "resume-document-bundle",
  ResumeImportFieldCandidateSchema: "resume-import-field-candidate",
  ResumeImportRunSchema: "resume-import-run",
  ProfileEditsDraftSchema: "profile-edits-draft",
  ProfileSetupStateSchema: "profile-setup-state",
  SourceInstructionArtifactSchema: "source-instruction-artifact",
  ApplicationAuthorityEnvelopeSchema: "application-authority-envelope",
  SubmissionPreflightRecordSchema: "submission-preflight",
  SubmissionExecutionGrantSchema: "submission-execution-grant",
  SubmissionIdempotencyRecordSchema: "submission-idempotency-record",
  SubmissionArmedMarkerSchema: "submission-armed-marker",
  ApprovedApplicationAnswerSnapshotSchema:
    "approved-application-answer-snapshot",
  PreparedApplicationFormSchema: "prepared-application-form",
  SavedOptionFallbackSchema: "saved-option-fallback",
};

/** Fields removed from a schema on purpose; stored rows still carry them. */
const RETIRED_FIELDS: Record<string, readonly string[]> = {
  ResumeDraftSchema: ["claimConfirmations"],
};

const fixtureDir = path.join(__dirname, "stored-json");

describe("JSON the job store keeps", () => {
  it("covers every schema the store parses stored JSON with", () => {
    // These two readers assemble an envelope around JSON-valued fields
    // before parsing, rather than calling Schema.parse(JSON.parse(...)).
    // The send guards parse each table's rows through that table's entry.
    const parsed = new Set<string>([
      "ProfileEditsDraftSchema",
      "ProfileSetupStateSchema",
    ]);
    const guards = readFileSync(path.join(__dirname, "send-guards.ts"), "utf8");
    for (const match of guards.matchAll(/([A-Za-z]+Schema)\.parse\(value\)/g))
      parsed.add(match[1]!);
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
        if (result.success) {
          if (row !== null && typeof row === "object") {
            const retired = RETIRED_FIELDS[name] ?? [];
            expect(result.data).toMatchObject(
              Object.fromEntries(
                Object.entries(row).filter(([key]) => !retired.includes(key)),
              ),
            );
            for (const field of retired)
              expect(result.data).not.toHaveProperty(field);
          } else expect(result.data).toEqual(row);
        }
      });
});
