import type { ListingActivity } from "@nestor/contracts";
import { formatOptionalDateOnly } from "./job-finder-utils";

export const listingActivityStatuses = [
  "active",
  "inactive",
  "stale",
  "closed",
  "unknown",
] as const satisfies readonly ListingActivity["status"][];

export type ListingActivityPresentation = {
  description: string;
  label: string;
  observedDate: string | null;
  tone: "positive" | "critical" | "neutral" | "muted";
};

const PROVENANCE_LABELS: Record<string, string> = {
  discovery_ledger: "an earlier search",
  provider: "the job site's own listing feed",
  browser: "opening the page",
  user: "you",
  system: "a routine check",
};

function formatProvenance(value: string): string {
  return PROVENANCE_LABELS[value] ?? "an earlier check";
}

export function presentListingActivity(
  activity: ListingActivity,
): ListingActivityPresentation {
  if (activity.status === "unknown") {
    return {
      description: "Listing availability is unknown.",
      label: "Unknown",
      observedDate: null,
      tone: "neutral",
    };
  }

  const observedDate = formatOptionalDateOnly(activity.observedAt);
  if (activity.status === "active") {
    return {
      description: `Last seen on source ${observedDate}.`,
      label: "Active",
      observedDate,
      tone: "positive",
    };
  }
  if (activity.status === "inactive") {
    return {
      description: `Not found in latest full source refresh on ${observedDate}. This does not prove the listing is closed. ${activity.explanation}`,
      label: "Inactive",
      observedDate,
      tone: "critical",
    };
  }
  if (activity.status === "stale") {
    const detail = activity.detail ? ` ${activity.detail}` : "";
    return {
      description: `This listing may no longer be open — ${formatProvenance(activity.provenance)} last saw it on ${observedDate}. ${activity.explanation}${detail}`,
      label: "May be closed",
      observedDate,
      tone: "neutral",
    };
  }

  const detail = activity.detail ? ` ${activity.detail}` : "";
  return {
    description: `Reported closed by ${formatProvenance(activity.provenance)} on ${observedDate}. ${activity.explanation}${detail}`,
    label: "Closed",
    observedDate,
    tone: "muted",
  };
}
