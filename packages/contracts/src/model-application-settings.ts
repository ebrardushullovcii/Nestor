/** Retired review preferences must never contradict the person's actual apply instruction. */
export function withoutLegacyApprovalSettings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLegacyApprovalSettings);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) => key !== "approvalMode" && key !== "humanReviewRequired",
        )
        .map(([key, entry]) => [key, withoutLegacyApprovalSettings(entry)]),
    );
  return value;
}
