import { createHash } from "node:crypto";
import {
  JobFinderIntelligenceStateSchema,
  type JobFinderIntelligenceState,
  type SavedJob,
  type ApplicationRecord,
  type SimultaneousApplicationConflict,
} from "@nestor/contracts";
import type { WorkspaceServiceContext } from "./workspace-service-context";

export function sendCompanyKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export function sendPairKey(ids: readonly string[]): string {
  return [...ids].sort().join("\0");
}
export function groupCompanyConflicts(
  state: JobFinderIntelligenceState,
  records: readonly ApplicationRecord[],
  jobs: readonly SavedJob[],
): JobFinderIntelligenceState {
  if (state.safeguards.simultaneousApplicationConflicts.length === 0)
    return state;
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const recordsByJobId = new Map<string, ApplicationRecord>();
  for (const record of records)
    if (!recordsByJobId.has(record.jobId))
      recordsByJobId.set(record.jobId, record);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const groups = new Map<string, SimultaneousApplicationConflict>();
  const unresolved: SimultaneousApplicationConflict[] = [];
  for (const conflict of state.safeguards.simultaneousApplicationConflicts) {
    const ids =
      conflict.jobIds ??
      [
        conflict.applicationRecordId,
        conflict.conflictingApplicationRecordId,
      ].flatMap((id) => {
        const record = recordsById.get(id);
        return record ? [record.jobId] : [];
      });
    const company =
      conflict.companyName ??
      jobsById.get(ids[0] ?? "")?.company ??
      recordsById.get(conflict.applicationRecordId)?.company;
    const names = ids.map(
      (id) => jobsById.get(id)?.company ?? recordsByJobId.get(id)?.company,
    );
    if (
      !company ||
      ids.length < 2 ||
      names.some(
        (name) => name && sendCompanyKey(name) !== sendCompanyKey(company),
      )
    ) {
      unresolved.push(conflict);
      continue;
    }
    const key = conflict.companyKey ?? sendCompanyKey(company);
    const existing = groups.get(key);
    const pairs = new Map<
      string,
      NonNullable<SimultaneousApplicationConflict["allowedPairs"]>[number]
    >();
    for (const pair of [
      ...(existing?.allowedPairs ?? []),
      ...(conflict.allowedPairs ?? []),
    ]) {
      const pairKey = sendPairKey(pair.jobIds);
      const old = pairs.get(pairKey);
      if (
        !old ||
        (pair.revokedAt ?? pair.decidedAt) >= (old.revokedAt ?? old.decidedAt)
      )
        pairs.set(pairKey, pair);
    }
    groups.set(key, {
      ...conflict,
      id: `company_sends_${createHash("sha256").update(key).digest("hex")}`,
      companyKey: key,
      companyName: company,
      jobIds: [...new Set([...(existing?.jobIds ?? []), ...ids])],
      allowedPairs: [...pairs.values()],
      // Legacy resolutions/dismissals are acknowledgements, never permission
      // to send a different pair. The shared send check owns the decision.
      status: "detected",
    });
  }
  return JobFinderIntelligenceStateSchema.parse({
    ...state,
    safeguards: {
      ...state.safeguards,
      simultaneousApplicationConflicts: [...unresolved, ...groups.values()],
    },
  });
}

/** Every automated send uses this check, including a single job or a chat send.
 * A pair decision removes only the overlap hold; final-send authority is separate.
 */
export async function checkSameCompanySends(input: {
  repository: WorkspaceServiceContext["repository"];
  jobIds: readonly string[];
  now?: string;
  transition?: WorkspaceServiceContext["withIntelligenceTransition"];
}): Promise<string | null> {
  const operation = async () => {
    const [state, records, jobs, results, runs] = await Promise.all([
      input.repository.getIntelligenceState(),
      input.repository.listApplicationRecords(),
      // Read-only company grouping; the cached display rows spare a full
      // parse of every saved job on each send.
      input.repository.readSavedJobsProjection(),
      input.repository.listApplyJobResults(),
      input.repository.listApplyRuns(),
    ]);
    let next = groupCompanyConflicts(state, records, jobs);
    const now = input.now ?? new Date().toISOString();
    const latestByJob = new Map<string, (typeof results)[number]>();
    for (const result of results) {
      const previous = latestByJob.get(result.jobId);
      if (!previous || result.updatedAt >= previous.updatedAt)
        latestByJob.set(result.jobId, result);
    }
    const latestResults = [...latestByJob.values()];
    const recent = new Set(
      latestResults
        .filter(
          (result) =>
            Date.parse(result.updatedAt) >= Date.parse(now) - 86400000 &&
            (result.state === "submitted" ||
              result.privacyReceipt?.submissionOutcome?.outcome ===
                "outcome_uncertain"),
        )
        .map((result) => result.jobId),
    );
    const pending = new Set(
      runs
        .filter((run) =>
          [
            "running",
            "awaiting_submit_approval",
            "paused_for_user_review",
            "paused_on_question",
          ].includes(run.state),
        )
        .flatMap((run) => run.jobIds),
    );
    for (const result of latestResults)
      if (
        ["awaiting_review", "blocked"].includes(result.state) &&
        result.applicationRecordId
      )
        pending.add(result.jobId);
    const selected = new Set(input.jobIds);
    const relevant = jobs.filter(
      (job) =>
        selected.has(job.id) || recent.has(job.id) || pending.has(job.id),
    );
    const refused: string[] = [];
    for (const job of relevant.filter((job) => selected.has(job.id))) {
      const key = sendCompanyKey(job.company);
      if (!key) continue;
      const others = relevant.filter(
        (other) => other.id !== job.id && sendCompanyKey(other.company) === key,
      );
      if (!others.length) continue;
      let group = next.safeguards.simultaneousApplicationConflicts.find(
        (group) => group.companyKey === key,
      );
      const ids = [
        ...new Set([
          ...(group?.jobIds ?? []),
          job.id,
          ...others.map((other) => other.id),
        ]),
      ];
      group = {
        id: `company_sends_${createHash("sha256").update(key).digest("hex")}`,
        applicationRecordId:
          records.find((record) => record.jobId === job.id)?.id ?? job.id,
        conflictingApplicationRecordId:
          records.find((record) => record.jobId === others[0]!.id)?.id ??
          others[0]!.id,
        status: "detected",
        explanation: `Several applications are for ${job.company}.`,
        recoveryGuidance: "Choose which pair may be sent in Safeguards.",
        ...group,
        companyKey: key,
        companyName: job.company,
        jobIds: ids,
      };
      next = {
        ...next,
        safeguards: {
          ...next.safeguards,
          simultaneousApplicationConflicts: [
            ...next.safeguards.simultaneousApplicationConflicts.filter(
              (old) => old.id !== group.id,
            ),
            group,
          ],
          updatedAt: now,
        },
      };
      for (const other of others) {
        if (
          group.allowedPairs?.some(
            (pair) =>
              sendPairKey(pair.jobIds) === sendPairKey([job.id, other.id]) &&
              pair.revokedAt === null,
          )
        )
          continue;
        const label = (entry: SavedJob) =>
          `${entry.title} (${entry.location || "place not listed"})`;
        const message = `${job.company}: ${[label(job), label(other)].sort().join(" and ")}`;
        if (!refused.includes(message)) refused.push(message);
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(state))
      await input.repository.saveIntelligenceState(next);
    return refused.length
      ? `These applications share an employer: ${refused.join("; ")}. In Safeguards, choose “Send both anyway” for each pair you want sent. Nothing was sent.`
      : null;
  };
  return input.transition ? input.transition(operation) : operation();
}
