import {
  readDiscoveryPreparation,
  writeDiscoveryPreparation,
  type DiscoveryFeedResult,
  type DiscoveryFeedTask,
  type JobPosting,
} from "@nestor/contracts";

export type DiscoveryFeedExecutor = (
  task: DiscoveryFeedTask,
  signal?: AbortSignal,
) => Promise<DiscoveryFeedResult>;

let executor: DiscoveryFeedExecutor | null = null;

export function rememberPreparedDiscoveryPosting(
  raw: JobPosting,
  prepared: JobPosting,
): void {
  writeDiscoveryPreparation(raw, { normalizedPosting: prepared });
}

export function takePreparedDiscoveryPosting(
  raw: JobPosting,
): JobPosting | null {
  return readDiscoveryPreparation(raw)?.normalizedPosting ?? null;
}

export function carryPreparedDiscoveryPosting(
  before: JobPosting,
  after: JobPosting,
): JobPosting {
  const prepared = readDiscoveryPreparation(before)?.normalizedPosting;
  if (prepared)
    writeDiscoveryPreparation(after, {
      normalizedPosting: {
        ...prepared,
        searchRejection: after.searchRejection,
      },
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
