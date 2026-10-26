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
  LIGHT_MAX_EDIT,
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
    const payloads = body.trimStart().startsWith("{")
      ? [body]
      : body
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line && line !== "[DONE]");
    let usage: Record<string, unknown> | null = null;
    for (const payload of payloads) {
      try {
        const parsed = JSON.parse(payload) as { usage?: unknown };
        if (parsed.usage && typeof parsed.usage === "object")
          usage = parsed.usage as Record<string, unknown>;
      } catch {
        // Not JSON: a keep-alive or a cut-off chunk.
      }
    }
    if (!usage) continue;
    prompt += Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
    completion += Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
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

function caseInputs(evalCase: ResumeLaneCase) {
  const listing = readRecordedListings().get(evalCase.listingId);
  if (!listing) throw new Error(`No recorded listing ${evalCase.listingId}.`);
  const source = readPersonaResume(evalCase.persona);
  const profile = profileFromResumeText(evalCase.persona, source, NOW);
  return { listing, source, profile };
}

interface Written {
  level: ResumeLevel;
  draft: ResumeDraft | null;
  error: string | null;
  seconds: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
}

/** Scores one case's drafts at every level; the same for a live run and a saved one. */
export function scoreCase(
  evalCase: ResumeLaneCase,
  written: readonly Written[],
): ResumeLaneResult[] {
  const { listing, source, profile } = caseInputs(evalCase);
  const scored = written.map((entry) => {
    const facts = entry.draft
      ? inventedFacts({
          draft: entry.draft,
          source,
          listing: listing.description,
          title: listing.title,
          company: listing.company,
          yearsExperience: profile.yearsExperience,
        })
      : [];
    const shape = levelShape({
      draft: entry.draft,
      source,
      listing: listing.description,
      title: listing.title,
    });
    return { entry, facts, shape };
  });
  const verdicts = levelVerdicts(
    Object.fromEntries(
      scored.map(({ entry, facts, shape }) => [
        entry.level,
        {
          ...shape,
          unchanged: entry.level === "original" && !entry.draft && !entry.error,
          inventedCount: facts.length,
        },
      ]),
    ),
    profile.headline ?? "",
    listing.title,
  );
  return scored.map(({ entry, facts, shape }) => ({
    caseId: evalCase.id,
    level: entry.level,
    draft: entry.draft,
    error: entry.error,
    seconds: entry.seconds,
    modelCalls: entry.modelCalls,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    inventedFacts: facts,
    levelProblem: entry.error
      ? `failed: ${entry.error}`
      : (verdicts[entry.level] ?? null),
    flagsLeft: flagsLeft(entry.draft),
    shape,
  }));
}

/**
 * Writes every case at every level with the configured model, the same
 * `writeResume` the resume service runs, and scores each draft.
 */
export async function runResumeLane(
  cases: readonly ResumeLaneCase[] = RESUME_LANE_CASES,
  onResult: (result: ResumeLaneResult) => void = () => undefined,
): Promise<ResumeLaneResult[]> {
  const aiClient = createJobFinderAiClientFromEnvironment();
  const results: ResumeLaneResult[] = [];
  for (const evalCase of cases) {
    const { listing, profile } = caseInputs(evalCase);
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
    const written: Written[] = [];
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
                searchPreferences: searchPreferences(listing.title),
                settings: SETTINGS,
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
      const tokens = tokensUsed(captures);
      written.push({
        level,
        draft,
        error,
        seconds: (performance.now() - started) / 1000,
        modelCalls: captures.length,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
      });
    }
    for (const result of scoreCase(evalCase, written)) {
      results.push(result);
      onResult(result);
    }
  }
  return results;
}

/** Scores a saved run again (after a check changes) without calling the model. */
export function rescoreResumeLane(
  saved: readonly ResumeLaneResult[],
): ResumeLaneResult[] {
  return RESUME_LANE_CASES.flatMap((evalCase) => {
    const rows = saved.filter((row) => row.caseId === evalCase.id);
    return rows.length ? scoreCase(evalCase, rows) : [];
  });
}

function searchPreferences(title: string) {
  return JobSearchPreferencesSchema.parse({
    targetRoles: [title],
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
  });
}

const SETTINGS = JobFinderSettingsSchema.parse({
  resumeTemplateId: TEMPLATE.id,
  resumeFormat: "pdf",
  fontPreset: "inter_requisite",
  appearanceTheme: "system",
  humanReviewRequired: true,
  keepSessionAlive: false,
  allowAutoSubmitOverride: false,
  discoveryOnly: false,
});

const pct = (value: number) => `${Math.round(value * 100)}%`;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

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
    `As named: 0 invented facts at every level, and Original unchanged; Light keeps the headline and edits at most ${pct(LIGHT_MAX_EDIT)} of words; Tailored edits more than Light; Aggressive edits at least as much as Tailored and leads with the role.`,
    "",
    "| Level | Resumes | Invented facts | As named | Flags left | Median edit size | Truthful tool coverage | Median s | Median calls | Median tokens in/out |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const level of RESUME_LEVELS) {
    const rows = results.filter((result) => result.level === level);
    const mid = (pick: (row: ResumeLaneResult) => number) =>
      median(rows.map(pick));
    lines.push(
      `| ${level} | ${rows.length} | ${rows.reduce((sum, row) => sum + row.inventedFacts.length, 0)} | ${rows.filter((row) => !row.levelProblem).length}/${rows.length} | ${rows.reduce((sum, row) => sum + row.flagsLeft.length, 0)} | ${pct(mid((row) => row.shape.editSize))} | ${pct(mid((row) => row.shape.truthfulKeywordCoverage))} | ${mid((row) => row.seconds).toFixed(1)} | ${mid((row) => row.modelCalls)} | ${Math.round(mid((row) => row.promptTokens))}/${Math.round(mid((row) => row.completionTokens))} |`,
    );
  }
  const written = results.filter((row) => row.level !== "original");
  lines.push(
    "",
    `Median write time over the ${written.length} written resumes: ${median(written.map((row) => row.seconds)).toFixed(1)} s.`,
    "",
    "## Findings",
    "",
  );
  for (const result of results) {
    const notes = [
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
