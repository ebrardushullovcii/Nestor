import { matchesCollectionSearch } from "../components/collection-search-toolbar";

export type JobFinderGlobalSearchKind = "application" | "job" | "screen";

export interface JobFinderGlobalSearchEntry {
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
];

/**
 * Groups the entries matching `query`, in kind order. `found` holds entries
 * another search already matched (the job store's own text search), so
 * they are kept as they are.
 */
export function searchJobFinderEntries(
  entries: readonly JobFinderGlobalSearchEntry[],
  query: string,
  options: {
    found?: readonly JobFinderGlobalSearchEntry[];
    limit?: number;
  } = {},
): readonly JobFinderGlobalSearchGroup[] {
  const limit = Math.max(1, Math.min(options.limit ?? 40, 200));
  const matches = [
    ...entries.filter((entry) =>
      matchesCollectionSearch(query, [
        entry.title,
        entry.subtitle,
        entry.kind,
        ...entry.metadata,
      ]),
    ),
    ...(options.found ?? []),
  ];

  // Reserve one place for each matching kind so many results of one kind
  // cannot hide every result of the others.
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
