import type { SavedJob } from "@nestor/contracts";
import { createSyncedJobIdentityIndex } from "./discovery-run-indexes";
import type { JobIdentityInput } from "./job-identity";

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
  return {
    sync(jobs: readonly SavedJob[]) {
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
      return index.sync(identities);
    },
  };
}
