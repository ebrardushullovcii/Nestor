import { afterEach, expect, test, vi } from "vitest";
import {
  JobPostingSchema,
  type ListingCard,
  type RawApplyPage,
} from "@nestor/contracts";
import {
  extractListingDetailFromHtml,
  listingPageText,
  decodeHtmlEntities,
} from "./listing-detail-extraction";
import { professionEvidence, clearRoleMatch } from "./listing-screening";
import { formatPagePart, linksInText, mapWithLimit } from "./page-read-parts";
import { describeSearchObservation } from "./search-observation";
import { createSearchCatalogTools } from "./job-search-catalog-tools";
import { listingClosedReason } from "./listing-status";
import { buildApplyFormObservation } from "../apply/page-hands";

afterEach(() => vi.restoreAllMocks());
const card = (text: string): ListingCard => ({
  title: "Engineer",
  text,
  url: "https://example.test/job",
  sourceId: "1",
  sourceLabel: "Test",
  cardFingerprint: "test",
});
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

test("HTML, visible text and JSON-LD traversal report actual evidence loss", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const input = { url: "https://example.test/job", expectedTitle: "Engineer" };
  extractListingDetailFromHtml({ ...input, html: " ".repeat(1_500_001) });
  expect(hits(log).some((hit) => hit.limit === "evidence_window")).toBe(true);
  log.mockClear();
  expect(
    listingPageText(`<main>${"evidence ".repeat(9000)}</main>`),
  ).toHaveLength(64000);
  expect(hits(log).some((hit) => hit.limit === "evidence_window")).toBe(true);
  log.mockClear();
  const graph = Array.from({ length: 205 }, () => ({ "@type": "Thing" }));
  extractListingDetailFromHtml({
    ...input,
    html: `<script type="application/ld+json">${JSON.stringify({ "@graph": graph })}</script>`,
  });
  expect(hits(log).some((hit) => hit.limit === "json_ld_nodes")).toBe(true);
  log.mockClear();
  decodeHtmlEntities("&amp;amp;amp;amp;amp;");
  expect(hits(log).some((hit) => hit.limit === "entity_decode_passes")).toBe(
    true,
  );
});
test("profession evidence, positive keyword shortcuts and closed-wording vetoes are visible", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(professionEvidence(card("x".repeat(1400)))).toHaveLength(1200);
  expect(
    professionEvidence(card(JSON.stringify({ description: "x".repeat(1400) }))),
  ).toHaveLength(1200);
  expect(
    clearRoleMatch("Senior Backend Engineer", {
      targetRoles: ["Backend Engineer"],
      relatedRoles: [],
      strategy: "target_roles",
    }),
  ).toBe(true);
  expect(listingClosedReason("This position is closed.")).toBeTruthy();
  expect(hits(log).map((hit) => hit.limit)).toEqual(
    expect.arrayContaining([
      "evidence_window",
      "role_keyword_shortcut",
      "closed_listing_wording",
    ]),
  );
});
test("page-part links and read concurrency report their boundaries without losing ordered successful siblings", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const label = "Engineer ".repeat(30),
    url = "https://example.test/jobs";
  expect(
    linksInText(label, [{ label, href: url + "/one" }], url)[0].label,
  ).toHaveLength(120);
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
    expect.arrayContaining([
      "evidence_window",
      "page_part_link_evidence",
      "page_read_concurrency",
    ]),
  );
});
test("search observations and catalog summaries report hidden context windows", async () => {
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
  await tools[0].execute("{}", { step: 1 });
  expect(
    hits(log).some((hit) => hit.limit === "search_observation_links"),
  ).toBe(true);
  expect(hits(log).some((hit) => hit.value === 400)).toBe(true);
});
