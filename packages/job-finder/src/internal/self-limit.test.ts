import { afterEach, expect, test, vi } from "vitest";
import {
  ResumeDocumentBundleSchema,
  ResumeResearchArtifactSchema,
} from "@nestor/contracts";
import { createSeed } from "../test-fixtures";
import {
  buildResumeClaimEvidenceBank,
  collectResearchContext,
  collectResumeWorkspaceEvidence,
  stripEmploymentEndSentences,
  buildResumeProposalReplyContent,
} from "./resume-workspace-helpers";
import { seedResumeDraft } from "./resume-workspace-structure";
import { safeSnippet } from "./resume-workspace-primitives";
import { extractLiteralCandidates } from "./resume-import-literal-extraction";
import { parseSourceInstructionReviewOverride } from "./source-instruction-types";
import { filterSourceDebugWarnings } from "./source-instruction-filtering";
import { writeResumeLanguage } from "./resume-workspace-language";
import { withResumeClaimChecks } from "./resume-claim-checks";
import {
  enrichSearchPreferencesFromProfile,
  mergeEvents,
} from "./workspace-helpers";
import {
  compactPercentageText,
  stripGenericPurposeClauseTexts,
  stripRepeatedAppendedClauseTexts,
  summaryWithoutRepeatedBulletPhrases,
  orderBulletsMetricsFirst,
} from "../resumes/write-resume";

afterEach(() => vi.restoreAllMocks());

test("profile roles, retained events and the model's proposal note report omitted content", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    seed = createSeed();
  enrichSearchPreferencesFromProfile(
    { ...seed.searchPreferences, targetRoles: [] },
    { ...seed.profile, targetRoles: ["one", "two", "three", "four", "five"] },
  );
  mergeEvents(
    Array.from({ length: 101 }, (_, i) => ({
      id: String(i),
      at: "2026-11-06T00:00:00Z",
      title: "Synthetic",
      detail: "Synthetic event",
      emphasis: "neutral" as const,
    })),
    [],
  );
  buildResumeProposalReplyContent({
    approvalBlockers: [],
    changeCount: 1,
    assistantNote: "I prepared a draft.",
  });
  buildResumeProposalReplyContent({
    approvalBlockers: [],
    changeCount: 1,
    assistantNote: "Evidence is missing. ".repeat(30),
  });
  expect(hits(log).map((hit) => hit.limit)).toEqual(
    expect.arrayContaining([
      "profile_target_roles",
      "evidence_window",
      "assistant_note_wording_veto",
    ]),
  );
});
function hits(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; value: number }]
      : [],
  );
}
test("resume evidence, summary, research and retrieval windows report actual omissions", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    seed = createSeed();
  seed.profile.baseResume.textContent = Array.from(
    { length: 510 },
    (_, i) => `Synthetic evidence line ${i} ${"detailed work ".repeat(30)}`,
  ).join("\n");
  seed.profile.professionalSummary.fullSummary = "First synthetic summary";
  seed.profile.professionalSummary.shortValueProposition =
    "Second synthetic summary";
  seed.profile.summary = "Third synthetic summary";
  seed.profile.narrative.professionalStory = "Fourth synthetic summary";
  seed.profile.narrative.nextChapterSummary = "Fifth synthetic summary";
  seed.profile.narrative.differentiators = ["Sixth synthetic summary"];
  const proof = seed.profile.proofBank[0]!;
  seed.profile.proofBank = Array.from({ length: 8 }, (_, i) => ({
    ...proof,
    id: `proof_${i}`,
  }));
  const research = Array.from({ length: 10 }, (_, i) =>
    ResumeResearchArtifactSchema.parse({
      id: `research_${i}`,
      jobId: seed.savedJobs[0]!.id,
      sourceUrl: `https://example.test/${i}`,
      fetchedAt: "2026-11-06T00:00:00Z",
      fetchStatus: "success",
      companyNotes: `Synthetic note ${i}`,
      domainVocabulary: [`Vocabulary${i}`, `More${i}`],
      priorityThemes: [`Theme${i}`],
    }),
  );
  expect(buildResumeClaimEvidenceBank(seed.profile).length).toBeGreaterThan(0);
  collectResumeWorkspaceEvidence({
    profile: seed.profile,
    job: seed.savedJobs[0]!,
    research,
  });
  const context = collectResearchContext(research);
  expect(context.companyNotes).toHaveLength(3);
  expect(context.domainVocabulary).toHaveLength(8);
  expect(context.priorityThemes).toHaveLength(6);
  expect(safeSnippet("x".repeat(300))).toHaveLength(220);
  expect(hits(log).map((hit) => hit.value)).toEqual(
    expect.arrayContaining([500, 320, 4, 6, 8, 3, 220]),
  );
});
test("literal resume header windows are visible even when extraction succeeds", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const text = Array.from(
    { length: 20 },
    (_, i) => `Synthetic section line ${i}`,
  ).join("\n");
  const bundle = ResumeDocumentBundleSchema.parse({
    id: "bundle",
    runId: "run",
    sourceResumeId: "resume",
    sourceFileKind: "plain_text",
    primaryParserKind: "plain_text",
    createdAt: "2026-11-06T00:00:00Z",
    fullText: text,
    blocks: text.split("\n").map((text, i) => ({
      id: `block${i}`,
      pageNumber: 1,
      kind: "paragraph",
      sectionHint: "other",
      text,
      readingOrder: i,
    })),
  });
  extractLiteralCandidates("run", bundle, "2026-11-06T00:00:00Z");
  expect(hits(log).some((hit) => hit.value === 8)).toBe(true);
  expect(hits(log).some((hit) => hit.value === 12)).toBe(true);
});
test("local prose edits, keyword vetos and metric reordering report the model override", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(
    stripEmploymentEndSentences("Built useful tools. Position was eliminated."),
  ).toBe("Built useful tools.");
  stripGenericPurposeClauseTexts([
    "Built a reliable data processing platform used across the company to improve performance.",
  ]);
  stripRepeatedAppendedClauseTexts([
    "Built internal APIs with SQL and automated tests",
    "Led the migration to a new billing platform with SQL and automated tests",
    "Improved release reliability with SQL and automated tests",
  ]);
  summaryWithoutRepeatedBulletPhrases(
    "Built useful tools. Led React and TypeScript platform used by teams.",
    ["Led React and TypeScript platform used by teams."],
  );
  expect(compactPercentageText("Improved by 20 percent")).toContain("20%");
  orderBulletsMetricsFirst([
    { text: "Built tools" },
    { text: "Saved 20 hours" },
  ]);
  expect(hits(log).map((hit) => hit.limit)).toEqual(
    expect.arrayContaining([
      "employment_end_wording",
      "generic_purpose_veto",
      "repeated_clause_veto",
      "summary_phrase_veto",
      "percentage_wording",
      "metric_bullet_order",
    ]),
  );
});
test("hidden source-intelligence validation and warning-word vetoes report", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  parseSourceInstructionReviewOverride({
    intelligence: { collection: { preferredMethod: "made-up-method" } },
  });
  expect(
    filterSourceDebugWarnings(["Agent runtime failed on this page"]),
  ).toEqual([]);
  expect(hits(log).map((hit) => hit.limit)).toEqual([
    "source_intelligence_validator",
    "source_warning_keyword_veto",
  ]);
});
test("removed translation caps stay quiet and claim-check writer deadlines report", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {}),
    seed = createSeed(),
    job = seed.savedJobs[0]!;
  const draft = seedResumeDraft({
    profile: seed.profile,
    job,
    templateId: seed.settings.resumeTemplateId,
  });
  await expect(
    writeResumeLanguage({
      draft,
      job,
      aiClient: {
        chatWithTools: () =>
          Promise.resolve({ content: "{}", finishReason: "length" }),
      },
    }),
  ).rejects.toThrow();
  await expect(
    withResumeClaimChecks({
      draft: {
        ...draft,
        sections: draft.sections.map((section) => ({
          ...section,
          origin: "ai_generated" as const,
          text:
            section.kind === "summary"
              ? "A new generated synthetic claim."
              : section.text,
        })),
      },
      job,
      profile: seed.profile,
      aiClient: { checkResumeClaims: () => Promise.resolve([]) },
      getRemainingBudgetMs: () => 0,
    }),
  ).rejects.toThrow();
  expect(hits(log).some((hit) => hit.limit === "resume_language_output")).toBe(
    false,
  );
  expect(
    hits(log).some((hit) => hit.limit === "claim_check_writing_budget"),
  ).toBe(true);
});
