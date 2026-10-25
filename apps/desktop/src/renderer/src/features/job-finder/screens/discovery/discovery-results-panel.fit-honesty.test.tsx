// @vitest-environment jsdom

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

/**
 * Rendered-string guards for the withheld fit score.
 *
 * The presentation helper was already wired into every surface, but the rule
 * that decides whether a percentage was earned only ever ran against bare
 * fixtures. Against the shape the real scorer emits for a card-only listing —
 * an "adjacent" role verdict, one saved-preference location requirement that
 * stayed unknown, and unavailable evidence confidence — it silently reported
 * "verified" and a bare "54% fit" reached the row. These tests assert the
 * strings a user actually sees for that exact shape.
 */
const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-07-30T10:00:00.000Z",
};

const boundFingerprints = {
  contextFingerprint: "match_context_v4_candidate",
  postingFingerprint: "match_posting_v4_listing",
};

/**
 * The exact assessment shape `createMatchAssessment` produces for a listing
 * whose text was never captured: the title matched a saved target role and
 * nothing else could be read.
 */
function titleOnlyJob(): SavedJob {
  return SavedJobSchema.parse({
    id: "fit_honesty_title_only",
    source: "target_site",
    sourceJobId: "fit_honesty_title_only_source",
    canonicalUrl: "https://jobs.example.test/roles/title-only",
    title: "Software Engineer",
    company: "Futurefit AI",
    location: "Location not stated",
    workMode: [],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-07-30T10:00:00.000Z",
    salaryText: null,
    description: "Software Engineer",
    detailQuality: "card_only",
    status: "discovered",
    discoveryMethod: "browser_agent",
    matchAssessment: {
      score: 54,
      ...boundFingerprints,
      compensationFit: { state: "unknown" },
      dimensions: {
        roleSuitability: {
          state: "adjacent",
          explanation:
            "The title matches, but the listing text was not captured, so nothing beyond the title could be checked.",
          evidence: [],
        },
        preferenceAlignment: { state: "unknown" },
        evidenceConfidence: { level: "unavailable" },
      },
      requirements: [
        {
          id: "location_not_stated",
          category: "location",
          label: "Location (not stated in listing)",
          importance: "required",
          status: "unknown",
          jobEvidence: "The listing does not state a location.",
          resumeEvidence: [],
          explanation:
            "The listing does not state a location, so it could not be compared with the saved search areas.",
        },
      ],
    },
  });
}

function checkedJob(): SavedJob {
  return SavedJobSchema.parse({
    id: "fit_honesty_checked",
    source: "target_site",
    sourceJobId: "fit_honesty_checked_source",
    canonicalUrl: "https://jobs.example.test/roles/checked",
    title: "Senior Software Engineer",
    company: "Checked Company",
    location: "Austin, TX",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-07-30T10:00:00.000Z",
    salaryText: null,
    description: "Full listing text was captured for this role.",
    detailQuality: "detail_enriched",
    status: "discovered",
    discoveryMethod: "browser_agent",
    matchAssessment: {
      score: 78,
      judgment: {
        source: "batch",
        judgedAt: "2026-10-02T10:00:00.000Z",
        score: 78,
        recommendation: "review_before_applying",
      },
      ...boundFingerprints,
      dimensions: {
        roleSuitability: { state: "exact" },
        preferenceAlignment: { state: "aligned" },
        evidenceConfidence: { level: "high" },
      },
      requirements: [
        {
          id: "skill_typescript",
          category: "skill",
          label: "TypeScript",
          importance: "required",
          status: "supported",
          jobEvidence: "TypeScript is used across the platform.",
          resumeEvidence: [],
          explanation: "The resume contains explicit TypeScript evidence.",
        },
      ],
    },
  });
}

function unboundJob(): SavedJob {
  return SavedJobSchema.parse({
    ...checkedJob(),
    id: "fit_honesty_unbound",
    sourceJobId: "fit_honesty_unbound_source",
    canonicalUrl: "https://jobs.example.test/roles/unbound",
    discoveryMethod: "catalog_seed",
    matchAssessment: {
      score: 70,
      contextFingerprint: null,
      postingFingerprint: null,
    },
  });
}

async function renderResults(
  jobs: readonly SavedJob[],
  selected: SavedJob | null,
) {
  const rendered = render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      hasCompletedSearch
      jobs={jobs}
      onSelectJob={vi.fn()}
      selectedJob={selected}
    />,
  );
  await flushFindJobsQueries();
  return rendered;
}

afterEach(() => {
  cleanup();
});

describe("Find jobs fit honesty", () => {
  it("never prints the unearned percentage, and states the title-only fact once per band", async () => {
    const job = titleOnlyJob();
    await renderResults([job], job);

    // The number that was not earned must not appear anywhere on the row.
    expect(screen.queryByText(/54% fit/)).toBeNull();
    expect(screen.queryByText(/Provisional 54% fit/)).toBeNull();
    const row = document.querySelector(`[data-job-result-id="${job.id}"]`);
    expect(row?.textContent).not.toContain("54");

    // The claim now lives on the divider that heads this band, once, instead
    // of on every row underneath it.
    const heading = screen.getByTestId("discovery-results-group-unchecked");
    expect(heading.textContent).toContain("Not yet assessed (1)");
    expect(screen.queryByTestId(`discovery-result-fit-${job.id}`)).toBeNull();
    expect(
      screen.queryByTestId(`discovery-result-fit-reason-${job.id}`),
    ).toBeNull();
    // The verdict and its reason survive for assistive technology on the row,
    // in one sr-only line: the divider is visual-only, so a row reached by
    // keyboard would otherwise lose both.
    const srOnly = screen.getByTestId(`discovery-result-fit-sr-${job.id}`);
    expect(srOnly.className).toContain("sr-only");
    expect(srOnly.textContent).toBe(
      "Overall fit: not judged yet. The AI judges each job against your profile and goals after a search. Choose Judge fit to do this one now.",
    );
    // …and it is the row's only carrier of that reason.
    expect(
      screen.getAllByText(/The AI judges each job against your profile/),
    ).toEqual([srOnly]);
  });

  it("prints 'Fit not assessed' with no number for an unbound assessment", async () => {
    const job = unboundJob();
    await renderResults([job], job);

    const fit = screen.getByTestId(`discovery-result-fit-${job.id}`);
    expect(fit.textContent).toBe("Fit not assessed");
    expect(fit.textContent).not.toContain("70");
  });

  it("still prints the percentage once its evidence was checked", async () => {
    const job = checkedJob();
    await renderResults([job], job);

    expect(
      screen.getByTestId(`discovery-result-fit-${job.id}`).textContent,
    ).toBe("78% fit");
  });
});

it("does not show a strong recommendation beside an unjudged fit", async () => {
  const job = unboundJob();
  job.matchAssessment.recommendation = "strong_fit";
  await renderResults([job], job);
  expect(screen.getAllByText("Fit not assessed").length).toBeGreaterThan(0);
  expect(screen.queryByText("Strong fit")).toBeNull();
});
