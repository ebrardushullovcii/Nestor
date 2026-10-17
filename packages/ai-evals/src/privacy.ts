import type { EvalCase } from "./contracts";

const forbiddenPersonalMarkers = [
  "ebrar",
  "resume-tests",
  "appdata\\roaming\\@nestor",
  "appdata/roaming/@nestor",
  // Pre-rename data folders (ADR 0040, ADR 0052) can still appear in older captures.
  "appdata\\roaming\\@nordri",
  "appdata/roaming/@nordri",
  "appdata\\roaming\\@unemployed",
  "appdata/roaming/@unemployed",
  "documents\\jobsources",
  "documents/jobsources",
] as const;

const nonSyntheticEmailPattern =
  /\b[a-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[a-z0-9.-]+\.[a-z]{2,}\b/i;
const localPathPattern = /\b[a-z]:[\\/](?!synthetic[\\/])/i;

export function findEvalPrivacyViolations(
  evalCase: EvalCase,
): readonly string[] {
  const serialized = JSON.stringify(evalCase).toLowerCase();
  const violations: string[] = forbiddenPersonalMarkers.filter((marker) =>
    serialized.includes(marker),
  );

  if (nonSyntheticEmailPattern.test(serialized)) {
    violations.push("non-synthetic email address");
  }
  if (localPathPattern.test(serialized)) {
    violations.push("unexpected local filesystem path");
  }
  return violations;
}

export function assertEvalCorpusPrivacy(cases: readonly EvalCase[]): void {
  const failures = cases.flatMap((evalCase) =>
    findEvalPrivacyViolations(evalCase).map(
      (violation) => `${evalCase.id}: ${violation}`,
    ),
  );
  if (failures.length > 0) {
    throw new Error(`Evaluation privacy scan failed:\n${failures.join("\n")}`);
  }
}
