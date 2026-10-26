import { createJobFinderAiClientFromEnvironment } from "@nestor/ai-providers";
import {
  JobFinderSettingsSchema,
  JobSearchPreferencesSchema,
  ResumeTemplateDefinitionSchema,
  type ResumeDraft,
  type ResumeLevel,
} from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { writeResume } from "@nestor/job-finder/resumes";

import { withCapturedModelFetch } from "../capture-fetch";
import type { EvalHttpCapture } from "../contracts";
import {
  RESUME_LANE_CASES,
  readPersonaResume,
  readRecordedListings,
  type ResumeLaneCase,
} from "./cases";
import {
  flagsLeft,
  inventedFacts,
  levelShape,
  levelVerdicts,
  type InventedFact,
  type LevelShape,
} from "./checks";
import { profileFromResumeText } from "./profile";

export const RESUME_LEVELS: readonly ResumeLevel[] = [
  "original",
  "light",
  "tailored",
  "aggressive",
];

export interface ResumeLaneResult {
  caseId: string;
  level: ResumeLevel;
  error: string | null;
  inventedFacts: InventedFact[];
  levelProblem: string | null;
  flagsLeft: string[];
  shape: LevelShape;
  seconds: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  draft: ResumeDraft | null;
}

/** Tokens from every model response in a capture (JSON or streamed). */
export function tokensUsed(captures: readonly EvalHttpCapture[]) {
  let prompt = 0;
  let completion = 0;
  for (const capture of captures) {
    const body = capture.responseBody ?? "";
    const usages = [...body.matchAll(/"usage"\s*:\s*(\{[^{}]*\})/gu)];
    const last = usages.at(-1)?.[1];
    if (!last) continue;
    try {
      const usage = JSON.parse(last) as Record<string, unknown>;
      prompt += Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
      completion += Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
    } catch {
      // A usage record split across chunks is skipped, not guessed.
    }
  }
  return { prompt, completion };
}

const NOW = new Date().toISOString();

/** One template, as the app lists it; pages are estimated, not rendered. */
const TEMPLATE = ResumeTemplateDefinitionSchema.parse({
  id: "classic_ats",
  label: "Chronology Classic",
  description: "Reverse chronology",
  density: "balanced",
  deliveryLane: "apply_safe",
  applyEligible: true,
  approvalEligible: true,
});

const documentManager = {
  listResumeTemplates: () => [TEMPLATE],
  renderResumeArtifact: (input: { renderDocument: unknown }) =>
    Promise.resolve({
      fileName: "resume.pdf",
      storagePath: null,
      format: "pdf" as const,
      // About 3,500 characters of content fill a page.
      pageCount: Math.max(
        1,
        Math.ceil(JSON.stringify(input.renderDocument).length / 3_500),
      ),
      warnings: [],
    }),
  discardResumeArtifact: () => Promise.resolve(),
};

/**
 * Writes every case at every level with the configured model, the same
 * `writeResume` the resume service runs, and scores each draft.
 */
export async function runResumeLane(
  cases: readonly ResumeLaneCase[] = RESUME_LANE_CASES,
  onResult: (result: ResumeLaneResult) => void = () => undefined,
): Promise<ResumeLaneResult[]> {
  const listings = readRecordedListings();
  const aiClient = createJobFinderAiClientFromEnvironment();
  const results: ResumeLaneResult[] = [];
  for (const evalCase of cases) {
    const listing = listings.get(evalCase.listingId);
    if (!listing) throw new Error(`No recorded listing ${evalCase.listingId}.`);
    const source = readPersonaResume(evalCase.persona);
    const profile = profileFromResumeText(evalCase.persona, source, NOW);
    const store = openJobStore(":memory:");
    const [jobId] = store.saveFoundJobs({
      searchId: null,
      jobs: [
        {
          title: listing.title,
          company: listing.company,
          location: listing.location,
          workModes: [],
          url: listing.url,
          applyUrl: null,
          sourceId: "recorded",
          sourceLabel: listing.company,
          sourceJobId: listing.id,
          postedAt: null,
          salaryText: null,
          salaryMin: null,
          salaryMax: null,
          salaryCurrency: null,
          seniority: null,
          employmentType: null,
          summary: null,
          description: listing.description,
        },
      ],
    }).added;
    const job = store.getJob(jobId!)!;
    store.close();
    const shapes: Partial<
      Record<ResumeLevel, LevelShape & { unchanged: boolean }>
    > = {};
    const caseResults: ResumeLaneResult[] = [];
    for (const level of RESUME_LEVELS) {
      const started = performance.now();
      let draft: ResumeDraft | null = null;
      let error: string | null = null;
      let captures: readonly EvalHttpCapture[] = [];
      try {
        const run = await withCapturedModelFetch({
          endpointPrefix: "http",
          run: () =>
            writeResume(
              { aiClient, documentManager },
              {
                profile,
                searchPreferences: JobSearchPreferencesSchema.parse({
                  targetRoles: [listing.title],
                  jobFamilies: [],
                  locations: [],
                  excludedLocations: [],
                  workModes: [],
                  seniorityLevels: [],
                  minimumSalaryUsd: null,
                  targetSalaryUsd: null,
                  salaryCurrency: "USD",
                  targetIndustries: [],
                  targetCompanyStages: [],
                  employmentTypes: [],
                  approvalMode: "review_before_submit",
                  tailoringMode: "balanced",
                  companyBlacklist: [],
                  companyWhitelist: [],
                  discovery: { historyLimit: 5, targets: [] },
                }),
                settings: JobFinderSettingsSchema.parse({
                  resumeTemplateId: TEMPLATE.id,
                  resumeFormat: "pdf",
                  fontPreset: "inter_requisite",
                  appearanceTheme: "system",
                  humanReviewRequired: true,
                  keepSessionAlive: false,
                  allowAutoSubmitOverride: false,
                  discoveryOnly: false,
                }),
                job,
                level,
              },
            ),
        });
        draft = run.result;
        captures = run.captures;
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
        captures =
          (caught as { captures?: readonly EvalHttpCapture[] }).captures ?? [];
      }
      const shape = levelShape({
        draft,
        source,
        listing: listing.description,
      });
      shapes[level] = { ...shape, unchanged: level === "original" && !draft };
      const tokens = tokensUsed(captures);
      const result: ResumeLaneResult = {
        caseId: evalCase.id,
        level,
        error,
        inventedFacts: draft
          ? inventedFacts({
              draft,
              source,
              listing: listing.description,
              company: listing.company,
            })
          : [],
        levelProblem: null,
        flagsLeft: flagsLeft(draft),
        shape,
        seconds: (performance.now() - started) / 1000,
        modelCalls: captures.length,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        draft,
      };
      caseResults.push(result);
    }
    const verdicts = levelVerdicts(
      shapes,
      profile.headline ?? "",
      listing.title,
    );
    for (const result of caseResults) {
      result.levelProblem = verdicts[result.level] ?? null;
      results.push(result);
      onResult(result);
    }
  }
  return results;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** The baseline table: one row per level, then every finding. */
export function formatResumeLaneReport(
  model: string,
  results: readonly ResumeLaneResult[],
): string {
  const lines = [
    `# Resume lane: ${model}`,
    "",
    `${results.length} resumes from ${new Set(results.map((r) => r.caseId)).size} cases, ${new Date().toISOString().slice(0, 10)}.`,
    "",
    "| Level | Resumes | Invented facts | Level as named | Flags left | Rewritten | Truthful keywords | Avg s | Avg calls | Avg tokens in/out |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const level of RESUME_LEVELS) {
    const rows = results.filter((result) => result.level === level);
    const avg = (pick: (row: ResumeLaneResult) => number) =>
      rows.length
        ? rows.reduce((sum, row) => sum + pick(row), 0) / rows.length
        : 0;
    lines.push(
      `| ${level} | ${rows.length}${rows.some((row) => row.error) ? ` (${rows.filter((row) => row.error).length} failed)` : ""} | ${rows.reduce((sum, row) => sum + row.inventedFacts.length, 0)} | ${rows.filter((row) => !row.levelProblem).length}/${rows.length} | ${rows.reduce((sum, row) => sum + row.flagsLeft.length, 0)} | ${pct(avg((row) => row.shape.rewrittenShare))} | ${pct(avg((row) => row.shape.truthfulKeywordCoverage))} | ${avg((row) => row.seconds).toFixed(1)} | ${avg((row) => row.modelCalls).toFixed(1)} | ${Math.round(avg((row) => row.promptTokens))}/${Math.round(avg((row) => row.completionTokens))} |`,
    );
  }
  lines.push("", "## Findings", "");
  for (const result of results) {
    const notes = [
      ...(result.error ? [`failed: ${result.error}`] : []),
      ...(result.levelProblem ? [result.levelProblem] : []),
      ...result.inventedFacts.map(
        (fact) => `invented ${fact.kind} "${fact.value}" in: ${fact.line}`,
      ),
      ...result.flagsLeft.map((flag) => `flag left: ${flag}`),
    ];
    if (notes.length)
      lines.push(
        `- **${result.caseId} / ${result.level}**`,
        ...notes.map((note) => `  - ${note}`),
      );
  }
  return lines.join("\n");
}
