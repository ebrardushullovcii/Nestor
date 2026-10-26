import type { SavedOptionFallback } from "@nestor/contracts";
import { matchOption } from "./option-match";

/** The person's ordered rule, applied only against the form's actual choices. */
export function resolveOptionFallback(
  options: readonly string[],
  rule: SavedOptionFallback,
):
  | { kind: "unknown" }
  | { kind: "choice"; value: string }
  | { kind: "skip"; reason: string } {
  if (!options.length) return { kind: "unknown" };
  const value =
    matchOption(options, rule.primary) ?? matchOption(options, rule.fallback);
  return value
    ? { kind: "choice", value }
    : {
        kind: "skip",
        reason: `The form's list has neither ${rule.primary} nor ${rule.fallback}. Your saved rule says to skip this application.`,
      };
}
