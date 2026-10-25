/** Explicit availability evidence; role fit cannot make a closed vacancy actionable. */
export function listingClosedReason(
  text: string,
  validThrough?: string | null,
): string | null {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (
    /\b(?:this (?:job|position|role|vacancy) (?:is )?no longer accepting applications|(?:job|position|role|vacancy) (?:has been |is )?(?:closed|filled)|applications (?:are |have )?(?:now )?(?:closed|ended)|diese stelle ist nicht mehr verf[uü]gbar|bewerbungen sind nicht mehr m[oö]glich)\b/iu.test(
      normalized,
    )
  )
    return "Closed: this vacancy is no longer accepting applications.";
  const until =
    validThrough && Number.isFinite(Date.parse(validThrough))
      ? Date.parse(validThrough) +
        (/^(?:\d{4}-\d{2}-\d{2}|.*T00:00:00\.000Z)$/u.test(validThrough)
          ? 86_400_000
          : 0)
      : null;
  if (until !== null && until < Date.now())
    return "Closed: the published application closing date has passed.";
  return null;
}
