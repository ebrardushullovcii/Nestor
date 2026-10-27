import { ISO_COUNTRY_CODES } from "@nestor/contracts";

const normalized = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const known = new Set(ISO_COUNTRY_CODES);
const labels = new Map<string, string>();
const loaded = new Set<string>();
const englishNames = new Intl.DisplayNames(["en"], { type: "region" });
function load(locale: string) {
  if (loaded.has(locale)) return;
  const names =
    locale === "en"
      ? englishNames
      : new Intl.DisplayNames([locale], { type: "region" });
  for (const code of ISO_COUNTRY_CODES) {
    labels.set(normalized(code), code);
    const name = names.of(code);
    if (name) labels.set(normalized(name), code);
  }
  loaded.add(locale);
}

/** Exact country labels only: a trailing CA on San Francisco is not Canada. */
export function fitCountryCode(
  value: string,
  translated = false,
): string | null {
  load("en");
  const key = normalized(value);
  const alias: Record<string, string> = {
    usa: "US",
    "united states of america": "US",
    uk: "GB",
    "great britain": "GB",
    "czech republic": "CZ",
    turkey: "TR",
  };
  if (alias[key]) return alias[key];
  if (labels.has(key)) return labels.get(key)!;
  if (translated)
    for (const locale of ["de", "fr", "es", "pt"]) {
      load(locale);
      if (labels.has(key)) return labels.get(key)!;
    }
  return null;
}

export function fitCountryCodes(value: string): Set<string> {
  const single = fitCountryCode(value);
  if (single) return new Set([single]);
  return new Set(
    value
      .split(/[,;\s/|]+/u)
      .map((code) => code.toUpperCase())
      .filter((code) => known.has(code)),
  );
}

export function fitCountryNames(codes: ReadonlySet<string>): string[] {
  return [...codes].flatMap((code) => [code, englishNames.of(code) ?? code]);
}
