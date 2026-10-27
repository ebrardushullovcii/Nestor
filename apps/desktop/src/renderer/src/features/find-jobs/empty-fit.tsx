import { ISO_COUNTRY_CODES, type JobFitSummary } from "@nestor/contracts";
import { useEffect, useState } from "react";

const labels = {
  eligibility: "work authorization",
  eligibility_unconfirmed: "work authorization",
  preferences: "preferences",
  role: "role",
};
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const countryLabel = (country: string) => {
  try {
    return countryNames.of(country) ?? country;
  } catch {
    return country;
  }
};
const countryChoices = new Set(
  ISO_COUNTRY_CODES.flatMap((code) => [
    code.toLowerCase(),
    countryLabel(code).toLowerCase(),
  ]),
);

/** This detail read runs only after the filtered Found list is empty. */
export function useEmptyFitSummary(
  enabled: boolean,
  minFit: number | null,
  revision: unknown,
) {
  const [summary, setSummary] = useState<JobFitSummary | null>(null);
  useEffect(() => {
    setSummary(null);
    if (!enabled || minFit === null) return;
    let live = true;
    void window.nestor.jobs
      .run("fit_summary", { minFit })
      .then((next) => {
        if (live) setSummary(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, minFit, revision]);
  return summary;
}

export function emptyFitReason(
  summary: JobFitSummary | null,
  floor: number | null,
): { detail: string | null; eligibility: boolean } {
  if (!summary?.total) return { detail: null, eligibility: false };
  // Both eligibility limits have one visible reason. Combine them for the
  // same countries before deciding whether authorization explains the list.
  const reasons = new Map<string, (typeof summary.limits)[number]>();
  for (const limit of summary.limits) {
    const kind =
      limit.kind === "eligibility_unconfirmed" ? "eligibility" : limit.kind;
    const key = `${kind}:${[...limit.countries].sort().join(",")}`;
    reasons.set(key, {
      ...limit,
      kind,
      count: limit.count + (reasons.get(key)?.count ?? 0),
    });
  }
  const dominant = [...reasons.values()].find(
    (limit) => limit.count / summary.total >= 0.6,
  );
  if (dominant) {
    const eligibility =
      dominant.kind === "eligibility" ||
      dominant.kind === "eligibility_unconfirmed";
    const countries = dominant.countries.map(countryLabel).join(", ");
    const count =
      dominant.count === summary.total
        ? `All ${summary.total}`
        : `${dominant.count} of ${summary.total}`;
    const missing =
      countries &&
      (summary.workCountries ?? []).every((saved) =>
        countryChoices.has(saved.toLowerCase()),
      ) &&
      dominant.countries.every(
        (code) =>
          !(summary.workCountries ?? []).some(
            (saved) =>
              saved.toLowerCase() === code.toLowerCase() ||
              saved.toLowerCase() === countryLabel(code).toLowerCase(),
          ),
      );
    const detail = eligibility
      ? missing
        ? ` Your profile doesn't list ${countries} as a place you can work.`
        : " Check where you can work and any permit conditions in your profile."
      : "";
    return {
      eligibility,
      detail: `${count} are held back by ${labels[dominant.kind]}${countries ? ` in ${countries}` : ""}.${detail}`,
    };
  }
  const counts = new Map<string, number>();
  for (const limit of summary.limits)
    counts.set(
      labels[limit.kind],
      (counts.get(labels[limit.kind]) ?? 0) + limit.count,
    );
  const reasonCounts = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");
  return {
    eligibility: false,
    detail: `${summary.total} found jobs score below ${floor}.${reasonCounts ? ` Most often: ${reasonCounts}.` : ""}`,
  };
}
