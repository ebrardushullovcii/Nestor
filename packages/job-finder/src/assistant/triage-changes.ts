import type {
  AssistantChangeReceipt,
  JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

import type { AssistantToolContext, AssistantTurnSession } from "./tool-kit";
import { readAssistantWorkspace } from "./tool-kit";

function states(snapshot: JobFinderWorkspaceSnapshot) {
  const hidden = new Set(snapshot.dismissedDiscoveryJobs.map((job) => job.id));
  const shortlisted = new Set(snapshot.reviewQueue.map((item) => item.jobId));
  return (id: string) => ({
    hidden: hidden.has(id),
    shortlisted: shortlisted.has(id),
  });
}

/** One receipt for a bulk move; later moves are checked before Undo. */
export async function recordTriageChange(
  session: AssistantTurnSession,
  before: JobFinderWorkspaceSnapshot,
  after: JobFinderWorkspaceSnapshot,
  ids: readonly string[],
  summary: string,
) {
  if (!session.recordChange) return [];
  const prior = states(before),
    current = states(after);
  const entries = [...new Set(ids)].flatMap((id) => {
    const a = prior(id),
      b = current(id);
    return a.hidden === b.hidden && a.shortlisted === b.shortlisted
      ? []
      : [
          {
            path: [id],
            kind: "set" as const,
            before: a,
            after: b,
            index: null,
            label: (
              after.reviewQueue.find((item) => item.jobId === id)?.title ??
              before.discoveryJobs.find((job) => job.id === id)?.title ??
              "Job"
            ).slice(0, 160),
          },
        ];
  });
  const parts = [];
  for (let cursor = 0; cursor < entries.length; cursor += 600) {
    const receipt = await session.recordChange({
      target: "job_triage",
      targetId: null,
      summary,
      entries: entries.slice(cursor, cursor + 600),
    });
    parts.push(receipt.part);
  }
  return parts;
}

export async function undoTriageChange(
  context: Pick<AssistantToolContext, "service" | "session">,
  receipt: AssistantChangeReceipt,
) {
  const { service, session } = context;
  const current = states(await readAssistantWorkspace(service));
  const changes = receipt.entries.filter((entry) => {
    const after = entry.after as { hidden: boolean; shortlisted: boolean };
    const now = current(entry.path[0]!);
    return now.hidden === after.hidden && now.shortlisted === after.shortlisted;
  });
  const conflicts = receipt.entries
    .filter((entry) => !changes.includes(entry))
    .map((entry) => entry.label ?? "Job");
  const restore = changes
    .filter((entry) => !(entry.before as { hidden: boolean }).hidden)
    .map((entry) => entry.path[0]!);
  const hide = changes
    .filter((entry) => (entry.before as { hidden: boolean }).hidden)
    .map((entry) => ({ jobId: entry.path[0]!, reasons: [] }));
  const shortlist = changes
    .filter((entry) => (entry.before as { shortlisted: boolean }).shortlisted)
    .map((entry) => entry.path[0]!);
  const remove = changes
    .filter(
      (entry) =>
        !(entry.before as { shortlisted: boolean }).shortlisted &&
        (entry.after as { shortlisted: boolean }).shortlisted,
    )
    .map((entry) => entry.path[0]!);
  session.assertCurrent();
  if (restore.length) {
    if (service.restoreDismissedDiscoveryJobs)
      await service.restoreDismissedDiscoveryJobs(restore, {
        assertCurrent: () => session.assertCurrent(),
      });
    else
      for (const id of restore) await service.restoreDismissedDiscoveryJob(id);
  }
  if (hide.length) {
    if (service.dismissDiscoveryJobs)
      await service.dismissDiscoveryJobs(hide, {
        assertCurrent: () => session.assertCurrent(),
      });
    else for (const entry of hide) await service.dismissDiscoveryJob(entry);
  }
  if (shortlist.length) {
    if (service.queueJobsForReview) await service.queueJobsForReview(shortlist);
    else for (const id of shortlist) await service.queueJobForReview(id);
  }
  if (remove.length) {
    if (service.removeJobsFromReview)
      await service.removeJobsFromReview(remove);
    else for (const id of remove) await service.removeJobFromReview(id);
  }
  const saved = states(await readAssistantWorkspace(service));
  const undone: string[] = [];
  for (const entry of changes) {
    const before = entry.before as { hidden: boolean; shortlisted: boolean };
    const actual = saved(entry.path[0]!);
    (actual.hidden === before.hidden &&
    actual.shortlisted === before.shortlisted
      ? undone
      : conflicts
    ).push(entry.label ?? "Job");
  }
  return { undoneLabels: undone, conflictLabels: conflicts };
}
