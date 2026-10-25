import {
  CampaignNotificationSchema,
  IsoDateTimeSchema,
  type CampaignNotification,
} from "@nestor/contracts";

/** Storage cap for the local in-app notification collection. */
export const MAX_CAMPAIGN_NOTIFICATIONS = 5_000;

/** Shown when a job source no longer carries the label the user saved. */
export const UNNAMED_JOB_SOURCE_TITLE = "A job source";

/**
 * Names a job source the way the user saved it. Internal target ids are never
 * user-facing, so an id with no saved label falls back to a plain phrase
 * instead of leaking the identifier into a notification.
 */
export function describeJobSourceWorkTitle(
  sourceTargetId: string,
  targets: readonly { id: string; label: string }[],
): string {
  const id = sourceTargetId.trim();
  const label = targets.find((target) => target.id === id)?.label.trim() ?? "";
  return label.length > 0 ? `Job source ${label}` : UNNAMED_JOB_SOURCE_TITLE;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
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
  /** Blocked campaign work evidence. */
  blockedWork?: readonly CampaignWorkFailureEvidence[] | null;
  /** Failed campaign work evidence. */
  failedWork?: readonly CampaignWorkFailureEvidence[] | null;
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
 * Derives local notifications for blocked or failed work used by Safeguards. Returns an empty list when the evidence is
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
