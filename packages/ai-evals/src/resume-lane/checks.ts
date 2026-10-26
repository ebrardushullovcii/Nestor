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
 * Tools and products the listing names: words it writes capitalized after a
 * sentence's first word and never in lower case (Python, dbt, Zendesk, CI),
 * leaving out the words of the job's own title.
 */
export function listingNames(listing: string, title = ""): Set<string> {
  const capitalized = new Set<string>();
  const lower = new Set<string>();
  for (const sentence of listing.split(/(?<=[.!?:])\s+|\n+/u)) {
    const words = sentence.split(/[\s,;()/]+/u);
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#]+$/gu, "");
      if (word.length < 2) return;
      if (/^[a-z]/u.test(word)) lower.add(word.toLowerCase());
      else if (
        index > 0 &&
        (/^[A-Z][A-Za-z0-9+#.]*$/u.test(word) || /[a-z][A-Z]/u.test(word))
      )
        capitalized.add(word);
    });
  }
  const titleWords = new Set(fold(title).split(" "));
  return new Set(
    [...capitalized].filter(
      (word) => !lower.has(word.toLowerCase()) && !titleWords.has(fold(word)),
    ),
  );
}

export interface InventedFact {
  kind: "number" | "entry" | "name";
  value: string;
  line: string;
}

/**
 * Claims in the draft that the source resume does not have: numbers, an
 * employer, title or date line it never had, and tools or products the
 * listing names that the person never mentioned. The headline (Aggressive
 * leads with the role applied for) and the listing's company name are not
 * claims; the years of experience the profile computed are evidence.
 */
export function inventedFacts(input: {
  draft: ResumeDraft;
  source: string;
  listing: string;
  title: string;
  company: string;
  yearsExperience: number | null;
}): InventedFact[] {
  const source = fold(input.source);
  const sourceNumbers = new Set([
    ...numbersIn(input.source),
    ...Object.entries(NUMBER_WORDS)
      .filter(([word]) => new RegExp(`\b${word}\b`, "iu").test(input.source))
      .map(([, digit]) => digit),
    ...(input.yearsExperience ? [String(input.yearsExperience)] : []),
  ]);
  const names = [...listingNames(input.listing, input.title)].filter(
    (name) =>
      !` ${source} `.includes(` ${fold(name)} `) &&
      !fold(input.company).includes(fold(name)),
  );
  const found: InventedFact[] = [];
  for (const line of draftLines(input.draft)) {
    if (line.where === "headline") continue;
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
    // A tool keeps its capitals in prose; "self-serve" is not "Serve".
    const tokens = new Set(line.text.split(/[^A-Za-z0-9+#]+/u));
    for (const name of names)
      if (
        tokens.has(name) ||
        (line.where === "skills" && fold(line.text) === fold(name))
      )
        found.push({ kind: "name", value: name, line: line.text });
  }
  return found;
}

const STOP = new Set(
  "and the for with that this from into across over using use used was were are has have had our your their its who all can will per out not but they them".split(
    " ",
  ),
);
const contentWords = (text: string) =>
  fold(text)
    .split(" ")
    .filter((word) => word.length > 2 && !STOP.has(word));

export interface LevelShape {
  /**
   * Edit size: the share of the summary's and bullets' words that are not in
   * the source resume. 0 means the person's own words.
   */
  editSize: number;
  /** Listing tools the person really has that the draft uses, of all such tools. */
  truthfulKeywordCoverage: number;
  headline: string | null;
}

export function levelShape(input: {
  draft: ResumeDraft | null;
  source: string;
  listing: string;
  title: string;
}): LevelShape {
  const sourceWords = new Set(contentWords(input.source));
  const shared = [...listingNames(input.listing, input.title)].filter((name) =>
    ` ${fold(input.source)} `.includes(` ${fold(name)} `),
  );
  if (!input.draft)
    return { editSize: 0, truthfulKeywordCoverage: 0, headline: null };
  const lines = draftLines(input.draft);
  const written = lines
    .filter((line) => ["summary", "bullet", "text"].includes(line.where))
    .flatMap((line) => contentWords(line.text));
  const text = ` ${fold(lines.map((line) => line.text).join(" "))} `;
  return {
    editSize: written.length
      ? written.filter((word) => !sourceWords.has(word)).length / written.length
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

/** The edit size Light may not exceed: small, clear wording fixes. */
export const LIGHT_MAX_EDIT = 0.25;

/**
 * Whether each level does what its name says. Every level must invent
 * nothing (0 invented facts); then Original sends the imported file
 * unchanged, Light keeps the person's headline and stays at or under
 * LIGHT_MAX_EDIT, Tailored edits more than Light, and Aggressive edits at
 * least as much as Tailored and leads with the role.
 */
export function levelVerdicts(
  shapes: Partial<
    Record<
      ResumeLevel,
      LevelShape & { unchanged: boolean; inventedCount: number }
    >
  >,
  personHeadline: string,
  roleTitle: string,
): Partial<Record<ResumeLevel, string | null>> {
  const { original, light, tailored, aggressive } = shapes;
  const pct = (value: number) => `${Math.round(value * 100)}%`;
  const verdicts: Partial<Record<ResumeLevel, string | null>> = {};
  const invented = (shape: { inventedCount: number }) =>
    shape.inventedCount > 0
      ? `${shape.inventedCount} invented ${shape.inventedCount === 1 ? "fact" : "facts"}.`
      : null;
  if (original)
    verdicts.original = original.unchanged
      ? null
      : "Original did not send the imported resume unchanged.";
  if (light)
    verdicts.light =
      invented(light) ??
      (light.editSize > LIGHT_MAX_EDIT
        ? `Light edited ${pct(light.editSize)} of words (at most ${pct(LIGHT_MAX_EDIT)}).`
        : light.headline && fold(light.headline) !== fold(personHeadline)
          ? "Light replaced the person's headline."
          : null);
  if (tailored)
    verdicts.tailored =
      invented(tailored) ??
      (light && tailored.editSize <= light.editSize
        ? `Tailored edited ${pct(tailored.editSize)}, no more than Light's ${pct(light.editSize)}.`
        : null);
  if (aggressive)
    verdicts.aggressive =
      invented(aggressive) ??
      (!aggressive.headline ||
      !fold(roleTitle).includes(fold(aggressive.headline))
        ? "Aggressive does not lead with the role."
        : tailored && aggressive.editSize < tailored.editSize
          ? `Aggressive edited ${pct(aggressive.editSize)}, less than Tailored's ${pct(tailored.editSize)}.`
          : null);
  return verdicts;
}
