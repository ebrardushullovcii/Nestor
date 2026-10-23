import type { DiscoveryLedgerEntry, SavedJob } from "@nestor/contracts";
import { buildJobIdentityAliases, hasSameJobIdentity } from "./job-identity";
import {
  inactiveListingLedger,
  type projectDiscoveryJobViews,
} from "./listing-activity";

/** Identity edits can change another row's inactive evidence through ambiguity. */
export function createListingActivityChangeResolver(
  index: NonNullable<
    Parameters<typeof projectDiscoveryJobViews>[0]["identityIndex"]
  >,
) {
  let previous = new Set<DiscoveryLedgerEntry>();
  const byAlias = new Map<string, Set<DiscoveryLedgerEntry>>();
  return (input: {
    beforeJobs: readonly SavedJob[];
    jobs: readonly SavedJob[];
    beforeById: ReadonlyMap<string, SavedJob>;
    changed: readonly SavedJob[];
    removed: readonly SavedJob[];
    beforeLedger: readonly DiscoveryLedgerEntry[];
    ledger: readonly DiscoveryLedgerEntry[];
  }): Set<string> => {
    const before = inactiveListingLedger(input.beforeLedger);
    const current = inactiveListingLedger(input.ledger);
    const identityChanges = input.changed.filter((row) => {
      const old = input.beforeById.get(row.id);
      return !old || !hasSameJobIdentity(old, row);
    });
    const affected = new Set<DiscoveryLedgerEntry>();
    if (before !== current) {
      const oldSet = new Set(before),
        newSet = new Set(current);
      for (const row of before) if (!newSet.has(row)) affected.add(row);
      for (const row of current) if (!oldSet.has(row)) affected.add(row);
    }
    if (identityChanges.length > 0 || input.removed.length > 0) {
      const present = new Set(current);
      for (const row of previous)
        if (!present.has(row))
          for (const alias of buildJobIdentityAliases(row)) {
            const rows = byAlias.get(alias.key);
            rows?.delete(row);
            if (rows?.size === 0) byAlias.delete(alias.key);
          }
      for (const row of current)
        if (!previous.has(row))
          for (const alias of buildJobIdentityAliases(row)) {
            let rows = byAlias.get(alias.key);
            if (!rows) byAlias.set(alias.key, (rows = new Set()));
            rows.add(row);
          }
      previous = present;
      const changedIdentities = [
        ...identityChanges,
        ...identityChanges.flatMap((row) => {
          const old = input.beforeById.get(row.id);
          return old ? [old] : [];
        }),
        ...input.removed,
      ];
      for (const row of changedIdentities)
        for (const alias of buildJobIdentityAliases(row))
          for (const entry of byAlias.get(alias.key) ?? []) affected.add(entry);
    }
    const ids = new Set<string>();
    if (affected.size === 0) return ids;
    const resolve = (jobs: readonly SavedJob[]) => {
      const identities = index.sync(jobs);
      for (const row of affected) {
        const match = identities.resolve(row);
        if (match.status === "matched") ids.add(match.value.id);
      }
    };
    if (identityChanges.length > 0 || input.removed.length > 0)
      resolve(input.beforeJobs);
    resolve(input.jobs);
    return ids;
  };
}
