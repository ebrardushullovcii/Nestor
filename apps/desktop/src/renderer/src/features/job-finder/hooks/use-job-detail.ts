import { useEffect, useState, useSyncExternalStore } from "react";
import { describeFailure } from "../lib/describe-failure";
import type {
  JobFinderJobDetail,
  JobListRow,
  SavedJob,
} from "@nestor/contracts";

/** A sentence this hook wrote for the person, shown as it is. */
class DetailReadError extends Error {}

const DETAIL_CACHE_LIMIT = 8;

export function createJobDetailCache(limit = DETAIL_CACHE_LIMIT) {
  let generation = 0;
  const entries = new Map<string, JobFinderJobDetail>();
  const pending = new Map<string, Promise<JobFinderJobDetail>>();
  const listeners = new Set<() => void>();
  return {
    subscribe(this: void, listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    generation: () => generation,
    size: () => entries.size,
    clear() {
      generation += 1;
      entries.clear();
      pending.clear();
      for (const listener of listeners) listener();
    },
    peek(key: string) {
      return entries.get(key) ?? null;
    },
    async load(key: string, read: () => Promise<JobFinderJobDetail>) {
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return cached;
      }
      const active = pending.get(key);
      if (active) return active;
      const startedGeneration = generation;
      const request = read();
      pending.set(key, request);
      try {
        const detail = await request;
        if (generation === startedGeneration) {
          entries.set(key, detail);
          while (entries.size > limit)
            entries.delete(entries.keys().next().value!);
        }
        return detail;
      } finally {
        if (pending.get(key) === request) pending.delete(key);
      }
    },
  };
}

const detailCache = createJobDetailCache();
export function clearJobDetailCache() {
  detailCache.clear();
}

/**
 * Reads a job's details into the cache ahead of time, so opening it next
 * (the next job in a triage pass) shows at once. A failed read is dropped;
 * opening the job reads it again.
 */
/**
 * What the detail reads are keyed by: the job, the revision of its stored
 * facts, and any list facts newer than the detail (Shortlisted's rows).
 */
export type JobDetailRow = {
  id: string;
  detailRevision?: string | undefined;
} & Partial<Omit<JobListRow, "id" | "detailRevision">>;

export function prefetchJobDetail(row: JobDetailRow, planId: string | null) {
  const key = JSON.stringify([
    detailCache.generation(),
    planId,
    row.id,
    row.detailRevision,
  ]);
  if (detailCache.peek(key)) return;
  void detailCache
    .load(key, async () => {
      const detail = await window.nestor.jobFinder.getJobDetail(row.id, planId);
      if (detail.job.id !== row.id || detail.planId !== planId)
        throw new DetailReadError(
          "The loaded details do not belong to this job and search plan.",
        );
      return detail;
    })
    .catch(() => undefined);
}

/** Selection, plan, detail revision and reset all fence asynchronous reads. */
export function useJobDetail(row: JobDetailRow | null, planId: string | null) {
  const generation = useSyncExternalStore(
    detailCache.subscribe,
    detailCache.generation,
  );
  const jobId = row?.id ?? null;
  const key = row
    ? JSON.stringify([generation, planId, row.id, row.detailRevision])
    : null;
  const [state, setState] = useState<{
    key: string | null;
    detail: JobFinderJobDetail | null;
    error: string | null;
  }>({ key: null, detail: null, error: null });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!jobId || !key) return;
    let current = true;
    setState({ key, detail: detailCache.peek(key), error: null });
    void detailCache
      .load(key, async () => {
        const detail = await window.nestor.jobFinder.getJobDetail(
          jobId,
          planId,
        );
        if (detail.job.id !== jobId || detail.planId !== planId)
          throw new DetailReadError(
            "The loaded details do not belong to this job and search plan.",
          );
        return detail;
      })
      .then((detail) => {
        if (current) setState({ key, detail, error: null });
      })
      .catch((error: unknown) => {
        if (current)
          setState({
            key,
            detail: null,
            error:
              error instanceof DetailReadError
                ? error.message
                : describeFailure(error, { action: "load job details" })
                    .userMessage,
          });
      });
    return () => {
      current = false;
    };
  }, [key, jobId, planId, retry]);
  const detail =
    state.key === key ? state.detail : key ? detailCache.peek(key) : null;
  // List workflow facts can advance without a body change. Keep those
  // current while reusing the same full evidence. The row carries only the
  // short form of the fit assessment, so the full one comes from the detail;
  // any change to it changes the detail revision and reloads the detail.
  const job:
    | (SavedJob & {
        listingActivity?: NonNullable<JobListRow["listingActivity"]>;
      })
    | null =
    detail && row
      ? {
          ...detail.job,
          ...row,
          matchAssessment: detail.job.matchAssessment,
          provenance: detail.job.provenance,
        }
      : null;
  return {
    job,
    error: state.key === key ? state.error : null,
    loading: Boolean(row && !job && !(state.key === key && state.error)),
    retry: () => setRetry((value) => value + 1),
  };
}
