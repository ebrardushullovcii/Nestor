import { readDiscoveryPreparation, type JobPosting } from "@nestor/contracts";
import {
  prepareJobIdentity,
  prepareListingContent,
  rememberPreparedListingContent,
} from "./job-identity";
import { createDiscoveryListingFingerprints } from "./workspace-discovery-ledger";

/** Call at creation; unchanged copies carry the same prepared facts. */
export function prepareDiscoveryPosting<T extends JobPosting>(posting: T): T {
  const content = readDiscoveryPreparation(posting)?.content;
  if (!content || content.description !== posting.description)
    rememberPreparedListingContent(
      posting,
      prepareListingContent(posting.description),
    );
  prepareJobIdentity(posting);
  createDiscoveryListingFingerprints(posting);
  return posting;
}
