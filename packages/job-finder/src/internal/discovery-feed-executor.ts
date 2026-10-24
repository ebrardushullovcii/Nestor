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
  writeDiscoveryPreparation(raw, {
    normalizedPosting: prepared,
    normalizedPostingSource: raw,
  });
}

export function takePreparedDiscoveryPosting(
  raw: JobPosting,
): JobPosting | null {
  const preparation = readDiscoveryPreparation(raw);
  return Object.isFrozen(raw) && preparation?.normalizedPostingSource === raw
    ? (preparation.normalizedPosting ?? null)
    : null;
}

export function carryPreparedDiscoveryPosting(
  before: JobPosting,
  after: JobPosting,
): JobPosting {
  const prepared = takePreparedDiscoveryPosting(before);
  if (
    prepared &&
    [...new Set([...Object.keys(before), ...Object.keys(after)])].every(
      (key) =>
        key === "searchRejection" ||
        Reflect.get(before, key) === Reflect.get(after, key),
    )
  ) {
    rememberPreparedDiscoveryPosting(after, {
      ...prepared,
      searchRejection: after.searchRejection,
    });
    Object.freeze(after);
  } else if (readDiscoveryPreparation(after)?.normalizedPosting)
    writeDiscoveryPreparation(after, {
      normalizedPosting: undefined,
      normalizedPostingSource: undefined,
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
