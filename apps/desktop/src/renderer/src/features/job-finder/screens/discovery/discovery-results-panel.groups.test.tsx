// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SavedJobSchema, type SavedJob } from "@nestor/contracts";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DISCOVERY_RESULTS_PAGE_SIZE } from "./discovery-results-panel";
import {
  buildDiscoveryResultGroupHeadings,
  countDiscoveryDefaultVisibleResults,
  countDiscoveryStrongMatches,
  countDiscoveryUncheckedResults,
  getDiscoveryResultGroup,
  isDiscoveryAlsoFoundResult,
  orderDiscoveryResultsByGroup,
} from "./discovery-result-groups";
import { createDiscoveryRunSucceededFeedback } from "./discovery-run-feedback";
import {
  DiscoveryResultsPanelWithJobs,
  flushFindJobsQueries,
} from "./find-jobs-query-fixture.test-support";

const browserSession = {
  source: "target_site" as const,
  status: "ready" as const,
  driver: "chrome_profile_agent" as const,
  label: "Browser ready",
  detail: "Browser session is ready.",
  lastCheckedAt: "2026-08-23T10:00:00.000Z",
};

/**
 * Builds a row whose score is *earned* by default: banding by score is only
 * meaningful once at least one dimension was actually verified, so the
 * fixture states that premise instead of leaving it to schema defaults. Pass
 * `titleOnly` for a listing the model has not judged yet (ADR 0041).
 */
function job(input: {
  id: string;
  score: number;
  provisional?: boolean;
  recommendation?: string;
  titleOnly?: boolean;
  gaps?: readonly string[];
}): SavedJob {
  return SavedJobSchema.parse({
    id: input.id,
    source: "target_site",
    sourceJobId: `source_${input.id}`,
    canonicalUrl: `https://jobs.example.test/${input.id}`,
    applicationUrl: `https://jobs.example.test/${input.id}/apply`,
    title: `Role ${input.id}`,
    company: "Mega Corp",
    location: "Remote",
    workMode: ["remote"],
    applyPath: "external_redirect",
    easyApplyEligible: false,
    discoveredAt: "2026-08-23T10:00:00.000Z",
    postedAt: null,
    salaryText: null,
    description: `Own systems for ${input.id}.`,
    status: "discovered",
    discoveryMethod: input.provisional ? "catalog_seed" : "browser_agent",
    matchAssessment: {
      score: input.score,
      reasons: ["Relevant experience"],
      gaps: [...(input.gaps ?? [])],
      recommendation: input.recommendation ?? "review_before_applying",
      ...(input.titleOnly
        ? {}
        : {
            dimensions: { roleSuitability: { state: "exact" } },
            judgment: {
              source: "batch",
              judgedAt: "2026-08-23T10:00:00.000Z",
              score: input.score,
              recommendation: input.recommendation ?? "review_before_applying",
            },
          }),
      ...(input.provisional
        ? {}
        : {
            contextFingerprint: "context_v1",
            postingFingerprint: `posting_${input.id}`,
          }),
    },
  });
}

beforeEach(() => {
  window.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage?.clear();
});

describe("discovery result bands", () => {
  it("keeps the header to a plain count and leaves the run report to the banner", async () => {
    const runReportLabel = "57 found · 35 new · 15 kept · 47 duplicates merged";
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[job({ id: "report", score: 72 })]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();
    const banner = createDiscoveryRunSucceededFeedback(null, runReportLabel);

    // The list says how many rows it holds; the finished search's own
    // banner is where its frozen accounting is quoted.
    expect(screen.getByTestId("discovery-result-count").textContent).toBe(
      "1 job",
    );
    expect(banner.headline).toContain(runReportLabel);
  });

  it("keeps location counts within the visible result set", async () => {
    const inArea = {
      ...job({ id: "chicago", score: 72 }),
      location: "Chicago, IL",
      matchAssessment: {
        ...job({ id: "chicago", score: 72 }).matchAssessment,
        locationReach: "in_area" as const,
      },
    };
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        inAreaJobCount={2}
        jobs={[inArea]}
        onSelectJob={vi.fn()}
        preferredLocations={["Chicago, IL"]}
        selectedJob={inArea}
        totalLocationJobCount={15}
      />,
    );
    await flushFindJobsQueries();

    expect(
      screen.getByText(/1 of 1 assessed jobs in or near Chicago, IL/u),
    ).toBeTruthy();
  });

  it("bands rows by verified score and never demotes a withheld one", () => {
    expect(getDiscoveryResultGroup(job({ id: "strong", score: 64 }))).toBe(
      "matches",
    );
    expect(getDiscoveryResultGroup(job({ id: "weak", score: 36 }))).toBe(
      "weaker",
    );
    expect(getDiscoveryResultGroup(job({ id: "off", score: 18 }))).toBe(
      "mismatches",
    );
    // An unbound assessment describes some other profile or listing text, so
    // it is neither recommended nor demoted: it was never checked.
    expect(
      getDiscoveryResultGroup(
        job({ id: "provisional", score: 36, provisional: true }),
      ),
    ).toBe("unchecked");
  });

  it("never puts a closed listing in the worth-opening band", () => {
    // The model read the listing as closed (ADR 0041); no phrase list does.
    const base = job({ id: "closed_high_score", score: 92 });
    const closed = {
      ...base,
      matchAssessment: {
        ...base.matchAssessment,
        judgment: {
          ...base.matchAssessment.judgment!,
          listingClosed: true,
          listingClosedEvidence: "This role is closed to new applicants.",
        },
      },
    };

    expect(getDiscoveryResultGroup(closed)).toBe("mismatches");
    expect(countDiscoveryStrongMatches([closed])).toBe(0);
  });

  it("never promotes or demotes a title-only row by a score it refuses to print", () => {
    // The row itself says "Not judged yet — no pay, location, or
    // requirements were captured". Filing it under "Clear mismatches — they
    // conflict with your saved requirements" hides it for a reason the app
    // has just said it cannot assess; filing it under "Matches" claims the
    // app checked something it never opened. It gets its own band.
    for (const score of [64, 36, 18]) {
      expect(
        getDiscoveryResultGroup(
          job({ id: `title_only_${score}`, score, titleOnly: true }),
        ),
      ).toBe("unchecked");
    }
    // An observed hard conflict is still a real verdict, not a withheld score.
    expect(
      getDiscoveryResultGroup(
        job({
          id: "title_only_skip",
          score: 18,
          titleOnly: true,
          recommendation: "skip",
        }),
      ),
    ).toBe("mismatches");
  });

  it("keeps every row the model has not judged in the unchecked band", () => {
    // No verdict, no judgement for or against it, whatever its old gap text.
    expect(
      getDiscoveryResultGroup(
        job({
          id: "title_silent",
          score: 64,
          titleOnly: true,
          gaps: ["Pay not stated."],
        }),
      ),
    ).toBe("unchecked");
  });

  it("keeps a title-only row out of both the recommended and the also-found pools", () => {
    const titleOnly = job({ id: "title_only", score: 64, titleOnly: true });
    // Neither claim is available: the app cannot recommend a listing it never
    // opened, and it cannot demote one either.
    expect(isDiscoveryAlsoFoundResult(titleOnly)).toBe(false);
    expect(countDiscoveryStrongMatches([titleOnly])).toBe(0);
    // Only a hard conflict moves a title-only row into the hidden pool.
    expect(
      isDiscoveryAlsoFoundResult(
        job({
          id: "title_only_skip",
          score: 64,
          titleOnly: true,
          recommendation: "skip",
        }),
      ),
    ).toBe(true);
  });

  it("splits every result into exactly one of the three populations", () => {
    const jobs = [
      job({ id: "strong", score: 72 }),
      job({ id: "weak", score: 40 }),
      job({ id: "off", score: 18 }),
      job({ id: "title_only", score: 30, titleOnly: true }),
      job({ id: "provisional", score: 30, provisional: true }),
      job({
        id: "title_only_skip",
        score: 30,
        titleOnly: true,
        recommendation: "skip",
      }),
    ];

    const worthOpening = countDiscoveryStrongMatches(jobs);
    const titleMatches = countDiscoveryUncheckedResults(jobs);
    const alsoFound = jobs.filter(isDiscoveryAlsoFoundResult).length;

    expect([worthOpening, titleMatches, alsoFound]).toEqual([1, 2, 3]);
    expect(worthOpening + titleMatches + alsoFound).toBe(jobs.length);
    // Home's sidebar badge reads the rows Find jobs lists by default, which is
    // the same split seen from the other side: everything but the also-found
    // pool. The two surfaces can therefore never report different totals.
    expect(countDiscoveryDefaultVisibleResults(jobs)).toBe(
      worthOpening + titleMatches,
    );
  });

  it("leaves only the leading matches run unlabelled, and only in ranked order", () => {
    const jobs = [
      job({ id: "a", score: 72 }),
      job({ id: "b", score: 64 }),
      job({ id: "c", score: 36 }),
      job({ id: "d", score: 36 }),
    ];

    const ranked = buildDiscoveryResultGroupHeadings(jobs, true);
    expect(ranked.get("c")).toEqual({
      count: 2,
      description:
        "These scored well below your saved targets. Open one before trusting its score.",
      id: "weaker",
      // The divider names the pool the summary line and the reveal control
      // name, then the part inside it.
      label: "Weaker matches",
    });
    expect(ranked.has("a")).toBe(false);
    expect(ranked.has("d")).toBe(false);

    // A list that opens with the weaker band IS labelled. It used to be
    // suppressed on the reasoning that an opening band has nothing above it to
    // be divided from, but a heading is not only a divider — it carries the
    // band's claim. Suppressing it left a single-band list stating nothing at
    // all about rows the app had scored below the saved targets, and left an
    // all-unchecked list silent about never having read them.
    const weakerOnly = buildDiscoveryResultGroupHeadings(
      [jobs[2]!, jobs[3]!],
      true,
    );
    expect([...weakerOnly.values()].map((heading) => heading.id)).toEqual([
      "weaker",
    ]);
    expect([...weakerOnly.values()].map((heading) => heading.count)).toEqual([
      2,
    ]);
    // Any other sort re-interleaves the bands, so dividers are withheld.
    expect(buildDiscoveryResultGroupHeadings(jobs, false).size).toBe(0);
  });

  it("heads every run, so a divider never claims rows that sit below the next one", () => {
    // The canonical order sorts bound rows purely by score, and a title-only
    // row is bound — so it lands between the weaker and mismatch rows while
    // keeping its own band. Heading only the first row of each band would
    // print "Weaker matches (1)" above two rows and file an unchecked row
    // under the weaker and mismatch dividers.
    const jobs = [
      job({ id: "verified_strong", score: 72 }),
      job({ id: "verified_weak", score: 40 }),
      job({ id: "title_only", score: 30, titleOnly: true }),
      job({ id: "verified_mismatch", score: 28 }),
    ];

    const headings = buildDiscoveryResultGroupHeadings(jobs, true);
    expect(
      [...headings].map(([id, heading]) => [id, heading.id, heading.count]),
    ).toEqual([
      ["verified_weak", "weaker", 1],
      ["title_only", "unchecked", 1],
      ["verified_mismatch", "mismatches", 1],
    ]);
    expect(headings.get("title_only")?.label).toBe("Not yet assessed");
    // The one line under the label states what was and was not read. It must
    // not promise a capability the app does not have — there is no
    // external-URL action — and it must not send the user to an inspector
    // that holds nothing the row does not already show.
    const description = headings.get("title_only")?.description ?? "";
    expect(description).toBe(
      "The full requirements have not been assessed. Check the role and level before applying.",
    );
    for (const promise of ["Open", "open", "browser", "link"]) {
      expect(description).not.toContain(promise);
    }
  });

  it("renders each divider directly above the rows it counts", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[
          job({ id: "verified_strong", score: 72 }),
          job({ id: "verified_weak", score: 40 }),
          job({ id: "title_only", score: 30, titleOnly: true }),
          job({ id: "verified_mismatch", score: 28 }),
        ]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(
      screen
        .getAllByTestId(/^discovery-results-group-/u)
        .map((heading) => heading.textContent?.split(")")[0] ?? ""),
    ).toEqual([
      "Weaker matches (1",
      "Clear mismatches (1",
      "Not yet assessed (1",
    ]);
    // Each stable divider immediately precedes the first row it heads.
    const titleOnlyRow = screen.getByTestId(
      "discovery-results-group-unchecked",
    ).nextElementSibling;
    expect(
      titleOnlyRow
        ?.querySelector("[data-job-result-id]")
        ?.getAttribute("data-job-result-id"),
    ).toBe("title_only");
  });

  it("keeps one contiguous band per caption in the canonical ranking", () => {
    const ordered = orderDiscoveryResultsByGroup([
      job({ id: "unchecked_high", score: 62, titleOnly: true }),
      job({ id: "weaker", score: 40 }),
      job({ id: "unchecked_low", score: 30, titleOnly: true }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "weaker",
      "unchecked_high",
      "unchecked_low",
    ]);
    expect(
      [...buildDiscoveryResultGroupHeadings(ordered, true).values()].map(
        (heading) => [heading.label, heading.count],
      ),
    ).toEqual([
      ["Weaker matches", 1],
      ["Not yet assessed", 2],
    ]);
  });

  it("divides weaker results in the list instead of presenting one flat ranking", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[
          job({ id: "strong_a", score: 72 }),
          job({ id: "strong_b", score: 64 }),
          job({ id: "weak_a", score: 36 }),
        ]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    const heading = screen.getByTestId("discovery-results-group-weaker");
    expect(heading.textContent).toContain("Weaker matches (1)");
    expect(screen.queryByTestId("discovery-results-group-mismatches")).toBe(
      null,
    );
  });

  // 10 leading matches then 60 weaker rows: the weaker band opens on page 1
  // and continues onto page 2.
  async function renderPaginatedBands(): Promise<void> {
    const jobs = [
      ...Array.from({ length: 10 }, (_, index) =>
        job({ id: `strong_${index}`, score: 72 }),
      ),
      ...Array.from({ length: 60 }, (_, index) =>
        job({ id: `weak_${index}`, score: 36 }),
      ),
    ];
    expect(jobs.length).toBeGreaterThan(DISCOVERY_RESULTS_PAGE_SIZE);

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();
  }

  it("counts a band heading over the whole band, the way the reveal control does", async () => {
    await renderPaginatedBands();

    // Page 1 shows 10 matches then the first 40 of 60 weaker rows. A
    // page-scoped "(40)" here and "(20)" on page 2 sat under one control
    // reading "Hide weaker matches (60)", with nothing on screen reconciling
    // them; the divider names the band, and pagination is the pager's story.
    expect(
      screen.getByTestId("discovery-results-group-weaker").textContent,
    ).toContain("Weaker matches (60)");
  });

  it("still draws the band divider on a page that opens mid-band", async () => {
    await renderPaginatedBands();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flushFindJobsQueries();

    // Page 2 is entirely the continuation of the weaker band. Without a
    // divider here it is indistinguishable from a page of real matches, and
    // the count is the same band total it carried on page 1.
    expect(
      screen.getByTestId("discovery-results-group-weaker").textContent,
    ).toContain("Weaker matches (60)");
  });

  it("makes revealing the also-found pool change the count, the label, and the list", async () => {
    const shown = [job({ id: "strong_a", score: 72 })];
    const mismatch = job({ id: "off_a", score: 18 });
    const onToggleAlsoFound = vi.fn();

    const { rerender } = render(
      <DiscoveryResultsPanelWithJobs
        areAlsoFoundShown={false}
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={1}
        jobs={shown}
        alsoFoundCount={1}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={onToggleAlsoFound}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.getByText("1 job")).toBeTruthy();
    // The accessible name is exactly the visible label, so the reveal is
    // reachable by the name a user actually reads.
    fireEvent.click(
      screen.getByRole("button", { name: "Show weaker matches (1)" }),
    );
    await flushFindJobsQueries();
    expect(onToggleAlsoFound).toHaveBeenCalledTimes(1);

    rerender(
      <DiscoveryResultsPanelWithJobs
        areAlsoFoundShown
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={0}
        jobs={[...shown, mismatch]}
        alsoFoundCount={1}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={onToggleAlsoFound}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(
      screen.getByRole("button", { name: "Hide weaker matches (1)" }),
    ).toBeTruthy();
    // The matches keep the number the sidebar shows; the revealed pool is
    // named beside it rather than folded into a third total.
    expect(screen.getByText("1 match + 1 weaker")).toBeTruthy();
    expect(
      screen.getByTestId("discovery-results-group-mismatches").textContent,
    ).toContain("Clear mismatches (1)");
  });

  it("names the revealed pool on both of its dividers, in the reveal control's words", async () => {
    // One vocabulary from the count through the control to the divider. The
    // summary line and the button called the pool "also found" while the
    // dividers underneath called its two halves "Weaker matches" and "Clear
    // mismatches", so nothing on screen connected what was revealed with what
    // was then labelled.
    render(
      <DiscoveryResultsPanelWithJobs
        alsoFoundCount={2}
        areAlsoFoundShown
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={0}
        jobs={[
          job({ id: "strong", score: 72 }),
          job({ id: "weak", score: 36 }),
          job({ id: "off", score: 18 }),
        ]}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.getByTestId("discovery-result-count").textContent).toContain(
      "1 match + 2 weaker",
    );
    expect(
      screen.getByRole("button", { name: "Hide weaker matches (2)" }),
    ).toBeTruthy();
    // The pool first, then the part it splits into.
    expect(
      screen.getByTestId("discovery-results-group-weaker").textContent,
    ).toContain("Weaker matches (1)");
    expect(
      screen.getByTestId("discovery-results-group-mismatches").textContent,
    ).toContain("Clear mismatches (1)");
    // The unchecked band is deliberately NOT in that pool, so it must never
    // borrow its name.
    expect(screen.queryAllByText(/^Also found · Matches your role/u)).toEqual(
      [],
    );
  });
});

describe("discovery three-band result counts", () => {
  it("prints all three populations when nothing was checked past the titles", async () => {
    // The r15 live shape: 13 title-only rows plus 2 rows with a real hard
    // conflict. Reporting "13 worth opening" claims 13 checks that never ran;
    // reporting "13 also found" demotes them by a score the app withheld.
    const titleOnly = Array.from({ length: 13 }, (_, index) =>
      job({ id: `title_only_${index}`, score: 44, titleOnly: true }),
    );

    render(
      <DiscoveryResultsPanelWithJobs
        alsoFoundCount={2}
        areAlsoFoundShown={false}
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={2}
        jobs={titleOnly}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    // The header counts the rows on the list; the band divider below it is
    // where "matched on the title alone" is said.
    expect(screen.getByTestId("discovery-result-count").textContent).toContain(
      "13 jobs",
    );
  });

  it("keeps one evidenced match apart from the title-only remainder", async () => {
    // The r9 shape: one row with checked evidence, fourteen title matches.
    const jobs = [
      job({ id: "evidenced", score: 64 }),
      ...Array.from({ length: 14 }, (_, index) =>
        job({ id: `title_only_${index}`, score: 44, titleOnly: true }),
      ),
    ];

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(screen.getByTestId("discovery-result-count").textContent).toContain(
      "15 jobs",
    );
    // Home's badge reads the same populations through the same predicates, so
    // the sidebar count and this headline can never disagree: the badge is
    // the two visible bands, and the headline prints them separately.
    expect(countDiscoveryStrongMatches(jobs)).toBe(1);
    expect(countDiscoveryUncheckedResults(jobs)).toBe(14);
    expect(countDiscoveryDefaultVisibleResults(jobs)).toBe(15);
  });

  it("labels an all-unchecked list, where the claim matters most", async () => {
    // The live r16 state: fourteen rows, every one matched on its title
    // alone. With the heading suppressed this rendered as a bare list with no
    // statement anywhere that these were never read — the exact honesty gap
    // the band exists to close. A single-band list is not a list that needs
    // no divider; it is a list that IS one band, and it has to say which.
    const jobs = Array.from({ length: 14 }, (_, index) =>
      job({ id: `title_only_${index}`, score: 44, titleOnly: true }),
    );

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    const headings = screen.getAllByTestId(/^discovery-results-group-/u);
    // Exactly one, at the top, covering every row.
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent).toContain("Not yet assessed (14)");
    expect(headings[0]!.textContent).not.toContain("The full requirements");
    expect(screen.getByTestId("discovery-result-count").textContent).toContain(
      "14 jobs",
    );
    // The divider makes the claim once for the run it heads, so the rows
    // beneath it no longer repeat it fourteen times over. Only the visible
    // restatement goes: each row still carries the verdict for assistive
    // technology, because a row button is reachable without reading the
    // divider.
    expect(screen.queryAllByText("Not judged yet")).toHaveLength(0);
    expect(
      screen.queryAllByTestId(/^discovery-result-fit-reason-/u),
    ).toHaveLength(0);
    expect(
      screen.getAllByTestId(/^discovery-result-fit-sr-/u).map((node) => ({
        srOnly: node.className.includes("sr-only"),
        text: node.textContent,
      })),
    ).toEqual(
      Array.from({ length: 14 }, () => ({
        srOnly: true,
        // The divider is a plain div outside the arrow-key traversal, so the
        // reason the visible rows gave up survives on the row itself.
        text: "Overall fit: not judged yet. The AI judges each job against your profile and goals after a search. Choose Judge fit to do this one now.",
      })),
    );
  });

  it("leaves a leading run of plain matches unlabelled, and only that", () => {
    // A list that opens with checked, well-scoring rows on its first page is
    // the baseline an unlabelled result list already means, so heading it
    // would be noise. Every other opening band is labelled.
    const allMatches = [
      job({ id: "a", score: 72 }),
      job({ id: "b", score: 64 }),
    ];
    expect(buildDiscoveryResultGroupHeadings(allMatches, true).size).toBe(0);

    const opensWeaker = [
      job({ id: "c", score: 36 }),
      job({ id: "d", score: 36 }),
    ];
    const weakerHeadings = buildDiscoveryResultGroupHeadings(opensWeaker, true);
    expect([...weakerHeadings.values()].map((heading) => heading.id)).toEqual([
      "weaker",
    ]);

    const opensMismatch = [job({ id: "e", score: 18 })];
    expect(
      [...buildDiscoveryResultGroupHeadings(opensMismatch, true).values()].map(
        (heading) => heading.id,
      ),
    ).toEqual(["mismatches"]);
  });

  it("drops the row restatement only under the divider that already makes it", async () => {
    // Three title-only rows, two bands. The two under the unchecked divider
    // say nothing more; the one banded as a mismatch by an observed conflict
    // keeps its chip and its caption, because the divider above THAT run says
    // nothing about what was read.
    render(
      <DiscoveryResultsPanelWithJobs
        alsoFoundCount={1}
        areAlsoFoundShown
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={0}
        jobs={[
          job({ id: "unchecked_a", score: 64, titleOnly: true }),
          job({ id: "unchecked_b", score: 44, titleOnly: true }),
          job({
            id: "conflicted",
            score: 18,
            recommendation: "skip",
            titleOnly: true,
          }),
        ]}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    for (const id of ["unchecked_a", "unchecked_b"]) {
      expect(screen.queryByTestId(`discovery-result-fit-${id}`)).toBeNull();
      expect(
        screen.queryByTestId(`discovery-result-fit-reason-${id}`),
      ).toBeNull();
      expect(
        screen.getByTestId(`discovery-result-fit-sr-${id}`).className,
      ).toContain("sr-only");
    }

    expect(
      screen.getByTestId("discovery-result-fit-conflicted").textContent,
    ).toBe("Not judged yet");
    expect(
      screen.getByTestId("discovery-result-fit-reason-conflicted").textContent,
    ).toContain("Review the listing and resume evidence before applying.");
    expect(
      screen.queryByTestId("discovery-result-fit-sr-conflicted"),
    ).toBeNull();
  });

  it("keeps the row restatement when no divider is drawn at all", async () => {
    // Dividers only exist in the canonical best-match order. Sorted any other
    // way there is nothing above the row making the claim, so the row keeps
    // making it itself.
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[job({ id: "title_only", score: 44, titleOnly: true })]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort results" }), {
      target: { value: "company" },
    });
    await flushFindJobsQueries();

    expect(screen.queryAllByTestId(/^discovery-results-group-/u)).toEqual([]);
    expect(
      screen.getByTestId("discovery-result-fit-title_only").textContent,
    ).toBe("Not judged yet");
    expect(
      screen.getByTestId("discovery-result-fit-reason-title_only").textContent,
    ).toContain("The AI judges each job against your profile");
  });

  it("names the unchecked band and says what would fill it in", async () => {
    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={[
          job({ id: "evidenced", score: 72 }),
          job({ id: "title_only", score: 44, titleOnly: true }),
        ]}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    const heading = screen.getByTestId("discovery-results-group-unchecked");
    expect(heading.textContent).toContain("Not yet assessed (1)");
    expect(heading.textContent).not.toContain("The full requirements");
  });

  it("heads the band on a page that opens mid-list even when it is the main band", async () => {
    // 60 leading matches then 10 weaker rows: page 2 opens inside the main
    // band. Leaving it unlabelled makes a continuation page read as the start
    // of the results.
    const jobs = [
      ...Array.from({ length: 60 }, (_, index) =>
        job({ id: `strong_${index}`, score: 72 }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        job({ id: `weak_${index}`, score: 36 }),
      ),
    ];
    expect(jobs.length).toBeGreaterThan(DISCOVERY_RESULTS_PAGE_SIZE);

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flushFindJobsQueries();

    // The count names the whole matches band (60), not the 10 of it that this
    // page happens to carry.
    expect(
      screen.getByTestId("discovery-results-group-matches").textContent,
    ).toContain("Matches (60)");
    // …and the weaker band that follows it on the same page is headed too.
    expect(
      screen.getByTestId("discovery-results-group-weaker").textContent,
    ).toContain("Weaker matches (10)");
  });

  it("returns to the first page when the also-found pool is revealed", async () => {
    // Revealing appends rows to the end of the ranking. On any later page
    // nothing on screen moves, so the control reads as a visible no-op.
    const jobs = Array.from({ length: 70 }, (_, index) =>
      job({ id: `strong_${index}`, score: 72 }),
    );

    const { rerender } = render(
      <DiscoveryResultsPanelWithJobs
        alsoFoundCount={1}
        areAlsoFoundShown={false}
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={1}
        jobs={jobs}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    const firstRowId = (): string | null =>
      document
        .querySelector("[data-job-result-id]")
        ?.getAttribute("data-job-result-id") ?? null;

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await flushFindJobsQueries();
    expect(firstRowId()).toBe("strong_54");

    rerender(
      <DiscoveryResultsPanelWithJobs
        alsoFoundCount={1}
        areAlsoFoundShown
        browserSession={browserSession}
        hasCompletedSearch
        hiddenAlsoFoundCount={0}
        jobs={[...jobs, job({ id: "off", score: 18 })]}
        onSelectJob={vi.fn()}
        onToggleAlsoFound={vi.fn()}
        selectedJob={null}
      />,
    );
    await flushFindJobsQueries();

    expect(firstRowId()).toBe("strong_0");
    expect(
      screen.getByRole("button", { name: "Hide weaker matches (1)" }),
    ).toBeTruthy();
  });
});

describe("stacked-width detail affordance", () => {
  it("tells the user where the inspector went, only on the selected row", async () => {
    const jobs = [
      job({ id: "first", score: 72 }),
      job({ id: "second", score: 64 }),
    ];

    render(
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        hasCompletedSearch
        jobs={jobs}
        onSelectJob={vi.fn()}
        selectedJob={jobs[0]!}
      />,
    );
    await flushFindJobsQueries();

    const cue = screen.getByTestId("discovery-result-details-below-first");
    const unselectedCue = screen.getByTestId(
      "discovery-result-details-below-second",
    );
    // Names the pane by its own visible heading. It must not promise listing
    // detail the run may never have read.
    expect(cue.textContent).toContain("Job details below");
    // Rendered on every row so the slot is reserved and selection can never
    // reflow the list...
    expect(unselectedCue).toBeTruthy();
    // ...but only the SELECTED row paints it. Both cases are pinned, not just
    // the positive one: the previous `group-data-*` form left both rows
    // carrying byte-identical class strings, so whether a row actually painted
    // the cue lived entirely in a stylesheet these tests never load — a DOM
    // query passed while every row showed the cue on screen. The state that
    // decides the paint is now on the element, where it can be asserted.
    expect(cue.getAttribute("data-details-cue")).toBe("visible");
    expect(unselectedCue.getAttribute("data-details-cue")).toBe("hidden");
    // Default hidden, revealed by that attribute alone.
    for (const node of [cue, unselectedCue]) {
      expect(node.className).toContain("invisible");
      expect(node.className).toContain("data-[details-cue=visible]:visible");
      // No dependency on an ancestor's state: nothing to resolve, nothing to
      // silently stop matching.
      expect(node.className).not.toContain("group-data-");
    }
    // The row already exposes the detail region through `aria-controls`, so
    // the cue is decorative and must not be announced a second time.
    expect(cue.getAttribute("aria-hidden")).toBe("true");
    // At xl and wider the inspector is a visible sibling pane, so the cue
    // collapses entirely; below xl it is the only sign the inspector exists.
    expect(cue.className).toContain("xl:hidden");
  });

  it("does not scroll anything for the default selection", async () => {
    const jobs = [job({ id: "first", score: 72 })];
    // jsdom does not implement scrollIntoView at all, so it is installed for
    // the duration of this test and removed again afterwards.
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
      writable: true,
    });

    try {
      render(
        <DiscoveryResultsPanelWithJobs
          browserSession={browserSession}
          hasCompletedSearch
          jobs={jobs}
          onSelectJob={vi.fn()}
          selectedJob={jobs[0]!}
        />,
      );
      await flushFindJobsQueries();

      // The default highlight is not a user action. Yanking the viewport on
      // load would be worse than the missing cue it replaces.
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

it("offers Show after all weaker results have been hidden", async () => {
  const onShowAlsoFound = vi.fn();
  render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      hasCompletedSearch
      jobs={[]}
      selectedJob={null}
      onSelectJob={vi.fn()}
      alsoFoundCount={31}
      hiddenAlsoFoundCount={31}
      areAlsoFoundShown={false}
      onToggleAlsoFound={onShowAlsoFound}
      onShowAlsoFound={onShowAlsoFound}
    />,
  );
  await flushFindJobsQueries();
  fireEvent.click(
    screen.getByRole("button", { name: "Show weaker matches (31)" }),
  );
  expect(onShowAlsoFound).toHaveBeenCalledOnce();
});

it("offers wider places and an area source before shortlisting outside-area jobs", async () => {
  const outside = job({ id: "outside", score: 72 });
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[outside]}
        selectedJob={null}
        onSelectJob={vi.fn()}
        preferredLocations={["Bristol", "Bath"]}
        remoteIncluded={false}
        inAreaJobCount={0}
        hasCompletedSearch
        editPlanHref="/job-finder/search-plans?edit=plan"
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  expect(screen.getByRole("link", { name: "Widen your places" })).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "add a source for your area" }),
  ).toBeTruthy();
});

it("separates pending place checks from assessed location totals", async () => {
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[
          job({ id: "read", score: 72 }),
          job({ id: "pending", score: 0, titleOnly: true }),
        ]}
        selectedJob={null}
        onSelectJob={vi.fn()}
        preferredLocations={["Bradford"]}
        remoteIncluded={false}
        inAreaJobCount={0}
        totalLocationJobCount={42}
        pendingLocationJobCount={40}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  expect(
    screen.getByText(
      /0 of 1 assessed jobs in or near Bradford · 1 awaiting place checks/,
    ),
  ).toBeTruthy();
});

it("sorts comparable Best match scores highest first and explains the priority", async () => {
  render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      jobs={[
        job({ id: "lower", score: 84 }),
        job({ id: "highest", score: 92 }),
      ]}
      onSelectJob={vi.fn()}
      selectedJob={null}
    />,
  );
  await flushFindJobsQueries();
  expect(
    screen
      .getByText("Role highest")
      .compareDocumentPosition(screen.getByText("Role lower")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(
    screen
      .getByRole("combobox", { name: "Sort results" })
      .getAttribute("title"),
  ).toContain("reachable places come first, then fit score");
});

it("counts places from the visible result set and does not offer widening mid-search", async () => {
  const local = job({ id: "local", score: 85 });
  local.matchAssessment.locationReach = "in_area";
  const unread = job({ id: "unread", score: 0, titleOnly: true });
  render(
    <DiscoveryResultsPanelWithJobs
      browserSession={browserSession}
      jobs={[local, unread]}
      selectedJob={null}
      onSelectJob={vi.fn()}
      preferredLocations={["Bristol"]}
      totalLocationJobCount={715}
      inAreaJobCount={19}
      pendingLocationJobCount={591}
      isSearchInProgress
    />,
  );
  await flushFindJobsQueries();
  expect(screen.getByTestId("discovery-result-count").textContent).toContain(
    "1 of 1 assessed jobs in or near Bristol · 1 awaiting place checks",
  );
  expect(screen.queryByTestId("discovery-no-area-matches")).toBeNull();
});

it("offers weaker matches when an assessment empties the leading list", async () => {
  const onToggle = vi.fn();
  render(
    <MemoryRouter>
      <DiscoveryResultsPanelWithJobs
        browserSession={browserSession}
        jobs={[]}
        selectedJob={null}
        onSelectJob={vi.fn()}
        alsoFoundCount={1}
        onToggleAlsoFound={onToggle}
      />
    </MemoryRouter>,
  );
  await flushFindJobsQueries();
  fireEvent.click(screen.getByRole("button", { name: "Show weaker matches" }));
  expect(onToggle).toHaveBeenCalledOnce();
});
