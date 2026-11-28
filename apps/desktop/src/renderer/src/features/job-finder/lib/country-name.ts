/**
 * A country as the app names it elsewhere: its full English name. A resume
 * location like "London, UK" leaves "UK" in the profile's country, and an
 * answer offered from it read "I'm allowed to work in UK". Intl supplies the
 * name for every region code (UK and GB both read "United Kingdom"), the same
 * source the fit and search code use; anything it does not know stays as the
 * person wrote it.
 */
const regionNames = new Intl.DisplayNames(["en"], {
  type: "region",
  fallback: "none",
});

const THREE_LETTER_ALIASES: Record<string, string> = {
  USA: "US",
};

export function fullCountryName(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.replace(/[.\s]/g, "").toUpperCase();
  const code = THREE_LETTER_ALIASES[compact] ?? compact;
  if (/^[A-Z]{2}$/.test(code)) {
    try {
      const name = regionNames.of(code);
      if (name && name !== code) return name;
    } catch {
      // Not a region Intl knows: keep the person's words.
    }
  }
  return trimmed;
}
