// @vitest-environment jsdom

import { Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import {
  CompanyEntitySchema,
  SavedJobSchema,
  type CompanyEntity,
  type DiscoveryJobView,
  type JobFinderRendererWorkspaceSnapshot,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";

import type { JobFinderPageContext } from "./job-finder-page-context";
import { JobFinderCompanyDetailRoute } from "./job-finder-page-routes";

const now = "2026-08-23T10:00:00.000Z";

function makeJob(input: {
  id: string;
  title: string;
  status: "rejected" | "submitted" | "archived";
  activity: DiscoveryJobView["listingActivity"];
}): DiscoveryJobView {
  return {
    ...SavedJobSchema.parse({
      id: input.id,
      source: "target_site",
      sourceJobId: `source-${input.id}`,
      canonicalUrl: `https://jobs.example.test/${input.id}`,
      title: input.title,
      company: "Acme Inc",
      location: "Remote",
      workMode: ["remote"],
      applyPath: "external_redirect",
      easyApplyEligible: false,
      discoveredAt: now,
      salaryText: null,
      description: "A retained company opening.",
      status: input.status,
      matchAssessment: { score: 80, reasons: [], gaps: [] },
      provenance: [],
    }),
    listingActivity: input.activity,
  };
}

function createContext(
  companies?: readonly CompanyEntity[],
): JobFinderPageContext {
  const companyJobs = [
    makeJob({
      id: "rejected-active",
      title: "Rejected active role",
      status: "rejected",
      activity: {
        status: "active",
        observedAt: now,
        evidence: "last_seen_at",
      },
    }),
    makeJob({
      id: "submitted-closed",
      title: "Submitted closed role",
      status: "submitted",
      activity: {
        status: "closed",
        observedAt: now,
        signalId: "closed-signal",
        provenance: "provider",
        explanation: "The provider marked this listing closed.",
        detail: null,
        confidence: 1,
      },
    }),
    makeJob({
      id: "dismissed-archived",
      title: "Dismissed role",
      status: "archived",
      activity: { status: "unknown" },
    }),
    makeJob({
      id: "archived-active",
      title: "Archived active role",
      status: "archived",
      activity: {
        status: "active",
        observedAt: now,
        evidence: "last_seen_at",
      },
    }),
  ];
  const company = CompanyEntitySchema.parse({
    id: "company-acme",
    canonicalName: "Acme Inc",
    jobIds: companyJobs.map((job) => job.id),
    createdAt: now,
    updatedAt: now,
  });

  return {
    actionState: { message: null },
    isPending: vi.fn(() => false),
    onMutateCompanyIntelligence: vi.fn(async () => {}),
    onNavigateSafely: vi.fn(),
    onRefreshCompanyIntelligence: vi.fn(async () => {}),
    onReviewCompanyMerge: vi.fn(async () => {}),
    onSelectApplicationRecord: vi.fn(),
    onSelectDiscoveryJob: vi.fn(),
    onSetCompanyPreference: vi.fn(async () => {}),
    workspace: {
      hydration: { phase: "complete", deferredCollections: [] },
      intelligence: {
        companies: companies ?? [company],
        safeguards: { companyApplicationCaps: [] },
      },
      applicationRecords: [],
      discoveryJobs: [],
      dismissedDiscoveryJobs: [],
      companyJobs,
    } as unknown as JobFinderRendererWorkspaceSnapshot,
  } as unknown as JobFinderPageContext;
}

function makeCompany(id: string, canonicalName: string): CompanyEntity {
  return CompanyEntitySchema.parse({
    id,
    canonicalName,
    jobIds: [],
    createdAt: now,
    updatedAt: now,
  });
}

function DetailRouteHarness(props: {
  context: JobFinderPageContext;
  initialEntry?: string;
}) {
  const detailRoute = (
    <Suspense fallback={null}>
      <JobFinderCompanyDetailRoute />
    </Suspense>
  );

  return (
    <MemoryRouter
      initialEntries={[
        props.initialEntry ?? "/job-finder/companies/company-acme",
      ]}
    >
      <Routes>
        <Route element={<Outlet context={props.context} />}>
          <Route
            path="/job-finder/companies/:companyId"
            element={detailRoute}
          />
          <Route path="/job-finder/company-detail" element={detailRoute} />
          <Route
            path="/job-finder/companies"
            element={<p>Companies index</p>}
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe("JobFinderCompanyDetailRoute", () => {
  it("retains activity groups and workflow statuses for all company-linked jobs", async () => {
    render(<DetailRouteHarness context={createContext()} />);

    expect(
      await screen.findByText("Openings (4)", {}, { timeout: 15_000 }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "2 last seen available · 1 need verification · 1 reported closed",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Workflow: Rejected/)).toBeTruthy();
    expect(screen.getByText(/Workflow: Submitted/)).toBeTruthy();
    expect(screen.getAllByText(/Workflow: Archived/)).toHaveLength(2);
    expect(screen.getByText("Dismissed role")).toBeTruthy();
    expect(screen.getByText("Archived active role")).toBeTruthy();
  }, 20_000);

  it("fails closed for a stale company ID when other companies remain", async () => {
    const unrelatedCompany = makeCompany("company-other", "Other Corp");
    const context = createContext([unrelatedCompany]);

    render(<DetailRouteHarness context={context} />);

    expect(await screen.findByText("Company not found")).toBeTruthy();
    expect(screen.queryByText("Other Corp")).toBeNull();
    expect(context.onMutateCompanyIntelligence).not.toHaveBeenCalled();
    expect(context.onReviewCompanyMerge).not.toHaveBeenCalled();
    expect(context.onSetCompanyPreference).not.toHaveBeenCalled();
  });

  it("shows not found for a stale company ID when the company list is empty", async () => {
    render(<DetailRouteHarness context={createContext([])} />);

    expect(await screen.findByText("Company not found")).toBeTruthy();
  });

  it("redirects a route with no company ID to the companies index", async () => {
    render(
      <DetailRouteHarness
        context={createContext()}
        initialEntry="/job-finder/company-detail"
      />,
    );

    expect(await screen.findByText("Companies index")).toBeTruthy();
  });

  it("fails closed when the routed company disappears on rerender", async () => {
    const initialContext = createContext();
    const { rerender } = render(
      <DetailRouteHarness context={initialContext} />,
    );

    expect(
      await screen.findByText("Acme Inc", {}, { timeout: 15_000 }),
    ).toBeTruthy();

    const unrelatedCompany = makeCompany("company-other", "Other Corp");
    const refreshedContext = createContext([unrelatedCompany]);
    rerender(<DetailRouteHarness context={refreshedContext} />);

    expect(await screen.findByText("Company not found")).toBeTruthy();
    expect(screen.queryByText("Acme Inc")).toBeNull();
    expect(screen.queryByText("Other Corp")).toBeNull();
    expect(refreshedContext.onMutateCompanyIntelligence).not.toHaveBeenCalled();
    expect(refreshedContext.onReviewCompanyMerge).not.toHaveBeenCalled();
    expect(refreshedContext.onSetCompanyPreference).not.toHaveBeenCalled();
  });
});
