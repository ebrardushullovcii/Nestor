import { matchesCollectionSearch } from "../components/collection-search-toolbar";

export type JobFinderGlobalSearchKind =
  | "application"
  | "company"
  | "document"
  | "job"
  | "screen";

export interface JobFinderGlobalSearchEntry {
  campaignId?: string | null;
  href: string;
  id: string;
  kind: JobFinderGlobalSearchKind;
  metadata: readonly string[];
  subtitle: string;
  title: string;
}

export interface JobFinderGlobalSearchGroup {
  entries: readonly JobFinderGlobalSearchEntry[];
  kind: JobFinderGlobalSearchKind;
}

const kindOrder: readonly JobFinderGlobalSearchKind[] = [
  "screen",
  "job",
  "application",
  "company",
  "document",
];

export function searchJobFinderEntries(
  entries: readonly JobFinderGlobalSearchEntry[],
  query: string,
  options: { campaignId?: string | null; limit?: number } = {},
): readonly JobFinderGlobalSearchGroup[] {
  const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
  const matches = entries.filter(
    (entry) =>
      // Screens belong to no plan; they are found under any plan.
      (!options.campaignId ||
        entry.kind === "screen" ||
        entry.campaignId === options.campaignId) &&
      matchesCollectionSearch(query, [
        entry.title,
        entry.subtitle,
        entry.kind,
        ...entry.metadata,
      ]),
  );

  // Jobs are built before applications and resumes. Reserve one place for
  // each matching kind so a large job collection cannot hide every result
  // from the other parts of the workspace.
  const selected = new Set<JobFinderGlobalSearchEntry>();
  if (matches[0]) selected.add(matches[0]);
  for (const kind of kindOrder) {
    const first = matches.find((entry) => entry.kind === kind);
    if (first && selected.size < limit) selected.add(first);
  }
  for (const entry of matches) {
    if (selected.size >= limit) break;
    selected.add(entry);
  }

  return kindOrder.flatMap((kind) => {
    const groupedEntries = matches.filter(
      (entry) => entry.kind === kind && selected.has(entry),
    );
    return groupedEntries.length > 0 ? [{ entries: groupedEntries, kind }] : [];
  });
}
