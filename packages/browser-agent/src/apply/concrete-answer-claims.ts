import { preserveTechnologyTokens } from "@nestor/contracts";

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
/** Complete statements of intent only: no qualifications, history or named facts. */
export function isPlainMotivationIntent(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/^I['’]m\b/iu, "I am")
    .replace(/^I['’]d\b/iu, "I would");
  const intent =
    /^I (?:am (?:excited|interested|motivated) (?:about|in|by|to)|(?:would like|hope|want) to|would welcome) (.+)$/iu.exec(
      normalized,
    );
  const body = intent?.[1];
  if (!body) return false;
  // Only connective words about future participation. No personal qualities,
  // possession, qualifications, named entities, numbers or history fit here.
  const words = new Set(
    "a an the this that your opportunity chance role position team company work working join joining contribute contributing contribution help helping to in at on about with for and would welcome".split(
      " ",
    ),
  );
  const remainder = body
    .replace(/[.,!]/gu, " ")
    .toLowerCase()
    .trim()
    .split(/\s+/u);
  return (
    remainder.length > 0 &&
    remainder.length <= 40 &&
    remainder.every((word) => words.has(word))
  );
}

/** A question naming one country carries its own jurisdiction across postings. */
export function explicitApplicationCountry(question: string): string | null {
  const countries = countriesIn(question);
  return countries.size === 1
    ? (countries.values().next().value ?? null)
    : null;
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
