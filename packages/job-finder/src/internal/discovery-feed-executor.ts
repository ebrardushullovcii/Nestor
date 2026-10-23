import type {
  DiscoveryFeedResult,
  DiscoveryFeedTask,
  JobPosting,
  DiscoveryInventoryPosting,
  DiscoveryInventoryPreparation,
} from "@nestor/contracts";

export type DiscoveryFeedExecutor = (
  task: DiscoveryFeedTask,
  signal?: AbortSignal,
) => Promise<DiscoveryFeedResult>;

let executor: DiscoveryFeedExecutor | null = null;
type DiscoveryInventoryExecutor = (
  postings: DiscoveryInventoryPosting[],
  signal?: AbortSignal,
) => Promise<DiscoveryInventoryPreparation[]>;
let inventoryExecutor: DiscoveryInventoryExecutor | null = null;
export function setDiscoveryInventoryExecutor(
  next: DiscoveryInventoryExecutor | null,
): void {
  inventoryExecutor = next;
}
export function getDiscoveryInventoryExecutor(): DiscoveryInventoryExecutor | null {
  return inventoryExecutor;
}
const preparedPostings = new WeakMap<JobPosting, JobPosting>();

export function rememberPreparedDiscoveryPosting(
  raw: JobPosting,
  prepared: JobPosting,
): void {
  preparedPostings.set(raw, prepared);
}

export function takePreparedDiscoveryPosting(
  raw: JobPosting,
): JobPosting | null {
  const prepared = preparedPostings.get(raw) ?? null;
  preparedPostings.delete(raw);
  return prepared;
}

export function carryPreparedDiscoveryPosting(
  before: JobPosting,
  after: JobPosting,
): JobPosting {
  const prepared = preparedPostings.get(before);
  if (prepared)
    preparedPostings.set(after, {
      ...prepared,
      searchRejection: after.searchRejection,
    });
  return after;
}

/** Desktop installs its bounded pool; other hosts retain the same pure reader. */
export function setDiscoveryFeedExecutor(next: DiscoveryFeedExecutor | null) {
  executor = next;
}

export function getDiscoveryFeedExecutor(): DiscoveryFeedExecutor | null {
  return executor;
}
