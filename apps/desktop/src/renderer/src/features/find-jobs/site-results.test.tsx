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
