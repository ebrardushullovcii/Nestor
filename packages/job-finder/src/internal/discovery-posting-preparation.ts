import {
  extractSalaryRangeFromListingBody,
  readDiscoveryPreparation,
  readPreparedBodySalaryRange,
  writeDiscoveryPreparation,
  type JobPosting,
} from "@nestor/contracts";
import {
  prepareJobIdentity,
  prepareListingContent,
  rememberPreparedListingContent,
} from "./job-identity";
import { createDiscoveryListingFingerprints } from "./workspace-discovery-ledger";

/** Call at creation; unchanged copies carry the same prepared facts. */
export function prepareDiscoveryPosting<T extends JobPosting>(
  posting: T,
  textSource?: JobPosting,
): T {
  let salaryRange = readPreparedBodySalaryRange(posting);
  if (readDiscoveryPreparation(posting)?.normalizedPosting)
    writeDiscoveryPreparation(posting, {
      normalizedPosting: undefined,
      normalizedPostingSource: undefined,
    });
  let content = readDiscoveryPreparation(posting)?.content;
  const needsContent = !content || content.description !== posting.description;
  const sourcePreparation = textSource
    ? readDiscoveryPreparation(textSource)
    : undefined;
  if (
    textSource &&
    (sourcePreparation?.content ||
      sourcePreparation?.bodySalaryRange !== undefined) &&
    (needsContent || salaryRange === undefined) &&
    textSource.description === posting.description
  ) {
    if (
      needsContent &&
      sourcePreparation?.content?.description === posting.description
    ) {
      content = sourcePreparation.content;
      writeDiscoveryPreparation(posting, { content });
    }
    if (salaryRange === undefined)
      salaryRange = readPreparedBodySalaryRange(textSource);
  }
  if (!content || content.description !== posting.description)
    rememberPreparedListingContent(
      posting,
      prepareListingContent(posting.description),
    );
  prepareJobIdentity(posting);
  createDiscoveryListingFingerprints(posting);
  if (salaryRange !== undefined)
    rememberPreparedBodySalaryRange(posting, salaryRange);
  else prepareBodySalaryRange(posting);
  return posting;
}

export function rememberPreparedBodySalaryRange(
  posting: JobPosting,
  bodySalaryRange: ReturnType<typeof extractSalaryRangeFromListingBody>,
): void {
  writeDiscoveryPreparation(posting, { bodySalaryRange });
}

export function prepareBodySalaryRange(
  posting: JobPosting,
): ReturnType<typeof extractSalaryRangeFromListingBody> {
  const carried = readPreparedBodySalaryRange(posting);
  if (carried !== undefined) return carried;
  const value = extractSalaryRangeFromListingBody(posting.description);
  createDiscoveryListingFingerprints(posting);
  rememberPreparedBodySalaryRange(posting, value);
  return value;
}
