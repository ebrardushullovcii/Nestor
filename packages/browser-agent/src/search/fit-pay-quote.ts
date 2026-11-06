/** Typography/currency spelling only: no conversion or inference of pay amounts. */
export function normalizeFitPayQuote(
  text: string,
  currency?: string | null,
): string {
  const dollars = new Set(["USD", "CAD", "AUD", "NZD", "SGD", "HKD"]);
  const code = currency?.toUpperCase() ?? "";
  const prefixes: Record<string, string> = {
    US: "USD",
    CA: "CAD",
    C: "CAD",
    AU: "AUD",
    A: "AUD",
    NZ: "NZD",
    SG: "SGD",
    HK: "HKD",
  };
  return text
    .normalize("NFKC")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(
      /\b(US|CA|C|AU|A|NZ|SG|HK)\s*\$/giu,
      (_match, prefix: string) => ` ${prefixes[prefix.toUpperCase()]} `,
    )
    .replace(/\$/gu, dollars.has(code) ? ` ${code} ` : "$")
    .replace(/€/gu, " EUR ")
    .replace(/£/gu, " GBP ")
    .replace(/¥/gu, code === "JPY" || code === "CNY" ? ` ${code} ` : "¥")
    .replace(/["'‘’“”‚‛„‟«»‹›ʼ]/gu, "")
    .replace(/(?<=\d)[,.\s](?=\d{3}(?:\D|$))/gu, "")
    .replace(/(?<=\d),(?=\d{1,2}(?:\D|$))/gu, ".")
    .replace(/\s+/gu, "")
    .toLowerCase();
}
