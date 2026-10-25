import type { SavedJob } from "@nestor/contracts";
import type { PreparedListingRead } from "./listing-detail-enrichment";

/** Run-local page facts. Preparing a read never changes the working jobs. */
export function createSearchListingReadAhead(input: {
  maxJobs: number;
  getJob: (id: string) => SavedJob | undefined;
  canRead: (job: SavedJob) => boolean;
}) {
  const queue: Array<{ id: string; key: string }> = [];
  const seen = new Set<string>();
  const prepared = new Map<string, PreparedListingRead>();
  const readers: Array<(job: SavedJob | undefined) => void> = [];
  let closed = false;
  let stopped = false;
  let readsStarted = 0;
  const key = (job: SavedJob) =>
    JSON.stringify([job.id, job.canonicalUrl, job.title]);
  const take = (): SavedJob | undefined => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      const job = input.getJob(entry.id);
      if (job && key(job) === entry.key && input.canRead(job)) {
        readsStarted += 1;
        return job;
      }
    }
    return undefined;
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
        if (!job || !input.canRead(job) || seen.has(key(job))) continue;
        seen.add(key(job));
        queue.push({ id, key: key(job) });
      }
      wake();
    },
    next(): Promise<SavedJob | undefined> {
      const job = take();
      if (job || closed) return Promise.resolve(job);
      return new Promise((resolve) => readers.push(resolve));
    },
    record(job: SavedJob, read: PreparedListingRead): void {
      if (!stopped) prepared.set(key(job), read);
    },
    read(job: SavedJob): PreparedListingRead | undefined {
      return prepared.get(key(job));
    },
    close(): void {
      closed = true;
      wake();
    },
    stop(): void {
      stopped = true;
      queue.length = 0;
      closed = true;
      wake();
      prepared.clear();
    },
    get readsStarted(): number {
      return readsStarted;
    },
  };
}
