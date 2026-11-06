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
  buildResumeProposalReplyContent,
} from "./resume-workspace-helpers";
import { seedResumeDraft } from "./resume-workspace-structure";
import { safeSnippet } from "./resume-workspace-primitives";
import { extractLiteralCandidates } from "./resume-import-literal-extraction";
import { parseSourceInstructionReviewOverride } from "./source-instruction-types";
import { filterSourceDebugWarnings } from "./source-instruction-filtering";
import { writeResumeLanguage } from "./resume-workspace-language";
import {
  enrichSearchPreferencesFromProfile,
  mergeEvents,
} from "./workspace-helpers";

afterEach(() => vi.restoreAllMocks());

test("profile roles, retained events and the model's proposal note preserve content", () => {
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
  expect(hits(log)).toEqual([]);
});
function hits(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; value: number }]
      : [],
  );
}
test("resume evidence, summary, research and retrieval preserve the complete record", () => {
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
  expect(context.companyNotes).toHaveLength(10);
  expect(context.domainVocabulary).toHaveLength(20);
  expect(context.priorityThemes).toHaveLength(10);
  expect(safeSnippet("x".repeat(300))).toHaveLength(300);
  expect(hits(log).every((hit) => [3, 6].includes(hit.value))).toBe(true);
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
test("source-intelligence validation reports its schema error while warning facts stay visible", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  parseSourceInstructionReviewOverride({
    intelligence: { collection: { preferredMethod: "made-up-method" } },
  });
  expect(
    filterSourceDebugWarnings(["Agent runtime failed on this page"]),
  ).toEqual(["Agent runtime failed on this page"]);
  expect(hits(log).map((hit) => hit.limit)).toEqual([
    "source_intelligence_validator",
  ]);
});
test("removed translation caps stay quiet", async () => {
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
  expect(hits(log).some((hit) => hit.limit === "resume_language_output")).toBe(
    false,
  );
});
