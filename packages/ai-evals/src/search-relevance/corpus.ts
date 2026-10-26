import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { ListingCard } from "@nestor/contracts";

export interface RecordedPage {
  url: string;
  finalUrl: string;
  method: string;
  body?: unknown;
  status: number;
  capturedAt: string;
  html: string;
}
export interface RecordedBoard {
  source: { id: string; label: string; url: string };
  responses: RecordedPage[];
  /** Frozen observed card facts; not relevance or fit judgments. */
  cards: ListingCard[];
}
export interface RelevanceLabel {
  relevant: boolean;
  reason: string;
}
export interface LabelledListing {
  board: string;
  url: string;
  title: string;
  labels: Record<string, RelevanceLabel>;
}
export interface CorpusManifest {
  version: number;
  capturedAt: string;
  selection: string;
  boards: Array<{ id: string; file: string; sha256: string }>;
  listings: LabelledListing[];
}
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export async function loadCorpus(directory: string) {
  const raw = await readFile(path.join(directory, "corpus.json"), "utf8");
  const manifest = JSON.parse(raw) as CorpusManifest;
  const boards = await Promise.all(manifest.boards.map(async (entry) => {
    const bytes = await readFile(path.join(directory, entry.file));
    if (digest(bytes) !== entry.sha256) throw new Error(`Recording checksum mismatch: ${entry.id}`);
    const board = JSON.parse(gunzipSync(bytes).toString("utf8")) as RecordedBoard;
    if (board.source.id !== entry.id) throw new Error(`Recording id mismatch: ${entry.id}`);
    return board;
  }));
  const urls = new Set<string>();
  for (const listing of manifest.listings) {
    if (urls.has(listing.url)) throw new Error(`Duplicate label: ${listing.url}`);
    urls.add(listing.url);
    const card = boards.find((b) => b.source.id === listing.board)?.cards.find((c) => c.url === listing.url);
    if (!card || card.title !== listing.title) throw new Error(`Missing or changed card: ${listing.url}`);
  }
  return { manifest, boards, digest: digest(raw) };
}
