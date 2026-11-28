import { ok as assert } from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { readJobFromBrowserPage } from "./browser-page-job";
import { createSeed } from "./test-fixtures";
import {
  createDeterministicJobFinderAiClient,
  createOpenAiCompatibleJobFinderAiClient,
} from "@nestor/ai-providers";
import type { JobFinderAiClient } from "@nestor/ai-providers";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  DiscoveryPageReadError,
  DiscoveryRunResultSchema,
  JobPostingSchema,
} from "@nestor/contracts";
import { openJobStore } from "@nestor/db/job-store";
import { savePageJobs } from "./job-commands";

const aiClient = createDeterministicJobFinderAiClient("Test model");
const pageUrl = "https://board.example.test/job";
const applicationUrl = "https://employer.example.test/jobs/design";
const boardPosting = JobPostingSchema.parse({
  ...createSeed().savedJobs[0]!,
  title: "Product Designer",
  company: "Example Studio",
  canonicalUrl: pageUrl,
  applicationUrl,
  description: "",
  needsRenderedPage: true,
});
const readContext = () => {
  const { profile, searchPreferences } = createSeed();
  return Promise.resolve({ profile, searchPreferences });
};

it.each([
  {
    site: "greenhouse",
    title: "Platform Engineer",
    html: "<body><header>Northwind Careers</header><h1>Platform Engineer</h1><section><h2>About the role</h2><p>Build &amp; run shared services.</p><ul><li>Rotate on call.</li><li>Write runbooks.</li></ul></section><p><a href='/apply'>Apply</a></p><footer>Privacy policy</footer></body>",
    range: { start: 4, end: 10 },
    description:
      "About the role\n\nBuild & run shared services.\n\n• Rotate on call.\n\n• Write runbooks.",
  },
  {
    site: "board",
    title: "Platform Engineer",
    html: "<body><h1>Platform Engineer</h1><p>Northwind · Remote</p><section><h2>What you’ll do</h2><p>Refactor TypeScript services.</p><p>£70,000–£85,000 per year.</p></section><aside><h2>Other jobs</h2><p>Account Manager</p></aside></body>",
    range: { start: 5, end: 9 },
    description:
      "What you’ll do\n\nRefactor TypeScript services.\n\n£70,000–£85,000 per year.",
  },
  {
    site: "localizado",
    title: "Ingeniera de datos",
    html: "<html lang='es'><body><h1>Ingeniera de datos</h1><p>Northwind · España</p><article><h2>Descripción</h2><p>Diseñar canalizaciones de datos.</p><p>Horario flexible, incorporación en marzo.</p></article><div>Más ofertas</div></body></html>",
    range: { start: 5, end: 9 },
    description:
      "Descripción\n\nDiseñar canalizaciones de datos.\n\nHorario flexible, incorporación en marzo.",
  },
])(
  "saves the exact description selected from a $site replica",
  async ({ site, title, html, range, description }) => {
    const pageUrl = `https://${site}.replica.test/jobs/1`;
    const client = createOpenAiCompatibleJobFinderAiClient({
      apiKey: "scripted-model",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "scripted-model",
    });
    const model = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_url, init) => {
        assert(typeof init?.body === "string", "expected a JSON request body");
        const request = JSON.parse(init.body) as {
          messages: Array<{ role: string; content: string }>;
        };
        const evidence: unknown = JSON.parse(
          request.messages.find(({ role }) => role === "user")!.content,
        );
        expect(evidence).toMatchObject({
          pageUrl,
          pageTextHasLineNumbers: true,
        });
        const numberedDescription = description
          .split("\n")
          .map((line, index) => (line ? `${range.start + index}: ${line}` : ""))
          .join("\n");
        expect(evidence).toHaveProperty(
          "pageText",
          expect.stringContaining(numberedDescription),
        );
        const content = JSON.stringify({
          jobs: [
            {
              canonicalUrl: pageUrl,
              applicationUrl: "/apply",
              title,
              company: "Northwind",
              location: "Remote",
              salaryText: "£70,000–£85,000",
              responsibilities: ["One model-extracted fact."],
              descriptionLineRange: range,
            },
          ],
        });
        return Promise.resolve(
          Response.json({ choices: [{ message: { content } }] }),
        );
      });
    const store = openJobStore(":memory:");
    try {
      const read = await readJobFromBrowserPage(client, { html, pageUrl });
      expect(read.fullListingRead).toBe(true);
      expect(read.posting).not.toHaveProperty("descriptionLineRange");
      const saved = savePageJobs(store, {
        postings: [read.posting],
        pageUrl,
        fullListingRead: read.fullListingRead,
      });
      expect(store.getJob(saved.ids[0]!)).toMatchObject({
        title,
        company: "Northwind",
        url: pageUrl,
        applyUrl: new URL("/apply", pageUrl).href,
        description,
        salaryText: "£70,000–£85,000",
        facts: {
          fullListingRead: true,
          responsibilities: ["One model-extracted fact."],
        },
      });
      expect(model).toHaveBeenCalledOnce();
    } finally {
      model.mockRestore();
      store.close();
    }
  },
);

it("Add to Find jobs reads rendered DOM facts when the initial capture has no posting", async () => {
  const body =
    "Build accessible workflows. Full duties, qualifications and salary are available after rendering.";
  const posting = { ...createSeed().savedJobs[0]!, description: body };
  const extractJobsFromPage = vi
    .fn<JobFinderAiClient["extractJobsFromPage"]>()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([posting]);
  const readRenderedPage = vi.fn(() =>
    Promise.resolve({
      html: "<main>Loading</main>",
      finalUrl: "https://replica.test/job",
      visibleText: body,
    }),
  );
  const result = await readJobFromBrowserPage(
    { ...aiClient, extractJobsFromPage },
    {
      html: "<main>Loading</main>",
      pageUrl: "https://replica.test/job",
      browser: { runtime: { readRenderedPage }, readContext },
    },
  );
  expect(result).toEqual({ posting, fullListingRead: true });
  expect(readRenderedPage).toHaveBeenCalledOnce();
  expect(extractJobsFromPage.mock.calls[1]?.[0].pageText).toContain(body);
  const store = openJobStore(":memory:");
  try {
    const saved = savePageJobs(store, {
      postings: [result.posting],
      pageUrl: "https://replica.test/job",
      fullListingRead: result.fullListingRead,
    });
    const row = store.getJob(saved.ids[0]!)!;
    expect(row.description).toBe(body);
    expect(row.facts.fullListingRead).toBe(true);
    expect(row.facts.keySkills).toEqual(result.posting.keySkills);
  } finally {
    store.close();
  }
});

it("fills a partial posting from its application link through the browser listing reader", async () => {
  const description = "Design accessible products. Partner with engineers.";
  const runAgentDiscovery = vi
    .fn<NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>>()
    .mockResolvedValue(
      DiscoveryRunResultSchema.parse({
        source: "target_site",
        startedAt: boardPosting.discoveredAt,
        completedAt: boardPosting.discoveredAt,
        querySummary: "Read the supplied vacancy",
        warning: null,
        jobs: [
          {
            ...boardPosting,
            canonicalUrl: applicationUrl,
            title: "Product Designer, Core Platform",
            description,
            listingDetailFetch: {
              outcome: "enriched",
              method: "page_text",
              attemptedAt: boardPosting.discoveredAt,
              detail: "Read the full posting",
            },
          },
        ],
      }),
    );
  const readRenderedPage = vi.fn();
  const result = await readJobFromBrowserPage(
    {
      ...aiClient,
      extractJobsFromPage: vi.fn().mockResolvedValue([boardPosting]),
    },
    {
      html: "<main>Product Designer at Example Studio</main>",
      pageUrl,
      browser: {
        runtime: { readRenderedPage, runAgentDiscovery },
        readContext,
      },
    },
  );
  expect(readRenderedPage).not.toHaveBeenCalled();
  expect(runAgentDiscovery).toHaveBeenCalledOnce();
  const [source, options] = runAgentDiscovery.mock.calls[0]!;
  expect(source).toBe("target_site");
  expect(options.startingUrls).toEqual([applicationUrl]);
  expect(options.requestedListing).toMatchObject({
    url: applicationUrl,
    title: boardPosting.title,
  });
  expect(options.requestedListing?.text).toContain(boardPosting.company);
  expect(result).toMatchObject({
    posting: {
      ...boardPosting,
      description,
      needsRenderedPage: false,
      listingDetailFetch: { outcome: "enriched" },
    },
    fullListingRead: true,
  });
});

it("keeps and saves the partial posting when the application page cannot be read", async () => {
  const result = await readJobFromBrowserPage(
    {
      ...aiClient,
      extractJobsFromPage: vi.fn().mockResolvedValue([boardPosting]),
    },
    {
      html: "<main>Product Designer at Example Studio</main>",
      pageUrl,
      browser: {
        runtime: {
          runAgentDiscovery: vi.fn().mockRejectedValue(new Error("Offline")),
        },
        readContext,
      },
    },
  );
  expect(result.fullListingRead).toBe(false);
  expect(result.warning).toContain("could not read the full description");
  const store = openJobStore(":memory:");
  try {
    const saved = savePageJobs(store, {
      postings: [result.posting],
      pageUrl,
      fullListingRead: result.fullListingRead,
    });
    expect(store.getJob(saved.ids[0]!)).toMatchObject({
      title: boardPosting.title,
      company: boardPosting.company,
      url: pageUrl,
      applyUrl: applicationUrl,
      facts: { fullListingRead: false },
    });
  } finally {
    store.close();
  }
});

it.each([404, 410])(
  "reports a listing taken down after HTTP %s",
  async (status) => {
    const extractJobsFromPage = vi.fn().mockResolvedValue([]);
    const readRenderedPage = vi
      .fn()
      .mockRejectedValue(new DiscoveryPageReadError(status));
    await expect(
      readJobFromBrowserPage(
        { ...aiClient, extractJobsFromPage },
        {
          html: "<main>This vacancy is unavailable</main>",
          pageUrl,
          browser: { runtime: { readRenderedPage }, readContext },
        },
      ),
    ).rejects.toThrow("This job listing has been taken down.");
    expect(extractJobsFromPage).toHaveBeenCalledOnce();
  },
);
