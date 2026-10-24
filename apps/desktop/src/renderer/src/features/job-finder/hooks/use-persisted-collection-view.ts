import { useEffect, useState } from "react";
import type { CollectionDensity } from "../components/collection-search-toolbar";

export interface PersistedCollectionView {
  density: CollectionDensity;
  query: string;
  savedViews: readonly SavedCollectionView[];
}

/**
 * Optional serializable payload a collection can attach to a named view.
 * Deliberately domain-agnostic: a flat record of string-list facts the
 * owning collection knows how to interpret (Discovery stores its facet
 * selections here). Bounds keep every stored view small.
 */
export type SavedViewMetadata = Readonly<Record<string, readonly string[]>>;

export interface SavedCollectionView {
  density: CollectionDensity;
  id: string;
  metadata?: SavedViewMetadata;
  name: string;
  query: string;
}

const MAX_SAVED_VIEW_METADATA_KEYS = 8;
const MAX_SAVED_VIEW_METADATA_VALUES = 24;
const MAX_SAVED_VIEW_METADATA_VALUE_LENGTH = 200;

function readSavedViewMetadata(value: unknown): SavedViewMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_SAVED_VIEW_METADATA_KEYS)
    .flatMap((entry) => {
      const [key, values] = entry;
      if (!Array.isArray(values)) return [];
      // Empty lists are kept: capturing a cleared facet is meaningful.
      const clean = values
        .filter(
          (entryValue): entryValue is string => typeof entryValue === "string",
        )
        .map((entryValue) =>
          entryValue.slice(0, MAX_SAVED_VIEW_METADATA_VALUE_LENGTH),
        )
        .slice(0, MAX_SAVED_VIEW_METADATA_VALUES);
      return [[key, clean] as const];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isCollectionDensity(value: unknown): value is CollectionDensity {
  return value === "compact" || value === "comfortable" || value === "detailed";
}

/** The search text a collection reopens with, without mounting it. */
export function readPersistedCollectionQuery(name: string): string {
  return readCollectionView(
    `nestor.job-finder.collection.${name}.v1`,
    "comfortable",
  ).query;
}

function readCollectionView(
  storageKey: string,
  defaultDensity: CollectionDensity,
): PersistedCollectionView {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return { density: defaultDensity, query: "", savedViews: [] };
    const parsed = JSON.parse(raw) as {
      density?: unknown;
      query?: unknown;
      savedViews?: unknown;
    };
    const savedViews = Array.isArray(parsed.savedViews)
      ? parsed.savedViews
          .flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const candidate = value as Record<string, unknown>;
            if (
              typeof candidate.id !== "string" ||
              typeof candidate.name !== "string" ||
              typeof candidate.query !== "string" ||
              !isCollectionDensity(candidate.density)
            ) {
              return [];
            }
            const metadata = readSavedViewMetadata(candidate.metadata);
            return [
              {
                density: candidate.density,
                id: candidate.id.slice(0, 80),
                name: candidate.name.slice(0, 60),
                query: candidate.query.slice(0, 200),
                ...(metadata ? { metadata } : {}),
              },
            ];
          })
          .slice(0, 12)
      : [];
    return {
      density: isCollectionDensity(parsed.density)
        ? parsed.density
        : defaultDensity,
      query: typeof parsed.query === "string" ? parsed.query.slice(0, 200) : "",
      savedViews,
    };
  } catch {
    return { density: defaultDensity, query: "", savedViews: [] };
  }
}

export function usePersistedCollectionView(
  name: string,
  defaultDensity: CollectionDensity = "comfortable",
) {
  const storageKey = `nestor.job-finder.collection.${name}.v1`;
  const [view, setView] = useState<PersistedCollectionView>(() =>
    readCollectionView(storageKey, defaultDensity),
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(view));
    } catch {
      // The list still works when durable renderer preferences are unavailable.
    }
  }, [storageKey, view]);

  return {
    density: view.density,
    query: view.query,
    savedViews: view.savedViews,
    applySavedView: (id: string): SavedViewMetadata | undefined => {
      const saved = view.savedViews.find((candidate) => candidate.id === id);
      if (!saved) return undefined;
      setView((current) => {
        const applied = current.savedViews.find(
          (candidate) => candidate.id === id,
        );
        return applied
          ? { ...current, density: applied.density, query: applied.query }
          : current;
      });
      // Callers restore their own domain state from this payload; callers
      // that ignore it keep the previous query/density-only behavior.
      return saved.metadata;
    },
    deleteSavedView: (id: string) =>
      setView((current) => ({
        ...current,
        savedViews: current.savedViews.filter(
          (candidate) => candidate.id !== id,
        ),
      })),
    saveCurrentView: (name: string, metadata?: SavedViewMetadata) =>
      setView((current) => {
        const trimmedName = name.trim().slice(0, 60);
        if (!trimmedName) return current;
        const id =
          trimmedName.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-") || "view";
        const cleanedMetadata = readSavedViewMetadata(metadata);
        const savedView: SavedCollectionView = {
          density: current.density,
          id,
          name: trimmedName,
          query: current.query,
          ...(cleanedMetadata ? { metadata: cleanedMetadata } : {}),
        };
        return {
          ...current,
          savedViews: [
            savedView,
            ...current.savedViews.filter((candidate) => candidate.id !== id),
          ].slice(0, 12),
        };
      }),
    setDensity: (density: CollectionDensity) =>
      setView((current) => ({ ...current, density })),
    setQuery: (query: string) =>
      setView((current) => ({ ...current, query: query.slice(0, 200) })),
  };
}
