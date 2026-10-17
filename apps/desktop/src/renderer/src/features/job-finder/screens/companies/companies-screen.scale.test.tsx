// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CompanyEntity, ReviewCompanyMergeInput } from "@nestor/contracts";
import { CompaniesScreen } from "./companies-screen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const now = "2026-10-13T10:00:00.000Z";
function company(id: string): CompanyEntity {
  return {
    id,
    canonicalName: `Employer ${id}`,
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
  };
}
function props(companies: CompanyEntity[]) {
  return {
    companies,
    discoveryJobs: [],
    actionMessage: null,
    isRefreshPending: false,
    isMergePending: () => false,
    isMutationPending: () => false,
    isPreferencePending: () => false,
    onNavigate: vi.fn(),
    onRefresh: vi.fn().mockResolvedValue(undefined),
    onMutateCompanyIntelligence: vi.fn().mockResolvedValue(undefined),
    onReviewCompanyMerge: vi
      .fn<(value: ReviewCompanyMergeInput) => Promise<void>>()
      .mockResolvedValue(undefined),
    onSetCompanyPreference: vi.fn().mockResolvedValue(undefined),
  };
}

it.each([3_000, 10_000])(
  "pages every one of %i merge candidates with bounded cards and no company finds",
  async (count) => {
    const companies = Array.from({ length: count + 1 }, (_, index) =>
      company(`company_${index}`),
    );
    // A single company may own the entire queue; paging company groups alone is insufficient.
    companies[0]!.mergeReviewCandidates = companies
      .slice(1)
      .map((candidate, index) => ({
        candidateCompanyId: candidate.id,
        decision: "pending",
        decidedAt: null,
        requiresUserDecision: true,
        reason: `Evidence ${index}`,
      }));
    const find = vi.spyOn(companies, "find");
    const input = props(companies);
    const view = render(<CompaniesScreen {...input} />);
    const section = screen
      .getByRole("heading", { name: "Duplicate employer review" })
      .closest("section")!;
    const navigation = within(section).getByRole("navigation", {
      name: "merge candidates pagination",
    });
    expect(navigation.textContent).toContain(`of ${count}`);
    expect(
      view.container.querySelectorAll('[data-testid^="company-card-"]'),
    ).toHaveLength(40);
    const reached = new Set<string>();
    for (let page = 1; page <= Math.ceil(count / 40); page++) {
      const rows = section.querySelectorAll<HTMLElement>(
        "[data-company-merge-candidate]",
      );
      expect(rows.length).toBeLessThanOrEqual(40);
      expect(
        section.querySelectorAll("[data-company-merge-review]").length,
      ).toBeLessThanOrEqual(40);
      for (const row of rows) reached.add(row.dataset.companyMergeCandidate!);
      if (page === 1)
        fireEvent.click(
          within(rows[0]!).getByRole("button", { name: "Reject" }),
        );
      if (page < Math.ceil(count / 40)) {
        fireEvent.click(
          within(navigation).getByRole("button", { name: "Next page" }),
        );
        await waitFor(() =>
          expect(navigation.getAttribute("aria-busy")).toBe("false"),
        );
      } else
        fireEvent.click(
          within(rows[rows.length - 1]!).getByRole("button", { name: "Merge" }),
        );
    }
    expect(reached.size).toBe(count);
    expect(find).not.toHaveBeenCalled();
    expect(
      input.onReviewCompanyMerge.mock.calls.map(([value]) => value),
    ).toEqual([
      {
        companyId: "company_0",
        candidateId: "company_1",
        decision: "rejected",
      },
      {
        companyId: "company_0",
        candidateId: `company_${count}`,
        decision: "accepted",
      },
    ]);
    expect(document.activeElement).toBe(
      within(navigation).getByRole("button", { name: "Previous page" }),
    );
  },
  60_000,
);

it("keeps all 1,000 undecided company groups reachable among 3,000 companies, including unnamed employers", async () => {
  const companies = Array.from({ length: 3_000 }, (_, index) =>
    company(`company_${index}`),
  );
  for (let index = 0; index < 1_000; index++)
    companies[index]!.mergeReviewCandidates = [
      {
        candidateCompanyId: `company_${index + 1_000}`,
        decision: "pending",
        decidedAt: null,
        requiresUserDecision: true,
        reason: `Pending ${index}`,
      },
    ];
  companies[999]!.canonicalName = "Unknown";
  const find = vi.spyOn(companies, "find");
  const input = props(companies);
  const view = render(<CompaniesScreen {...input} isLoading />);
  expect(screen.getByText("Loading companies")).toBeTruthy();
  view.rerender(<CompaniesScreen {...input} isLoading={false} />);
  const section = screen
    .getByRole("heading", { name: "Duplicate employer review" })
    .closest("section")!;
  const nav = within(section).getByRole("navigation", {
    name: "merge candidates pagination",
  });
  const reached = new Set<string>();
  for (let page = 1; page <= 25; page++) {
    expect(
      section.querySelectorAll("[data-company-merge-review]"),
    ).toHaveLength(40);
    for (const row of section.querySelectorAll<HTMLElement>(
      "[data-company-merge-review]",
    ))
      reached.add(row.dataset.companyMergeReview!);
    if (page < 25) {
      fireEvent.click(within(nav).getByRole("button", { name: "Next page" }));
      await waitFor(() => expect(nav.getAttribute("aria-busy")).toBe("false"));
    }
  }
  expect(reached.size).toBe(1_000);
  expect(reached.has("company_999")).toBe(true);
  expect(find).not.toHaveBeenCalled();
}, 30_000);
