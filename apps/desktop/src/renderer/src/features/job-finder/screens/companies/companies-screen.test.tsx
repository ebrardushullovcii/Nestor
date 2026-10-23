// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  SavedJobSchema,
  type CompanyEntity,
  type DiscoveryJobView,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompaniesScreen } from "./companies-screen";

afterEach(cleanup);

const now = "2026-08-15T10:00:00.000Z";

function makeCompany(overrides: Partial<CompanyEntity> = {}): CompanyEntity {
  return {
    id: "company_1",
    canonicalName: "Acme Inc",
    aliases: [],
    domains: [],
    preference: "neutral",
    preferenceReason: null,
    mergeReviewCandidates: [],
    contacts: [],
    notes: [],
    salaryOfferEvidence: [],
    sourceHistory: [],
    jobIds: [],
    applicationRecordIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function renderScreen(
  overrides: {
    companies?: readonly CompanyEntity[];
    discoveryJobs?: readonly DiscoveryJobView[];
    onRefresh?: ReturnType<typeof vi.fn>;
    onReviewCompanyMerge?: ReturnType<typeof vi.fn>;
    onSetCompanyPreference?: ReturnType<typeof vi.fn>;
    onNavigate?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onRefresh = overrides.onRefresh ?? vi.fn();
  const onReviewCompanyMerge = overrides.onReviewCompanyMerge ?? vi.fn();
  const onSetCompanyPreference = overrides.onSetCompanyPreference ?? vi.fn();
  const onNavigate = overrides.onNavigate ?? vi.fn();
  const view = render(
    <CompaniesScreen
      actionMessage={null}
      companies={overrides.companies ?? [makeCompany()]}
      discoveryJobs={overrides.discoveryJobs ?? []}
      isMergePending={() => false}
      isMutationPending={() => false}
      isPreferencePending={() => false}
      isRefreshPending={false}
      onMutateCompanyIntelligence={vi.fn()}
      onNavigate={onNavigate}
      onRefresh={onRefresh}
      onReviewCompanyMerge={onReviewCompanyMerge}
      onSetCompanyPreference={onSetCompanyPreference}
    />,
  );
  return {
    container: view.container,
    onNavigate,
    onRefresh,
    onReviewCompanyMerge,
    onSetCompanyPreference,
  };
}

describe("CompaniesScreen", () => {
  it("renders an empty state when no companies are reconciled yet", () => {
    renderScreen({ companies: [] });

    expect(screen.getByText("No companies yet")).toBeTruthy();
    expect(
      screen.getByText(/Employers from your saved jobs and applications/i),
    ).toBeTruthy();
    // No duplicate review card when nothing waits on a decision.
    expect(screen.queryByText("Duplicate employer review")).toBeNull();
  });

  it("builds the list itself once when saved jobs exist but no company does", () => {
    const job = SavedJobSchema.parse({
      id: "job_1",
      source: "target_site",
      sourceJobId: "source-job-1",
      canonicalUrl: "https://jobs.example.test/1",
      title: "Engineer",
      company: "Acme Inc",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: now,
      salaryText: null,
      description: "A role.",
      status: "rejected",
      matchAssessment: { score: 80, reasons: [], gaps: [] },
      provenance: [],
    });
    const onRefresh = vi.fn(() => new Promise<void>(() => undefined));
    renderScreen({
      companies: [],
      discoveryJobs: [
        {
          ...job,
          listingActivity: {
            status: "active",
            observedAt: now,
            evidence: "last_seen_at",
          },
        },
      ],
      onRefresh,
    });

    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Listing your employers")).toBeTruthy();
  });

  it("hides legacy absence-placeholder company shells from the list", () => {
    renderScreen({
      companies: [
        makeCompany({
          id: "placeholder",
          canonicalName: "Employer not stated",
          jobIds: ["job_1"],
        }),
        makeCompany({
          id: "real",
          canonicalName: "Acme Inc",
          jobIds: ["job_2"],
        }),
      ],
    });

    expect(screen.queryByText("Employer not stated")).toBeNull();
    expect(screen.getByText("Acme Inc")).toBeTruthy();
    expect(screen.queryByTestId("company-card-placeholder")).toBeNull();
    expect(screen.getByTestId("company-card-real")).toBeTruthy();
  });

  it("hides Albanian privacy-policy utility chrome company shells from the list", () => {
    renderScreen({
      companies: [
        makeCompany({
          id: "privacy",
          canonicalName: "Politikë e Privatësisë",
          jobIds: ["job_privacy"],
        }),
        makeCompany({
          id: "real",
          canonicalName: "Acme Inc",
          jobIds: ["job_2"],
        }),
      ],
    });

    expect(screen.queryByText("Politikë e Privatësisë")).toBeNull();
    expect(screen.getByText("Acme Inc")).toBeTruthy();
    expect(screen.queryByTestId("company-card-privacy")).toBeNull();
    expect(screen.getByTestId("company-card-real")).toBeTruthy();
  });

  it("makes refresh the primary inline action while no companies are reconciled", async () => {
    const { onRefresh } = renderScreen({
      companies: [],
      onRefresh: vi.fn(async () => {}),
    });

    const refreshButtons = screen.getAllByRole("button", {
      name: "Refresh from jobs and applications",
    });
    expect(refreshButtons).toHaveLength(1);

    fireEvent.click(refreshButtons[0]!);
    await vi.waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the persistent header refresh action once companies exist", () => {
    const { onRefresh } = renderScreen({
      onRefresh: vi.fn(async () => {}),
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Refresh from jobs and applications",
      }),
    );
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("searches companies by name, alias, and domain and keeps the count visible", () => {
    renderScreen({
      companies: [
        makeCompany({
          id: "c1",
          canonicalName: "Acme Inc",
          aliases: [
            {
              alias: "Acme Corporation",
              normalized: "acme corporation",
              confidence: 1,
              identityAuthority: "unknown",
            },
          ],
          domains: [{ domain: "acme.com", primary: true, verifiedAt: null }],
        }),
        makeCompany({ id: "c2", canonicalName: "Northwind Labs" }),
      ],
    });

    expect(screen.getByText("Acme Inc")).toBeTruthy();
    expect(screen.getByText("Northwind Labs")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "acme.com" },
    });
    expect(screen.getByText("Acme Inc")).toBeTruthy();
    expect(screen.queryByText("Northwind Labs")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "acme corporation" },
    });
    expect(screen.getByText("Acme Inc")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "northwind" },
    });
    expect(screen.queryByText("Acme Inc")).toBeNull();
    expect(screen.getByText("Northwind Labs")).toBeTruthy();
  });

  it("shows a no-match state without changing selection or filters", () => {
    renderScreen({
      companies: [makeCompany({ id: "c1", canonicalName: "Acme Inc" })],
    });

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "zzz no such company" },
    });

    expect(screen.getByText(/No companies match/)).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Clear search" }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("mounts one page at a time for a 500-plus company catalog", () => {
    const companies = Array.from({ length: 501 }, (_, index) =>
      makeCompany({
        id: `company_${index}`,
        canonicalName: `Company ${String(index).padStart(3, "0")}`,
      }),
    );
    renderScreen({ companies });

    expect(screen.getAllByTestId(/^company-card-/)).toHaveLength(40);
    expect(screen.getByText("1–40 of 501")).toBeTruthy();
    expect(screen.getByText("Page 1 of 13")).toBeTruthy();
    expect(screen.getByText("Company 000")).toBeTruthy();
    expect(screen.queryByText("Company 040")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(screen.getAllByTestId(/^company-card-/)).toHaveLength(40);
    expect(screen.getByText("41–80 of 501")).toBeTruthy();
    expect(screen.getByText("Company 040")).toBeTruthy();
    expect(screen.queryByText("Company 000")).toBeNull();
  });

  it("links a company card to its detail route", () => {
    const { onNavigate } = renderScreen({
      companies: [makeCompany({ id: "company_1", canonicalName: "Acme Inc" })],
    });

    fireEvent.click(screen.getByRole("button", { name: "View company" }));
    expect(onNavigate).toHaveBeenCalledWith("/job-finder/companies/company_1");
  });

  it("surfaces pending merge candidates with explicit merge and reject controls", () => {
    const onReviewCompanyMerge = vi.fn();
    renderScreen({
      companies: [
        makeCompany({
          id: "c1",
          canonicalName: "Acme Inc",
          mergeReviewCandidates: [
            {
              candidateCompanyId: "c2",
              reason: "Similar company name.",
              decision: "pending",
              decidedAt: null,
              requiresUserDecision: true,
            },
          ],
        }),
        makeCompany({ id: "c2", canonicalName: "Acme" }),
      ],
      onReviewCompanyMerge,
    });

    expect(screen.getByText("Duplicate employer review")).toBeTruthy();
    expect(screen.getByText("Possible match: Acme")).toBeTruthy();
    expect(screen.getByText("1 merge review")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReviewCompanyMerge).toHaveBeenCalledWith({
      companyId: "c1",
      candidateId: "c2",
      decision: "rejected",
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    expect(onReviewCompanyMerge).toHaveBeenCalledWith({
      companyId: "c1",
      candidateId: "c2",
      decision: "accepted",
    });
  });

  it("labels company preferences as local tracking without changing persistence", () => {
    const onSetCompanyPreference = vi.fn();
    renderScreen({
      companies: [
        makeCompany({
          id: "c1",
          canonicalName: "Acme Inc",
          preference: "exclude",
        }),
      ],
      onSetCompanyPreference,
    });

    expect(
      screen.getAllByText("Company tracking: exclude").length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(
        "Local company tracking only. This does not change job search or matching.",
      ),
    ).toBeTruthy();

    fireEvent.change(
      screen.getByLabelText("Company tracking preference for Acme Inc"),
      {
        target: { value: "prefer" },
      },
    );
    expect(onSetCompanyPreference).toHaveBeenCalledWith({
      companyId: "c1",
      preference: "prefer",
    });
  });

  it("summarizes listing activity separately from workflow status", () => {
    const baseJob = SavedJobSchema.parse({
      id: "job_1",
      source: "target_site",
      sourceJobId: "source-job-1",
      canonicalUrl: "https://jobs.example.test/1",
      title: "Engineer",
      company: "Acme Inc",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: now,
      salaryText: null,
      description: "A role.",
      status: "rejected",
      matchAssessment: { score: 80, reasons: [], gaps: [] },
      provenance: [],
    });
    renderScreen({
      companies: [makeCompany({ jobIds: ["job_1"] })],
      discoveryJobs: [
        {
          ...baseJob,
          listingActivity: {
            status: "active",
            observedAt: now,
            evidence: "last_seen_at",
          },
        },
      ],
    });

    expect(screen.getByText("Last seen available")).toBeTruthy();
    expect(screen.getByText("Needs verification")).toBeTruthy();
    expect(screen.getByText("Reported closed")).toBeTruthy();
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(1);
  });

  it("styles company tracking selects with canonical tokens, focus hierarchy, and preserved geometry", () => {
    const onSetCompanyPreference = vi.fn();
    const { container } = renderScreen({
      companies: [makeCompany({ id: "c1", canonicalName: "Acme Inc" })],
      onSetCompanyPreference,
    });

    const selects = Array.from(container.querySelectorAll("select"));
    expect(selects.length).toBeGreaterThanOrEqual(1);

    for (const select of selects) {
      for (const className of [
        "border-(--field-border)",
        "bg-(--field)",
        "outline-none",
        "focus-visible:border-(--field-focus-border)",
        "focus-visible:bg-(--field-strong)",
        "focus-visible:shadow-[var(--field-focus-shadow)]",
      ]) {
        expect(select.className).toContain(className);
      }
      expect(select.className).not.toContain("border-input");
      expect(select.className).not.toContain("--surface-panel-raised");
      expect(select.className).not.toContain("focus-visible:ring");
      // Compact card geometry is preserved.
      expect(select.className).toContain("h-9");
      expect(select.className).toContain("px-2");
      expect(select.className).toContain("text-sm");
      expect(select.className).toContain("rounded-(--radius-field)");
    }
    expect(container.innerHTML).not.toContain("border-input");

    // Native select behavior is unchanged.
    fireEvent.change(
      screen.getByLabelText("Company tracking preference for Acme Inc"),
      { target: { value: "prefer" } },
    );
    expect(onSetCompanyPreference).toHaveBeenCalledWith({
      companyId: "c1",
      preference: "prefer",
    });
  });
});
