import type {
  DiscoveryRunRecord,
  DiscoverySourceHealthState,
} from "@nestor/contracts";
import { buildDiscoveryCardOnlyEvidenceWarning } from "@nestor/contracts";

/**
 * Home's source-health line, collapsed.
 *
 * A run records at most one warning per source (`summary.warnings` is exactly
 * `summary.sourceHealth.flatMap(source => source.warnings)`), so a large
 * source plan having a bad afternoon printed one raw internal sentence per
 * source under the badge — "Public provider API collection failed: …",
 * "Agent discovery stopped after 10 steps…", "Unable to open a usable
 * starting URL…" — verbatim. That is a debug log, not a status line.
 *
 * Home now prints one plain-language count line instead. The categories come
 * from the classified per-source `health` state the run already recorded,
 * never from reading the error prose: each source carries exactly one health
 * state, so the categories are disjoint by construction and sum to the total.
 * The detail stays one click away behind "Review source health".
 */

// No surrounding whitespace: the builder trims its label, so a padded
// sentinel would not survive into the template and the split would fail.
const CARD_ONLY_WARNING_LABEL_SENTINEL = "HOME_SOURCE_LABEL_SENTINEL";
const [CARD_ONLY_WARNING_PREFIX = "", CARD_ONLY_WARNING_SUFFIX = ""] =
  buildDiscoveryCardOnlyEvidenceWarning(CARD_ONLY_WARNING_LABEL_SENTINEL).split(
    CARD_ONLY_WARNING_LABEL_SENTINEL,
  );

/**
 * Pulls the canonical card-only evidence sentence out of one recorded
 * warning, or returns null when it is not in there.
 *
 * This must be contains-based, not whole-string: production joins the
 * sentence onto whatever partial warning already existed
 * (`agent/discovery.ts` does `[resolvedPartial.warning, cardOnlyWarning].join(" ")`,
 * and a later stage can append another sentence after it), so a
 * whole-string test would fail to see the caveat exactly when a source had
 * other trouble too — and the "match details are unchecked" warning would
 * silently vanish for the sources it matters most for.
 *
 * It stays template-derived rather than prose-matching: the two halves come
 * from the contract builder's own output, so a copy change moves with it.
 * Returning the extracted sentence (never the whole joined string) is what
 * keeps the surrounding raw error prose off Home.
 */
export function extractCardOnlyEvidenceWarning(warning: string): string | null {
  if (CARD_ONLY_WARNING_PREFIX.length === 0) {
    return null;
  }

  const prefixStart = warning.indexOf(CARD_ONLY_WARNING_PREFIX);
  if (prefixStart < 0) {
    return null;
  }

  const suffixStart = warning.indexOf(
    CARD_ONLY_WARNING_SUFFIX,
    prefixStart + CARD_ONLY_WARNING_PREFIX.length,
  );
  if (suffixStart < 0) {
    return null;
  }

  return warning.slice(
    prefixStart,
    suffixStart + CARD_ONLY_WARNING_SUFFIX.length,
  );
}

/**
 * True when the warning carries the card-only evidence sentence anywhere in
 * it. That sentence is product-authored plain language about what was read,
 * so it keeps its own line instead of disappearing into a count.
 */
export function isCardOnlyEvidenceWarning(warning: string): boolean {
  return extractCardOnlyEvidenceWarning(warning) !== null;
}

/**
 * True only when the warning is nothing *but* the card-only caveat. A source
 * whose warning also carries real trouble still counts as a problem, so the
 * summary must not excuse it just because the caveat rode along.
 */
function isOnlyCardOnlyEvidenceWarning(warning: string): boolean {
  const trimmed = warning.trim();
  return extractCardOnlyEvidenceWarning(trimmed) === trimmed;
}

/**
 * The card-only caveats to print, one line each: extracted from the newest
 * run's warnings (joined or not) and deduplicated, since two sources of the
 * same site label produce the identical sentence.
 */
export function selectCardOnlyEvidenceNotices(
  warnings: readonly string[],
): string[] {
  const notices: string[] = [];
  const seen = new Set<string>();

  for (const warning of warnings) {
    const notice = extractCardOnlyEvidenceWarning(warning);
    if (notice === null || seen.has(notice)) {
      continue;
    }
    seen.add(notice);
    notices.push(notice);
  }

  return notices;
}

/**
 * Categories are exactly what the recorded per-source health state can back.
 * There is no classified timeout/navigation distinction anywhere in the run
 * record — that difference exists only inside the error prose — so this
 * deliberately does not invent one.
 */
export type HomeSourceProblemCategory =
  | "unreadable"
  | "no_results"
  | "partial"
  | "skipped";

const CATEGORY_LABELS: Record<HomeSourceProblemCategory, string> = {
  no_results: "found nothing",
  partial: "finished with a problem",
  skipped: "skipped",
  unreadable: "couldn't be read",
};

/** Most severe first, so the worst news is not buried mid-line. */
const CATEGORY_ORDER: readonly HomeSourceProblemCategory[] = [
  "unreadable",
  "no_results",
  "partial",
  "skipped",
];

export type HomeSourceProblemGroup = {
  category: HomeSourceProblemCategory;
  count: number;
  label: string;
};

export type HomeSourceProblemSummary = {
  /** Sources with a recorded problem. Always equals the group-count sum. */
  total: number;
  /** Only non-zero categories; a zero category is omitted, never printed. */
  groups: readonly HomeSourceProblemGroup[];
  /**
   * Sources that stopped because the person stopped the search. R11: a
   * tester read "1 source had a problem in the last search · 1 stopped
   * early" under a HEALTHY badge and said "I pressed pause myself, so
   * nothing had a 'problem'". A stop you asked for is its own outcome and is
   * never counted as a problem.
   */
  userStopped: number;
};

type SourceHealthEntry = {
  targetId: string;
  health: DiscoverySourceHealthState;
  warnings?: readonly string[];
};

export type DiscoveryRunSourceProblemInput = {
  state: DiscoveryRunRecord["state"];
  startedAt: string;
  summary?: { sourceHealth?: readonly SourceHealthEntry[] } | undefined;
  targetExecutions?: readonly { targetId: string; jobsFound?: number }[];
};

/**
 * Newest attempt by `startedAt` — never array order — ignoring `idle`
 * placeholder rows, which are not attempts. Ties keep the first-listed run,
 * matching the run-notice selector so the summary and the card-only line can
 * never describe two different searches.
 */
export function selectNewestSettledDiscoveryRun<
  TRun extends { startedAt: string; state: DiscoveryRunRecord["state"] },
>(runs: readonly TRun[]): TRun | null {
  let newest: TRun | null = null;
  for (const run of runs) {
    if (run.state === "idle") {
      continue;
    }
    if (!newest || Date.parse(run.startedAt) > Date.parse(newest.startedAt)) {
      newest = run;
    }
  }
  return newest;
}

/**
 * Reached only if a health state is added to the contract enum without being
 * handled above: the `never` binding makes that a compile error rather than a
 * silent drop. If an unexpected value somehow arrives at runtime, it is still
 * a source the run flagged, so it is counted under the neutral category
 * instead of disappearing from Home.
 */
function categorizeUnhandledSourceHealth(
  health: never,
): HomeSourceProblemCategory {
  void health;
  return "partial";
}

function categorizeSource(
  entry: SourceHealthEntry,
  jobsFound: number | undefined,
): HomeSourceProblemCategory | null {
  switch (entry.health) {
    case "failed":
      return "unreadable";
    case "cancelled":
      // Counted as a user-owned stop, not a problem. See `userStopped`.
      return null;
    case "skipped":
      return "skipped";
    case "warning":
      // Only an explicit zero can claim "found nothing"; a missing count keeps
      // the conservative wording.
      return jobsFound === 0 ? "no_results" : "partial";
    case "healthy":
    case "pending":
      // Not problems.
      return null;
    default:
      return categorizeUnhandledSourceHealth(entry.health);
  }
}

/**
 * Fold one run's per-source health into disjoint plain-language counts.
 *
 * A source whose only warning is the card-only evidence warning is excluded:
 * it completed and returned jobs, its caveat already has its own line, and
 * counting it here would report the same source twice.
 */
export function summarizeDiscoveryRunSourceProblems(
  run: DiscoveryRunSourceProblemInput | null,
): HomeSourceProblemSummary | null {
  if (!run) {
    return null;
  }

  const jobsFoundByTarget = new Map<string, number | undefined>();
  for (const execution of run.targetExecutions ?? []) {
    jobsFoundByTarget.set(execution.targetId, execution.jobsFound);
  }

  const counts = new Map<HomeSourceProblemCategory, number>();
  let total = 0;
  let userStopped = 0;

  for (const entry of run.summary?.sourceHealth ?? []) {
    const warnings = entry.warnings ?? [];
    if (warnings.length > 0 && warnings.every(isOnlyCardOnlyEvidenceWarning)) {
      continue;
    }
    if (entry.health === "cancelled") {
      userStopped += 1;
      continue;
    }
    const category = categorizeSource(
      entry,
      jobsFoundByTarget.get(entry.targetId),
    );
    if (!category) {
      continue;
    }
    total += 1;
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  if (total === 0 && userStopped === 0) {
    return null;
  }

  return {
    groups: CATEGORY_ORDER.flatMap((category) => {
      const count = counts.get(category) ?? 0;
      return count > 0
        ? [{ category, count, label: CATEGORY_LABELS[category] }]
        : [];
    }),
    total,
    userStopped,
  };
}

/** One line, or nothing at all when the last search had no source problem. */
export function formatDiscoveryRunSourceProblemSummary(
  run: DiscoveryRunSourceProblemInput | null,
): string | null {
  const summary = summarizeDiscoveryRunSourceProblems(run);
  if (!summary) {
    return null;
  }

  const sentences: string[] = [];

  if (summary.userStopped > 0) {
    // The person's own stop, named as theirs.
    sentences.push(
      summary.userStopped === 1
        ? "You stopped the last search, so 1 source did not finish."
        : `You stopped the last search, so ${summary.userStopped} sources did not finish.`,
    );
  }

  if (summary.total > 0) {
    const noResults =
      summary.groups.find((group) => group.category === "no_results")?.count ??
      0;
    const problems = summary.total - noResults;
    const lead =
      problems === 1
        ? "1 source had a problem in the last search"
        : `${problems} sources had a problem in the last search`;
    if (problems > 0)
      sentences.push(
        [
          lead,
          ...summary.groups
            .filter((group) => group.category !== "no_results")
            .map((group) => `${group.count} ${group.label}`),
        ].join(" · ") + (noResults > 0 ? "." : ""),
      );
    if (noResults > 0)
      sentences.push(
        `${noResults} ${noResults === 1 ? "source" : "sources"} found nothing in the last search.`,
      );
  }

  return sentences.length > 0 ? sentences.join(" ") : null;
}
