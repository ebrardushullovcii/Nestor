import type { JobPosting } from "@nestor/contracts";
import type { AgentConfig, AgentResult } from "../types";
import { onlyNewJobs } from "./known-listings";

/** Session-local, bounded reuse of model judgments after a fresh complete feed read. */
export function createSearchResultCache(maxEntries = 24) {
  const entries = new Map<string, { inventory: string; result: AgentResult }>();
  const keyFor = (config: AgentConfig) =>
    JSON.stringify({
      source: config.source,
      inventoryOnly: config.inventoryOnly === true,
      urls: config.startingUrls,
      profile: config.userProfile,
      preferences: config.searchPreferences,
      prompt: config.promptContext,
      retainAllFound: config.retainAllFound,
      targetJobCount: config.targetJobCount,
    });
  const inventoryFor = (jobs: readonly JobPosting[]) =>
    JSON.stringify(
      jobs
        .map((job) => {
          // Collection timestamps change on every fetch; actual posting facts do not.
          return {
            ...job,
            discoveredAt: undefined,
            firstSeenAt: undefined,
            lastSeenAt: undefined,
            lastVerifiedActiveAt: undefined,
          };
        })
        .sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl)),
    );
  return {
    read(config: AgentConfig, completeIndex?: string): AgentResult | null {
      if (
        (!(config.sourceCatalogComplete && config.sourceCatalog) &&
          !(!config.sourceCatalog && completeIndex)) ||
        config.promptContext.taskPacket ||
        config.resumeCheckpoint ||
        config.promptContext.searchRequest?.freshness === "recent"
      )
        return null;
      const key = keyFor(config);
      const cached = entries.get(key);
      const inventory =
        config.sourceCatalogComplete && config.sourceCatalog
          ? `feed:${inventoryFor(config.sourceCatalog)}`
          : `index:${completeIndex}`;
      if (!cached || cached.inventory !== inventory) return null;
      entries.delete(key);
      entries.set(key, cached);
      const result = structuredClone(cached.result);
      const latest = new Map(
        (config.sourceCatalog ?? []).map((job) => [job.canonicalUrl, job]),
      );
      result.jobs = result.jobs.map((job) => {
        const fresh = latest.get(job.canonicalUrl);
        return fresh
          ? {
              ...job,
              discoveredAt: fresh.discoveredAt,
              firstSeenAt: fresh.firstSeenAt,
              lastSeenAt: fresh.lastSeenAt,
              lastVerifiedActiveAt: fresh.lastVerifiedActiveAt,
            }
          : job;
      });
      return result;
    },
    write(
      config: AgentConfig,
      result: AgentResult,
      completeIndex?: string,
    ): void {
      if (
        (!(config.sourceCatalogComplete && config.sourceCatalog) &&
          !(!config.sourceCatalog && completeIndex)) ||
        config.promptContext.taskPacket ||
        config.resumeCheckpoint ||
        result.incomplete ||
        result.error ||
        result.accessBlockerReason
      )
        return;
      const key = keyFor(config);
      entries.delete(key);
      const entry = {
        inventory:
          config.sourceCatalogComplete && config.sourceCatalog
            ? `feed:${inventoryFor(config.sourceCatalog)}`
            : `index:${completeIndex}`,
        result: structuredClone(result),
      };
      if (key.length + JSON.stringify(entry).length > 2_000_000) return;
      entries.set(key, entry);
      // Cap retained data as well as entry count on the shared laptop.
      while (
        [...entries].reduce(
          (size, [entryKey, value]) =>
            size + entryKey.length + JSON.stringify(value).length,
          0,
        ) > 8_000_000
      )
        entries.delete(entries.keys().next().value!);
      while (entries.size > maxEntries)
        entries.delete(entries.keys().next().value!);
    },
  };
}
export type SearchResultCache = ReturnType<typeof createSearchResultCache>;

export async function readCachedSearchResult(
  cache: SearchResultCache | undefined,
  config: AgentConfig,
  completeIndex?: string,
): Promise<AgentResult | null> {
  const result = cache?.read(config, completeIndex) ?? null;
  if (result)
    result.jobs = await onlyNewJobs(result.jobs, config.lookupKnownUrls);
  return result;
}
