import { createRequire } from "node:module";
import type { Readability as ReadabilityClass } from "@mozilla/readability";
import type { JSDOM as JSDOMClass } from "jsdom";

// jsdom and Readability take about a third of a second to load, and only a
// research read needs them; load them then, not with the app.
const requireOnUse = createRequire(import.meta.url);
let pageReader:
  | { JSDOM: typeof JSDOMClass; Readability: typeof ReadabilityClass }
  | undefined;
function loadPageReader() {
  pageReader ??= {
    JSDOM: (requireOnUse("jsdom") as { JSDOM: typeof JSDOMClass }).JSDOM,
    Readability: (
      requireOnUse("@mozilla/readability") as {
        Readability: typeof ReadabilityClass;
      }
    ).Readability,
  };
  return pageReader;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "among",
  "been",
  "being",
  "between",
  "build",
  "built",
  "candidate",
  "company",
  "could",
  "from",
  "have",
  "into",
  "just",
  "more",
  "most",
  "over",
  "role",
  "than",
  "that",
  "their",
  "them",
  "there",
  "they",
  "this",
  "those",
  "through",
  "using",
  "with",
  "work",
  "your",
]);

export interface ReadablePageResult {
  title: string | null;
  text: string;
  excerpt: string | null;
}

export interface ResearchSignalResult {
  companyNotes: string | null;
  domainVocabulary: readonly string[];
  priorityThemes: readonly string[];
}

export function extractReadablePage(input: {
  url: string;
  html: string;
}): ReadablePageResult {
  const { JSDOM, Readability } = loadPageReader();
  const dom = new JSDOM(input.html, { url: input.url });
  const article = new Readability(dom.window.document).parse();
  const fallbackTitle = dom.window.document.title?.trim() || null;
  const rawText =
    article?.textContent ?? dom.window.document.body?.textContent ?? "";
  const text = normalizeResearchText(rawText);

  return {
    title: article?.title?.trim() || fallbackTitle,
    text,
    excerpt: article?.excerpt?.trim() || null,
  };
}

export function extractResearchSignals(text: string): ResearchSignalResult {
  const normalizedText = normalizeResearchText(text);
  if (!normalizedText) {
    return {
      companyNotes: null,
      domainVocabulary: [],
      priorityThemes: [],
    };
  }

  const sentences = normalizedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 24);
  const tokenCounts = new Map<string, number>();

  for (const token of tokenize(normalizedText)) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  const domainVocabulary = [...tokenCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 6)
    .map(([token]) => token);

  const repeatedPhraseCounts = new Map<string, number>();
  for (const sentence of sentences) {
    const sentenceTokens = tokenize(sentence);
    for (let index = 0; index < sentenceTokens.length - 1; index += 1) {
      const phrase = `${sentenceTokens[index]} ${sentenceTokens[index + 1]}`;
      repeatedPhraseCounts.set(
        phrase,
        (repeatedPhraseCounts.get(phrase) ?? 0) + 1,
      );
    }
  }

  const repeatedThemes = [...repeatedPhraseCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )
    .slice(0, 4)
    .map(([phrase]) => phrase);
  const fallbackThemes = sentences
    .filter((sentence) =>
      domainVocabulary.some((token) => sentence.toLowerCase().includes(token)),
    )
    .slice(0, 3)
    .map((sentence) => sentence.slice(0, 96));
  const priorityThemes =
    repeatedThemes.length > 0 ? repeatedThemes : fallbackThemes;
  const companyNotes = sentences.slice(0, 2).join(" ") || null;

  return {
    companyNotes,
    domainVocabulary,
    priorityThemes,
  };
}

export function normalizeResearchText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function tokenize(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[a-z][a-z0-9+-]{2,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) ?? []
  );
}
