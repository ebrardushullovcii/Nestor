import { preserveTechnologyTokens } from "@nestor/contracts";
import type { AnswerEvidence } from "./answer-evidence";

const normalize = (value: string) =>
  preserveTechnologyTokens(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\bjs\b/gu, "javascript")
    .replace(/\bts\b/gu, "typescript")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const contains = (quote: string, claim: string) =>
  ` ${normalize(quote)} `.includes(` ${normalize(claim)} `);
const numberWords = new Map(
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty"
    .split(" ")
    .map((word, index) => [word, String(index)]),
);
const numbers = (text: string) =>
  [
    ...text.matchAll(
      /\b\d+(?:[.,]\d+)*\b|\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/giu,
    ),
  ].map((match) => numberWords.get(match[0].toLowerCase()) ?? match[0]);
const ordinaryCapitals = new Set(
  "i my we our the a an this that these those it its your you with as since from for in on at to and or by why how what when where who yes no true false dear hiring team manager sincerely regards thank thanks hello yours supported january february march april may june july august september october november december engineering software building developing working joining applying experience professional years owning throughout over during alongside beyond across having through before previously currently additionally together helping improving".split(
    " ",
  ),
);

function namesIn(text: string, personalHistory: boolean): string[] {
  text = preserveTechnologyTokens(text);
  const names = [
    ...text.matchAll(/\b[A-Z][A-Za-z0-9]*(?:\s+[A-Z][A-Za-z0-9]*)*\b/gu),
  ]
    .map((match) => match[0])
    .filter(
      (name) =>
        !name
          .toLowerCase()
          .split(/\s+/u)
          .every((word) => ordinaryCapitals.has(word)),
    );
  for (const match of text.matchAll(
    /\b[Aa]t\s+(?:the\s+)?([\p{L}\p{N}][\p{L}\p{N}&.-]*(?:\s+(?:[A-Z][\p{L}\p{N}&.-]*|(?:corp|inc|ltd|company|foundation)))*)/gu,
  ))
    if (match[1] && !ordinaryCapitals.has(match[1].toLowerCase()))
      names.push(match[1]);
  if (personalHistory)
    for (const match of text.matchAll(
      /\bfor\s+(?:the\s+)?([\p{L}][\p{L}\p{N}&.-]*)/giu,
    ))
      if (
        match[1] &&
        !ordinaryCapitals.has(match[1].toLowerCase()) &&
        !numberWords.has(match[1].toLowerCase())
      )
        names.push(match[1]);
  return [...new Set(names)];
}

function durationInQuote(
  quote: string,
  duration: string,
  names: readonly string[],
): boolean {
  return quote.split(/[;\n]|[.!?](?:\s|$)/u).some((part) => {
    if (
      !contains(part, duration) ||
      !names.every((name) => contains(part, name))
    )
      return false;
    if (!names.length || /^(?:since|from)\b/iu.test(duration)) return true;
    if (/\b(?:overall|total|career)\b/iu.test(part)) return false;
    const text = normalize(part),
      at = text.indexOf(normalize(duration));
    const after = text
      .slice(at + normalize(duration).length)
      .trim()
      .split(" ");
    const connectors = new Set([
      "of",
      "professional",
      "experience",
      "working",
      "using",
      "with",
      "in",
      "at",
      "hands",
      "on",
    ]);
    const subject = after.find((word) => !connectors.has(word));
    if (
      subject &&
      names.some((name) => normalize(name).split(" ")[0] === subject)
    )
      return true;
    const before = text.slice(0, at).trim();
    return names.some((name) => {
      const named = normalize(name),
        atName = before.lastIndexOf(named);
      return (
        atName >= 0 &&
        before
          .slice(atName + named.length)
          .trim()
          .split(" ")
          .every(
            (word) => !word || ["for", "with", "using", "and"].includes(word),
          )
      );
    });
  });
}

// Only connective writing may be new. Content words and numbers must occur
// together in one cited passage, so a checker cannot assemble a new fact from
// unrelated numbers, tools, languages or employers across several quotes.
const writingGlue = new Set(
  (
    "yes no true false i my me we our you your the a an this that these those it its own owning " +
    "and or but of for in on at to with by from as an am is are was were be been being " +
    "have has had do does did would could can will may might should " +
    "want welcome like love appreciate opportunity chance contribute contribution excited interested interest drawn motivated look forward hope " +
    "role position team company work working join joining build building help helping " +
    "apply applying bring bringing use using used develop developing support supporting " +
    "reliable dependable meaningful thoughtful strong stronger good great well " +
    "because about through into together also especially aligns aligns alignment involves involving"
  ).split(/\s+/u),
);
function contentWords(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((word) => word && !writingGlue.has(word));
}

/** Complete statements of intent only: no qualifications, history or named facts. */
export function isPlainMotivationIntent(text: string): boolean {
  return /^I (?:am (?:excited|interested|motivated) (?:about|in|by) (?:this|the) (?:opportunity|role|position)|am excited to (?:help|contribute)|(?:would like|hope|want) to (?:help|contribute|join your team)|would welcome the opportunity to (?:help|contribute))[.!]?$/iu.test(
    text.trim(),
  );
}

/** Concrete claims must be in the cited text, even when the checker lies about support. */
export function concreteClaimsSupported(
  answer: string,
  evidence: readonly AnswerEvidence[],
): boolean {
  for (const clause of answer.split(
    /(?<=[.!?])\s+|\n|\b(?:and|but)\s+(?=I\b|I['’]|would\b|hope\b|want\b)/gu,
  )) {
    if (isPlainMotivationIntent(clause)) continue;
    const personalHistory =
      /\b(?:led|worked|managed|built|delivered|earned|achieved|spent|graduated|founded|employed)\b|\bmy\s+(?:experience|work|career|time|tenure)\b/iu.test(
        clause,
      );
    const roleSubject =
      /^(?:(?:The|Your|This) )?(?:role|position|company|organisation|organization|team|posting|job|mission|product|work)\b|^Owning the\b/iu.test(
        clause.trim(),
      );
    const personalVoice = /\b(?:I|my|me|our|we)\b/iu.test(clause);
    const applicantClaim = personalHistory || personalVoice || !roleSubject;
    const quotes = evidence
      .filter((entry) => !applicantClaim || entry.source !== "posting")
      .map((entry) => entry.quote);
    const content = contentWords(clause);
    if (
      content.length &&
      (applicantClaim
        ? !quotes.some((quote) =>
            content.every((word) => contains(quote, word)),
          )
        : content.some(
            (word) => !quotes.some((quote) => contains(quote, word)),
          ))
    )
      return false;
    const literalClaim =
      applicantClaim &&
      (personalHistory || personalVoice || numbers(clause).length > 0);
    if (literalClaim && !quotes.some((quote) => contains(quote, clause)))
      return false;
    const counts = numbers(clause);
    if (
      counts.some(
        (count) => !quotes.some((quote) => numbers(quote).includes(count)),
      )
    )
      return false;
    const names = namesIn(clause, personalHistory);
    if (names.some((name) => !quotes.some((quote) => contains(quote, name))))
      return false;
    const durations = [
      ...clause.matchAll(
        /\b(?:\d+(?:\.\d+)?\+?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:years?|months?|weeks?|days?|decades?)\b|\b(?:since|from)\s+\d{4}\b/giu,
      ),
    ].map((match) => match[0]);
    if (
      durations.some(
        (duration) =>
          !quotes.some((quote) => durationInQuote(quote, duration, names)),
      )
    )
      return false;
    if (personalHistory) {
      const verbs = [
        ...clause.matchAll(
          /\b(?:led|worked|managed|built|delivered|earned|achieved|spent|graduated|founded|employed)\b/giu,
        ),
      ].map((match) => match[0]);
      if (
        verbs.some(
          (verb) =>
            !quotes.some(
              (quote) =>
                contains(quote, verb) &&
                counts.every((count) => numbers(quote).includes(count)) &&
                names.every((name) => contains(quote, name)),
            ),
        )
      )
        return false;
    }
  }
  return true;
}

let countryNames:
  | Array<{ code: string; name: string; abbreviation: boolean }>
  | undefined;
const countryReadCache = new Map<string, readonly string[]>();
export function countriesIn(text: string): Set<string> {
  const cached = countryReadCache.get(text);
  if (cached) return new Set(cached);
  if (!countryNames) {
    countryNames = [];
    for (const locale of ["en", "de", "fr", "es", "pt"]) {
      const display = new Intl.DisplayNames([locale], { type: "region" });
      for (let a = 65; a <= 90; a++)
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b),
            name = display.of(code);
          if (name && name !== code) {
            const canonical = new Intl.Locale(`und-${code}`).region ?? code;
            countryNames.push({ code: canonical, name, abbreviation: false });
            if (locale === "en")
              countryNames.push({
                code: canonical,
                name: code,
                abbreviation: true,
              });
          }
        }
    }
    for (const [code, names] of Object.entries({
      US: ["US", "USA", "United States of America"],
      GB: ["UK", "Great Britain"],
      CZ: ["Czech Republic"],
      TR: ["Turkey"],
    }))
      for (const name of names)
        countryNames.push({ code, name, abbreviation: name.length <= 3 });
  }
  const result = new Set(
    countryNames
      .filter((entry) =>
        entry.abbreviation
          ? new RegExp(`\\b${entry.name}\\b`, "u").test(text)
          : contains(text, entry.name),
      )
      .map((entry) => entry.code),
  );
  if (countryReadCache.size >= 256)
    countryReadCache.delete(countryReadCache.keys().next().value ?? "");
  countryReadCache.set(text, [...result]);
  return result;
}

export function authorizationCountryMatches(
  question: string,
  answer: string,
  evidence: readonly AnswerEvidence[],
): boolean {
  if (
    !/\b(?:authori[sz](?:ed|ation)|eligible|eligibility|sponsor(?:ship)?|work permit|right to work)\b/iu.test(
      question,
    )
  )
    return true;
  const wanted = countriesIn(`${question} ${answer}`);
  if (!wanted.size) return true;
  const cited = new Set(
    evidence
      .filter((entry) => entry.source !== "posting")
      .flatMap((entry) => [...countriesIn(entry.quote)]),
  );
  return [...wanted].every((country) => cited.has(country));
}

/** Exact country terms for a full-question allow list, including UK shorthand. */
export function countryTerms(code: string): string[] {
  countriesIn("");
  return [
    ...new Set(
      (countryNames ?? [])
        .filter((entry) => entry.code === code)
        .map((entry) => entry.name),
    ),
  ];
}
