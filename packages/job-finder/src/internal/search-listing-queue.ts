import {
  JobPostingSchema,
  SavedJobSchema,
  type SavedJob,
} from "@nestor/contracts";
import { fitPostingFingerprint } from "./fit-judgment";

/** A read owns listing facts, never changes made while the HTTP/AI waited. */
export function rebaseSearchListingRead(
  original: SavedJob,
  read: SavedJob,
  current: SavedJob,
): SavedJob {
  if (
    current.canonicalUrl !== original.canonicalUrl ||
    fitPostingFingerprint(current) !== fitPostingFingerprint(original)
  )
    return current;
  const changedFields = (before: object, after: object) => {
    const previous = new Map(Object.entries(before));
    return Object.fromEntries(
      Object.entries(after).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(previous.get(key)),
      ),
    );
  };
  return SavedJobSchema.parse({
    ...current,
    ...changedFields(
      JobPostingSchema.parse(original),
      JobPostingSchema.parse(read),
    ),
    provenance: current.provenance.map((entry) => {
      const matches = (other: SavedJob["provenance"][number]) =>
        other.targetId === entry.targetId &&
        other.listingUrl === entry.listingUrl;
      const before = original.provenance.find(matches);
      const after = read.provenance.find(matches);
      return before && after
        ? { ...entry, ...changedFields(before, after) }
        : entry;
    }),
  });
}

/** One bounded listing pass, fed by source checkpoints while they arrive. */
export function createSearchListingQueue(input: {
  maxJobs: number;
  getJob: (id: string) => SavedJob | undefined;
  canRead: (job: SavedJob) => boolean;
}) {
  const queued: string[] = [];
  const seen = new Set<string>();
  const pending = new Set<string>();
  const readers: Array<(job: SavedJob | undefined) => void> = [];
  let closed = false;
  const take = (): SavedJob | undefined => {
    for (;;) {
      const id = queued.shift();
      if (!id) return;
      const job = input.getJob(id);
      if (job && input.canRead(job)) return job;
      pending.delete(id);
    }
  };
  const wake = () => {
    while (readers.length > 0) {
      const job = take();
      if (!job && !closed) break;
      readers.shift()!(job);
    }
  };
  return {
    enqueue(ids: Iterable<string>): void {
      if (closed) return;
      for (const id of ids) {
        if (seen.size >= input.maxJobs) break;
        const job = input.getJob(id);
        if (pending.has(id) || !job || !input.canRead(job)) continue;
        const key = `${id}|${job.canonicalUrl}|${fitPostingFingerprint(job)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pending.add(id);
        queued.push(id);
      }
      wake();
    },
    next(): Promise<SavedJob | undefined> {
      const job = take();
      if (job || closed) return Promise.resolve(job);
      return new Promise((resolve) => readers.push(resolve));
    },
    complete(id: string): void {
      pending.delete(id);
    },
    isPending(id: string): boolean {
      return pending.has(id);
    },
    close(): void {
      closed = true;
      wake();
    },
    stop(): void {
      queued.length = 0;
      pending.clear();
      closed = true;
      wake();
    },
    get size(): number {
      return seen.size;
    },
  };
}
