import { expect, test, vi } from "vitest";
import { collectSource, readListings } from "./listing-engine";
import {
  ATS_FEED_PAGE_LIMIT,
  collectAtsFeed,
  readAtsListing,
} from "./ats-public-feed";
const client = {
  chatWithTools: vi.fn(() => Promise.reject(new Error("No model needed"))),
};

test("public paginated directory streams all cards; only a plausible card reads its full body once", async () => {
  const source = {
    id: "1",
    label: "Synthetic careers",
    url: "https://synthetic.wd1.myworkdayjobs.com/en-US/Careers",
  };
  const chunks: number[] = [];
  const readPage = vi.fn(
    (url: string, options: { jsonQuery?: Record<string, unknown> }) => {
      if (url.endsWith("/jobs")) {
        const offset = Number(options.jsonQuery?.offset);
        return Promise.resolve({
          finalUrl: url,
          html: JSON.stringify({
            total: 21,
            jobPostings: Array.from({ length: offset ? 1 : 20 }, (_, i) => ({
              title: "Data Analyst " + (offset + i),
              externalPath: "/job/Berlin/Analyst_" + (offset + i),
              locationsText: "Berlin",
              bulletFields: ["REQ" + (offset + i)],
            })),
          }),
        });
      }
      return Promise.resolve({
        finalUrl: url,
        html: JSON.stringify({
          jobPostingInfo: {
            title: "Data Analyst 0",
            jobReqId: "REQ0",
            jobDescription:
              "<p>Full requirements: SQL, Python and stakeholder reporting.</p>",
            location: "Berlin",
            timeType: "Full time",
            canApply: true,
            posted: true,
          },
          hiringOrganization: { name: "Synthetic Employer" },
        }),
      });
    },
  );
  const inventory = await collectSource({
    source,
    readPage,
    onPage: (cards) => {
      chunks.push(cards.length);
    },
  });
  expect(inventory).toMatchObject({
    complete: true,
    pagesRead: 2,
    provider: "workday",
  });
  expect(inventory.cards).toHaveLength(21);
  expect(chunks).toEqual([20, 1]);
  const read = await readListings({
    cards: inventory.cards.slice(0, 1),
    readPage,
    client,
  });
  expect(read.failures).toEqual([]);
  expect(read.jobs).toHaveLength(1);
  expect(read.jobs[0]).toMatchObject({
    company: "Synthetic Employer",
    sourceJobId: "REQ0",
  });
  expect(read.jobs[0].description).toContain("Full requirements: SQL, Python");
  expect(client.chatWithTools).not.toHaveBeenCalled();
  expect(readPage).toHaveBeenCalledTimes(3);
});

test("public widget merges locations by vacancy and supplies full requirements without rendering", async () => {
  const source = {
    id: "2",
    label: "Synthetic studio",
    url: "https://apply.workable.com/synthetic",
  };
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: JSON.stringify(
        url.includes("/widget/")
          ? {
              name: "Synthetic Studio",
              jobs: ["Germany", "United Kingdom"].map((country) => ({
                title: "Data Analyst",
                shortcode: "ABC",
                url: "https://apply.workable.com/j/ABC",
                country,
                employment_type: "Full-time",
                telecommuting: true,
              })),
            }
          : {
              title: "Data Analyst",
              description: "<p>Build reports.</p>",
              requirements: "<p>Complete requirement: SQL and Python.</p>",
              benefits: "<p>Flexible hours.</p>",
              locations: [
                { country: "Germany" },
                { country: "United Kingdom" },
              ],
              remote: true,
              type: "full",
              state: "published",
            },
      ),
    }),
  );
  const inventory = await collectSource({ source, readPage });
  expect(inventory.cards).toHaveLength(1);
  expect(inventory.complete).toBe(false);
  expect(inventory.requiresBrowser).toBe(true);
  expect(inventory.notes.join(" ")).toContain("did not report a total");
  expect(inventory.cards[0].locationHint).toContain("Germany");
  expect(inventory.cards[0].locationHint).toContain("United Kingdom");
  const read = await readListings({ cards: inventory.cards, readPage, client });
  expect(read.jobs).toHaveLength(1);
  expect(read.jobs[0]).toMatchObject({
    company: "Synthetic Studio",
    workModes: ["remote"],
  });
  expect(read.jobs[0].description).toContain(
    "Complete requirement: SQL and Python",
  );
  expect(read.jobs[0].description).toContain("Flexible hours");
  expect(readPage).toHaveBeenCalledTimes(2);
});

test("a provider total larger than its repeated page remains incomplete", async () => {
  const source = {
    id: "3",
    label: "Careers",
    url: "https://synthetic.wd1.myworkdayjobs.com/Careers",
  };
  const readPage = (url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: JSON.stringify({
        total: 198,
        jobPostings: [{ title: "Analyst", externalPath: "/job/Analyst_1" }],
      }),
    });
  const inventory = await collectSource({ source, readPage });
  expect(inventory.complete).toBe(false);
  expect(inventory.requiresBrowser).toBe(true);
  expect(inventory.cards).toHaveLength(1);
});

test.each([
  [
    "https://synthetic.wd1.myworkdayjobs.com/Careers",
    { total: 0, jobPostings: [] },
  ],
  [
    "https://apply.workable.com/synthetic",
    { name: "Synthetic Studio", jobs: [] },
  ],
])(
  "a zero-read provider feed does not claim complete coverage: %s",
  async (url, payload) => {
    const inventory = await collectSource({
      source: { id: "empty", label: "Empty board", url },
      readPage: (url) =>
        Promise.resolve({ finalUrl: url, html: JSON.stringify(payload) }),
    });
    expect(inventory.cards).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.notes.join(" ")).toContain("coverage incomplete");
  },
);

const workday = {
  id: "bounded",
  label: "Synthetic",
  url: "https://synthetic.wd1.myworkdayjobs.com/Careers",
};
test("a growing feed stops at the page cap and reports incomplete coverage", async () => {
  const readPage = vi.fn(
    (url: string, options: { jsonQuery?: Record<string, unknown> }) =>
      Promise.resolve({
        finalUrl: url,
        html: JSON.stringify({
          total: 100000,
          jobPostings: [
            {
              title: "Engineer",
              externalPath: "/job/Engineer_" + String(options.jsonQuery?.offset),
            },
          ],
        }),
      }),
  );
  const result = await collectAtsFeed({ source: workday, readPage });
  expect(readPage).toHaveBeenCalledTimes(ATS_FEED_PAGE_LIMIT);
  expect(result).toMatchObject({
    pagesRead: ATS_FEED_PAGE_LIMIT,
    complete: false,
    requiresBrowser: true,
  });
  expect(result?.notes.join(" ")).toContain("page limit");
});

test("a shrinking Workday total stays incomplete even when all initially reported rows arrive", async () => {
  const result = await collectAtsFeed({
    source: workday,
    readPage: (url, options) =>
      Promise.resolve({
        finalUrl: url,
        html: JSON.stringify({
          total: options.jsonQuery?.offset ? 0 : 2,
          jobPostings: [
            {
              title: "Engineer",
              externalPath: "/job/Engineer_" + String(options.jsonQuery?.offset),
            },
          ],
        }),
      }),
  });
  expect(result?.cards).toHaveLength(2);
  expect(result?.complete).toBe(false);
  expect(result?.notes.join(" ")).toContain("total shrank");
});

test("one malformed Workday row keeps the valid cards and makes coverage incomplete", async () => {
  const result = await collectAtsFeed({
    source: workday,
    readPage: (url) =>
      Promise.resolve({
        finalUrl: url,
        html: JSON.stringify({
          total: 4,
          jobPostings: [
            null,
            { title: "Broken URL", externalPath: "/job/%invalid" },
            { title: "Wrong route", externalPath: "/not-a-job" },
            { title: "Engineer", externalPath: "/job/Engineer_1" },
          ],
        }),
      }),
  });
  expect(result?.cards.some((card) => card.title === "Engineer")).toBe(true);
  expect(result?.complete).toBe(false);
  expect(result?.notes.join(" ")).toContain("malformed listing");
});

test("a provider detail tolerates a title suffix, and an uncorroborated detail falls through to HTML", async () => {
  const card = {
    url: workday.url + "/job/Engineer_1",
    title: "Frontend Engineer",
    text: "Frontend Engineer",
    sourceId: "bounded",
    sourceLabel: "Synthetic",
    cardFingerprint: "synthetic",
  };
  const api = (title: string) =>
    JSON.stringify({
      jobPostingInfo: {
        title,
        jobDescription: "<p>Build React applications.</p>",
      },
      hiringOrganization: { name: "Synthetic" },
    });
  const first = await readAtsListing(
    {
      readPage: (url) =>
        Promise.resolve({
          finalUrl: url,
          html: api("Frontend Engineer (Remote)"),
        }),
    },
    card,
  );
  expect(first?.listingText).toContain("Build React applications.");
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: url.includes("/wday/cxs/")
        ? api("Unrelated vacancy")
        : `<h1>Frontend Engineer</h1><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Frontend Engineer", hiringOrganization: { name: "Synthetic" }, description: "<p>Build React applications with accessible TypeScript interfaces.</p>" })}</script><p>Build React applications with accessible TypeScript interfaces.</p>`,
    }),
  );
  const metadataClient = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        content: JSON.stringify({
          jobs: [
            {
              id: 0,
              title: card.title,
              company: "Synthetic",
              location: "Remote",
              workModes: ["remote"],
              sourceJobId: null,
              employmentType: null,
              seniority: null,
              salaryText: null,
              closed: false,
            },
          ],
        }),
      }),
    ),
  };
  const result = await readListings({
    cards: [card],
    readPage,
    client: metadataClient,
  });
  expect(result.failures).toEqual([]);
  expect(result.jobs[0]?.description).toContain("Build React applications");
  expect(readPage.mock.calls.map(([url]) => url)).toContain(card.url);
});
