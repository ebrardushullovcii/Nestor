// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import {
  JobSearchSettingsSchema,
  type JobSearchSourceQuery,
} from "@nestor/contracts";
import { createSearchSourcesStore, openJobStore } from "@nestor/db/job-store";
import { SiteResults } from "./site-results";

afterEach(cleanup);
test("900 source results page on demand and repeat totals distinguish listings from new jobs", async () => {
  const store = openJobStore(":memory:");
  try {
    const search = store.searches.start(JobSearchSettingsSchema.parse({}), 900),
      sources = createSearchSourcesStore(store);
    store.transaction(() => {
      for (let i = 0; i < 900; i++)
        sources.put(search.id, {
          sourceId: String(i),
          label: `Board ${i}`,
          url: `https://board-${i}.example/`,
          state: "done",
          lane: "http",
          phase: null,
          cards: 8,
          related: 0,
          unrelated: 0,
          seen: 8,
          failedReads: 0,
          found: 0,
          added: 0,
          hidden: 0,
          message: "8 listings; 8 already seen.",
        });
    });
    let calls = 0;
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobs: {
          run: (_name: string, input: JobSearchSourceQuery) => {
            calls++;
            return Promise.resolve(sources.list(input));
          },
        },
      },
    });
    render(<SiteResults searchId={search.id} revision={1} />);
    expect(calls).toBe(0);
    fireEvent.click(screen.getByText("What each site found"));
    await screen.findByText("1–25 of 900");
    expect(document.querySelectorAll("[data-site-result]")).toHaveLength(25);
    const first = document.querySelector<HTMLElement>("[data-site-result]")!;
    expect(first.textContent).toContain("8 listings · 0 new jobs");
    expect(within(first).getByText(/0 new related/).textContent).toContain(
      "8 already seen",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next sites" }));
    await screen.findByText("26–50 of 900");
    await waitFor(() =>
      expect(document.querySelectorAll("[data-site-result]")).toHaveLength(25),
    );
  } finally {
    store.close();
  }
});

test.each([
  [
    "The site took too long to respond. Open it to check it loads, then retry the search. Other sites continue normally.",
    "This site took too long to respond. Open it to check it loads, then search again. Other sites continue normally.",
  ],
  [
    "page.goto: Timeout 20000ms exceeded.",
    "This site took too long to respond. Open it to check it loads, then search again. Other sites continue normally.",
  ],
  [
    "page.goto: net::ERR_CONNECTION_REFUSED.",
    "This site could not be reached. Check its address and your connection.",
  ],
  ["Listing read returned HTTP 404.", "Page not found. Check the URL."],
  [
    "Listing read returned HTTP 500.",
    "The site returned an error. Check the address or try again later.",
  ],
])(
  "failed sites show a plain reason for %s before diagnostics",
  async (message, reason) => {
    const store = openJobStore(":memory:");
    try {
      const search = store.searches.start(JobSearchSettingsSchema.parse({}), 1);
      const sources = createSearchSourcesStore(store);
      sources.put(search.id, {
        sourceId: "unreachable",
        label: "Unreachable board",
        url: "https://board.example/",
        state: "failed",
        lane: "browser",
        phase: null,
        cards: 0,
        related: 0,
        unrelated: 0,
        seen: 0,
        failedReads: 0,
        found: 0,
        added: 0,
        hidden: 0,
        message: `${message} Call log: internal navigation details`,
      });
      Object.defineProperty(window, "nestor", {
        configurable: true,
        value: {
          jobs: {
            run: (_name: string, input: JobSearchSourceQuery) =>
              Promise.resolve(sources.list(input)),
          },
        },
      });
      render(<SiteResults searchId={search.id} revision={1} showFailures />);
      await screen.findByText(reason);
      const diagnostics = screen
        .getByText("Technical details")
        .closest("details");
      expect(diagnostics?.open).toBe(false);
      expect(
        screen.getByText(/internal navigation details/).closest("details"),
      ).toBe(diagnostics);
      expect(
        document.querySelector<HTMLDetailsElement>(
          "[data-site-result] > details",
        )?.open,
      ).toBe(true);
    } finally {
      store.close();
    }
  },
);

test("a site Quick stopped early reads More to read, never Stopped, and Keep reading reads it whole", async () => {
  const store = openJobStore(":memory:");
  try {
    const search = store.searches.start(JobSearchSettingsSchema.parse({}), 1),
      sources = createSearchSourcesStore(store);
    sources.put(search.id, {
      sourceId: "7",
      label: "Big board",
      url: "https://big.example/jobs",
      state: "partial",
      lane: "http",
      phase: null,
      cards: 300,
      related: 120,
      unrelated: 180,
      seen: 0,
      failedReads: 0,
      found: 120,
      added: 120,
      hidden: 0,
      message:
        "300 listings; 120 new related; 180 unrelated; 0 already seen. Quick stopped after 100 listings in a row that don't match your profile.",
    });
    const calls: [string, unknown][] = [];
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobs: {
          run: (name: string, input: JobSearchSourceQuery) => {
            calls.push([name, input]);
            return Promise.resolve(
              name === "list_search_sources" ? sources.list(input) : {},
            );
          },
        },
      },
    });
    render(<SiteResults searchId={search.id} revision={1} />);
    fireEvent.click(screen.getByText("What each site found"));
    const row = await screen.findByText(/Big board/);
    const item = row.closest<HTMLElement>("[data-site-result]")!;
    expect(item.textContent).toContain("More to read");
    expect(item.textContent).not.toContain("Stopped");
    fireEvent.click(within(item).getByRole("button", { name: "Keep reading" }));
    expect(calls.at(-1)).toEqual(["keep_reading", { id: 7 }]);
  } finally {
    store.close();
  }
});
