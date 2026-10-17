import type { DiscoveryFeedbackReason } from "@nestor/contracts";

export const discoveryFeedbackOptions: ReadonlyArray<{
  value: DiscoveryFeedbackReason;
  label: string;
}> = [
  { value: "role", label: "Role" },
  { value: "seniority", label: "Seniority" },
  { value: "location", label: "Location" },
  { value: "work_mode", label: "Work mode" },
  { value: "compensation", label: "Compensation" },
  { value: "company", label: "Company" },
  { value: "missing_requirement", label: "Missing requirement" },
  { value: "duplicate", label: "Duplicate" },
  { value: "other", label: "Other" },
];

/** Maps a stored hide reason to the label the user picked it by. */
export function formatDiscoveryHideReason(reason: string): string {
  return (
    discoveryFeedbackOptions.find((option) => option.value === reason)?.label ??
    reason
  );
}
