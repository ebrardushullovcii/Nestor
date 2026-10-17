import {
  JobSearchCampaignCollectionSchema,
  type JobPosting,
  type SavedJob,
} from "@nestor/contracts";

import { mergeDiscoveredPostings } from "./matching";
import { createDiscoveryProvenance } from "./workspace-discovery-ledger";
import type { WorkspaceServiceContext } from "./workspace-service-context";

/**
 * Jobs the assistant reads off a page the person lent it (ADR 0038).
 *
 * Collecting only reads: postings go into a conversation result set. Saving
 * the ones the person picked runs the same canonical merge discovery uses,
 * so a job already saved from a source is recognised (ADR 0030), and puts
 * the saved jobs in the active search plan. Nothing here applies to
 * anything or creates a saved search.
 */

export const ASSISTANT_PAGE_TARGET_ID = "assistant_page";

export async function extractJobsFromPageText(
  ctx: WorkspaceServiceContext,
  input: {
    pageText: string;
    pageUrl: string;
    pageType: "search_results" | "job_detail";
    maxJobs: number;
    signal?: AbortSignal;
  },
): Promise<JobPosting[]> {
  return ctx.aiClient.extractJobsFromPage({
    pageText: input.pageText,
    pageUrl: input.pageUrl,
    pageType: input.pageType,
    maxJobs: input.maxJobs,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export async function saveJobsFromPage(
  ctx: WorkspaceServiceContext,
  input: {
    postings: readonly JobPosting[];
    pageUrl: string;
    applyOnThisPage?: boolean;
  },
): Promise<{
  savedJobIds: string[];
  newJobIds: string[];
  mergedJobIds: string[];
}> {
  if (input.postings.length === 0) {
    return { savedJobIds: [], newJobIds: [], mergedJobIds: [] };
  }
  const [profile, searchPreferences, savedJobs] = await Promise.all([
    ctx.repository.getProfile(),
    ctx.repository.getSearchPreferences(),
    ctx.repository.listSavedJobs(),
  ]);
  const activeCampaignId = await ctx.getActiveCampaignId();
  const now = new Date().toISOString();
  const result = mergeDiscoveredPostings(
    profile,
    searchPreferences,
    savedJobs,
    input.postings,
    (posting) =>
      createDiscoveryProvenance({
        targetId: ASSISTANT_PAGE_TARGET_ID,
        adapterKind: "auto",
        resolvedAdapterKind: "target_site",
        startingUrl: input.pageUrl,
        discoveredAt: now,
        collectionMethod: "listing_route",
        providerKey: posting.providerKey,
        providerBoardToken: posting.providerBoardToken,
        titleTriageOutcome: posting.titleTriageOutcome,
        listingUrl: posting.canonicalUrl,
        applicationUrl: posting.applicationUrl,
        sourceJobId: posting.sourceJobId,
        applyPath: posting.applyPath,
      }),
  );
  const newIds = new Set(result.newJobs.map((job) => job.id));
  // A posting that matched a saved job keeps that job's id and gains this
  // sighting. A saved job that only shares a source id with a posting the
  // merge kept apart was not touched and is not reported as saved.
  const affected: SavedJob[] = result.mergedJobs.filter(
    (job) =>
      newIds.has(job.id) ||
      job.provenance.some(
        (entry) =>
          entry.targetId === ASSISTANT_PAGE_TARGET_ID &&
          entry.discoveredAt === now,
      ),
  );
  // A page listing that matches a job already saved only records that it
  // was seen there. The saved job keeps its company, title, status and the
  // person's triage: a site's brand name or an older copy of the listing
  // must not overwrite them, and a skipped job must not come back.
  const existingById = new Map(savedJobs.map((job) => [job.id, job]));
  const preserved = affected.map((job) => {
    const existing = existingById.get(job.id);
    if (!existing) return job;
    const seen = new Set(
      existing.provenance.map((entry) => JSON.stringify(entry)),
    );
    // "Apply on this link" is the person choosing where to apply: the same
    // job saved from another site applies on this page's own form.
    const chosenApplicationUrl =
      input.applyOnThisPage && input.postings.length === 1
        ? (input.postings[0]?.applicationUrl ?? input.pageUrl)
        : null;
    return {
      ...existing,
      ...(chosenApplicationUrl ? { applicationUrl: chosenApplicationUrl } : {}),
      provenance: [
        ...existing.provenance,
        ...job.provenance.filter((entry) => !seen.has(JSON.stringify(entry))),
      ],
      lastSeenAt: job.lastSeenAt ?? existing.lastSeenAt,
    };
  });
  const withCampaign = preserved.map((job) =>
    activeCampaignId && !(job.campaignIds ?? []).includes(activeCampaignId)
      ? { ...job, campaignIds: [...(job.campaignIds ?? []), activeCampaignId] }
      : job,
  );
  await ctx.repository.commitSavedJobDelta({ upserts: withCampaign });
  if (activeCampaignId) {
    await ctx.withCampaignTransition(async () => {
      const state = await ctx.repository.getCampaignState();
      if (!state) return;
      await ctx.repository.saveCampaignState(
        JobSearchCampaignCollectionSchema.parse({
          ...state,
          campaigns: state.campaigns.map((campaign) =>
            campaign.id === activeCampaignId
              ? {
                  ...campaign,
                  jobIds: [
                    ...new Set([
                      ...campaign.jobIds,
                      ...withCampaign.map((job) => job.id),
                    ]),
                  ],
                }
              : campaign,
          ),
        }),
      );
    });
  }
  return {
    savedJobIds: withCampaign.map((job) => job.id),
    newJobIds: [...newIds],
    mergedJobIds: withCampaign
      .map((job) => job.id)
      .filter((id) => !newIds.has(id)),
  };
}
