import type { JobFinderRendererWorkspaceSnapshot } from "@nestor/contracts";

type DiscoveryJobs = Readonly<JobFinderRendererWorkspaceSnapshot["discoveryJobs"]>;
type ReviewQueue = Readonly<JobFinderRendererWorkspaceSnapshot["reviewQueue"]>;
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
