/** Split exact text at reusable boundaries without changing its contents. */
export function splitPromptCachePrefix(
  text: string,
  lead: string | undefined,
  next?: string,
): { cached: string[]; suffix: string } {
  if (!lead || !text.startsWith(lead)) return { cached: [], suffix: text };
  const rest = text.slice(lead.length);
  return next && rest.startsWith(next)
    ? { cached: [lead, next], suffix: rest.slice(next.length) }
    : { cached: [lead], suffix: rest };
}
