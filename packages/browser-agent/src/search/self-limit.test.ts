import { afterEach, expect, test, vi } from "vitest";
import { JobPostingSchema, type RawApplyPage } from "@nestor/contracts";
import { formatPagePart, linksInText, mapWithLimit } from "./page-read-parts";
import { describeSearchObservation } from "./search-observation";
import { createSearchCatalogTools } from "./job-search-catalog-tools";
import { buildApplyFormObservation } from "../apply/page-hands";

afterEach(() => vi.restoreAllMocks());
const raw = (overrides: Partial<RawApplyPage> = {}): RawApplyPage => ({
  url: "https://example.test/",
  title: "Jobs",
  bodyText: "Jobs",
  controls: [],
  actions: [],
  links: [],
  clickables: [],
  headings: [],
  validationErrors: [],
  openedTabs: [],
  loading: false,
  stepLabel: null,
  ...overrides,
});
function hits(log: ReturnType<typeof vi.spyOn>) {
  return log.mock.calls.flatMap(([line]) =>
    typeof line === "string" && line.startsWith("[self_limit_hit] ")
      ? [JSON.parse(line.slice(17)) as { limit: string; value: number }]
      : [],
  );
}

test("page-part links and read concurrency report their boundaries without losing ordered successful siblings", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const label = "Engineer ".repeat(30),
    url = "https://example.test/jobs";
  expect(
    linksInText(label, [{ label, href: url + "/one" }], url)[0].label,
  ).toHaveLength(label.length);
  formatPagePart(
    "all text",
    Array.from({ length: 120 }, (_, i) => ({
      label: "role ".repeat(30),
      href: url + "/" + i,
    })),
    { index: 1, total: 1 },
  );
  expect(
    await mapWithLimit([1, 2, 3], 2, (i) => Promise.resolve(i * 2)),
  ).toEqual([
    { status: "fulfilled", value: 2 },
    { status: "fulfilled", value: 4 },
    { status: "fulfilled", value: 6 },
  ]);
  expect(hits(log).map((hit) => hit.limit)).toEqual(
    expect.arrayContaining(["page_read_concurrency"]),
  );
});
test("search observations and catalog summaries retain their full evidence", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  describeSearchObservation(
    buildApplyFormObservation(
      raw({
        links: Array.from({ length: 155 }, (_, index) => ({
          index,
          label: "Engineer ".repeat(20) + index,
          href: `https://example.test/job/${index}`,
          visible: true,
          target: "",
          topOffset: index,
        })),
      }),
      "2026-11-06T00:00:00Z",
    ),
  );
  const job = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "1",
    applyPath: "unknown",
    easyApplyEligible: false,
    discoveredAt: "2026-11-06T00:00:00Z",
    salaryText: null,
    title: "Engineer",
    company: "Example",
    location: "Remote",
    canonicalUrl: "https://example.test/job",
    description: "x".repeat(500),
  });
  const tools = createSearchCatalogTools({
    jobs: [job],
    keep: () => true,
    checkpoint: async () => {},
  });
  const result = await tools[0].execute("{}", { step: 1 });
  expect("content" in result && result.content).toContain(job.description);
  expect(
    hits(log).some((hit) => hit.limit === "search_observation_links"),
  ).toBe(false);
  expect(hits(log)).toEqual([]);
});
