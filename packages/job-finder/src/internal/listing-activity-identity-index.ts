import type { SavedJob } from "@nestor/contracts";
import { createSyncedJobIdentityIndex } from "./discovery-run-indexes";
import type { JobIdentityInput } from "./job-identity";
import { readSavedJobProjectionChanges } from "@nestor/db";

type ListingIdentity = JobIdentityInput & { id: string };
const fields = [
  "source",
  "sourceJobId",
  "canonicalUrl",
  "applicationUrl",
  "providerKey",
  "providerBoardToken",
  "providerIdentifier",
  "title",
  "seniority",
  "company",
  "location",
  "description",
  "postedAt",
  "postedAtText",
] as const;

/** Status/fit changes leave listing identity and cached ambiguity results alone. */
export function createListingActivityIdentityIndex() {
  const index = createSyncedJobIdentityIndex<ListingIdentity>((value) => value);
  const byRow = new WeakMap<SavedJob, ListingIdentity>();
  let previous = new Map<string, ListingIdentity>();
  let lastJobs: readonly SavedJob[] | null = null;
  let lastIdentities: readonly ListingIdentity[] | null = null;
  function select(jobs: readonly SavedJob[]) {
    if (lastJobs === jobs && lastIdentities) return lastIdentities;
    const changes = lastJobs
      ? readSavedJobProjectionChanges(lastJobs, jobs)
      : null;
    if (
      changes &&
      changes.removedIds.length === 0 &&
      lastIdentities &&
      changes.rows.every((job) => {
        const identity = previous.get(job.id);
        if (
          !identity ||
          !fields.every((field) => identity[field] === job[field])
        )
          return false;
        if (Object.isFrozen(job)) byRow.set(job, identity);
        return true;
      })
    ) {
      lastJobs = jobs;
      return lastIdentities;
    }
    const next = new Map<string, ListingIdentity>();
    const identities = jobs.map((job) => {
      const rowIdentity = Object.isFrozen(job) ? byRow.get(job) : undefined;
      if (rowIdentity) {
        next.set(job.id, rowIdentity);
        return rowIdentity;
      }
      const cached = previous.get(job.id);
      const identity =
        cached && fields.every((field) => cached[field] === job[field])
          ? cached
          : Object.freeze({
              id: job.id,
              source: job.source,
              sourceJobId: job.sourceJobId,
              canonicalUrl: job.canonicalUrl,
              applicationUrl: job.applicationUrl,
              providerKey: job.providerKey,
              providerBoardToken: job.providerBoardToken,
              providerIdentifier: job.providerIdentifier,
              title: job.title,
              seniority: job.seniority,
              company: job.company,
              location: job.location,
              description: job.description,
              postedAt: job.postedAt,
              postedAtText: job.postedAtText,
            });
      if (Object.isFrozen(job)) byRow.set(job, identity);
      next.set(job.id, identity);
      return identity;
    });
    previous = next;
    lastJobs = Object.isFrozen(jobs) ? jobs : null;
    lastIdentities = identities;
    return identities;
  }
  return {
    warm: (jobs: readonly SavedJob[]) => index.warm(select(jobs)),
    sync: (jobs: readonly SavedJob[]) => index.sync(select(jobs)),
  };
}
