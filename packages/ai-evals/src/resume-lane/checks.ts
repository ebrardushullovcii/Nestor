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

const MONTH =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gu;
/** Lower case, plain spacing, and months as three letters ("April" = "Apr"). */
const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9+#.%$ ]+/gu, " ")
    .replace(/\.(?=\s|$)/gu, "")
    .replace(MONTH, (month) => month.slice(0, 3))
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
  kind: "number" | "entry" | "name" | "leadership" | "domain" | "credential";
  value: string;
  line: string;
}

export interface ResumeStretch {
  kind: "listing_technology" | "years" | "model";
  value: string;
  line: string;
  /** Old recordings did not keep per-line verdicts; do not claim they did. */
  flagged: boolean;
}

type FactInputs = {
  draft: ResumeDraft;
  source: string;
  listing: string;
  title: string;
  company: string;
  yearsExperience: number | null;
  level?: ResumeLevel;
  /** Reviewed domain phrases for a case, when the hiring domain differs. */
  hiringDomainTerms?: readonly string[];
  technologyNames?: readonly string[] | undefined;
  credentialNames?: readonly string[] | undefined;
};

const includesWords = (text: string, value: string) =>
  ` ${fold(text)} `.includes(` ${fold(value)} `);
const withNumberWords = (text: string) =>
  text.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\b/giu,
    (word) => NUMBER_WORDS[word.toLowerCase()] ?? word,
  );

/**
 * Offline probes for the hard limits, separate from Aggressive's stretches.
 * Entry identity and numeric literals are mechanical checks; named-technology,
 * leadership and reviewed domain probes are signals, not a semantic fact judge.
 * The writer's model checks and a read of the saved drafts cover meaning.
 */
export function assessFacts(input: FactInputs): {
  invented: InventedFact[];
  stretches: ResumeStretch[];
} {
  const source = fold(input.source);
  const sourceNumbers = new Set([
    ...numbersIn(withNumberWords(input.source)),
    ...(input.yearsExperience === null ? [] : [String(input.yearsExperience)]),
  ]);
  const sourceYears = [
    ...withNumberWords(input.source).matchAll(/\b(\d+)\s+years?\b/giu),
  ].map((m) => Number(m[1]));
  if (input.yearsExperience !== null) sourceYears.push(input.yearsExperience);
  const listingYears = new Set(
    [
      ...withNumberWords(input.listing).matchAll(/\b(\d+)\s*\+?\s+years?\b/giu),
    ].map((m) => Number(m[1])),
  );
  const listedNames = listingNames(input.listing, input.title);
  const invented: InventedFact[] = [];
  const stretches: ResumeStretch[] = [];
  const checks = new Map(
    (input.draft.claimChecks ?? []).map((check) => [check.contentHash, check]),
  );
  const seen = new Set<string>();
  for (const line of draftLines(input.draft)) {
    if (line.where === "headline") continue;
    const check = checks.get(resumeClaimContentHash(line.text));
    const flagged = check?.verdict === "stretch";
    const normalized = withNumberWords(line.text);
    for (const match of normalized.matchAll(new RegExp(NUMBER.source, "gu"))) {
      const value = match[0].replace(/,/gu, "");
      if (sourceNumbers.has(value)) continue;
      const inYears = /^\s+years?\b/iu.test(
        normalized.slice(match.index + match[0].length),
      );
      const rounded =
        input.level === "aggressive" &&
        inYears &&
        listingYears.has(Number(value)) &&
        sourceYears.some((years) => Number(value) === years + 1);
      if (rounded)
        stretches.push({ kind: "years", value, line: line.text, flagged });
      else invented.push({ kind: "number", value, line: line.text });
    }
    for (const credential of input.credentialNames ?? [])
      if (
        includesWords(line.text, credential) &&
        !includesWords(input.source, credential)
      )
        invented.push({
          kind: "credential",
          value: credential,
          line: line.text,
        });
    if (line.where === "entry") {
      const parts = line.text
        .split(/\s*[-��|,]\s*/u)
        .map(fold)
        .filter(Boolean);
      for (const part of parts)
        if (!source.includes(part) && !/^(present|current)$/u.test(part))
          invented.push({ kind: "entry", value: part, line: line.text });
      continue;
    }
    const names = new Set(
      new Map(
        (
          input.technologyNames ?? [
            ...listedNames,
            ...listingNames(line.text, input.title),
          ]
        ).map((name) => [fold(name), name]),
      ).values(),
    );
    if (
      !input.technologyNames &&
      line.where === "skills" &&
      /^[A-Z][A-Za-z0-9+#./ -]*$/u.test(line.text)
    )
      names.add(line.text);
    for (const name of names) {
      if (
        [...names].some(
          (other) =>
            other !== name &&
            includesWords(other, name) &&
            includesWords(line.text, other),
        )
      )
        continue;
      if (
        !(input.technologyNames
          ? includesWords(line.text, name)
          : line.text.split(/[^A-Za-z0-9+#]+/u).includes(name) ||
            (line.where === "skills" && fold(line.text) === fold(name))) ||
        includesWords(input.source, name) ||
        includesWords(input.title, name)
      )
        continue;
      // Company names in prose are checked as domain transfer, not technologies.
      if (!input.technologyNames && includesWords(input.company, name))
        continue;
      const key = `${line.text}|${fold(name)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (input.level === "aggressive" && includesWords(input.listing, name))
        stretches.push({
          kind: "listing_technology",
          value: name,
          line: line.text,
          flagged,
        });
      else invented.push({ kind: "name", value: name, line: line.text });
    }
    if (
      /\b(led|managed|supervised|mentored|leadership)\b/iu.test(line.text) &&
      !/\b(led|lead|managed|manage|supervised|mentored|coach|trained|leadership)\b/iu.test(
        input.source,
      )
    )
      invented.push({ kind: "leadership", value: line.text, line: line.text });
    if (line.where === "bullet" || line.where === "text")
      for (const term of input.hiringDomainTerms ?? [])
        if (
          includesWords(line.text, term) &&
          !includesWords(input.source, term)
        )
          invented.push({ kind: "domain", value: term, line: line.text });
    if (flagged && !stretches.some((stretch) => stretch.line === line.text))
      stretches.push({
        kind: "model",
        value: check.reason,
        line: line.text,
        flagged: true,
      });
  }
  return { invented, stretches };
}

/** Kept for callers that only need hard-limit findings. */
export function inventedFacts(input: FactInputs): InventedFact[] {
  return assessFacts(input).invented;
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
