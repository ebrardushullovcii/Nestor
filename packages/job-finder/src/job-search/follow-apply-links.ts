import type {
  FoundJob,
  ReadDiscoveryPostingPage,
  ReadListingResult,
} from "@nestor/contracts";

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/**
 * A board often gives its own address as a listing's apply link, one that
 * redirects to the employer's form (Working Nomads' /job/go/…, arbeitnow's
 * …/apply). Each such link is followed once, through the reader's per-host
 * pacing, and the employer page it lands on is stored as the apply link, so
 * the employer's form ties one posting together across boards. A link that
 * stays on the board is kept as it was. Either way the listing records that
 * its link was followed, so a later search does not read it again for this.
 */
export async function followBoardApplyLinks(
  result: ReadListingResult,
  readPage: ReadDiscoveryPostingPage,
  signal: AbortSignal | undefined,
): Promise<ReadListingResult> {
  const landings = new Map<string, Promise<string | null>>();
  const land = (url: string) => {
    let landing = landings.get(url);
    if (!landing) {
      landing = readPage(url, { signal, landingOnly: true }).then(
        (page) => page.finalUrl,
        () => {
          signal?.throwIfAborted();
          // Not answered: the next search follows it again.
          return null;
        },
      );
      landings.set(url, landing);
    }
    return landing;
  };
  const jobs = await Promise.all(
    result.jobs.map(async (job): Promise<FoundJob> => {
      const board = hostOf(job.url);
      if (
        !job.applyUrl ||
        job.applyUrl === job.url ||
        !board ||
        hostOf(job.applyUrl) !== board
      )
        return job;
      const landed = await land(job.applyUrl);
      if (landed === null) return job;
      const host = hostOf(landed);
      return {
        ...job,
        ...(host && host !== board ? { applyUrl: landed } : {}),
        facts: { ...job.facts, applyLinkFollowed: true },
      };
    }),
  );
  return { ...result, jobs };
}
