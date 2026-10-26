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
  resumeTechnologyNames,
  type ResumeLaneCase,
} from "./cases";
import {
  LIGHT_MAX_EDIT,
  flagsLeft,
  assessFacts,
  levelShape,
  levelVerdicts,
  type InventedFact,
  type LevelShape,
  type ResumeStretch,
  draftLines,
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
  stretches: ResumeStretch[];
  levelProblem: string | null;
  flagsLeft: string[];
  shape: LevelShape;
  seconds: number;
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  draft: ResumeDraft | null;
  captures?: readonly EvalHttpCapture[] | undefined;
  stretchChecks: StretchCheckReport;
}

export interface StretchCheckReport {
  traceAvailable: boolean;
  sanctioned: Array<{
    text: string;
    stretches: ResumeStretch[];
    flagged: boolean;
    removed: boolean;
    checked: boolean;
    missingBeforeCheck: boolean;
    unanswered: boolean;
    verdicts: Array<{ verdict: string; reason: string }>;
  }>;
  /** Listing-only lines without a writer inferred flag or a model stretch verdict. */
  unflaggedListingLines: string[];
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
const json = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

/** Complete response objects from both JSON and streamed Responses/Chat APIs. */
function responseObjects(body: string): JsonObject[] {
  const payloads = body.trimStart().startsWith("{")
    ? [body]
    : body
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim());
  return payloads.flatMap((payload) => {
    const value = object(json(payload));
    return value ? [object(value.response) ?? value] : [];
  });
}

function responseContributions(capture: EvalHttpCapture): unknown[] {
  const values: unknown[] = [];
  for (const payload of responseObjects(capture.responseBody ?? "")) {
    for (const raw of Array.isArray(payload.output) ? payload.output : []) {
      const item = object(raw);
      if (!item) continue;
      if (item.type === "function_call" && typeof item.arguments === "string")
        values.push(json(item.arguments));
      for (const rawContent of Array.isArray(item.content)
        ? item.content
        : []) {
        const content = object(rawContent);
        if (typeof content?.text === "string") values.push(json(content.text));
      }
    }
    for (const raw of Array.isArray(payload.choices) ? payload.choices : []) {
      const message = object(object(raw)?.message);
      if (!message) continue;
      if (typeof message.content === "string")
        values.push(json(message.content));
      for (const rawCall of Array.isArray(message.tool_calls)
        ? message.tool_calls
        : []) {
        const fn = object(object(rawCall)?.function);
        if (typeof fn?.arguments === "string") values.push(json(fn.arguments));
      }
    }
  }
  return values;
}

/** Measure what the unchanged checker does to sanctioned Aggressive stretches. */
export function stretchCheckReport(input: {
  draft: ResumeDraft | null;
  captures?: readonly EvalHttpCapture[] | undefined;
  source: string;
  listing: string;
  title: string;
  company: string;
  yearsExperience: number | null;
  technologyNames?: readonly string[] | undefined;
  credentialNames?: readonly string[] | undefined;
}): StretchCheckReport {
  const report: StretchCheckReport = {
    traceAvailable: Boolean(input.captures?.length),
    sanctioned: [],
    unflaggedListingLines: [],
  };
  if (!input.draft || !input.captures?.length) return report;
  const inferred = new Map<string, string>();
  const key = (text: string) => text.replace(/\s+/gu, " ").trim();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const child of value) walk(child);
      return;
    }
    const entry = object(value);
    if (!entry) return;
    if (entry.inferred === true && typeof entry.text === "string")
      inferred.set(key(entry.text), entry.text);
    for (const child of Object.values(entry)) walk(child);
  };
  const asked = new Set<string>();
  const checks = new Map<string, Array<{ verdict: string; reason: string }>>();
  for (const capture of input.captures) {
    const contributions = responseContributions(capture);
    for (const contribution of contributions) walk(contribution);
    const request = object(json(capture.requestBody));
    const claims = new Map<string, string>();
    const readClaims = (value: unknown) => {
      const entry = object(value);
      if (!entry || !Array.isArray(entry.claims)) return;
      for (const raw of entry.claims) {
        const claim = object(raw);
        if (typeof claim?.id === "string" && typeof claim.text === "string") {
          claims.set(claim.id, claim.text);
          asked.add(claim.text);
        }
      }
    };
    for (const raw of Array.isArray(request?.messages)
      ? request.messages
      : Array.isArray(request?.input)
        ? request.input
        : []) {
      const message = object(raw);
      if (typeof message?.content === "string")
        readClaims(json(message.content));
      for (const rawContent of Array.isArray(message?.content)
        ? message.content
        : []) {
        const content = object(rawContent);
        if (typeof content?.text === "string") readClaims(json(content.text));
      }
    }
    for (const contribution of contributions) {
      const result = object(contribution);
      if (!Array.isArray(result?.checks)) continue;
      for (const raw of result.checks) {
        const check = object(raw);
        if (typeof check?.id !== "string" || typeof check.verdict !== "string")
          continue;
        const text = claims.get(check.id);
        if (!text) continue;
        const verdicts = checks.get(text) ?? [];
        verdicts.push({
          verdict: check.verdict,
          reason: typeof check.reason === "string" ? check.reason : "",
        });
        checks.set(text, verdicts);
      }
    }
  }
  const final = new Set(draftLines(input.draft).map((line) => key(line.text)));
  for (const text of new Set([...checks.keys(), ...inferred.values()])) {
    const verdicts = checks.get(text) ?? [];
    const section = {
      ...input.draft.sections[0]!,
      id: "probe",
      kind: "summary" as const,
      label: "Summary",
      included: true,
      text,
      bullets: [],
      entries: [],
    };
    const stretches = assessFacts({
      ...input,
      level: "aggressive",
      draft: { ...input.draft, sections: [section] },
    }).stretches.filter((stretch) => stretch.kind !== "model");
    if (!stretches.length) continue;
    const flagged = verdicts.some((check) => check.verdict !== "supported");
    if (
      inferred.has(key(text)) ||
      verdicts.some((check) => check.verdict === "stretch")
    )
      report.sanctioned.push({
        text,
        stretches,
        flagged,
        removed: !final.has(key(text)),
        checked: verdicts.length > 0,
        missingBeforeCheck: !asked.has(text) && !final.has(key(text)),
        unanswered: asked.has(text) && verdicts.length === 0,
        verdicts,
      });
    else report.unflaggedListingLines.push(text);
  }
  return report;
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
        // Chat completions put usage on the payload; the Responses API puts
        // it on the response inside its completed event.
        const parsed = JSON.parse(payload) as {
          usage?: unknown;
          response?: { usage?: unknown };
        };
        const found = parsed.usage ?? parsed.response?.usage;
        if (found && typeof found === "object")
          usage = found as Record<string, unknown>;
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
  captures?: readonly EvalHttpCapture[] | undefined;
}

/** Scores one case's drafts at every level; the same for a live run and a saved one. */
export function scoreCase(
  evalCase: ResumeLaneCase,
  written: readonly Written[],
): ResumeLaneResult[] {
  const { listing, source, profile } = caseInputs(evalCase);
  const scored = written.map((entry) => {
    const assessment = entry.draft
      ? assessFacts({
          draft: entry.draft,
          level: entry.level,
          source,
          listing: listing.description,
          title: listing.title,
          company: listing.company,
          yearsExperience: profile.yearsExperience,
          technologyNames: resumeTechnologyNames(),
          credentialNames: listing.credentials,
        })
      : { invented: [], stretches: [] };
    const facts = assessment.invented;
    const shape = levelShape({
      draft: entry.draft,
      source,
      listing: listing.description,
      title: listing.title,
    });
    return { entry, facts, stretches: assessment.stretches, shape };
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
  return scored.map(({ entry, facts, stretches, shape }) => ({
    caseId: evalCase.id,
    level: entry.level,
    draft: entry.draft,
    error: entry.error,
    seconds: entry.seconds,
    modelCalls: entry.modelCalls,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    inventedFacts: facts,
    stretches,
    captures: entry.captures,
    stretchChecks:
      entry.level === "aggressive"
        ? stretchCheckReport({
            draft: entry.draft,
            captures: entry.captures,
            source,
            listing: listing.description,
            title: listing.title,
            company: listing.company,
            yearsExperience: profile.yearsExperience,
            technologyNames: resumeTechnologyNames(),
            credentialNames: listing.credentials,
          })
        : {
            traceAvailable: Boolean(entry.captures?.length),
            sanctioned: [],
            unflaggedListingLines: [],
          },
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
  levels: readonly ResumeLevel[] = RESUME_LEVELS,
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
    for (const level of levels) {
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
        captures,
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
    "| Level | Resumes | Invented facts | Stretches | As named | Flags left | Median edit size | Truthful tool coverage | Median s | Median calls | Median tokens in/out |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const level of RESUME_LEVELS) {
    const rows = results.filter((result) => result.level === level);
    const mid = (pick: (row: ResumeLaneResult) => number) =>
      median(rows.map(pick));
    lines.push(
      `| ${level} | ${rows.length} | ${rows.reduce((sum, row) => sum + row.inventedFacts.length, 0)} | ${rows.reduce((sum, row) => sum + row.stretches.length, 0)} | ${rows.filter((row) => !row.levelProblem).length}/${rows.length} | ${rows.reduce((sum, row) => sum + row.flagsLeft.length, 0)} | ${pct(mid((row) => row.shape.editSize))} | ${pct(mid((row) => row.shape.truthfulKeywordCoverage))} | ${mid((row) => row.seconds).toFixed(1)} | ${mid((row) => row.modelCalls)} | ${Math.round(mid((row) => row.promptTokens))}/${Math.round(mid((row) => row.completionTokens))} |`,
    );
  }
  const written = results.filter((row) => row.level !== "original");
  lines.push(
    "",
    `Median write time over the ${written.length} written resumes: ${median(written.map((row) => row.seconds)).toFixed(1)} s.`,
    "",
    "Offline probes do not prove semantic correctness. Read the saved drafts for unsupported duties and hiring-domain transfer; the writer also checks generated lines with the model.",
    "",
    "## Stretch handling by case",
    "",
    "| Case | Trace available | Sanctioned lines checked | Flagged | Removed/rewritten by checker | Missing before checker | No verdict | Unflagged listing-only lines |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results
      .filter((row) => row.level === "aggressive")
      .map(
        (row) =>
          `| ${row.caseId} | ${row.stretchChecks.traceAvailable ? "yes" : "no"} | ${row.stretchChecks.sanctioned.filter((line) => line.checked).length} | ${row.stretchChecks.sanctioned.filter((line) => line.flagged).length} | ${row.stretchChecks.sanctioned.filter((line) => line.checked && line.removed).length} | ${row.stretchChecks.sanctioned.filter((line) => line.missingBeforeCheck).length} | ${row.stretchChecks.sanctioned.filter((line) => line.unanswered).length} | ${row.stretchChecks.unflaggedListingLines.length} |`,
      ),
    "",
    "Confirmation chores and approval blockers require the built-app check; these counts do not assert approval behavior.",
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
      ...result.stretches.map(
        (stretch) =>
          `stretch ${stretch.kind} "${stretch.value}" (${stretch.flagged ? "flagged" : "old recording: no per-line flag"}) in: ${stretch.line}`,
      ),
      ...result.stretchChecks.sanctioned.map(
        (line) =>
          `checker ${!line.checked ? "did not see" : line.flagged ? "flagged" : "passed"}, ${line.removed ? "removed/rewritten" : "kept"} sanctioned stretch: ${line.text} (${line.verdicts.map((check) => `${check.verdict}: ${check.reason}`).join("; ")})`,
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
