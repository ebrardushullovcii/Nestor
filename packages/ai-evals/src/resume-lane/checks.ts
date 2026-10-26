import type { ResumeDraft, ResumeLevel } from "@nestor/contracts";
import { resumeClaimContentHash } from "@nestor/job-finder/resumes";

/** One printed line of a draft, with where it sits. */
export interface DraftLine {
  where: "headline" | "summary" | "skills" | "entry" | "bullet" | "text";
  text: string;
}

/** Every line the finished resume prints (included sections, entries and bullets). */
export function draftLines(draft: ResumeDraft): DraftLine[] {
  const lines: DraftLine[] = [];
  if (draft.identity?.headline)
    lines.push({ where: "headline", text: draft.identity.headline });
  for (const section of draft.sections) {
    if (!section.included) continue;
    const where =
      section.kind === "summary"
        ? "summary"
        : section.kind === "skills" || section.kind === "keywords"
          ? "skills"
          : "bullet";
    if (section.text)
      lines.push({
        where: where === "bullet" ? "text" : where,
        text: section.text,
      });
    for (const bullet of section.bullets)
      if (bullet.included) lines.push({ where, text: bullet.text });
    for (const entry of section.entries) {
      if (!entry.included) continue;
      for (const value of [entry.title, entry.subtitle, entry.dateRange])
        if (value) lines.push({ where: "entry", text: value });
      if (entry.summary) lines.push({ where: "text", text: entry.summary });
      for (const bullet of entry.bullets)
        if (bullet.included) lines.push({ where: "bullet", text: bullet.text });
    }
  }
  return lines;
}

const MONTH = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gu;
/** Lower case, plain spacing, and months as three letters ("April" = "Apr"). */
const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9+#.%$ ]+/gu, " ")
    .replace(MONTH, "$1")
    .replace(/\s+/gu, " ")
    .trim();

const NUMBER = /\d[\d,]*(?:\.\d+)?%?/gu;
const numbersIn = (text: string) =>
  (text.match(NUMBER) ?? []).map((value) => value.replace(/,/gu, ""));

const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  eleven: "11",
  twelve: "12",
  fifteen: "15",
  twenty: "20",
};

/**
 * Terms the listing writes as names (capitalized mid-sentence, acronyms,
 * mixed case): the tools and products a resume could claim.
 */
export function listingNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const sentence of listing.split(/(?<=[.!?:])\s+|\n+/u)) {
    const words = sentence.split(/[\s,;()/]+/u).slice(1);
    for (const raw of words) {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/gu, "");
      if (word.length < 2) continue;
      if (/^[A-Z][A-Za-z0-9+#.]*$/u.test(word) || /[a-z][A-Z]/u.test(word))
        names.add(word);
    }
  }
  return names;
}

export interface InventedFact {
  kind: "number" | "entry" | "name";
  value: string;
  line: string;
}

/**
 * Claims in the draft that the source resume does not have: numbers, an
 * employer, title or date line it never had, and named tools or products
 * the listing asks for that the person never mentioned. The writer's own
 * section labels and the listing's company name are not claims.
 */
export function inventedFacts(input: {
  draft: ResumeDraft;
  source: string;
  listing: string;
  company: string;
}): InventedFact[] {
  const source = fold(input.source);
  const sourceNumbers = new Set([
    ...numbersIn(input.source),
    ...Object.entries(NUMBER_WORDS)
      .filter(([word]) => new RegExp(`\\b${word}\\b`, "iu").test(input.source))
      .map(([, digit]) => digit),
  ]);
  const names = [...listingNames(input.listing)].filter(
    (name) =>
      !source.includes(fold(name)) && !fold(input.company).includes(fold(name)),
  );
  const found: InventedFact[] = [];
  for (const line of draftLines(input.draft)) {
    for (const value of numbersIn(line.text))
      if (!sourceNumbers.has(value))
        found.push({ kind: "number", value, line: line.text });
    if (line.where === "entry") {
      const parts = line.text
        .split(/\s*[-–—|,]\s*/u)
        .map(fold)
        .filter(Boolean);
      for (const part of parts)
        if (!source.includes(part) && !/^(present|current)$/u.test(part))
          found.push({ kind: "entry", value: part, line: line.text });
    }
    // Aggressive leads with the role applied for; that is not a fact claim.
    if (line.where === "headline") continue;
    const folded = ` ${fold(line.text)} `;
    for (const name of names)
      if (folded.includes(` ${fold(name)} `))
        found.push({ kind: "name", value: name, line: line.text });
  }
  return found;
}

const words = (text: string) =>
  new Set(
    fold(text)
      .split(" ")
      .filter((w) => w.length > 2),
  );

/** How much of a line's wording is new against the closest source line. */
function novelty(line: string, sourceLines: readonly string[]): number {
  const own = words(line);
  if (own.size === 0) return 0;
  let best = 1;
  for (const candidate of sourceLines) {
    const theirs = words(candidate);
    let shared = 0;
    for (const word of own) if (theirs.has(word)) shared += 1;
    best = Math.min(best, 1 - shared / own.size);
  }
  return best;
}

export interface LevelShape {
  /** Share of written bullets and summary lines that read as rewritten (over 40% new words). */
  rewrittenShare: number;
  /** Listing names the person really has that the draft now uses, of all such names. */
  truthfulKeywordCoverage: number;
  headline: string | null;
}

export function levelShape(input: {
  draft: ResumeDraft | null;
  source: string;
  listing: string;
}): LevelShape {
  const sourceLines = input.source
    .split(/\r?\n/u)
    .filter((line) => line.trim());
  const shared = [...listingNames(input.listing)].filter((name) =>
    fold(input.source).includes(fold(name)),
  );
  if (!input.draft)
    return { rewrittenShare: 0, truthfulKeywordCoverage: 0, headline: null };
  const lines = draftLines(input.draft);
  const written = lines.filter((line) =>
    ["summary", "bullet", "text"].includes(line.where),
  );
  const text = ` ${fold(lines.map((line) => line.text).join(" "))} `;
  return {
    rewrittenShare: written.length
      ? written.filter((line) => novelty(line.text, sourceLines) > 0.4).length /
        written.length
      : 0,
    truthfulKeywordCoverage: shared.length
      ? shared.filter((name) => text.includes(` ${fold(name)} `)).length /
        shared.length
      : 1,
    headline: input.draft.identity?.headline ?? null,
  };
}

/** Checked lines the finished draft still prints that the checker did not pass. */
export function flagsLeft(draft: ResumeDraft | null): string[] {
  if (!draft) return [];
  const printed = new Map(
    draftLines(draft).map((line) => [
      resumeClaimContentHash(line.text),
      line.text,
    ]),
  );
  return (draft.claimChecks ?? [])
    .filter((check) => check.verdict !== "supported")
    .flatMap((check) => {
      const line = printed.get(check.contentHash);
      return line ? [`${check.verdict}: ${line}`] : [];
    });
}

/**
 * Whether each level does what its name says, from the shapes of one case:
 * Original sends the imported file, Light edits a little and keeps the
 * person's headline, Tailored goes further than Light, and Aggressive goes
 * at least as far as Tailored and leads with the role.
 */
export function levelVerdicts(
  shapes: Partial<Record<ResumeLevel, LevelShape & { unchanged: boolean }>>,
  personHeadline: string,
  roleTitle: string,
): Partial<Record<ResumeLevel, string | null>> {
  const { original, light, tailored, aggressive } = shapes;
  const verdicts: Partial<Record<ResumeLevel, string | null>> = {};
  if (original)
    verdicts.original = original.unchanged
      ? null
      : "Original did not send the imported resume unchanged.";
  if (light)
    verdicts.light =
      light.rewrittenShare > 0.5
        ? `Light rewrote ${Math.round(light.rewrittenShare * 100)}% of lines.`
        : light.headline && fold(light.headline) !== fold(personHeadline)
          ? "Light replaced the person's headline."
          : null;
  if (tailored && light)
    verdicts.tailored =
      tailored.rewrittenShare <= light.rewrittenShare &&
      tailored.truthfulKeywordCoverage <= light.truthfulKeywordCoverage
        ? "Tailored did not go further than Light."
        : null;
  if (aggressive && tailored)
    verdicts.aggressive =
      !aggressive.headline ||
      !fold(roleTitle).includes(fold(aggressive.headline))
        ? "Aggressive does not lead with the role."
        : aggressive.truthfulKeywordCoverage <
              tailored.truthfulKeywordCoverage &&
            aggressive.rewrittenShare < tailored.rewrittenShare
          ? "Aggressive went less far than Tailored."
          : null;
  return verdicts;
}
