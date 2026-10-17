// @vitest-environment jsdom

import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DiscoveryResultsPanel } from "./discovery-results-panel";

/**
 * Three rows printed "26% fit" one under the other and two of them said
 * nothing else, so the order between them was unexplainable. A row that
 * shares its percentage with another row has to say the one thing that
 * separates it.
 */
const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-09-13T10:00:00.000Z",
};

const boundFingerprints = {
  contextFingerprint: "match_context_v4_candidate",
  postingFingerprint: "match_posting_v4_listing",
};

function tiedJob(
  id: string,
  title: string,
  company: string,
  assessment: Record<string, unknown>,
): SavedJob {
  return SavedJobSchema.parse({
    id,
    source: "target_site",
    sourceJobId: `${id}_source`,
    canonicalUrl: `https://jobs.example.test/roles/${id}`,
    title,
    company,
    location: "Chicago, IL",
    workMode: ["hybrid"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-09-13T10:00:00.000Z",
    salaryText: null,
    description: `${title} at ${company}, full listing text captured.`,
    detailQuality: "detail_enriched",
    status: "discovered",
    discoveryMethod: "browser_agent",
    matchAssessment: {
      score: 26,
      judgment: {
        source: "batch",
        judgedAt: "2026-10-02T10:00:00.000Z",
        score: 26,
        recommendation: "review_before_applying",
      },
      ...boundFingerprints,
      dimensions: {
        roleSuitability: { state: "adjacent" },
        preferenceAlignment: { state: "aligned" },
        evidenceConfidence: { level: "moderate" },
      },
      ...assessment,
    },
  });
}

function threeTiedJobs(): readonly SavedJob[] {
  return [
    tiedJob("tie_alliant", "Manager", "Alliant Credit Union", {
      titleFamilyMatch: "adjacent",
      locationReach: "in_area",
      requirements: [
        {
          id: "skill_portfolio",
          category: "skill",
          label: "Loan portfolio management",
          importance: "required",
          status: "partial",
          jobEvidence: "Manages a consumer loan portfolio.",
          resumeEvidence: [],
          explanation: "Some portfolio evidence is present.",
        },
      ],
    }),
    tiedJob("tie_wells", "Lead", "Wells Fargo", {
      titleFamilyMatch: "unrelated",
      locationReach: "in_area",
      requirements: [
        {
          id: "seniority_lead",
          category: "seniority",
          label: "Lead level",
          importance: "required",
          status: "missing",
          jobEvidence: "The listing asks for a lead-level candidate.",
          resumeEvidence: [],
          explanation: "The resume does not show lead-level scope.",
        },
      ],
    }),
    tiedJob(
      "tie_commercial",
      "Senior Lead Commercial Loan Servicing Specialist",
      "Example Bank",
      {
        titleFamilyMatch: "same_family",
        locationReach: "outside_area",
        requirements: [
          {
            id: "skill_servicing",
            category: "skill",
            label: "Commercial loan servicing",
            importance: "required",
            status: "supported",
            jobEvidence: "Services commercial loans daily.",
            resumeEvidence: [],
            explanation: "The resume shows commercial loan servicing.",
          },
        ],
      },
    ),
  ];
}

afterEach(cleanup);

describe("rows that share a percentage", () => {
  it("gives every tied row its own secondary reason", () => {
    const jobs = threeTiedJobs();
    render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={jobs[0] ?? null}
      />,
    );

    const reasons = jobs.map(
      (job) =>
        screen.getByTestId(`discovery-result-fit-reason-${job.id}`)
          .textContent ?? "",
    );

    for (const reason of reasons) {
      expect(reason.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("leaves a row with no shared percentage quiet", () => {
    const jobs = [
      tiedJob("solo_high", "Marketing Manager", "Envisionit", {
        score: 74,
        titleFamilyMatch: "same_family",
        locationReach: "in_area",
        requirements: [],
      }),
      tiedJob("solo_low", "Paid Media Lead", "Other Co", {
        score: 41,
        titleFamilyMatch: "adjacent",
        locationReach: "in_area",
        requirements: [],
      }),
    ];
    render(
      <DiscoveryResultsPanel
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={jobs[0] ?? null}
      />,
    );

    expect(
      screen.queryByTestId("discovery-result-fit-reason-solo_high"),
    ).toBeNull();
    expect(
      screen.queryByTestId("discovery-result-fit-reason-solo_low"),
    ).toBeNull();
  });
});
