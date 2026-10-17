import type {
  JobFinderIntelligenceSafeguards,
  JobFinderRendererWorkspaceSnapshot,
  ListingSignalRecord,
  SafeguardDismissal,
  SafeguardEntryKind,
  SafeguardMutationInput,
  JobListRow,
} from "@nestor/contracts";
import type { BadgeTone } from "../../lib/job-finder-types";
import { buildJobFinderContextRoute } from "../../lib/job-finder-context-navigation";
import {
  hasPendingSampleReview,
  listApplyRunsStoppedBySafeguard,
} from "../../lib/apply-run-pause-state";
import { AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID } from "@nestor/job-finder/plan-safeguard-pauses";

/**
 * Stable per-mutation key used for pending-action scopes so the Safeguards
 * screen and the page controller agree on which control is in flight.
 */
export function safeguardMutationKey(input: SafeguardMutationInput): string {
  let reference = "global";
  switch (input.type) {
    case "apply_company_application_evidence":
      reference = input.config.companyId;
      break;
    case "decide_same_company_send_pair":
      reference = `${input.conflictId}:${input.jobIds.join(":")}:${input.allow}`;
      break;
    case "record_simultaneous_application_conflict":
    case "resolve_simultaneous_application_conflict":
      reference = input.conflictId;
      break;
    case "record_listing_signal":
      reference = input.signalId;
      break;
    case "record_abnormal_failure_evidence":
      reference = input.pauseId;
      break;
    case "prepare_batch_sample_review":
    case "update_batch_sample_review":
      reference = input.reviewId;
      break;
    case "record_contradictory_answer_detection":
    case "resolve_contradictory_answer_detection":
    case "dismiss_contradictory_answer_detection":
      reference = input.detectionId;
      break;
    case "dismiss_safeguard_entry":
      reference = `${input.kind}:${input.referenceId}`;
      break;
    case "restore_safeguard_entry":
      reference = input.dismissalId;
      break;
    default: {
      const unreachable: never = input;
      reference = String(unreachable);
    }
  }
  return `${input.type}:${reference}`;
}

export type SafeguardTabId =
  | "all"
  | "caps"
  | "conflicts"
  | "signals"
  | "pauses"
  | "reviews"
  | "contradictions"
  | "dismissals";

export type SafeguardControlKind =
  | "resolve"
  | "dismiss"
  | "restore"
  | "review_increment";

export interface SafeguardControl {
  id: string;
  label: string;
  kind: SafeguardControlKind;
  mutation: SafeguardMutationInput;
}

/**
 * A recovery sentence that names an action ("inspect the failed source
 * history") has to be followed by a control that performs it. Each row that
 * names a place carries the route to it, so the guidance is never advice the
 * page cannot act on.
 */
export interface SafeguardRecoveryLink {
  href: string;
  label: string;
}

const RECOVERY_LINKS: Record<
  Exclude<SafeguardTabId, "all">,
  SafeguardRecoveryLink | null
> = {
  caps: { href: "/job-finder/applications", label: "Open Applications" },
  conflicts: { href: "/job-finder/applications", label: "Open Applications" },
  signals: { href: "/job-finder/review-queue", label: "Open Shortlisted" },
  pauses: { href: "/job-finder/discovery", label: "Open Find jobs" },
  reviews: { href: "/job-finder/review-queue", label: "Open Shortlisted" },
  // Reused answers are resolved by the row's own Resolve control, so there is
  // no second destination to advertise.
  contradictions: null,
  dismissals: null,
};

/**
 * A raw ISO instant is machine output, not a fact a job seeker can read.
 */
export function formatSafeguardTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export interface SafeguardRow {
  key: string;
  kind: Exclude<SafeguardTabId, "all">;
  title: string;
  subtitle: string;
  explanation: string;
  recoveryGuidance: string;
  statusLabel: string;
  statusTone: BadgeTone;
  active: boolean;
  blocked: boolean;
  dismissed: boolean;
  lineage: {
    jobs: readonly string[];
    companies: readonly string[];
    campaigns: readonly string[];
  };
  tags: readonly string[];
  controls: readonly SafeguardControl[];
  recoveryLink: SafeguardRecoveryLink | null;
  sampleLinks?: readonly SafeguardRecoveryLink[];
  searchText: string;
}

export interface SafeguardsPresentationModel {
  rows: readonly SafeguardRow[];
  counts: {
    caps: number;
    conflicts: number;
    signals: number;
    pauses: number;
    reviews: number;
    contradictions: number;
    dismissals: number;
    blockers: number;
    /**
     * What the `All` filter means: the number of rows the page actually
     * renders. It is derived from the rows themselves and therefore always
     * equals the sum of the category counts, which is exactly what the old
     * `All 0` beside `Automatic pauses 1` did not.
     */
    total: number;
  };
}

export interface BuildSafeguardsPresentationModelInput {
  safeguards: JobFinderIntelligenceSafeguards;
  workspace: JobFinderRendererWorkspaceSnapshot;
}

// Live updates retain unchanged collections. Cache by those identities rather
// than the enclosing snapshot so event-only changes do not rebuild job indexes.
interface WorkspaceLookup {
  discoveryJobs: JobFinderRendererWorkspaceSnapshot["discoveryJobs"];
  companyJobs: JobFinderRendererWorkspaceSnapshot["companyJobs"];
  dismissedJobs: JobFinderRendererWorkspaceSnapshot["dismissedDiscoveryJobs"];
  records: JobFinderRendererWorkspaceSnapshot["applicationRecords"];
  companies: JobFinderRendererWorkspaceSnapshot["intelligence"]["companies"];
  campaigns: JobFinderRendererWorkspaceSnapshot["campaigns"];
  results: JobFinderRendererWorkspaceSnapshot["applyJobResults"];
  jobById: ReadonlyMap<string, JobListRow>;
  recordById: ReadonlyMap<
    string,
    JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]
  >;
  recordByJobId: ReadonlyMap<
    string,
    JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]
  >;
  submittedJobIds: ReadonlySet<string>;
  companyById: ReadonlyMap<
    string,
    JobFinderRendererWorkspaceSnapshot["intelligence"]["companies"][number]
  >;
  campaignsByJobId: ReadonlyMap<string, ReadonlySet<number>>;
  resultById: ReadonlyMap<
    string,
    JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
  >;
  jobLabels: Map<string, string>;
}

const workspaceLookupCache = new WeakMap<
  readonly JobListRow[],
  WorkspaceLookup
>();
const jobIndexCache = new WeakMap<
  readonly JobListRow[],
  Pick<WorkspaceLookup, "companyJobs" | "dismissedJobs" | "jobById">
>();

function getJobIndex(workspace: JobFinderRendererWorkspaceSnapshot) {
  const cached = jobIndexCache.get(workspace.discoveryJobs);
  if (
    cached &&
    cached.companyJobs === workspace.companyJobs &&
    cached.dismissedJobs === workspace.dismissedDiscoveryJobs
  )
    return cached.jobById;
  const jobById = new Map<string, JobListRow>();
  for (const jobs of [
    workspace.discoveryJobs,
    workspace.companyJobs ?? [],
    workspace.dismissedDiscoveryJobs ?? [],
  ]) {
    for (const job of jobs) {
      const id = job.id;
      if (!jobById.has(id)) jobById.set(id, job);
    }
  }
  jobIndexCache.set(workspace.discoveryJobs, {
    companyJobs: workspace.companyJobs,
    dismissedJobs: workspace.dismissedDiscoveryJobs,
    jobById,
  });
  return jobById;
}

function getWorkspaceLookup(
  workspace: JobFinderRendererWorkspaceSnapshot,
): WorkspaceLookup {
  const cached = workspaceLookupCache.get(workspace.discoveryJobs);
  if (
    cached &&
    cached.companyJobs === workspace.companyJobs &&
    cached.dismissedJobs === workspace.dismissedDiscoveryJobs &&
    cached.records === workspace.applicationRecords &&
    cached.companies === workspace.intelligence.companies &&
    cached.campaigns === workspace.campaigns &&
    cached.results === workspace.applyJobResults
  )
    return cached;
  const jobById = getJobIndex(workspace);
  const recordById = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]
  >();
  const recordByJobId = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["applicationRecords"][number]
  >();
  const submittedJobIds = new Set<string>();
  for (const record of workspace.applicationRecords) {
    if (!recordById.has(record.id)) recordById.set(record.id, record);
    if (!recordByJobId.has(record.jobId))
      recordByJobId.set(record.jobId, record);
    if (record.lastAttemptState === "submitted")
      submittedJobIds.add(record.jobId);
  }
  const companyById = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["intelligence"]["companies"][number]
  >();
  for (const company of workspace.intelligence.companies ?? [])
    if (!companyById.has(company.id)) companyById.set(company.id, company);
  const campaignsByJobId = new Map<string, Set<number>>();
  workspace.campaigns.forEach((campaign, index) => {
    for (const jobId of campaign.jobIds) {
      const indices = campaignsByJobId.get(jobId) ?? new Set<number>();
      indices.add(index);
      campaignsByJobId.set(jobId, indices);
    }
  });
  const resultById = new Map<
    string,
    JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
  >();
  for (const result of workspace.applyJobResults ?? [])
    if (!resultById.has(result.id)) resultById.set(result.id, result);
  const lookup: WorkspaceLookup = {
    discoveryJobs: workspace.discoveryJobs,
    companyJobs: workspace.companyJobs,
    dismissedJobs: workspace.dismissedDiscoveryJobs,
    records: workspace.applicationRecords,
    companies: workspace.intelligence.companies,
    campaigns: workspace.campaigns,
    results: workspace.applyJobResults,
    jobById,
    recordById,
    recordByJobId,
    submittedJobIds,
    companyById,
    campaignsByJobId,
    resultById,
    jobLabels: new Map(),
  };
  workspaceLookupCache.set(workspace.discoveryJobs, lookup);
  return lookup;
}

function jobLabel(lookup: WorkspaceLookup, jobId: string): string {
  const cached = lookup.jobLabels.get(jobId);
  if (cached !== undefined) return cached;
  const job = lookup.jobById.get(jobId);
  const record = lookup.recordByJobId.get(jobId);
  const label = job
    ? [job.title, job.location, job.company].filter(Boolean).join(" · ")
    : record
      ? `${record.title} · ${record.company}`
      : jobId;
  lookup.jobLabels.set(jobId, label);
  return label;
}

function companyLabel(lookup: WorkspaceLookup, companyId: string): string {
  const company = lookup.companyById.get(companyId);
  return company?.canonicalName ?? companyId;
}

function applicationRecordLabel(
  lookup: WorkspaceLookup,
  applicationRecordId: string,
): string {
  const record = lookup.recordById.get(applicationRecordId);
  return record
    ? jobLabel(lookup, record.jobId)
    : "Application no longer saved";
}

function dismissalReferenceLabel(
  lookup: WorkspaceLookup,
  safeguards: ReturnType<typeof indexSafeguards>,
  dismissal: SafeguardDismissal,
): string {
  switch (dismissal.kind) {
    case "company_cap_limit": {
      const cap = safeguards.caps.get(dismissal.referenceId);
      return cap
        ? `Application limit · ${companyLabel(lookup, cap.companyId)}`
        : dismissal.referenceId;
    }
    case "simultaneous_application_conflict": {
      const conflict = safeguards.conflicts.get(dismissal.referenceId);
      return conflict
        ? `Conflict: ${applicationRecordLabel(lookup, conflict.applicationRecordId)} ↔ ${applicationRecordLabel(lookup, conflict.conflictingApplicationRecordId)}`
        : dismissal.referenceId;
    }
    case "listing_signal": {
      const signal = safeguards.signals.get(dismissal.referenceId);
      return signal
        ? `Listing ${signal.signal} · ${jobLabel(lookup, signal.jobId)}`
        : dismissal.referenceId;
    }
    case "abnormal_failure_pause":
      return safeguards.pauses.has(dismissal.referenceId)
        ? "Paused after repeated failures"
        : dismissal.referenceId;
    case "batch_sample_review_pending":
      return safeguards.reviews.has(dismissal.referenceId)
        ? "Quality sample review"
        : dismissal.referenceId;
    case "contradictory_answer":
      return safeguards.contradictions.has(dismissal.referenceId)
        ? "Contradictory reused answers"
        : dismissal.referenceId;
  }
}

function campaignLabelsForJobs(
  lookup: WorkspaceLookup,
  jobIds: readonly string[],
): readonly string[] {
  const indices = new Set<number>();
  for (const jobId of jobIds) {
    for (const index of lookup.campaignsByJobId.get(jobId) ?? [])
      indices.add(index);
  }
  return [...indices]
    .sort((a, b) => a - b)
    .map((index) => lookup.campaigns[index]!.name);
}

function dismissalPairKey(kind: string, referenceId: string): string {
  return `${kind}\u0000${referenceId}`;
}

function findDismissal(
  safeguards: ReturnType<typeof indexSafeguards>,
  kind: SafeguardEntryKind,
  referenceId: string,
): SafeguardDismissal | null {
  const pair = dismissalPairKey(kind, referenceId);
  return safeguards.dismissals.get(pair) ?? null;
}

function indexSafeguards(safeguards: JobFinderIntelligenceSafeguards) {
  const byId = <T extends { id: string }>(entries: readonly T[]) => {
    const index = new Map<string, T>();
    for (const entry of entries)
      if (!index.has(entry.id)) index.set(entry.id, entry);
    return index;
  };
  const dismissals = new Map<string, SafeguardDismissal>();
  for (const dismissal of safeguards.safeguardDismissals) {
    const key = dismissalPairKey(dismissal.kind, dismissal.referenceId);
    if (!dismissals.has(key)) dismissals.set(key, dismissal);
  }
  return {
    caps: byId(safeguards.companyApplicationCaps),
    conflicts: byId(safeguards.simultaneousApplicationConflicts),
    signals: byId(safeguards.listingSignals),
    pauses: byId(safeguards.abnormalFailurePauses),
    reviews: byId(safeguards.preparedBatchSampleReviews),
    contradictions: byId(safeguards.contradictoryAnswerDetections),
    dismissals,
  };
}

function latestSignalIdsByJob(
  safeguards: JobFinderIntelligenceSafeguards,
): ReadonlyMap<string, string> {
  const latest = new Map<string, ListingSignalRecord>();
  for (const signal of safeguards.listingSignals) {
    const current = latest.get(signal.jobId);
    if (
      !current ||
      signal.detectedAt > current.detectedAt ||
      (signal.detectedAt === current.detectedAt && signal.id > current.id)
    ) {
      latest.set(signal.jobId, signal);
    }
  }
  return new Map(
    [...latest.entries()].map(([jobId, signal]) => [jobId, signal.id]),
  );
}

export function buildSafeguardsPresentationModel(
  input: BuildSafeguardsPresentationModelInput,
): SafeguardsPresentationModel {
  const { safeguards, workspace } = input;
  const lookup = getWorkspaceLookup(workspace);
  const safeguardIndex = indexSafeguards(safeguards);
  const latestByJob = latestSignalIdsByJob(safeguards);
  const rows: SafeguardRow[] = [];

  const pushRow = (row: SafeguardRow) => {
    rows.push(row);
  };

  const baseLineage = (
    jobIds: readonly string[],
    companyIds: readonly string[],
  ) => ({
    jobs: [...new Set(jobIds)].map((jobId) => jobLabel(lookup, jobId)),
    companies: [...new Set(companyIds)].map((companyId) =>
      companyLabel(lookup, companyId),
    ),
    campaigns: campaignLabelsForJobs(lookup, jobIds),
  });

  for (const cap of safeguards.companyApplicationCaps) {
    const dismissal = findDismissal(
      safeguardIndex,
      "company_cap_limit",
      cap.id,
    );
    const active = cap.limitReached;
    // A limit that has not been reached is a rule, not an event. Rendering a
    // card for it told the user something had happened when nothing had.
    if (!active && !dismissal) {
      continue;
    }
    const companyJobs = lookup.companyById.get(cap.companyId)?.jobIds ?? [];
    const lineage = baseLineage(companyJobs, [cap.companyId]);
    const controls: SafeguardControl[] = [];
    if (active && !dismissal) {
      controls.push({
        id: `cap-dismiss-${cap.id}`,
        label: "Dismiss cap",
        kind: "dismiss",
        mutation: {
          type: "dismiss_safeguard_entry",
          kind: "company_cap_limit",
          referenceId: cap.id,
          reason: "user_resolved",
          note: "User acknowledged the cap.",
        },
      });
    }
    if (dismissal) {
      controls.push({
        id: `cap-restore-${cap.id}`,
        label: "Restore cap (retry)",
        kind: "restore",
        mutation: {
          type: "restore_safeguard_entry",
          dismissalId: dismissal.id,
        },
      });
    }
    pushRow({
      key: `cap-${cap.id}`,
      kind: "caps",
      title: `${cap.currentWindowCount}/${cap.maxApplicationsPerWindow} applications`,
      subtitle: `Company cap · ${cap.windowDays}-day window since ${formatSafeguardTimestamp(cap.windowStartedAt)}`,
      explanation: cap.explanation,
      recoveryGuidance: cap.recoveryGuidance,
      statusLabel: active ? "Limit reached" : "Within limit",
      statusTone: active ? (dismissal ? "muted" : "critical") : "positive",
      active,
      blocked: active && !dismissal,
      dismissed: Boolean(dismissal),
      lineage,
      tags: [`company:${companyLabel(lookup, cap.companyId)}`],
      controls,
      recoveryLink: RECOVERY_LINKS.caps,
      searchText: [
        cap.explanation,
        cap.recoveryGuidance,
        companyLabel(lookup, cap.companyId),
        ...lineage.jobs,
        ...lineage.companies,
        ...lineage.campaigns,
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  for (const conflict of safeguards.simultaneousApplicationConflicts) {
    if (conflict.companyKey && conflict.jobIds) {
      const jobIds = conflict.jobIds;
      const label = (id: string) => {
        const job = lookup.jobById.get(id);
        const record = lookup.recordByJobId.get(id);
        return `${job?.title ?? record?.title ?? "Application"} (${job?.location || "place not listed"})`;
      };
      const controls: SafeguardControl[] = [];
      const pairKey = (ids: readonly string[]) =>
        JSON.stringify([...ids].sort());
      const allowedPairKeys = new Set(
        (conflict.allowedPairs ?? [])
          .filter((decision) => decision.revokedAt === null)
          .map((decision) => pairKey(decision.jobIds)),
      );
      let blocked = false;
      for (let i = 0; i < jobIds.length; i++) {
        for (let j = i + 1; j < jobIds.length; j++) {
          const pair: [string, string] = [jobIds[i]!, jobIds[j]!];
          const allowed = allowedPairKeys.has(pairKey(pair));
          const bothSent = pair.every((id) => lookup.submittedJobIds.has(id));
          if (!allowed && bothSent) continue;
          if (!allowed) blocked = true;
          controls.push({
            id: `${conflict.id}-${i}-${j}`,
            label: `${allowed ? "Revoke Send both anyway" : "Send both anyway"}: ${pair.map(label).join(" and ")}`,
            kind: allowed ? "restore" : "resolve",
            mutation: {
              type: "decide_same_company_send_pair",
              conflictId: conflict.id,
              jobIds: pair,
              allow: !allowed,
            },
          });
        }
      }
      pushRow({
        key: `conflict-${conflict.id}`,
        kind: "conflicts",
        title: conflict.companyName ?? "Same employer",
        subtitle: jobIds.map(label).join("; "),
        explanation:
          "These applications share an employer. Your choice applies to each pair, and you can revoke it.",
        recoveryGuidance: blocked
          ? "Choose Send both anyway for a pair you want sent, then return to the application. Sending still needs your permission."
          : controls.length
            ? "Your choices are saved. Return to the applications to send them, or revoke a choice here."
            : "These applications have already been sent.",
        statusLabel: blocked
          ? "Needs your choice"
          : controls.length
            ? "Pairs allowed by you"
            : "Past overlap",
        statusTone: blocked
          ? "critical"
          : controls.length
            ? "positive"
            : "neutral",
        active: blocked,
        blocked,
        dismissed: false,
        lineage: baseLineage(jobIds, []),
        tags: [],
        controls,
        recoveryLink: RECOVERY_LINKS.conflicts,
        searchText: [conflict.companyName, ...jobIds.map(label)]
          .join(" ")
          .toLowerCase(),
      });
      continue;
    }
    const dismissal = findDismissal(
      safeguardIndex,
      "simultaneous_application_conflict",
      conflict.id,
    );
    const active = conflict.status === "detected";
    const jobIds = [
      conflict.applicationRecordId,
      conflict.conflictingApplicationRecordId,
    ].flatMap((id) => {
      const record = lookup.recordById.get(id);
      return record ? [record.jobId] : [];
    });
    const controls: SafeguardControl[] = [];
    if (active && !dismissal) {
      controls.push({
        id: `conflict-resolve-${conflict.id}`,
        label: "Resolve conflict",
        kind: "resolve",
        mutation: {
          type: "resolve_simultaneous_application_conflict",
          conflictId: conflict.id,
        },
      });
      controls.push({
        id: `conflict-dismiss-${conflict.id}`,
        label: "Dismiss",
        kind: "dismiss",
        mutation: {
          type: "dismiss_safeguard_entry",
          kind: "simultaneous_application_conflict",
          referenceId: conflict.id,
          reason: "not_applicable",
          note: "User acknowledged the conflict.",
        },
      });
    }
    if (dismissal) {
      controls.push({
        id: `conflict-restore-${conflict.id}`,
        label: "Restore (retry)",
        kind: "restore",
        mutation: {
          type: "restore_safeguard_entry",
          dismissalId: dismissal.id,
        },
      });
    }
    pushRow({
      key: `conflict-${conflict.id}`,
      kind: "conflicts",
      title: `Conflict: ${applicationRecordLabel(lookup, conflict.applicationRecordId)} ↔ ${applicationRecordLabel(lookup, conflict.conflictingApplicationRecordId)}`,
      subtitle:
        conflict.status === "detected"
          ? "Two applications overlapped in time"
          : "Conflict resolved",
      explanation:
        "These applications were recorded close together at the same employer. Review them before starting more work for this company.",
      recoveryGuidance:
        "Review the two applications, then resolve or dismiss this hold. Applications already sent stay sent.",
      statusLabel: active ? "Detected" : "Resolved",
      statusTone: active ? (dismissal ? "muted" : "critical") : "positive",
      active,
      blocked: active && !dismissal,
      dismissed: Boolean(dismissal),
      lineage: baseLineage(jobIds, []),
      tags: jobIds.map((jobId) => `job:${jobId}`),
      controls,
      recoveryLink: RECOVERY_LINKS.conflicts,
      searchText: [
        conflict.explanation,
        conflict.recoveryGuidance,
        ...jobIds,
        ...baseLineage(jobIds, []).jobs,
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  for (const signal of safeguards.listingSignals) {
    const dismissal = findDismissal(
      safeguardIndex,
      "listing_signal",
      signal.id,
    );
    const isLatestForJob = latestByJob.get(signal.jobId) === signal.id;
    const active = isLatestForJob;
    const jobIds = [signal.jobId];
    const controls: SafeguardControl[] = [];
    if (active && !dismissal) {
      controls.push({
        id: `signal-dismiss-${signal.id}`,
        label: "Dismiss signal",
        kind: "dismiss",
        mutation: {
          type: "dismiss_safeguard_entry",
          kind: "listing_signal",
          referenceId: signal.id,
          reason: "rechecked",
          note: "Re-verified the listing.",
        },
      });
    }
    if (dismissal) {
      controls.push({
        id: `signal-restore-${signal.id}`,
        label: "Restore (retry)",
        kind: "restore",
        mutation: {
          type: "restore_safeguard_entry",
          dismissalId: dismissal.id,
        },
      });
    }
    pushRow({
      key: `signal-${signal.id}`,
      kind: "signals",
      title: `Listing ${signal.signal}`,
      subtitle: `${signal.provenance} · confidence ${Math.round(signal.confidence * 100)}%`,
      explanation: signal.explanation,
      recoveryGuidance: signal.recoveryGuidance,
      statusLabel: active
        ? dismissal
          ? "Dismissed"
          : "Blocking"
        : "Superseded",
      statusTone: active ? (dismissal ? "muted" : "critical") : "neutral",
      active,
      blocked: active && !dismissal,
      dismissed: Boolean(dismissal),
      lineage: baseLineage(jobIds, []),
      tags: [`signal:${signal.signal}`],
      controls,
      recoveryLink: RECOVERY_LINKS.signals,
      searchText: [
        signal.signal,
        signal.explanation,
        signal.recoveryGuidance,
        signal.detail ?? "",
        ...baseLineage(jobIds, []).jobs,
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  for (const pause of safeguards.abnormalFailurePauses) {
    const dismissal = findDismissal(
      safeguardIndex,
      "abnormal_failure_pause",
      pause.id,
    );
    const active = pause.paused;
    // The failure-rate threshold is a standing rule. Until it is crossed it
    // has nothing to report, so it must not render a card at all.
    if (!active && !dismissal) {
      continue;
    }
    const controls: SafeguardControl[] = [];
    if (active && !dismissal) {
      controls.push({
        id: `pause-dismiss-${pause.id}`,
        label: "Dismiss pause",
        kind: "dismiss",
        mutation: {
          type: "dismiss_safeguard_entry",
          kind: "abnormal_failure_pause",
          referenceId: pause.id,
          reason: "user_resolved",
          note: "User inspected the failure evidence.",
        },
      });
    }
    if (dismissal) {
      controls.push({
        id: `pause-restore-${pause.id}`,
        label: "Restore pause (retry)",
        kind: "restore",
        mutation: {
          type: "restore_safeguard_entry",
          dismissalId: dismissal.id,
        },
      });
    }
    pushRow({
      key: `pause-${pause.id}`,
      kind: "pauses",
      title: `Paused after repeated failures (${pause.failureRatePercent.toFixed(1)}% failed)`,
      subtitle: `${pause.failuresInWindow} of ${pause.sampleSize} attempts failed since ${formatSafeguardTimestamp(pause.windowStartedAt)}`,
      explanation: pause.explanation,
      recoveryGuidance: pause.recoveryGuidance,
      statusLabel: active ? (dismissal ? "Dismissed" : "Paused") : "Not paused",
      statusTone: active ? (dismissal ? "muted" : "critical") : "positive",
      active,
      blocked: active && !dismissal,
      dismissed: Boolean(dismissal),
      lineage: baseLineage([], []),
      tags: [
        `threshold:${pause.failureRateThresholdPercent}%`,
        `sample:${pause.minimumSample}`,
      ],
      controls,
      recoveryLink: pause.id.startsWith(
        `${AUTOMATIC_APPLICATION_FAILURE_PAUSE_ID}:`,
      )
        ? { href: "/job-finder/applications", label: "Open Applications" }
        : RECOVERY_LINKS.pauses,
      searchText: [
        pause.explanation,
        pause.recoveryGuidance,
        `${pause.failureRatePercent}`,
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  // R3: Tasks said "Paused by a safety limit" while this page said "No active
  // safeguard blockers. Discovery and preparation are clear." and counted
  // zero. The pause the Tasks card names lives on the application run, not in
  // the safeguard records, so this page never knew about it. Read it from the
  // same runs the Tasks card reads, so both surfaces name the same pause and
  // the counters agree.
  // Only runs a safety limit actually stopped. A run waiting on the person
  // is in Needs you, a filled-in one is Ready to send, and an old run whose
  // jobs were all sent or ended keeps its "paused" state from before later
  // fixes but is finished (the same classifier Activity reads).
  for (const run of listApplyRunsStoppedBySafeguard(workspace)) {
    const finishedJobs = Math.max(0, run.totalJobs - run.pendingJobs);
    const remainingJobs = Math.max(0, run.pendingJobs);
    const explanation =
      run.detail?.trim() ||
      run.summary?.trim() ||
      "Job Finder stopped preparing this batch because one of your safety limits was reached.";
    const recoveryGuidance = hasPendingSampleReview(workspace, run.id)
      ? "It will not carry on by itself. Review the prepared sample below, then open Applications to prepare the remaining jobs."
      : remainingJobs > 0
        ? "It will not carry on by itself. Check the limit named here. Daily limits reset tomorrow; search-plan limits can be changed in Search plans. Then open Applications and press Try again on an unstarted job."
        : "It will not carry on by itself. Open Applications to review each outcome.";
    pushRow({
      key: `apply-run-pause-${run.id}`,
      kind: "pauses",
      title: "Applications paused by a safety limit",
      subtitle: `${finishedJobs} of ${run.totalJobs} application task${
        run.totalJobs === 1 ? "" : "s"
      } finished · paused ${formatSafeguardTimestamp(run.updatedAt)}`,
      explanation,
      recoveryGuidance,
      statusLabel: "Paused",
      statusTone: "critical",
      active: true,
      blocked: true,
      dismissed: false,
      lineage: baseLineage(run.jobIds, []),
      tags: ["paused:safety limit"],
      controls: [],
      recoveryLink: {
        href: "/job-finder/applications",
        label: "Open Applications",
      },
      searchText: [explanation, recoveryGuidance, "paused safety limit"]
        .join(" ")
        .toLowerCase(),
    });
  }

  for (const review of [...safeguards.preparedBatchSampleReviews].sort(
    (left, right) =>
      Number(left.reviewCompleted) - Number(right.reviewCompleted),
  )) {
    const sampleLinks = review.sampledItemIds.flatMap((resultId) => {
      const result = lookup.resultById.get(resultId);
      if (!result?.applicationRecordId) return [];
      return [
        {
          href: buildJobFinderContextRoute("/job-finder/applications", {
            applicationRecordId: result.applicationRecordId,
            jobId: result.jobId,
          }),
          label: jobLabel(lookup, result.jobId),
        },
      ];
    });
    const dismissal = findDismissal(
      safeguardIndex,
      "batch_sample_review_pending",
      review.id,
    );
    const active = !review.reviewCompleted;
    const controls: SafeguardControl[] = [];
    if (active && !dismissal) {
      const nextCount = Math.min(review.reviewedCount + 1, review.sampleCount);
      controls.push({
        id: `review-increment-${review.id}`,
        label:
          review.reviewedCount >= review.sampleCount
            ? "Review complete"
            : `Mark reviewed (${review.reviewedCount}/${review.sampleCount})`,
        kind: "review_increment",
        mutation: {
          type: "update_batch_sample_review",
          reviewId: review.id,
          reviewedCount: nextCount,
          reviewCompleted: nextCount === review.sampleCount,
        },
      });
      controls.push({
        id: `review-dismiss-${review.id}`,
        label: "Dismiss review",
        kind: "dismiss",
        mutation: {
          type: "dismiss_safeguard_entry",
          kind: "batch_sample_review_pending",
          referenceId: review.id,
          reason: "not_applicable",
          note: "User acknowledged the review.",
        },
      });
    }
    if (dismissal) {
      controls.push({
        id: `review-restore-${review.id}`,
        label: "Restore (retry)",
        kind: "restore",
        mutation: {
          type: "restore_safeguard_entry",
          dismissalId: dismissal.id,
        },
      });
    }
    pushRow({
      key: `review-${review.id}`,
      kind: "reviews",
      title: "Quality sample review",
      subtitle: `${review.reviewedCount}/${review.sampleCount} reviewed of ${review.preparedCount} prepared`,
      explanation: describeSampleReviewExplanation(review.explanation),
      recoveryGuidance: review.recoveryGuidance,
      statusLabel: active ? (dismissal ? "Dismissed" : "Pending") : "Completed",
      statusTone: active ? (dismissal ? "muted" : "critical") : "positive",
      active,
      blocked: active && !dismissal,
      dismissed: Boolean(dismissal),
      lineage: baseLineage([], []),
      sampleLinks,
      tags: [`batch:${review.batchId}`],
      controls,
      recoveryLink: sampleLinks.length === 0 ? RECOVERY_LINKS.reviews : null,
      searchText: [
        review.batchId,
        review.explanation,
        review.recoveryGuidance,
        `${review.preparedCount}`,
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  for (const detection of safeguards.contradictoryAnswerDetections) {
    const dismissal = findDismissal(
      safeguardIndex,
      "contradictory_answer",
      detection.id,
    );
    const active = detection.status === "detected";
    const controls: SafeguardControl[] = [];
    if (active && !dismissal) {
      controls.push({
        id: `contradiction-resolve-${detection.id}`,
        label: "Resolve",
        kind: "resolve",
        mutation: {
          type: "resolve_contradictory_answer_detection",
          detectionId: detection.id,
        },
      });
      controls.push({
        id: `contradiction-dismiss-${detection.id}`,
        label: "Dismiss",
        kind: "dismiss",
        mutation: {
          type: "dismiss_contradictory_answer_detection",
          detectionId: detection.id,
        },
      });
    }
    if (dismissal) {
      controls.push({
        id: `contradiction-restore-${detection.id}`,
        label: "Restore (retry)",
        kind: "restore",
        mutation: {
          type: "restore_safeguard_entry",
          dismissalId: dismissal.id,
        },
      });
    }
    pushRow({
      key: `contradiction-${detection.id}`,
      kind: "contradictions",
      title: "Contradictory reused answers",
      subtitle: `“${detection.answerA}” vs “${detection.answerB}” · score ${detection.contradictionScore.toFixed(2)}`,
      explanation: detection.explanation,
      recoveryGuidance: detection.recoveryGuidance,
      statusLabel: active
        ? dismissal
          ? "Dismissed"
          : "Advisory"
        : detection.status,
      statusTone: active ? (dismissal ? "muted" : "neutral") : "positive",
      active,
      blocked: false,
      dismissed: Boolean(dismissal),
      lineage: baseLineage([], []),
      tags: [detection.questionA, detection.questionB],
      controls,
      recoveryLink: RECOVERY_LINKS.contradictions,
      searchText: [
        detection.questionA,
        detection.questionB,
        detection.answerA,
        detection.answerB,
        detection.explanation,
        detection.recoveryGuidance,
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  for (const dismissal of safeguards.safeguardDismissals) {
    pushRow({
      key: `dismissal-${dismissal.id}`,
      kind: "dismissals",
      title: `Dismissed ${dismissal.kind.replaceAll("_", " ")}`,
      subtitle: `${dismissalReferenceLabel(lookup, safeguardIndex, dismissal)} · ${dismissal.reason}`,
      explanation: dismissal.note ?? "Dismissed by the user.",
      recoveryGuidance: "Restore to re-arm the safeguard before continuing.",
      statusLabel: "Dismissed",
      statusTone: "muted",
      active: false,
      blocked: false,
      dismissed: true,
      lineage: baseLineage([], []),
      tags: [`dismissal:${dismissal.reason}`],
      controls: [
        {
          id: `dismissal-restore-${dismissal.id}`,
          label: "Restore",
          kind: "restore",
          mutation: {
            type: "restore_safeguard_entry",
            dismissalId: dismissal.id,
          },
        },
      ],
      recoveryLink: RECOVERY_LINKS.dismissals,
      searchText: [
        dismissal.kind,
        dismissal.referenceId,
        dismissal.reason,
        dismissal.note ?? "",
      ]
        .join(" ")
        .toLowerCase(),
    });
  }

  // Every count is derived from the rows that are actually rendered, so
  // `All` can never disagree with the list beneath it or with the sum of its
  // own sibling categories.
  const countByKind = (kind: Exclude<SafeguardTabId, "all">) =>
    rows.filter((row) => row.kind === kind).length;

  return {
    rows,
    counts: {
      caps: countByKind("caps"),
      conflicts: countByKind("conflicts"),
      signals: countByKind("signals"),
      pauses: countByKind("pauses"),
      reviews: countByKind("reviews"),
      contradictions: countByKind("contradictions"),
      dismissals: countByKind("dismissals"),
      blockers: rows.filter((row) => row.blocked).length,
      total: rows.length,
    },
  };
}

export function filterSafeguardRows(
  rows: readonly SafeguardRow[],
  tab: SafeguardTabId,
  query: string,
): readonly SafeguardRow[] {
  const normalized = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (tab !== "all" && row.kind !== tab) return false;
    if (normalized.length === 0) return true;
    return row.searchText.includes(normalized);
  });
}

/**
 * Sample reviews saved before the wording changed still carry "A
 * deterministic sample of this prepared queue must be reviewed…"; they read
 * in the current plain words.
 */
export function describeSampleReviewExplanation(explanation: string): string {
  return /^a deterministic sample of this prepared queue\b/iu.test(
    explanation.trim(),
  )
    ? "Look over a few of these prepared applications before Job Finder prepares more on its own."
    : explanation;
}
