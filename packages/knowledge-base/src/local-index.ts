import MiniSearch from "minisearch";

import { chunkText, type ChunkTextOptions } from "./chunk";

export type KnowledgeDocumentTag = "resume" | "profile" | "job" | "research";

export interface KnowledgeDocumentMetadata {
  tags?: readonly KnowledgeDocumentTag[];
  title?: string | null;
  section?: string | null;
  sourceId?: string | null;
}

export interface KnowledgeIndexSearchOptions {
  limit?: number;
  tags?: readonly KnowledgeDocumentTag[];
  prefix?: boolean;
  fuzzy?: boolean | number;
}

export interface KnowledgeSearchResult {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  metadata: KnowledgeDocumentMetadata;
  score: number;
}

export interface KnowledgeIndex {
  addDocument(
    id: string,
    text: string,
    metadata?: KnowledgeDocumentMetadata,
  ): void;
  search(
    query: string,
    options?: KnowledgeIndexSearchOptions,
  ): readonly KnowledgeSearchResult[];
  clear(): void;
}

interface StoredDocument {
  id: string;
  text: string;
  metadata: KnowledgeDocumentMetadata;
}

interface IndexedChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  text: string;
  title: string;
  section: string;
  tagsText: string;
  metadata: KnowledgeDocumentMetadata;
}

export interface CreateLocalKnowledgeIndexOptions {
  chunking?: ChunkTextOptions;
}

export function createLocalKnowledgeIndex(
  options: CreateLocalKnowledgeIndexOptions = {},
): KnowledgeIndex {
  const storedDocuments = new Map<string, StoredDocument>();
  let indexedChunks = new Map<string, IndexedChunk>();
  let miniSearch = createMiniSearch();
  // Built at the first search after documents change. Rebuilding on every
  // added document made collecting a resume's evidence quadratic (about a
  // quarter second per resume on a long profile).
  let stale = false;

  function rebuildIndex(): void {
    miniSearch = createMiniSearch();
    indexedChunks = new Map<string, IndexedChunk>();
    const chunks = Array.from(storedDocuments.values()).flatMap((document) =>
      chunkText(document.text, options.chunking).map((chunk) => ({
        id: `${document.id}::${chunk.chunkIndex}`,
        documentId: document.id,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        title: document.metadata.title ?? "",
        section: document.metadata.section ?? "",
        tagsText: [...(document.metadata.tags ?? [])].sort().join(" "),
        metadata: document.metadata,
      })),
    );

    for (const chunk of chunks) {
      indexedChunks.set(chunk.id, chunk);
    }

    if (chunks.length > 0) {
      miniSearch.addAll(chunks);
    }
  }

  return {
    addDocument(id, text, metadata = {}) {
      storedDocuments.set(id, {
        id,
        text,
        metadata: normalizeMetadata(metadata),
      });
      stale = true;
    },
    search(query, searchOptions = {}) {
      const normalizedQuery = query.trim();

      if (normalizedQuery.length === 0) {
        return [];
      }
      if (stale) {
        rebuildIndex();
        stale = false;
      }

      const tagFilter = searchOptions.tags
        ? new Set(searchOptions.tags)
        : null;
      const results = miniSearch.search(normalizedQuery, {
        prefix: searchOptions.prefix ?? true,
        fuzzy: searchOptions.fuzzy ?? 0,
        boost: {
          title: 2,
          section: 1.5,
          tagsText: 1.2,
        },
      });

      const filteredResults = results
        .map((result) => {
          const chunk = indexedChunks.get(String(result.id));
          if (!chunk) {
            return null;
          }

          return {
            ...chunk,
            score: result.score,
          };
        })
        .filter((result): result is IndexedChunk & { score: number } => result !== null)
        .filter((result) => {
        if (!tagFilter) {
          return true;
        }

        const metadataTags = result.metadata.tags ?? [];
        return metadataTags.some((tag: KnowledgeDocumentTag) => tagFilter.has(tag));
        });

      return filteredResults
        .sort((left, right) => {
          if (!tagFilter) {
            const leftPriority = getTagPriority(left.metadata.tags);
            const rightPriority = getTagPriority(right.metadata.tags);

            if (leftPriority !== rightPriority) {
              return leftPriority - rightPriority;
            }
          }

          if (right.score !== left.score) {
            return right.score - left.score;
          }

          if (left.documentId !== right.documentId) {
            return left.documentId.localeCompare(right.documentId);
          }

          return left.chunkIndex - right.chunkIndex;
        })
        .slice(0, searchOptions.limit ?? 5)
        .map((result) => ({
          id: result.id,
          documentId: result.documentId,
          chunkIndex: result.chunkIndex,
          text: result.text,
          metadata: result.metadata,
          score: result.score,
        }));
    },
    clear() {
      storedDocuments.clear();
      stale = false;
      indexedChunks = new Map<string, IndexedChunk>();
      miniSearch = createMiniSearch();
    },
  };
}

function createMiniSearch(): MiniSearch<IndexedChunk> {
  return new MiniSearch<IndexedChunk>({
    idField: "id",
    fields: ["text", "title", "section", "tagsText"],
    storeFields: ["id", "documentId", "chunkIndex", "text", "metadata"],
    searchOptions: {
      combineWith: "OR",
    },
  });
}

function normalizeMetadata(
  metadata: KnowledgeDocumentMetadata,
): KnowledgeDocumentMetadata {
  return {
    tags: metadata.tags ? [...metadata.tags].sort() : [],
    title: metadata.title ?? null,
    section: metadata.section ?? null,
    sourceId: metadata.sourceId ?? null,
  };
}

function getTagPriority(
  tags: readonly KnowledgeDocumentTag[] | undefined,
): number {
  if (!tags || tags.length === 0) {
    return Number.MAX_SAFE_INTEGER;
  }

  if (tags.includes("job")) {
    return 0;
  }

  if (tags.includes("profile")) {
    return 1;
  }

  if (tags.includes("resume")) {
    return 2;
  }

  if (tags.includes("research")) {
    return 3;
  }

  return Number.MAX_SAFE_INTEGER;
}
