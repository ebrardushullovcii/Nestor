import type { CandidateProfile } from "@nestor/contracts";
import type { ApplyFormControl } from "./types";

export function addedHistoryKind(label: string): "work" | "education" | null {
  if (!/^add\b/iu.test(label.trim())) return null;
  if (/\b(?:work|employment|experience)\b/iu.test(label)) return "work";
  return /\b(?:education|school|qualification)\b/iu.test(label)
    ? "education"
    : null;
}

export function completeHistoryCount(
  profile: CandidateProfile,
  kind: "work" | "education",
): number {
  const records = kind === "work" ? profile.experiences : profile.education;
  return records.filter(
    (record) =>
      !record.isDraft &&
      ("companyName" in record
        ? record.companyName?.trim() &&
          record.title?.trim() &&
          record.startDate?.trim()
        : record.schoolName?.trim() &&
          record.degree?.trim() &&
          record.endDate?.trim()),
  ).length;
}

export function emptyHistoryRow(
  controls: readonly ApplyFormControl[],
): boolean {
  return (
    controls.length > 0 &&
    controls.every(
      (control) =>
        !control.value.trim() &&
        !control.checked &&
        !control.selectedOptionLabel.trim() &&
        !control.answered,
    )
  );
}
