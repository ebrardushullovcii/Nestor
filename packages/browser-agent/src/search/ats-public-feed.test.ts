import { expect, test, vi } from "vitest";
import { collectSource, readListings } from "./listing-engine";
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
            total: offset ? 0 : 21,
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
