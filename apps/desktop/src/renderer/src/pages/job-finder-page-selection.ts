import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

type DiscoveryJobs = Readonly<JobFinderRendererWorkspaceSnapshot["discoveryJobs"]>;
type ReviewQueue = Readonly<JobFinderRendererWorkspaceSnapshot["reviewQueue"]>;
type ApplicationRecords = Readonly<
  JobFinderRendererWorkspaceSnapshot["applicationRecords"]
>;
type ApplicationAttempts = Readonly<
  JobFinderRendererWorkspaceSnapshot["applicationAttempts"]
>;
type TailoredAssets = Readonly<JobFinderRendererWorkspaceSnapshot["tailoredAssets"]>;

// Workspace deltas retain unchanged collection references. Key by those
// collections, not the enclosing snapshot or a selected ID: local navigation
// and route remounts can reuse the index, and retired collections can be GC'd.
const discoveryIndexes = new WeakMap<
  DiscoveryJobs,
  {
    jobsById: ReadonlyMap<string, DiscoveryJobs[number]>;
    validIds: ReadonlySet<string>;
  }
>();
const reviewIndexes = new WeakMap<
  ReviewQueue,
  {
    itemsByJobId: ReadonlyMap<string, ReviewQueue[number]>;
    validIds: ReadonlySet<string>;
  }
>();
const applicationRecordIndexes = new WeakMap<
  ApplicationRecords,
  ReadonlyMap<string, ApplicationRecords[number]>
>();
const applicationAttemptIndexes = new WeakMap<
  ApplicationAttempts,
  ReadonlyMap<string, ApplicationAttempts[number]>
>();
const tailoredAssetIndexes = new WeakMap<
  TailoredAssets,
  ReadonlyMap<string, TailoredAssets[number]>
>();

export function getDiscoverySelectionIndex(jobs: DiscoveryJobs) {
  const cached = discoveryIndexes.get(jobs);
  if (cached) return cached;

  const jobsById = new Map<string, DiscoveryJobs[number]>();
  for (const job of jobs) jobsById.set(job.id, job);
  const index = { jobsById, validIds: new Set(jobsById.keys()) };
  discoveryIndexes.set(jobs, index);
  return index;
}

export function getReviewSelectionIndex(items: ReviewQueue) {
  const cached = reviewIndexes.get(items);
  if (cached) return cached;

  const itemsByJobId = new Map<string, ReviewQueue[number]>();
  for (const item of items) {
    // Preserve Array.find's first-match behavior if a legacy queue repeats ID.
    if (!itemsByJobId.has(item.jobId)) itemsByJobId.set(item.jobId, item);
  }
  const index = { itemsByJobId, validIds: new Set(itemsByJobId.keys()) };
  reviewIndexes.set(items, index);
  return index;
}

export function getApplicationRecordIndex(records: ApplicationRecords) {
  const cached = applicationRecordIndexes.get(records);
  if (cached) return cached;

  const recordsById = new Map<string, ApplicationRecords[number]>();
  for (const record of records) {
    if (!recordsById.has(record.id)) recordsById.set(record.id, record);
  }
  applicationRecordIndexes.set(records, recordsById);
  return recordsById;
}

export function getLatestApplicationAttemptIndex(
  attempts: ApplicationAttempts,
) {
  const cached = applicationAttemptIndexes.get(attempts);
  if (cached) return cached;

  const latestByRecordId = new Map<string, ApplicationAttempts[number]>();
  const updatedAtByRecordId = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.applicationRecordId === null) continue;
    const updatedAt = Date.parse(attempt.updatedAt);
    const previous =
      updatedAtByRecordId.get(attempt.applicationRecordId) ??
      Number.NEGATIVE_INFINITY;
    // Equal timestamps keep the first attempt, and invalid timestamps are
    // ignored, just like the previous selected-record scan.
    if (updatedAt > previous) {
      latestByRecordId.set(attempt.applicationRecordId, attempt);
      updatedAtByRecordId.set(attempt.applicationRecordId, updatedAt);
    }
  }
  applicationAttemptIndexes.set(attempts, latestByRecordId);
  return latestByRecordId;
}

export function getTailoredAssetIndex(assets: TailoredAssets) {
  const cached = tailoredAssetIndexes.get(assets);
  if (cached) return cached;

  const assetsById = new Map<string, TailoredAssets[number]>();
  for (const asset of assets) {
    if (!assetsById.has(asset.id)) assetsById.set(asset.id, asset);
  }
  tailoredAssetIndexes.set(assets, assetsById);
  return assetsById;
}
