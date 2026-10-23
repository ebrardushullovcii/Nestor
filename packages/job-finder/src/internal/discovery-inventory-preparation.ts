import type {
  DiscoveryCpuTask,
  DiscoveryCpuResult,
  SavedJob,
  DiscoveryInventoryPosting,
} from "@nestor/contracts";
import { yieldToEventLoop } from "@nestor/core";
import { preparePublicProviderFeed } from "./workspace-source-intelligence";
import {
  buildJobIdentityAliases,
  prepareListingContent,
  rememberPreparedListingContent,
  rememberPreparedJobIdentity,
} from "./job-identity";
import {
  createMatchAssessmentPostingFingerprint,
  rememberMatchAssessmentPostingFingerprint,
} from "./match-assessment-session";
import { createMatchAssessmentPostingInput } from "./match-assessment-posting-input";
import { getDiscoveryInventoryExecutor } from "./discovery-feed-executor";

export async function runDiscoveryCpuTask(
  task: DiscoveryCpuTask,
): Promise<DiscoveryCpuResult> {
  if (task.kind === "feed")
    return {
      kind: "feed",
      result: await preparePublicProviderFeed(task.input),
    };
  const result = [];
  for (const [position, posting] of task.postings.entries()) {
    if (position % 20 === 0) await yieldToEventLoop();
    const acrossSources = buildJobIdentityAliases({
      ...posting,
      matchAcrossSources: true,
    });
    result.push({
      postingFingerprint: createMatchAssessmentPostingFingerprint(posting),
      content: prepareListingContent(posting.description),
      aliases: {
        local: acrossSources.filter(
          (alias) => alias.kind !== "cross_source_listing_facts",
        ),
        acrossSources,
      },
    });
  }
  return { kind: "inventory", result };
}

/** Small messages keep serialization bounded; neither queue nor reader owns the inventory. */
export async function warmDiscoveryInventory(
  jobs: readonly SavedJob[],
  signal: AbortSignal,
): Promise<void> {
  const execute = getDiscoveryInventoryExecutor();
  if (!execute) return;
  const facts = (job: SavedJob): DiscoveryInventoryPosting => ({
    ...createMatchAssessmentPostingInput(job),
    source: job.source,
    sourceJobId: job.sourceJobId,
    canonicalUrl: job.canonicalUrl,
    applicationUrl: job.applicationUrl,
    providerKey: job.providerKey,
    providerBoardToken: job.providerBoardToken,
    providerIdentifier: job.providerIdentifier,
    postedAt: job.postedAt,
    postedAtText: job.postedAtText,
    alternateListingUrls: job.provenance.flatMap((entry) =>
      entry.listingUrl && entry.listingUrl !== job.canonicalUrl
        ? [entry.listingUrl]
        : [],
    ),
  });
  for (let start = 0; start < jobs.length; start += 100) {
    signal.throwIfAborted();
    await Promise.all(
      [0, 50].map(async (offset) => {
        const page = jobs.slice(start + offset, start + offset + 50);
        if (!page.length) return;
        const postings = page.map(facts);
        const prepared = await execute(postings, signal);
        signal.throwIfAborted();
        if (prepared.length !== page.length)
          throw new Error("Incomplete inventory preparation.");
        for (const [position, job] of page.entries()) {
          const row = prepared[position]!;
          rememberMatchAssessmentPostingFingerprint(
            job,
            row.postingFingerprint,
          );
          rememberPreparedListingContent(job.description, row.content);
        rememberPreparedJobIdentity(job, row.aliases, postings[position]);
        }
      }),
    );
  }
}
