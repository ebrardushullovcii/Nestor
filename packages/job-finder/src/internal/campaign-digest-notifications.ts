import {
  CampaignDigestSchema,
  CampaignNotificationSchema,
  DiscoveryRunRecordSchema,
  IsoDateTimeSchema,
  type SavedJob,
  type CampaignDigest,
  type CampaignDigestFailedSource,
  type CampaignNotification,
  type CampaignRunFacts,
  type DiscoveryRunRecord,
  type DiscoveryRunReport,
} from "@nestor/contracts";
import { isProvisionalMatchAssessment } from "../discovery-ordering";
import { deriveDiscoverySourceOutcome } from "../source-health";

/**
 * Pure, deterministic campaign digest + notification helpers.
 *
 * - `buildCampaignDigest` derives a truthful digest from a finished
 *   `DiscoveryRunRecord`: counts are copied verbatim from the run's aggregate
 *   change digest and failed sources come from the run's source health
 *   summary. No count is ever fabricated.
 * - `listFailedSources` returns the sources whose health summary recorded a
 *   failure, with a truthful failure time taken from the target execution or
 *   the run completion time.
 * - `deriveCampaignNotifications` emits local in-app notifications only for
 *   strong new matches and blocked/failed campaign work (including a failed
 *   scheduled run from the campaign run facts).
 * - `mergeCampaignNotifications` merges and dedupes by notification id, then
 *   caps the result at 5,000 (keeping the newest when over the cap).
 * - `markCampaignNotificationRead` flips exactly one notification to read.
 */

/**
 * A new match is "strong" at or above this fit score. This mirrors the
 * existing `strong_fit` recommendation threshold used by the fit scorer.
 */
export const STRONG_MATCH_MIN_SCORE = 86;

/** Storage cap for the local in-app notification collection. */
export const MAX_CAMPAIGN_NOTIFICATIONS = 5_000;

/** Schema cap for the digest `failedSources` array. */
const MAX_DIGEST_FAILED_SOURCES = 100;

/** Schema cap for the digest `jobIds` array. */
const MAX_DIGEST_JOB_IDS = 10_000;

/** Truthful fallback when a failed source carries no warning text. */
const DEFAULT_FAILED_SOURCE_REASON =
  "The discovery source failed before this run completed.";

/** Shown when a job source no longer carries the label the user saved. */
export const UNNAMED_JOB_SOURCE_TITLE = "A job source";

/**
 * Names a job source the way the user saved it. Internal target ids are never
 * user-facing, so an id with no saved label falls back to a plain phrase
 * instead of leaking the identifier into a notification or a digest row.
 */
export function describeJobSourceWorkTitle(
  sourceTargetId: string,
  targets: readonly { id: string; label: string }[],
): string {
  const id = sourceTargetId.trim();
  const label = targets.find((target) => target.id === id)?.label.trim() ?? "";
  return label.length > 0 ? `Job source ${label}` : UNNAMED_JOB_SOURCE_TITLE;
}

/** The plain sentence for a source stopped at a step only the person can take. */
function describeAccessBlockedSource(reason: string | null): string | null {
  if (!reason) return null;
  return reason === "auth_required"
    ? "This site asks you to sign in before Job Finder can read its jobs. Sign in from Needs you; the search carries on by itself."
    : "This site showed a check only you can finish before Job Finder could read its jobs. Finish it from Needs you; the search carries on by itself.";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function listFailedSourcesFromRecord(
  record: DiscoveryRunRecord,
): CampaignDigestFailedSource[] {
  // Without a completion time there is no truthful failure timestamp evidence.
  if (record.completedAt === null) return [];

  const completedAtByTarget = new Map<string, string | null>(
    record.targetExecutions.map((execution) => [
      execution.targetId,
      execution.completedAt,
    ]),
  );
  const accessBlockerByTarget = new Map(
    record.targetExecutions.map((execution) => [
      execution.targetId,
      execution.accessBlockerReason ?? null,
    ]),
  );

  const sources: CampaignDigestFailedSource[] = [];
  for (const source of record.summary.sourceHealth) {
    if (source.health !== "failed") continue;
    const failedAt =
      completedAtByTarget.get(source.targetId) ?? record.completedAt;
    if (failedAt === null) continue;
    sources.push({
      sourceTargetId: source.targetId,
      // A wall only the person can clear is said the way its Needs you card
      // says it; the agent's own notes about the page are not for the person.
      reason: truncate(
        describeAccessBlockedSource(
          accessBlockerByTarget.get(source.targetId) ?? null,
        ) ??
          source.warnings[0] ??
          DEFAULT_FAILED_SOURCE_REASON,
        1_000,
      ),
      failedAt,
      // No retryability evidence exists on the run record, so stay truthful.
      retryable: false,
    });
  }
  return sources.slice(0, MAX_DIGEST_FAILED_SOURCES);
}

/**
 * Lists the sources that failed during a discovery run, derived only from the
 * run's source health summary. Returns an empty list when the run record is
 * invalid or carries no failure timestamp evidence.
 */
export function listFailedSources(run: unknown): CampaignDigestFailedSource[] {
  const parsed = DiscoveryRunRecordSchema.safeParse(run);
  if (!parsed.success) return [];
  return listFailedSourcesFromRecord(parsed.data);
}

export interface BuildCampaignDigestInput {
  campaignId: string;
  /** The finished discovery run. Parsed defensively; invalid evidence yields `null`. */
  run: unknown;
  /**
   * When the digest was generated. Defaults to the run completion time. An
   * explicitly provided value must be a valid ISO timestamp.
   */
  generatedAt?: string | null;
  /**
   * Job ids this run produced or retained. Deduplicated and capped at the
   * schema maximum; only evidence supplied here is included.
   */
  jobIds?: readonly string[] | null;
  /**
   * The run's frozen accounting, carried onto the digest so a plan card can
   * print the run's own numbers without holding the run record.
   */
  report?: DiscoveryRunReport | null;
}

/**
 * Builds a truthful campaign digest for a finished discovery run.
 *
 * Returns `null` (instead of guessing) when the evidence is invalid or
 * missing: the run is still in progress, has no completion time, fails schema
 * validation, the campaign id is empty, or an explicit `generatedAt` is not a
 * valid ISO timestamp.
 */
export function buildCampaignDigest(
  input: BuildCampaignDigestInput,
): CampaignDigest | null {
  const campaignId = input.campaignId.trim();
  if (campaignId.length === 0) return null;

  const parsed = DiscoveryRunRecordSchema.safeParse(input.run);
  if (!parsed.success) return null;
  const run = parsed.data;

  if (run.state === "idle" || run.state === "running") return null;
  if (run.completedAt === null) return null;

  let generatedAt = run.completedAt;
  if (input.generatedAt !== undefined && input.generatedAt !== null) {
    const trimmed = input.generatedAt.trim();
    if (trimmed.length === 0) return null;
    const parsedGeneratedAt = IsoDateTimeSchema.safeParse(trimmed);
    if (!parsedGeneratedAt.success) return null;
    generatedAt = parsedGeneratedAt.data;
  }

  return CampaignDigestSchema.parse({
    id: `digest_${run.id}`,
    campaignId,
    discoveryRunId: run.id,
    outcome:
      run.runPhase === "interrupted"
        ? "interrupted"
        : run.state === "cancelled"
          ? "stopped"
          : run.state,
    generatedAt,
    counts: {
      new: run.summary.changeDigest.new,
      changed: run.summary.changeDigest.changed,
      reactivated: run.summary.changeDigest.reactivated,
      inactive: run.summary.changeDigest.inactive,
      known: run.summary.changeDigest.known,
      skipped: run.summary.changeDigest.skipped,
    },
    report: input.report ?? run.summary.report ?? null,
    failedSources: listFailedSourcesFromRecord(run),
    sourceOutcome: deriveDiscoverySourceOutcome(run),
    jobIds: dedupeStrings(input.jobIds ?? []).slice(0, MAX_DIGEST_JOB_IDS),
  });
}

/** Evidence for a strong new match discovered during a campaign run. */
export interface StrongMatchEvidence {
  jobId: string;
  title: string;
  company?: string | null;
  /** Fit score on the 0-100 match scale; only scores at/above the strong threshold notify. */
  fitScore: number;
  /**
   * The saved-job assessment projection that proves whether `fitScore` is
   * bound to the current candidate context and posting. Missing evidence is
   * intentionally treated as provisional so notification copy never promotes
   * an unbound score to candidate-facing authority.
   */
  assessment?: Pick<SavedJob, "discoveryMethod" | "matchAssessment">;
}

/** Evidence for one blocked or failed piece of campaign work (e.g. an apply job). */
export interface CampaignWorkFailureEvidence {
  /** Stable id of the work unit (e.g. apply run id) used for deterministic notification ids. */
  workId?: string | null;
  /** Affected job id when known. */
  jobId?: string | null;
  /** Affected discovery/source target when known. */
  sourceTargetId?: string | null;
  /** Human-readable label; a generic label is used when omitted. */
  title?: string | null;
  /** Why the work was blocked or failed. */
  reason?: string | null;
}

export interface DeriveCampaignNotificationsInput {
  campaignId: string;
  /** Notification creation time; must be a valid ISO timestamp. */
  now: string;
  /** Strong new matches discovered in the run; only evidence here notifies. */
  strongMatches?: readonly StrongMatchEvidence[] | null;
  /** Campaign minimum fit score; raises the strong-match bar when higher than the default. */
  minimumFitScore?: number | null;
  /** Blocked campaign work evidence. */
  blockedWork?: readonly CampaignWorkFailureEvidence[] | null;
  /** Failed campaign work evidence. */
  failedWork?: readonly CampaignWorkFailureEvidence[] | null;
  /** Campaign schedule run facts; a failed last run becomes a blocked-work notification. */
  runFacts?: CampaignRunFacts | null;
}

function appendWorkFailureNotifications(
  notifications: CampaignNotification[],
  seenIds: Set<string>,
  campaignId: string,
  now: string,
  outcome: "blocked" | "failed",
  items: readonly CampaignWorkFailureEvidence[],
): void {
  items.forEach((item) => {
    const workId = item.workId?.trim() ?? "";
    const jobId = item.jobId?.trim() ?? "";
    const sourceTargetId = item.sourceTargetId?.trim() ?? "";
    // Do not fall back to an array index: a missing stable identity would
    // otherwise make a later re-derivation point at a different work unit.
    const stableIdentity = workId || sourceTargetId || jobId;
    if (stableIdentity.length === 0) return;

    // Blocked and failed are intentionally different identities. A technical
    // retry must not inherit a read state from an earlier manual blocker.
    const id = `n_${campaignId}_${outcome}_${stableIdentity}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const label = item.title?.trim() || "Campaign work";
    const reason = item.reason?.trim();
    notifications.push(
      CampaignNotificationSchema.parse({
        id,
        campaignId,
        kind: "blocked_work",
        title: truncate(
          `${outcome === "blocked" ? "Blocked" : "Failed"}: ${label}`,
          200,
        ),
        body: reason ? reason.slice(0, 2_000) : null,
        createdAt: now,
        unread: true,
        readAt: null,
        jobId: jobId.length > 0 ? jobId : null,
        sourceTargetId: sourceTargetId.length > 0 ? sourceTargetId : null,
      }),
    );
  });
}

/**
 * Derives local in-app notifications only for strong new matches and
 * blocked/failed campaign work. Returns an empty list when the evidence is
 * invalid or missing (empty campaign id, invalid `now`). Notification ids are
 * deterministic so re-derivation dedupes cleanly and never resets read state.
 */
export function deriveCampaignNotifications(
  input: DeriveCampaignNotificationsInput,
): CampaignNotification[] {
  const campaignId = input.campaignId.trim();
  if (campaignId.length === 0) return [];
  if (!IsoDateTimeSchema.safeParse(input.now).success) return [];

  const notifications: CampaignNotification[] = [];
  const seenIds = new Set<string>();

  const rawMinimum = input.minimumFitScore;
  const campaignMinimum =
    typeof rawMinimum === "number" && Number.isFinite(rawMinimum)
      ? Math.max(0, rawMinimum)
      : 0;
  const strongThreshold = Math.max(STRONG_MATCH_MIN_SCORE, campaignMinimum);

  for (const match of input.strongMatches ?? []) {
    if (!Number.isFinite(match.fitScore)) continue;
    if (match.fitScore < strongThreshold) continue;

    const title = match.title.trim();
    const jobId = match.jobId.trim();
    if (title.length === 0 || jobId.length === 0) continue;

    const id = `n_${campaignId}_strong_${jobId}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const company = match.company?.trim();
    const fitCopy =
      match.assessment && !isProvisionalMatchAssessment(match.assessment)
        ? `scores ${match.fitScore} of 100`
        : "has fit not assessed";
    notifications.push(
      CampaignNotificationSchema.parse({
        id,
        campaignId,
        kind: "strong_match",
        title: truncate(`Strong match: ${title}`, 200),
        body:
          company && company.length > 0
            ? `New match at ${company} ${fitCopy}.`
            : `New match ${fitCopy}.`,
        createdAt: input.now,
        unread: true,
        readAt: null,
        jobId,
        sourceTargetId: null,
      }),
    );
  }

  appendWorkFailureNotifications(
    notifications,
    seenIds,
    campaignId,
    input.now,
    "blocked",
    input.blockedWork ?? [],
  );
  appendWorkFailureNotifications(
    notifications,
    seenIds,
    campaignId,
    input.now,
    "failed",
    input.failedWork ?? [],
  );

  const runFacts = input.runFacts;
  if (
    runFacts !== null &&
    runFacts !== undefined &&
    runFacts.lastRunOutcome === "failed" &&
    runFacts.lastRunAt !== null
  ) {
    const id = `n_${campaignId}_failed_run_${runFacts.lastRunAt}`;
    if (!seenIds.has(id)) {
      seenIds.add(id);
      notifications.push(
        CampaignNotificationSchema.parse({
          id,
          campaignId,
          kind: "blocked_work",
          // The run facts record no trigger, so this notification cannot know
          // whether the schedule or the person started the run. It says
          // "search plan run" rather than telling someone who just pressed Run
          // now that a scheduled search failed.
          title: "Failed: search plan run",
          body:
            runFacts.lastRunSummary !== null
              ? runFacts.lastRunSummary.slice(0, 2_000)
              : null,
          createdAt: input.now,
          unread: true,
          readAt: null,
          jobId: null,
          sourceTargetId: null,
        }),
      );
    }
  }

  return notifications;
}

function compareNewestFirst(
  left: CampaignNotification,
  right: CampaignNotification,
): number {
  const leftMs = Date.parse(left.createdAt);
  const rightMs = Date.parse(right.createdAt);
  if (leftMs !== rightMs) {
    if (Number.isNaN(leftMs)) return 1;
    if (Number.isNaN(rightMs)) return -1;
    return rightMs - leftMs;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Merges two notification lists, dedupes by id (existing wins, so read state
 * survives re-derivation), drops invalid notifications, and caps the result at
 * 5,000. When over the cap the newest notifications are kept while the kept
 * entries retain their original relative order.
 */
export function mergeCampaignNotifications(input: {
  existing: readonly CampaignNotification[];
  incoming: readonly CampaignNotification[];
}): CampaignNotification[] {
  const merged: CampaignNotification[] = [];
  const seenIds = new Set<string>();
  for (const notification of [...input.existing, ...input.incoming]) {
    const parsed = CampaignNotificationSchema.safeParse(notification);
    if (!parsed.success) continue;
    if (seenIds.has(parsed.data.id)) continue;
    seenIds.add(parsed.data.id);
    merged.push(parsed.data);
  }

  if (merged.length <= MAX_CAMPAIGN_NOTIFICATIONS) return merged;

  const keptIndices = new Set(
    merged
      .map((notification, index) => ({ notification, index }))
      .sort((left, right) =>
        compareNewestFirst(left.notification, right.notification),
      )
      .slice(0, MAX_CAMPAIGN_NOTIFICATIONS)
      .map((entry) => entry.index),
  );
  return merged.filter((_, index) => keptIndices.has(index));
}

/**
 * Marks exactly one notification read. Returns a new array with the matching
 * notification flipped to `unread: false` with the given `readAt`; everything
 * else is untouched. An unknown id or an invalid `readAt` is a no-op.
 */
export function markCampaignNotificationRead(input: {
  notifications: readonly CampaignNotification[];
  notificationId: string;
  readAt: string;
}): CampaignNotification[] {
  if (!IsoDateTimeSchema.safeParse(input.readAt).success) {
    return [...input.notifications];
  }
  return input.notifications.map((notification) =>
    notification.id === input.notificationId
      ? CampaignNotificationSchema.parse({
          ...notification,
          unread: false,
          readAt: input.readAt,
        })
      : notification,
  );
}

/**
 * Marks every unread notification read. Returns a new array where each
 * unread notification is flipped to `unread: false` with the given `readAt`;
 * already-read notifications are untouched. An invalid `readAt` is a no-op.
 */
export function markAllCampaignNotificationsRead(input: {
  notifications: readonly CampaignNotification[];
  readAt: string;
}): CampaignNotification[] {
  if (!IsoDateTimeSchema.safeParse(input.readAt).success) {
    return [...input.notifications];
  }
  return input.notifications.map((notification) =>
    notification.unread
      ? CampaignNotificationSchema.parse({
          ...notification,
          unread: false,
          readAt: input.readAt,
        })
      : notification,
  );
}
