import {
  RESUME_CLAIM_CHECK_BATCH_SIZE,
  getAiProviderAccessFailure,
  type JobFinderAiClient,
  type ResumeClaimCheckInput,
} from "@nestor/ai-providers";
import type {
  CandidateProfile,
  ResumeClaimCheck,
  ResumeDraft,
  SavedJob,
} from "@nestor/contracts";
import { fnv1a32 } from "@nestor/core";

import { applyPatchToResumeDraft } from "./resume-workspace-patches";
import {
  areNearDuplicateResumeLines,
  buildResumeClaimDescriptors,
  buildResumeClaimEvidenceBank,
  buildPersonsOwnResumeClaimMatcher,
  evaluateResumeProposalGrounding,
  resumeClaimContentHash,
  sanitizeResumeDraft,
} from "./resume-workspace-helpers";

/**
 * The model checks a draft's generated lines against the person's evidence
 * before the draft is validated and kept (ADR 0041).
 *
 * Verdicts are kept on the draft by each line's content hash, and remembered
 * here for the session, so a line is checked once however many times the
 * draft is previewed, proposed, accepted or exported. A line the model could
 * not check stays unchecked; it does not hold the resume back.
 */

const SESSION_CACHE_LIMIT = 4_000;
type ResumeLine = Parameters<
  ReturnType<typeof buildPersonsOwnResumeClaimMatcher>
>[0];
const sessionChecks = new Map<string, ResumeClaimCheck>();

class ResumeClaimBudgetExceededError extends Error {
  constructor() {
    super(
      "Resume claim checking timed out: exceeded the remaining writing budget.",
    );
    this.name = "TimeoutError";
  }
}

type ClaimCheckTransaction = {
  signal?: AbortSignal;
  getRemainingBudgetMs?: () => number;
};

/** Each batch/retry consumes the same writer clock, including nested checks. */
async function checkWithinWritingBudget(
  transaction: ClaimCheckTransaction,
  request: ResumeClaimCheckInput,
  check: NonNullable<JobFinderAiClient["checkResumeClaims"]>,
) {
  transaction.signal?.throwIfAborted();
  const remaining = transaction.getRemainingBudgetMs?.();
  if (
    remaining !== undefined &&
    (!Number.isFinite(remaining) || remaining <= 0)
  )
    throw new ResumeClaimBudgetExceededError();
  const timeoutMs =
    remaining === undefined ? undefined : Math.max(1, Math.floor(remaining));
  const deadline = timeoutMs === undefined ? undefined : new AbortController();
  const signal = deadline
    ? transaction.signal
      ? AbortSignal.any([transaction.signal, deadline.signal])
      : deadline.signal
    : transaction.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          const reason: unknown = signal.reason;
          reject(
            reason instanceof Error
              ? reason
              : new DOMException(
                  "Resume claim checking was cancelled.",
                  "AbortError",
                ),
          );
        };
        signal.addEventListener("abort", onAbort, { once: true });
      })
    : undefined;
  // A synchronous provider can abort and throw before the race is attached.
  void aborted?.catch(() => {});
  try {
    signal?.throwIfAborted();
    if (deadline && timeoutMs !== undefined)
      timer = setTimeout(
        () => deadline.abort(new ResumeClaimBudgetExceededError()),
        timeoutMs,
      );
    const checking = check({
      ...request,
      ...(signal ? { signal } : {}),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    const results = await (aborted
      ? Promise.race([checking, aborted])
      : checking);
    signal?.throwIfAborted();
    return results;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function remember(key: string, check: ResumeClaimCheck): void {
  sessionChecks.delete(key);
  sessionChecks.set(key, check);
  if (sessionChecks.size > SESSION_CACHE_LIMIT) {
    const oldest = sessionChecks.keys().next().value;
    if (oldest !== undefined) sessionChecks.delete(oldest);
  }
}

export async function withResumeClaimChecks(input: {
  aiClient: Pick<JobFinderAiClient, "checkResumeClaims">;
  draft: ResumeDraft;
  job: SavedJob;
  profile: CandidateProfile | undefined;
  tailoringStrength?: string | null;
  now?: () => string;
  signal?: AbortSignal;
  getRemainingBudgetMs?: () => number;
  /**
   * False reuses the verdicts already known and asks the model nothing; the
   * rest stay unchecked until the draft is saved (the live preview).
   */
  askModel?: boolean;
}): Promise<ResumeDraft> {
  input.signal?.throwIfAborted();
  const { draft, profile } = input;
  const isPersonsOwn = buildPersonsOwnResumeClaimMatcher({ draft, profile });
  const allLines = buildResumeClaimDescriptors(draft);
  const resumeLines = draft.sections
    .filter((section) => section.included)
    .flatMap((section) =>
      [
        section.text,
        ...section.bullets
          .filter((bullet) => bullet.included)
          .map((bullet) => bullet.text),
        ...section.entries
          .filter((entry) => entry.included)
          .flatMap((entry) => [
            [entry.title, entry.subtitle, entry.location, entry.dateRange]
              .filter(Boolean)
              .join(" — "),
            entry.summary,
            ...entry.bullets
              .filter((bullet) => bullet.included)
              .map((bullet) => bullet.text),
          ]),
      ]
        .filter((text): text is string => !!text?.trim())
        .map((text) => ({ section: section.label, text })),
    );
  const claims = allLines.filter((claim) => !isPersonsOwn(claim));
  if (claims.length === 0 && (draft.claimChecks ?? []).length === 0) {
    return draft;
  }
  const evidence = buildResumeClaimEvidenceBank(profile).map((entry) => ({
    id: entry.ref.id,
    text: entry.text,
  }));
  const tailoringStrength = input.tailoringStrength ?? "balanced";
  const jobContext = [
    input.job.title,
    input.job.company,
    input.job.description,
    [
      ...input.job.responsibilities,
      ...input.job.minimumQualifications,
      ...input.job.preferredQualifications,
    ],
  ];
  const evidenceTexts = evidence.map((entry) => entry.text);
  const importedResume = profile?.baseResume.textContent ?? "";
  // What a line's verdict depends on: the line itself (its content hash),
  // the evidence, the job and how far the person let the resume stretch.
  // Editing one line has only that line checked again.
  const evidenceKey = fnv1a32(
    JSON.stringify([
      "resume-fact-check-2026-10-21-per-line-v4",
      jobContext,
      evidenceTexts,
      importedResume,
      tailoringStrength,
    ]),
  );
  // Verdicts stored before v4 were also keyed on every visible line. One
  // stored for this very draft is current and is re-keyed, not re-checked.
  const legacyEvidenceKey = fnv1a32(
    JSON.stringify([
      "resume-fact-check-2026-10-14-context-v3",
      jobContext,
      resumeLines.map((line) => [
        line.section,
        resumeClaimContentHash(line.text),
      ]),
      evidenceTexts,
      importedResume,
      tailoringStrength,
    ]),
  );
  const stored = new Map(
    (draft.claimChecks ?? [])
      .filter(
        (check) =>
          check.evidenceKey === evidenceKey ||
          check.evidenceKey === legacyEvidenceKey,
      )
      .map(
        (check) =>
          [
            check.contentHash,
            check.evidenceKey === evidenceKey
              ? check
              : { ...check, evidenceKey },
          ] as const,
      ),
  );
  const kept = new Map<string, ResumeClaimCheck>();
  const pending = new Map<string, (typeof claims)[number]>();
  for (const claim of claims) {
    const contentHash = resumeClaimContentHash(claim.text);
    const known =
      stored.get(contentHash) ??
      sessionChecks.get(`${evidenceKey}|${contentHash}`);
    if (known) kept.set(contentHash, known);
    else if (!kept.has(contentHash)) pending.set(contentHash, claim);
  }

  const checkResumeClaims =
    input.askModel === false
      ? undefined
      : input.aiClient.checkResumeClaims?.bind(input.aiClient);
  if (checkResumeClaims && pending.size > 0) {
    const now = input.now ?? (() => new Date().toISOString());
    const entries = [...pending.entries()];
    for (
      let start = 0;
      start < entries.length;
      start += RESUME_CLAIM_CHECK_BATCH_SIZE
    ) {
      const batch = entries.slice(start, start + RESUME_CLAIM_CHECK_BATCH_SIZE);
      // Short ids the model can echo exactly; each maps back to its line.
      const hashById = new Map(
        batch.map(([contentHash], index) => [`line_${index + 1}`, contentHash]),
      );
      const request: ResumeClaimCheckInput = {
        tailoringStrength,
        job: {
          title: input.job.title,
          company: input.job.company,
          description: input.job.description,
          requirements: [
            ...input.job.responsibilities,
            ...input.job.minimumQualifications,
            ...input.job.preferredQualifications,
          ],
        },
        evidence,
        resumeLines,
        // The imported resume is already in the evidence, line by line with
        // ids the verdict can cite; sending it whole as well doubled it.
        resumeText: null,
        claims: batch.map(([, claim], index) => ({
          id: `line_${index + 1}`,
          section:
            draft.sections.find((section) => section.id === claim.sectionId)
              ?.label ?? claim.field,
          text: claim.text,
        })),
      };
      // The provider transport already retries transient requests within its budget.
      // Repeating that whole operation here doubles failed paid attempts without
      // giving the model new feedback. Unchecked lines still go to the person.
      const results = await checkWithinWritingBudget(
        input,
        request,
        checkResumeClaims,
      ).catch((error: unknown) => {
        if (
          input.signal?.aborted ||
          error instanceof ResumeClaimBudgetExceededError ||
          getAiProviderAccessFailure(error) !== null
        )
          throw error;
        return [];
      });
      const checkedAt = now();
      for (const result of results) {
        const contentHash = hashById.get(result.id);
        if (!contentHash) continue;
        const check: ResumeClaimCheck = {
          contentHash,
          verdict: result.verdict,
          reason: result.reason,
          evidenceIds: result.evidenceIds,
          fix: result.fix ?? null,
          style: result.style ?? null,
          evidenceKey,
          checkedAt,
        };
        kept.set(contentHash, check);
        remember(`${evidenceKey}|${contentHash}`, check);
      }
    }
  }

  return { ...draft, claimChecks: [...kept.values()] };
}

/**
 * Settles the failed generated lines of a draft from the verdicts already on
 * it, without calling the model: a line with a fix takes it, a line without
 * one goes back to the person's saved wording or is left off (ADR 0051).
 * Stretches count only outside aggressive tailoring, where choosing the level
 * accepted them. Returns null when nothing needed settling.
 */
export function settleResumeClaimLines(input: {
  draft: ResumeDraft;
  profile: CandidateProfile | undefined;
  stretchesAreThePersons: boolean;
}): ResumeDraft | null {
  const { draft } = input;
  const checks = new Map(
    (draft.claimChecks ?? []).map((check) => [check.contentHash, check]),
  );
  const isPersonsOwn = buildPersonsOwnResumeClaimMatcher({
    draft,
    profile: input.profile,
  });
  let changed = false;
  // Every line on the resume now; a fix that repeats one hides its line.
  const shown = buildResumeClaimDescriptors(draft).map((claim) => claim.text);
  const repeatsAShownLine = (fix: string, original: string) =>
    shown.some(
      (line) =>
        line !== original &&
        (resumeClaimContentHash(line) === resumeClaimContentHash(fix) ||
          areNearDuplicateResumeLines(line, fix)),
    );
  // An achievement's saved wording, by its "experience:<id>:achievement:<n>"
  // evidence ID, for a failed line the checker offered no fix for.
  const savedAchievement = (sourceId: string | null): string | null => {
    const match = sourceId?.match(/^experience:(.+):achievement:(\d+)$/u);
    if (!match) return null;
    const experience = input.profile?.experiences.find(
      (record) => record.id === match[1],
    );
    return experience?.achievements[Number(match[2])]?.trim() || null;
  };
  /**
   * The text a line should become: null keeps it, "" leaves it off. A failed
   * line with no fix is settled here rather than left for the person.
   */
  const fixFor = (
    claim: ResumeLine,
    savedWording: string | null = null,
  ): string | null => {
    if (isPersonsOwn(claim)) return null;
    const check = checks.get(resumeClaimContentHash(claim.text));
    if (!check) return null;
    const failed =
      check.verdict === "unsupported" ||
      (check.verdict === "stretch" && !input.stretchesAreThePersons);
    if (check.fix === null) {
      if (!failed) return null;
      changed = true;
      return savedWording && savedWording !== claim.text.trim()
        ? savedWording
        : "";
    }
    // A line that is not finished resume writing gets the same fix.
    const unfinished = Boolean(check.style);
    if ((!failed && !unfinished) || check.fix === claim.text.trim()) {
      return null;
    }
    changed = true;
    return check.fix;
  };
  const fixBullets = <
    T extends {
      text: string;
      origin: ResumeLine["origin"];
      included: boolean;
      sourceRefs?: readonly { sourceKind: string; sourceId: string | null }[];
    },
  >(
    bullets: readonly T[],
    field: "section_bullet" | "entry_bullet",
    sectionId: string,
  ): T[] =>
    bullets.map((bullet) => {
      if (!bullet.included) return bullet;
      const fix = fixFor(
        {
          text: bullet.text,
          origin: bullet.origin,
          field,
          sectionId,
        },
        savedAchievement(
          bullet.sourceRefs?.find((ref) => ref.sourceKind === "profile")
            ?.sourceId ?? null,
        ),
      );
      if (fix === null) return bullet;
      // A fix that repeats a line already on the resume hides this one instead.
      if (!fix || repeatsAShownLine(fix, bullet.text)) {
        return { ...bullet, included: false };
      }
      shown.push(fix);
      return { ...bullet, text: fix };
    });
  // An empty model fix removes a generated summary with nothing safe to keep.
  const fixText = (
    text: string | null,
    origin: ResumeLine["origin"],
    field: "section_text" | "entry_summary",
    sectionId: string,
  ): string | null => {
    if (!text?.trim()) return text;
    const fix = fixFor(
      { text, origin, field, sectionId },
      field === "section_text"
        ? (input.profile?.summary?.trim() ?? null)
        : null,
    );
    if (fix === null) return text;
    if (!fix || repeatsAShownLine(fix, text)) return null;
    shown.push(fix);
    return fix;
  };

  const fixed: ResumeDraft = {
    ...draft,
    sections: draft.sections.map((section) =>
      !section.included
        ? section
        : {
            ...section,
            text: fixText(
              section.text,
              section.origin,
              "section_text",
              section.id,
            ),
            bullets: fixBullets(section.bullets, "section_bullet", section.id),
            entries: section.entries.map((entry) =>
              !entry.included
                ? entry
                : {
                    ...entry,
                    summary: fixText(
                      entry.summary,
                      entry.origin,
                      "entry_summary",
                      section.id,
                    ),
                    bullets: fixBullets(
                      entry.bullets,
                      "entry_bullet",
                      section.id,
                    ),
                  },
            ),
          },
    ),
  };
  return changed ? fixed : null;
}

/**
 * Applies the checker's fixes to a freshly generated draft and checks the
 * rewrites once more (ADR 0041, ADR 0051).
 */
export async function withResumeClaimFixes(
  input: Parameters<typeof withResumeClaimChecks>[0] & {
    stretchesAreThePersons: boolean;
  },
): Promise<ResumeDraft> {
  input.signal?.throwIfAborted();
  const settled = settleResumeClaimLines(input);
  if (!settled) return input.draft;
  return withResumeClaimChecks({ ...input, draft: settled });
}

/**
 * The proposal gate over the draft that accepting these changes would
 * produce, with the model's verdicts on its new lines (ADR 0041).
 */
export async function evaluateCheckedResumeProposalGrounding(
  check: {
    aiClient: Pick<JobFinderAiClient, "checkResumeClaims">;
    tailoringStrength?: string | null;
    signal?: AbortSignal;
  },
  input: Parameters<typeof evaluateResumeProposalGrounding>[0],
): Promise<ReturnType<typeof evaluateResumeProposalGrounding>> {
  if (input.patches.length === 0) {
    return evaluateResumeProposalGrounding(input);
  }
  let candidate = input.baselineDraft;
  for (const patch of input.patches) {
    candidate = applyPatchToResumeDraft({
      draft: candidate,
      patch,
      updatedAt: input.evaluatedAt,
    });
  }
  const checked = await withResumeClaimChecks({
    aiClient: check.aiClient,
    draft: sanitizeResumeDraft({
      draft: candidate,
      job: input.job,
      ...(input.profile ? { profile: input.profile } : {}),
    }),
    job: input.job,
    profile: input.profile,
    tailoringStrength: check.tailoringStrength ?? null,
    ...(check.signal ? { signal: check.signal } : {}),
  });
  return evaluateResumeProposalGrounding({
    ...input,
    candidateClaimChecks: checked.claimChecks ?? [],
  });
}
