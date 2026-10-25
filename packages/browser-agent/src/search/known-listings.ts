import type { KnownJobUrlLookup } from "@nestor/contracts";

/** Preserve identity-bearing queries and path case; only fragments are local. */
export function postingUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.href;
  } catch {
    return url;
  }
}

export async function onlyNewJobs<T extends { canonicalUrl: string }>(
  jobs: readonly T[],
  lookup?: KnownJobUrlLookup,
): Promise<T[]> {
  if (!lookup || !jobs.length) return [...jobs];
  const known = new Set(
    (await lookup(jobs.map((job) => job.canonicalUrl))).map(postingUrlKey),
  );
  return jobs.filter((job) => !known.has(postingUrlKey(job.canonicalUrl)));
}

/** Omit whole semantic HTML items only when every link in that item is saved. */
export async function omitKnownListingItems(
  text: string,
  lookup: KnownJobUrlLookup,
): Promise<{ text: string; skippedUrls: string[] }> {
  const items = [
    ...text.matchAll(/\[Page item (\d+)\]\n[\s\S]*?\[End page item \1\]/gu),
  ];
  const links = (item: string) =>
    [...item.matchAll(/→ (https?:\/\/[^\s<>]+)/gu)].flatMap(([, url]) =>
      url ? [url] : [],
    );
  const urls = [...new Set(items.flatMap((item) => links(item[0])))];
  if (!urls.length) return { text, skippedUrls: [] };
  const requested = new Set(urls.map(postingUrlKey));
  const known = new Set(
    (await lookup(urls)).map(postingUrlKey).filter((url) => requested.has(url)),
  );
  const skipped = new Set<string>();
  let output = "";
  let end = 0;
  for (const item of items) {
    output += text.slice(end, item.index);
    const itemUrls = links(item[0]);
    if (
      itemUrls.length &&
      itemUrls.every((url) => known.has(postingUrlKey(url)))
    ) {
      itemUrls.forEach((url) => skipped.add(url));
    } else {
      output += item[0];
    }
    end = item.index + item[0].length;
  }
  return { text: output + text.slice(end), skippedUrls: [...skipped] };
}
