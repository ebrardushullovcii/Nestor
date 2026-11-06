import { expect, test, vi } from "vitest";
import {
  CandidateProfileSchema,
  DiscoveryPageReadError,
  JobDetailSchema,
  type ListingCard,
} from "@nestor/contracts";
import {
  collectSource,
  listingInventoryReady,
  fitJobs,
  readListings,
  screenCards,
} from "./listing-engine";
import {
  readInventoryHtml,
  readListingHtml,
  listingSignInRequired,
} from "./listing-html";
import { htmlToPlainText } from "./listing-detail-extraction";
import { publicBoardFeed } from "./public-board-feed";
import type { LLMClient } from "../agent/contracts";

const source = {
  id: "source",
  label: "Board brand",
  url: "https://board.example/",
};
const card = (title: string, id = title): ListingCard => ({
  title,
  url: `https://board.example/${id}`,
  text: `${title}\nReal Employer\nBerlin · Part-time`,
  cardFingerprint: id,
  sourceId: source.id,
  sourceLabel: source.label,
});

function metadataClient(
  company = "Real Employer",
  location = "Remote, Worldwide",
  workModes: string[] = ["remote"],
) {
  return {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((messages) => {
      const data = JSON.parse(String(messages[1].content)) as {
        listings: { id: number; title: string }[];
      };
      return Promise.resolve({
        content: JSON.stringify({
          jobs: data.listings.map(({ id, title }) => ({
            id,
            title,
            company,
            location,
            workModes,
            sourceJobId: null,
            employmentType: null,
            seniority: null,
            salaryText: null,
            closed: false,
          })),
        }),
      });
    }),
  };
}

test("the model sees a closed listing's landed board and keeps the requested identity as closed", async () => {
  const requested = card("Backend Engineer");
  const finalUrl = "https://employer.example/board";
  const client = {
    chatWithTools: vi.fn<LLMClient["chatWithTools"]>((messages) => {
      const data = JSON.parse(String(messages[1].content)) as {
        listings: { url: string; finalUrl: string; pageText: string }[];
      };
      expect(data.listings[0]).toMatchObject({ url: requested.url, finalUrl });
      expect(data.listings[0].pageText).toContain(
        "The job you are looking for is no longer open",
      );
      return Promise.resolve({
        content: JSON.stringify({
          jobs: [
            {
              id: 0,
              title: requested.title,
              company: "Employer",
              location: "",
              workModes: [],
              sourceJobId: null,
              employmentType: null,
              seniority: null,
              salaryText: null,
              closed: true,
              isListing: true,
            },
          ],
        }),
      });
    }),
  };
  const result = await readListings({
    cards: [requested],
    client,
    readPage: () =>
      Promise.resolve({
        finalUrl,
        html: '<main><h1>Open jobs</h1><p>The job you are looking for is no longer open</p><a href="/other">Another vacancy</a></main>',
      }),
  });
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    url: requested.url,
    hiddenReason: "Closed: this vacancy is no longer accepting applications.",
  });
});

test("the model can keep a login link's real listing destination without storing the login wall as its URL", async () => {
  const listingUrl = "https://board.example/job/123";
  const login = `https://board.example/auth/login?destination=${encodeURIComponent("/job/123")}`;
  const client = metadataClient();
  client.chatWithTools.mockResolvedValueOnce({
    content: JSON.stringify({
      jobs: [
        {
          id: 0,
          title: "Backend Engineer",
          company: "Employer",
          location: "Europe",
          workModes: [],
          sourceJobId: null,
          employmentType: null,
          seniority: null,
          salaryText: null,
          canonicalUrl: listingUrl,
          applyUrl: null,
        },
      ],
    }),
  });
  const result = await readListings({
    cards: [{ ...card("Backend Engineer"), url: login }],
    client,
    readPage: () =>
      Promise.resolve({
        html: "<main><h1>Backend Engineer</h1><p>Employer's complete vacancy text.</p></main>",
        finalUrl: login,
      }),
  });
  expect(result.jobs[0]).toMatchObject({ url: listingUrl, applyUrl: null });
});

test("one malformed metadata row never loses a complete sibling listing", async () => {
  const client = metadataClient();
  client.chatWithTools.mockResolvedValueOnce({
    content: JSON.stringify({
      jobs: [
        {
          id: 0,
          title: "Backend Engineer",
          company: "Employer",
          location: "Europe",
          workModes: [],
          sourceJobId: null,
          employmentType: null,
          seniority: null,
          salaryText: null,
        },
        { id: 1, title: 123 },
      ],
    }),
  });
  const cards = [
    card("Backend Engineer", "one"),
    card("Platform Engineer", "two"),
  ];
  const result = await readListings({
    cards,
    client,
    readPage: (url) =>
      Promise.resolve({
        html: "<main><h1>Engineer</h1><p>Full listing duties and requirements.</p></main>",
        finalUrl: url,
      }),
  });
  expect(result.jobs.map((job) => job.url)).toEqual([cards[0].url]);
  expect(result.failures).toMatchObject([
    { url: cards[1].url, requiresBrowser: true },
  ]);
});

test("an unusual title is judged with full duties once and its page is reused", async () => {
  const cards = [card("Trend Steward"), card("Metrics Caretaker")];
  const pages = new Map(
    cards.map((row) => [
      row.url,
      {
        html: `<article><h1>${row.title}</h1><p>Analyse revenue with SQL joins, R extracts and Tableau dashboards. Check data quality and report findings to stakeholders. Remote in Germany, part time.</p></article>`,
        finalUrl: row.url,
      },
    ]),
  );
  const readPage = vi.fn((url: string) => Promise.resolve(pages.get(url)!));
  let calls = 0;
  const client: LLMClient = {
    chatWithTools: (messages) => {
      const data = JSON.parse(String(messages[1].content)) as {
        titles?: unknown[][];
        evidenceBlocks: string[];
        listings: { id: number; title: string }[];
      };
      if (data.titles) {
        calls++;
        for (const row of data.titles)
          expect(
            (row[3] as number[])
              .map((id) => data.evidenceBlocks[id])
              .join("\n"),
          ).toContain("Analyse revenue with SQL joins");
        return Promise.resolve({
          content: JSON.stringify({
            keep: { 0: 1, 1: 1 },
          }),
        });
      }
      return Promise.resolve({
        content: JSON.stringify({
          jobs: data.listings.map((row: { id: number; title: string }) => ({
            id: row.id,
            title: row.title,
            company: "Real Employer",
            location: "Germany",
            workModes: ["remote"],
            sourceJobId: null,
            employmentType: "part_time",
            seniority: null,
            salaryText: null,
            closed: false,
          })),
        }),
      });
    },
  };
  const result = await screenCards({
    cards,
    client,
    readPage,
    goals: {
      targetRoles: ["Data Analyst"],
      relatedRoles: [],
      strategy: "wide_net",
    },
  });
  expect(result.related.map((row) => row.url)).toEqual(
    cards.map((row) => row.url),
  );
  expect(result.seen).toEqual([]);
  expect(result.failed).toEqual([]);
  expect(readPage).toHaveBeenCalledTimes(2);
  expect(calls).toBe(1);
  expect(result.related[0].listingPage).toEqual(pages.get(cards[0].url));
  const downstream = vi.fn(() =>
    Promise.reject(new Error("The verified page should be reused")),
  );
  const read = await readListings({
    cards: result.related,
    client,
    readPage: downstream,
  });
  expect(downstream).not.toHaveBeenCalled();
  expect(read.jobs).toHaveLength(2);
});

test("a failed duty read is evidence for the model, not a code-side profession veto", async () => {
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({ content: '{"keep":{"0":1}}' }),
    ),
  };
  const result = await screenCards({
    cards: [card("Trend Steward")],
    goals: {
      targetRoles: ["Data Analyst"],
      relatedRoles: [],
      strategy: "wide_net",
    },
    client,
    readPage: () => Promise.reject(new Error("Temporary source failure")),
  });
  expect(result.related).toHaveLength(1);
  expect(result.failed).toEqual([]);
  expect(client.chatWithTools.mock.calls).toHaveLength(1);
});

test.each([{ "0": 1, "1": 0 }, { "keep{": { "0": 1, "1": 0 } }])(
  "B2 retains unambiguous indexed decisions despite a wrong wrapper: %j",
  async (answer) => {
    const cards = [card("Data Quality Assistant"), card("Dental Nurse")];
    const result = await screenCards({
      cards,
      goals: {
        targetRoles: ["Data Analyst"],
        relatedRoles: [],
        strategy: "target_roles",
      },
      client: {
        chatWithTools: vi.fn(() =>
          Promise.resolve({ content: JSON.stringify(answer) }),
        ),
      },
    });
    expect(result.related).toEqual([cards[0]]);
    expect(result.seen.map((row) => row.url)).toEqual([cards[1].url]);
    expect(result.failed).toEqual([]);
  },
);

test("B2 repairs only missing or invalid screen judgments, including small batches", async () => {
  const requests: unknown[][] = [];
  const result = await screenCards({
    cards: [card("Research Assistant"), card("Dental Nurse")],
    goals: {
      targetRoles: ["Data Analyst"],
      relatedRoles: [],
      strategy: "target_roles",
    },
    client: {
      chatWithTools: vi.fn(
        (messages: Parameters<LLMClient["chatWithTools"]>[0]) => {
          const titles = (
            JSON.parse(messages[1].content) as { titles: unknown[][] }
          ).titles;
          requests.push(titles);
          return Promise.resolve({
            content: JSON.stringify({
              keep:
                requests.length === 1 ? { "0": 1, "1": "invalid" } : { "0": 0 },
            }),
          });
        },
      ),
    },
  });
  expect(requests.map((rows) => rows.length)).toEqual([2, 1]);
  expect(JSON.stringify(requests[1])).toContain("dental nurse");
  expect(result.related.map((row) => row.title)).toEqual([
    "Research Assistant",
  ]);
  expect(result.seen).toHaveLength(1);
  expect(result.failed).toEqual([]);
});

test("B2 title cache distinguishes actual duties and preserves evidence beyond a short byline", async () => {
  const decisions = new Map<string, boolean>();
  const client = {
    chatWithTools: vi.fn(
      (messages: Parameters<LLMClient["chatWithTools"]>[0]) =>
        Promise.resolve({
          content: JSON.stringify({
            keep: {
              "0": messages[1].content.includes("SQL validation") ? 1 : 0,
            },
          }),
        }),
    ),
  };
  const goals = {
    targetRoles: ["Data Analyst"],
    relatedRoles: [],
    strategy: "target_roles" as const,
  };
  await screenCards({
    client,
    goals,
    decisions,
    cards: [
      { ...card("Research Assistant", "lab"), text: "Laboratory animal care" },
    ],
  });
  const analytical = {
    ...card("Research Assistant", "data"),
    text:
      "Berlin office. ".repeat(24) +
      "SQL validation and recurring reporting duties.",
  };
  const result = await screenCards({
    client,
    goals,
    decisions,
    cards: [analytical],
  });
  expect(result.related).toEqual([analytical]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test.each(["No open positions", "No current vacancies", "0 open jobs"])(
  "an explicit empty HTML inventory is complete: %s",
  async (message) => {
    const navigateFallback = vi.fn(() =>
      Promise.reject(new Error("No navigation needed")),
    );
    const inventory = await collectSource({
      source,
      readPage: () =>
        Promise.resolve({
          finalUrl: source.url,
          html: `<main><h1>Careers</h1><p>${message}</p></main>`,
        }),
      navigateFallback,
    });
    expect(inventory).toMatchObject({
      cards: [],
      pagesRead: 1,
      complete: true,
      emptyConfirmed: true,
      requiresBrowser: false,
    });
    expect(inventory.notes.join(" ")).toContain("all observed pages covered");
    expect(inventory.notes.join(" ")).toContain("1 page address attempted");
    expect(navigateFallback).not.toHaveBeenCalled();
  },
);

test("an empty shell is incomplete and explicit emptiness cannot hide a failed page", async () => {
  const shell = await collectSource({
    source,
    readPage: () =>
      Promise.resolve({
        finalUrl: source.url,
        html: '<main>Loading</main><script>{"message":"No open positions"}</script>',
      }),
  });
  expect(shell.complete).toBe(false);
  expect(shell.emptyConfirmed).not.toBe(true);
  const attempts: string[] = [];
  const failed = await collectSource({
    source,
    readPage: (url) => {
      attempts.push(url);
      return url === source.url
        ? Promise.resolve({
            finalUrl: url,
            html: '<main>No open positions<a rel="next" href="/page/2">Next</a></main>',
          })
        : Promise.reject(new DiscoveryPageReadError(503));
    },
  });
  expect(failed).toMatchObject({
    cards: [],
    complete: false,
    emptyConfirmed: true,
  });
  expect(attempts).toEqual([source.url, "https://board.example/page/2"]);
  expect(failed.notes.join(" ")).toContain("2 page addresses attempted");
  expect(failed.notes.join(" ")).not.toContain("collected from 2 pages");
});

test("browser navigation owns its completion judgment even with an empty inventory", async () => {
  for (const emptyConfirmed of [true, false]) {
    const inventory = await collectSource({
      source,
      readPage: () =>
        Promise.resolve({
          finalUrl: source.url,
          html: '<main>Loading</main><script src="app.js"></script>',
        }),
      navigateFallback: () =>
        Promise.resolve({
          cards: [],
          pagesRead: 1,
          complete: true,
          emptyConfirmed,
          notes: emptyConfirmed
            ? ["The site explicitly reports no open positions."]
            : [],
        }),
    });
    expect(inventory.complete).toBe(true);
    expect(
      inventory.notes.join(" ").includes("coverage could not be confirmed"),
    ).toBe(false);
  }
});

test("detail reads retain all visible requirements and interactive controls without parsing script payloads", () => {
  const detail = readListingHtml(
    `<style>.hidden { display:none }</style><script>window.state=${JSON.stringify({ payload: "script-only ".repeat(25000) })}</script><main><article><h1>Engineer</h1><p>First requirement: TypeScript.</p><p>Final requirement: German B1.</p><a href="/apply">Apply</a></article></main>`,
    "Engineer",
  );
  expect(detail.text).toContain("First requirement: TypeScript.");
  expect(detail.text).toContain("Final requirement: German B1.");
  expect(detail.text).not.toContain("script-only");
  expect(detail).toMatchObject({
    detailHeading: true,
    renderSuggested: false,
    hasInteractiveContent: true,
  });
  expect(
    readListingHtml(
      '<main>Loading</main><script src="app.js"></script>',
      "Engineer",
    ).renderSuggested,
  ).toBe(true);
  expect(
    readListingHtml(
      '<main>No open jobs</main><script type="application/ld+json">{}</script>',
      "Engineer",
    ).renderSuggested,
  ).toBe(false);
});

test("collects all observed pages without AI, ignoring editorial links and preserving query identities", async () => {
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: url.includes("page=2")
        ? '<article><p>Employer B</p><h2><a href="/posting?id=2">Senior Analyst</a></h2><p>Berlin</p></article>'
        : '<aside><a href="/salary-guide">Salary guide</a></aside><article><p>Employer A</p><h2><a href="/posting?id=1">Data Analyst</a></h2><p>Berlin</p></article><nav><a href="/?page=2" rel="next">Next</a></nav>',
    }),
  );
  const inventory = await collectSource({ source, readPage });
  expect(inventory.complete).toBe(true);
  expect(inventory.cards.map((card) => card.url)).toEqual([
    "https://board.example/posting?id=1",
    "https://board.example/posting?id=2",
  ]);
  expect(readPage).toHaveBeenCalledTimes(2);
});

test("screens titles in one call, retains senior variants and skips saved and rejected cards on repeat", async () => {
  const cards = [
    card("Data Analyst"),
    card("Senior Data Analyst"),
    card("Nurse"),
    card("Saved"),
  ];
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({ content: '{"keep":{"0":1,"1":1,"2":0}}' }),
    ),
  };
  const goals = {
    targetRoles: ["Data Analyst"],
    relatedRoles: ["Analytics Engineer"],
    strategy: "related_roles" as const,
  };
  const first = await screenCards({
    client,
    cards,
    goals,
    lookupKnownUrls: () => Promise.resolve([cards[3].url]),
  });
  expect(first.related.map((card) => card.title)).toEqual([
    "Data Analyst",
    "Senior Data Analyst",
  ]);
  expect(first.seen.map((card) => card.verdict)).toEqual(["unrelated"]);
  const again = await screenCards({
    client,
    cards: cards.slice(0, 3),
    goals,
    lookupSeenCards: () => Promise.resolve(first.seen),
    lookupKnownUrls: () =>
      Promise.resolve(first.related.map((card) => card.url)),
  });
  expect(again.related).toEqual([]);
  expect(again.skipped).toBe(3);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("a changing age badge does not make a rejected listing cost another model call", async () => {
  let age = "1 day ago";
  const readPage = () =>
    Promise.resolve({
      finalUrl: source.url,
      html: `<article><p>Employer</p><h2><a href="/jobs/nurse">Nurse</a></h2><p>Berlin</p><span class="age">${age}</span></article>`,
    });
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({ content: '{"keep":{"0":0}}' }),
    ),
  };
  const goals = {
    targetRoles: ["Data Analyst"],
    relatedRoles: [],
    strategy: "wide_net" as const,
  };
  const first = await screenCards({
    client,
    cards: (await collectSource({ source, readPage })).cards,
    goals,
  });
  age = "2 days ago";
  const second = await screenCards({
    client,
    cards: (await collectSource({ source, readPage })).cards,
    goals,
    lookupSeenCards: () => Promise.resolve(first.seen),
  });
  expect(second.related).toEqual([]);
  expect(second.skipped).toBe(1);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("returns full visible requirements beyond sparse JSON-LD and reads metadata for all bodies in one call", async () => {
  const cards = [
    card("Data Analyst", "one"),
    card("Senior Data Analyst", "two"),
  ];
  const lastRequirement = "Final requirement: SQL and German B1.";
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: `<header>Board brand</header><main><article><h1>${cards.find((card) => card.url === url)!.title}</h1><p>Real Employer</p><p>${"Useful duties. ".repeat(2000)}</p><h2>Requirements</h2><p>${lastRequirement}</p><a href="/application/one">Apply now</a></article></main>`,
    }),
  );
  const client = {
    chatWithTools: vi.fn((messages: { content: string }[]) => {
      const input = JSON.parse(messages[1].content) as {
        listings: { id: number; title: string }[];
      };
      return Promise.resolve({
        content: JSON.stringify({
          jobs: input.listings.map((card) => ({
            id: card.id,
            title: card.title,
            company: "Real Employer",
            location: "Berlin",
            workModes: ["onsite"],
            sourceJobId: null,
            employmentType: "Part-time",
            seniority: null,
            salaryText: null,
          })),
        }),
      });
    }),
  };
  const result = await readListings({ cards, readPage, client });
  expect(result.failures).toEqual([]);
  expect(result.jobs).toHaveLength(2);
  expect(
    result.jobs.every(
      (job) =>
        job.description.endsWith("Apply now") &&
        job.description.includes(lastRequirement) &&
        job.description.length > 24000,
    ),
  ).toBe(true);
  expect(result.jobs[0].company).toBe("Real Employer");
  expect(readPage).toHaveBeenCalledTimes(2);
  // Each model request receives complete bodies. Batching never truncates them.
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("provider endpoints are reusable across boards and never claimed from lookalike hosts", () => {
  expect(publicBoardFeed("https://jobs.lever.co/example")?.url).toBe(
    "https://api.lever.co/v0/postings/example?mode=json&limit=250&skip=0",
  );
  expect(publicBoardFeed("https://job-boards.greenhouse.io/acme")?.url).toBe(
    "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
  );
  expect(publicBoardFeed("https://jobs.ashbyhq.com/acme")?.provider).toBe(
    "ashby",
  );
  expect(publicBoardFeed("https://jobs.lever.co.evil.test/acme")).toBeNull();
  expect(
    publicBoardFeed("https://jobs.lever.co/acme/exact-vacancy"),
  ).toBeNull();
});

test("identical cards on different sources retain each URL's own full read and application link", async () => {
  const first = { ...card("Backend Engineer"), sourceJobId: "7" };
  const alias = {
    ...first,
    sourceId: "other",
    url: "https://other.example/jobs/abc",
    sourceJobId: "abc",
  };
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: `<main><h1>Backend Engineer</h1><p>Real Employer</p><p>Complete duties unique to ${url}</p><a href="/apply">Apply now</a></main>`,
    }),
  );
  const result = await readListings({
    cards: [first, alias],
    readPage,
    client: metadataClient(),
  });
  expect(result.failures).toEqual([]);
  expect(readPage).toHaveBeenCalledTimes(2);
  for (const job of result.jobs) {
    expect(job.description).toContain(`unique to ${job.url}`);
    expect(job.applyUrl).toBe(new URL("/apply", job.url).href);
  }
});

test("an authenticated listing is deferred to the browser lane after HTTP refuses it", async () => {
  const listing = {
    ...card("Backend Engineer"),
    companyHint: "Real Employer",
    locationHint: "Remote, Worldwide",
  };
  const readPage = vi.fn((url: string, options: { rendered?: boolean }) =>
    options.rendered
      ? Promise.resolve({
          finalUrl: url,
          html: "<main><h1>Backend Engineer</h1><p>Real Employer</p><p>Own APIs and SQL production services.</p></main>",
        })
      : Promise.reject(new DiscoveryPageReadError(401)),
  );
  const client = metadataClient();
  const http = await readListings({
    cards: [listing],
    readPage,
    client,
    lane: "http",
  });
  expect(http.jobs).toEqual([]);
  expect(http.failures[0]).toMatchObject({ requiresBrowser: true });
  const full = await readListings({
    cards: [listing],
    readPage,
    client,
    lane: "browser",
  });
  expect(full.failures).toEqual([]);
  expect(full.jobs[0]?.description).toContain(
    "Own APIs and SQL production services.",
  );
  expect(
    readPage.mock.calls.map(([, options]) => options.rendered ?? false),
  ).toEqual([false, true]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("judges merged unscored jobs once, retaining low scores and all three explanations", async () => {
  const now = "2026-10-25T08:00:00Z";
  const profile = CandidateProfileSchema.parse({
    id: "synthetic",
    firstName: "Robin",
    lastName: "Ashford",
    fullName: "Robin Ashford",
    headline: "Data analyst",
    summary: null,
    currentLocation: "Berlin",
    currentCountry: "Germany",
    yearsExperience: 2,
    workEligibility: { authorizedWorkCountries: ["Germany"] },
    baseResume: { id: "resume", fileName: "synthetic.txt", uploadedAt: now },
  });
  const job = JobDetailSchema.parse({
    id: 1,
    stage: "found",
    stageNote: null,
    stageChangedAt: now,
    title: "Senior Data Analyst",
    company: "Employer",
    location: "Berlin",
    workModes: ["onsite"],
    salaryText: null,
    fitScore: null,
    fitSummary: null,
    postedAt: null,
    foundAt: now,
    searchId: null,
    sourceLabel: "Board",
    sourceCount: 2,
    url: "https://board.example/1",
    applyUrl: null,
    seenAt: now,
    description: "Full duties and requirements.",
    summary: null,
    seniority: "Senior",
    employmentType: "Part-time",
    salary: null,
    facts: {},
    fit: null,
    sightings: [],
  });
  const verdict = {
    score: 28,
    summary: "Related work with a substantial seniority gap.",
    reasons: [],
    gaps: [],
    role: {
      assessment: "stretch",
      explanation: "Same profession, more responsibility.",
    },
    preferences: { assessment: "aligned", explanation: "Part-time in Berlin." },
    coverage: {
      assessment: "partial",
      explanation:
        "Analytics skills established; senior ownership not evidenced.",
    },
  };
  const client = {
    chatWithTools: vi.fn((...args: Parameters<LLMClient["chatWithTools"]>) => {
      void args;
      return Promise.resolve({
        content: JSON.stringify({
          fits: [
            {
              id: 1,
              s: verdict.score,
              why: verdict.summary,
              r: [verdict.role.assessment, verdict.role.explanation],
              p: [
                verdict.preferences.assessment,
                verdict.preferences.explanation,
              ],
              c: [verdict.coverage.assessment, verdict.coverage.explanation],
              e: ["compatible", "Berlin", "unknown", "DE"],
            },
          ],
        }),
      });
    }),
  };
  const fits = await fitJobs({
    client,
    profile,
    goals: { targetRoles: ["Data Analyst"], locations: ["Berlin"] },
    jobs: [job, { ...job, id: 2, fit: { ...verdict, scoredAt: now } }],
  });
  expect(fits).toHaveLength(1);
  expect(fits[0]).toMatchObject({ id: 1, ...verdict });
  expect(typeof fits[0].scoredAt).toBe("string");
  expect(
    await fitJobs({
      client,
      profile,
      goals: { targetRoles: ["Data Analyst"], locations: ["Berlin"] },
      jobs: [{ ...job, fit: { ...verdict, scoredAt: now } }],
    }),
  ).toEqual([]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  const fitInput = JSON.parse(
    client.chatWithTools.mock.calls[0][0][1].content,
  ) as { listings: { description: string }[] };
  expect(fitInput.listings[0].description).toBe(job.description);
  expect(fitInput).not.toHaveProperty("passages");
  const fit = {
    id: 1,
    s: verdict.score,
    why: verdict.summary,
    r: [verdict.role.assessment, verdict.role.explanation],
    p: [verdict.preferences.assessment, verdict.preferences.explanation],
    c: [verdict.coverage.assessment, verdict.coverage.explanation],
    e: ["compatible", "Berlin", "unknown", "DE"],
  };
  const requests: number[][] = [];
  const secondDescription =
    "An unusual title\n\nBuild SQL extracts and explain weekly trends.\n\nEUR 26 per hour.";
  const retryClient = {
    chatWithTools: vi.fn(
      (messages: Parameters<LLMClient["chatWithTools"]>[0]) => {
        const data = JSON.parse(messages[1].content) as {
          listings: { id: number; description: string }[];
        };
        for (const listing of data.listings)
          expect(listing.description).toBe(
            listing.id === 1 ? job.description : secondDescription,
          );
        requests.push(data.listings.map((item) => item.id));
        return Promise.resolve({
          content: JSON.stringify({
            fits: [{ ...fit, id: requests.length === 1 ? 1 : 2 }],
          }),
        });
      },
    ),
  };
  const repaired = await fitJobs({
    client: retryClient,
    profile,
    goals: { targetRoles: ["Data Analyst"], locations: ["Berlin"] },
    jobs: [job, { ...job, id: 2, description: secondDescription }],
  });
  expect(requests).toEqual([[1, 2], [2]]);
  expect(repaired.map((fit) => fit.id)).toEqual([1, 2]);
  const duplicateRequests: number[][] = [];
  const duplicates = await fitJobs({
    profile,
    goals: { targetRoles: ["Data Analyst"], locations: ["Berlin"] },
    jobs: [job, { ...job, id: 2 }],
    client: {
      chatWithTools: (messages) => {
        duplicateRequests.push(
          (
            JSON.parse(messages[1].content) as { listings: { id: number }[] }
          ).listings.map((row) => row.id),
        );
        return Promise.resolve({
          content: JSON.stringify({
            fits:
              duplicateRequests.length === 1
                ? [fit, fit, { ...fit, id: 2 }]
                : [fit],
          }),
        });
      },
    },
  });
  expect(duplicateRequests).toEqual([[1, 2], [1]]);
  expect(duplicates.map((fit) => fit.id)).toEqual([2, 1]);
  const mixedRequests: number[][] = [];
  const partial = await fitJobs({
    profile,
    goals: { targetRoles: ["Data Analyst"], locations: ["Berlin"] },
    jobs: [job, { ...job, id: 2 }, { ...job, id: 3 }],
    client: {
      chatWithTools: (messages) => {
        const ids = (
          JSON.parse(messages[1].content) as {
            listings: { id: number }[];
          }
        ).listings.map((row) => row.id);
        mixedRequests.push(ids);
        return Promise.resolve({
          content: JSON.stringify({
            fits:
              mixedRequests.length === 1
                ? [fit, { ...fit, id: 2, s: "invalid" }, { ...fit, id: 999 }]
                : ids.map((id) => ({ ...fit, id })),
          }),
        });
      },
    },
  });
  expect(mixedRequests).toEqual([[1, 2, 3], [2], [3]]);
  expect(partial.map((fit) => fit.id)).toEqual([1, 2, 3]);
  const requestSchema =
    client.chatWithTools.mock.calls[0][2]?.jsonSchema?.schema;
  expect(requestSchema).toMatchObject({
    properties: {
      fits: {
        type: "array",
        items: { properties: { id: { type: "integer", minimum: 1 } } },
      },
    },
  });
});

test("a source can be an unlinked single vacancy; its complete page is reused for metadata and full text", async () => {
  const direct = { ...source, url: "https://board.example/a-vacancy" };
  const html =
    '<main><p>Real Employer · Remote</p><h1>Frontend Engineer</h1><h2>About the role</h2><p>Build reliable software with TypeScript and SQL. Collaborate across product and engineering on accessible interfaces.</p><h2>What you bring</h2><p>Professional development experience and clear communication.</p><a href="/apply">Apply now</a></main>';
  const readPage = vi.fn(() => Promise.resolve({ html, finalUrl: direct.url })),
    fallback = vi.fn(() => Promise.reject(new Error("No navigation needed")));
  const inventory = await collectSource({
    source: direct,
    readPage,
    navigateFallback: fallback,
  });
  expect(inventory.complete).toBe(true);
  expect(inventory.needsYou).not.toBe(true);
  expect(inventory.cards).toHaveLength(1);
  expect(inventory.cards[0]?.url).toBe(direct.url);
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        content: JSON.stringify({
          jobs: [
            {
              id: 0,
              title: "Frontend Engineer",
              company: "Real Employer",
              location: "Remote",
              workModes: ["remote"],
              sourceJobId: null,
              employmentType: null,
              seniority: null,
              salaryText: null,
            },
          ],
        }),
      }),
    ),
  };
  const detail = await readListings({
    cards: inventory.cards,
    readPage,
    client,
  });
  expect(detail.jobs[0]?.description).toContain(
    "Professional development experience",
  );
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(fallback).not.toHaveBeenCalled();
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  expect(detail.jobs[0]).toMatchObject({
    company: "Real Employer",
    location: "Remote",
  });
});

test.each(["http", "browser"] as const)(
  "a readable %s page with no vacancies reports zero listings without a sign-in or navigation fallback",
  async (lane) => {
    const fallback = vi.fn(() =>
      Promise.reject(new Error("No navigation needed")),
    );
    const inventory = await collectSource({
      source,
      lane,
      readPage: () =>
        Promise.resolve({
          html: `${lane === "browser" ? '<head><script src="/app.js"></script></head>' : ""}<main><h1>About our company</h1><p>We make useful products with a thoughtful team.</p></main>`,
          finalUrl: source.url,
        }),
      navigateFallback: fallback,
    });
    expect(inventory.cards).toEqual([]);
    expect(inventory.complete).toBe(false);
    expect(inventory.notes.join(" ")).toContain("coverage incomplete");
    expect(inventory.needsYou).not.toBe(true);
    expect(fallback).not.toHaveBeenCalled();
  },
);

test("follows an observed jobs portal without counting the surrounding navigation or product cards", async () => {
  expect(
    listingInventoryReady(
      '<main><a href="https://portal.example/">View open roles</a></main>',
      source.url,
    ),
  ).toBe(true);
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: url.endsWith("/careers")
        ? '<nav><article><h2><a href="/products">Infrastructure</a></h2><p>Our products</p></article></nav><main><article><h2><a href="/blog">Engineering stories</a></h2><p>Meet the team</p></article><a href="https://portal.example/openings">View open roles</a></main>'
        : '<main><article class="job"><h2><a href="/jobs/1">Data Analyst</a></h2><p>Berlin</p></article></main>',
    }),
  );
  const result = await collectSource({
    source: { ...source, url: "https://company.example/careers" },
    readPage,
  });
  expect(result.cards.map((row) => row.title)).toEqual(["Data Analyst"]);
  expect(result.complete).toBe(true);
  expect(readPage.mock.calls.map(([url]) => url)).toEqual([
    "https://company.example/careers",
    "https://portal.example/openings",
  ]);
});

test("a script-only portal reports incomplete coverage, and a public login widget is not an access wall", async () => {
  const html =
    "<main><h1>Careers</h1><p>" +
    "Learn about our work. ".repeat(200) +
    '</p></main><aside><form><input type="password"></form></aside>';
  expect(listingSignInRequired(html)).toBe(false);
  expect(
    listingSignInRequired(
      '<main><h1>Sign in</h1><form><input type="password"></form></main>',
    ),
  ).toBe(true);
  const result = await collectSource({
    source,
    readPage: (url) =>
      Promise.resolve({
        finalUrl: url,
        html: '<div id="app"></div><script src="/app.js"></script>',
      }),
  });
  expect(result.cards).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.needsYou).toBeUndefined();
});

test("reads public embedded vacancy JSON and encoded provider descriptions without executing scripts or using AI", async () => {
  const content =
    "&lt;div&gt;&lt;p&gt;Build &lt;strong&gt;SQL reports&lt;/strong&gt; &amp; dashboards.&lt;/p&gt;&lt;/div&gt;";
  expect(htmlToPlainText(content)).toBe("Build SQL reports & dashboards.");
  const embedded = readInventoryHtml(
    `<script>const publicJobs = ${JSON.stringify([{ id: 1, internal_job_id: 2, title: "Data Analyst", href: "/jobs/1", content }])};</script>`,
    source.url,
    source,
  );
  expect(embedded.cards[0]?.listingText).toBe(
    "Build SQL reports & dashboards.",
  );
  const feedSource = { ...source, url: "https://boards.greenhouse.io/sample" };
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: JSON.stringify(
        url.includes("content=true")
          ? {
              jobs: [
                {
                  id: 1,
                  title: "Data Analyst",
                  absolute_url: "https://boards.greenhouse.io/sample/jobs/1",
                  location: { name: "Remote" },
                  content,
                },
              ],
            }
          : { name: "Hiring Employer" },
      ),
    }),
  );
  const cards = (await collectSource({ source: feedSource, readPage })).cards;
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.reject(Error("Provider already publishes these fields")),
    ),
  };
  const result = await readListings({ cards, readPage, client });
  expect(result.jobs[0]).toMatchObject({
    company: "Hiring Employer",
    location: "Remote",
  });
  expect(result.jobs[0]?.description).toContain(
    "Build SQL reports & dashboards.",
  );
  expect(client.chatWithTools).not.toHaveBeenCalled();
  expect(readPage).toHaveBeenCalledTimes(2);
});

test("a truncated screen batch is left retryable while other title batches complete", async () => {
  const cards = Array.from({ length: 251 }, (_, n) =>
    card(`Analyst specialty ${n}`),
  );
  let count = 0;
  const result = await screenCards({
    cards,
    goals: {
      targetRoles: ["Analyst"],
      relatedRoles: [],
      strategy: "target_roles",
    },
    client: {
      chatWithTools: vi.fn(
        (messages: Parameters<LLMClient["chatWithTools"]>[0]) =>
          ++count === 1
            ? Promise.reject(Error("incomplete response"))
            : Promise.resolve({
                content: JSON.stringify({
                  keep: Object.fromEntries(
                    (
                      JSON.parse(messages[1].content) as { titles: unknown[] }
                    ).titles.map((_, index) => [String(index), 1]),
                  ),
                }),
              }),
      ),
    },
  });
  expect(result.failed).toHaveLength(120);
  expect(result.seen).toEqual([]);
  expect(result.related.map((row) => row.title)).toEqual(
    cards.slice(120).map((row) => row.title),
  );
});

test("even exact role-title prefixes are decided by the model", async () => {
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({ content: '{"keep":{"0":0,"1":1}}' }),
    ),
  };
  const result = await screenCards({
    client,
    goals: {
      targetRoles: ["Backend Engineer"],
      relatedRoles: ["Platform Engineer"],
      strategy: "related_roles",
    },
    cards: [card("Staff Backend Engineer"), card("Senior Platform Engineer")],
  });
  expect(result.related.map((card) => card.title)).toEqual([
    "Senior Platform Engineer",
  ]);
  expect(result.seen).toHaveLength(1);
  expect(client.chatWithTools).toHaveBeenCalledOnce();
});

test("hands a directory choice to browser navigation without crawling all categories", async () => {
  const directory =
    '<nav><h3>Jobs by teams</h3><ul><li><a href="/bogus1">Product 3</a></li><li><a href="/bogus2">News 4</a></li></ul></nav><main><h3>Openings By Teams</h3><ul><li><a href="/engineering"><span>Engineering</span><span>2</span></a></li><li><a href="/design">Design (1)</a></li></ul></main>';
  const parsed = readInventoryHtml(directory, source.url, source);
  expect(parsed.cards).toEqual([]);
  expect(parsed.portals).toEqual([
    "https://board.example/engineering",
    "https://board.example/design",
  ]);
  expect(listingInventoryReady(directory, source.url)).toBe(true);
  const result = await collectSource({
    source,
    lane: "browser",
    readPage: (url) =>
      Promise.resolve({
        finalUrl: url,
        html:
          url === source.url
            ? directory
            : '<main><a href="/jobs/1"><h4>Data Analyst</h4><p>London</p></a></main>',
      }),
  });
  expect(result.cards).toEqual([]);
  expect(result.complete).toBe(false);
  expect(result.requiresBrowser).toBe(true);
});

test("malformed screening retries only its unfinished titles in small groups", async () => {
  let calls = 0;
  const cards = Array.from({ length: 121 }, (_, i) =>
    card(`Analyst specialty ${i}`),
  );
  const result = await screenCards({
    cards,
    goals: {
      targetRoles: ["Analyst"],
      relatedRoles: [],
      strategy: "target_roles",
    },
    client: {
      chatWithTools: vi.fn(
        (messages: Parameters<LLMClient["chatWithTools"]>[0]) => {
          const data = JSON.parse(messages[1].content) as { titles: unknown[] };
          calls++;
          return Promise.resolve({
            content:
              calls === 1
                ? "broken"
                : JSON.stringify({
                    keep: Object.fromEntries(
                      data.titles.map((_, index) => [String(index), 1]),
                    ),
                  }),
          });
        },
      ),
    },
  });
  expect(result.failed).toEqual([]);
  expect(result.related).toHaveLength(121);
  expect(calls).toBe(8);
});

test("ambiguous provider titles include cached full duties in their first judgment", async () => {
  const listing = {
    ...card("Software Engineer - Marketplaces"),
    listingText: "Our team develops and operates backend services.",
  };
  const client = {
    chatWithTools: vi.fn(
      (messages: Parameters<LLMClient["chatWithTools"]>[0]) =>
        Promise.resolve({
          content: JSON.stringify({
            keep: {
              0: messages[1].content.includes(
                "Our team develops and operates backend services",
              )
                ? 1
                : 0,
            },
          }),
        }),
    ),
  };
  const result = await screenCards({
    client,
    cards: [listing],
    goals: {
      targetRoles: ["Backend Engineer"],
      relatedRoles: [],
      strategy: "target_roles",
    },
  });
  expect(result.related).toEqual([listing]);
  expect(result.seen).toEqual([]);
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("uncertain metadata receives the complete listing on its first model call", async () => {
  const description =
    "Useful duties. ".repeat(1000) +
    "Northstar Trellis" +
    "Useful duties. ".repeat(1000);
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: `<main><h1>Data Analyst</h1><p>${description}</p></main>`,
    }),
  );
  const client = {
    chatWithTools: vi.fn(
      (messages: Parameters<LLMClient["chatWithTools"]>[0]) =>
        Promise.resolve({
          content: JSON.stringify({
            jobs: [
              {
                id: 0,
                title: "Data Analyst",
                company: messages[1].content.includes("Northstar Trellis")
                  ? "Northstar Trellis"
                  : "",
                location: "Berlin",
                workModes: [],
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
    client,
    cards: [card("Data Analyst")],
    readPage,
  });
  expect(result.jobs[0]?.company).toBe("Northstar Trellis");
  expect(result.jobs[0]?.description).toContain(description.trim());
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  expect(readPage).toHaveBeenCalledTimes(1);
});

test("single vacancies also preserve explicitly labelled employer and location after their heading", async () => {
  const html =
    '<header>ATS brand</header><main><article><h1>Backend Engineer</h1><p class="company">Hiring Employer</p><p class="job-location">Berlin · Hybrid</p><h2>Responsibilities</h2><p>Build reliable production APIs and maintain scalable data services with a cross-functional engineering team.</p><a href="/apply">Apply</a></article></main>';
  const readPage = vi.fn(() => Promise.resolve({ html, finalUrl: source.url }));
  const inventory = await collectSource({ source, readPage });
  const client = metadataClient("Hiring Employer", "Berlin", ["hybrid"]);
  const detail = await readListings({
    cards: inventory.cards,
    readPage,
    client,
  });
  expect(detail.failures).toEqual([]);
  expect(detail.jobs[0]).toMatchObject({
    title: "Backend Engineer",
    company: "Hiring Employer",
    location: "Berlin",
    workModes: ["hybrid"],
  });
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
  expect(readPage).toHaveBeenCalledTimes(1);
});

test("a breadcrumb above a vacancy is not its hiring employer", () => {
  const html =
    '<main><p>Home · Careers</p><h1>Backend Engineer</h1><h2>About the role</h2><p>Build production services and collaborate with engineers on reliable software, APIs and data systems.</p><a href="/apply">Apply</a></main>';
  const [card] = readInventoryHtml(html, source.url, source).cards;
  expect(card?.companyHint).toBeUndefined();
  expect(card?.locationHint).toBeUndefined();
});

test("a known employer beside a breadcrumb still needs the real location read", async () => {
  const html =
    '<main><p>Home · Careers</p><h1>Backend Engineer</h1><p class="company">Real Employer</p><p>Berlin</p><h2>About the role</h2><p>Build production services and collaborate with engineers on reliable software, APIs and data systems.</p><a href="/apply">Apply</a></main>';
  const cards = readInventoryHtml(html, source.url, source).cards;
  expect(cards[0]?.companyHint).toBe("Real Employer");
  expect(cards[0]?.locationHint).toBeUndefined();
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({
        content: JSON.stringify({
          jobs: [
            {
              id: 0,
              title: "Backend Engineer",
              company: "Real Employer",
              location: "Berlin",
              workModes: [],
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
    cards,
    client,
    readPage: () => Promise.resolve({ html, finalUrl: source.url }),
  });
  expect(result.jobs[0]?.location).toBe("Berlin");
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test.each([403, 429, 999, 404, 410, 500])(
  "a browser HTTP %s hands its failure to browser navigation",
  async (status) => {
    const navigateFallback = vi.fn(() =>
      Promise.resolve({
        cards: [],
        complete: false,
        pagesRead: 1,
        notes: [`The site returned HTTP ${status} after a browser attempt.`],
      }),
    );
    const result = await collectSource({
      source,
      lane: "browser",
      readPage: () => Promise.reject(new DiscoveryPageReadError(status)),
      navigateFallback,
    });
    expect(navigateFallback).toHaveBeenCalledOnce();
    expect(result.complete).toBe(false);
    expect(result.needsYou).not.toBe(true);
    expect(result.notes.join(" ")).toContain(`HTTP ${status}`);
    return Promise.resolve();
  },
);

test("a model-completed browser inventory can contain zero new cards", async () => {
  const inventory = await collectSource({
    source,
    lane: "browser",
    readPage: () =>
      Promise.resolve({
        html: '<div id="root"></div>',
        finalUrl: source.url,
      }),
    navigateFallback: () =>
      Promise.resolve({
        cards: [],
        pagesRead: 1,
        complete: true,
        notes: ["Finished"],
      }),
  });
  expect(inventory.complete).toBe(true);
  expect(inventory.notes.join(" ")).not.toContain("No listings were read");
});

test("unlabelled paragraphs after a card title are not location evidence", () => {
  const html =
    '<article><h2><a href="/jobs/1">Junior Data Analyst</a></h2><p>Example Analytics</p><p>Berlin, Germany</p><p>20 hours per week</p></article>';
  const cards = readInventoryHtml(html, source.url, source).cards;
  expect(cards).toHaveLength(1);
  expect(cards[0]?.locationHint).toBeUndefined();
});

test("a vacancy's published address overrides an incorrect card location hint", async () => {
  const title = "Junior Data Analyst";
  const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title, description: "Build SQL and Python dashboards with the analytics team in Berlin.", hiringOrganization: { name: "Example Analytics" }, jobLocation: { address: { addressLocality: "Berlin", addressCountry: "DE" } } })}</script><main><h1>${title}</h1><p>Example Analytics</p><p>Berlin, Germany</p><p>Build SQL and Python dashboards with the analytics team in Berlin.</p></main>`;
  const client = metadataClient("Example Analytics", "Berlin, Germany");
  const result = await readListings({
    cards: [{ ...card(title), locationHint: "Example Analytics" }],
    readPage: (url) => Promise.resolve({ html, finalUrl: url }),
    client,
  });
  expect(result.failures).toEqual([]);
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]).toMatchObject({
    company: "Example Analytics",
    location: "Berlin, Germany",
  });
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test("an employer-before-title card keeps its separate location without structured data", async () => {
  const html =
    '<article><p>Example Analytics</p><h2><a href="/jobs/1">Junior Data Analyst</a></h2><p>Berlin, Germany</p></article>';
  const cards = readInventoryHtml(html, source.url, source).cards;
  expect(cards[0]).toMatchObject({
    companyHint: "Example Analytics",
    locationHint: "Berlin, Germany",
  });
  const client = metadataClient("Example Analytics", "Berlin, Germany");
  const detail =
    "<main><h1>Junior Data Analyst</h1><p>Example Analytics</p><p>Berlin, Germany</p><p>Build SQL and Python dashboards with the analytics team.</p></main>";
  const result = await readListings({
    cards,
    readPage: (url) => Promise.resolve({ html: detail, finalUrl: url }),
    client,
  });
  expect(result.jobs[0]?.location).toBe("Berlin, Germany");
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
});

test.each([401, 403])(
  "an access wall at HTTP %s reaches browser navigation with settings as context",
  async (status) => {
    const readPage = () => Promise.reject(new DiscoveryPageReadError(status));
    const fallback = vi.fn(() =>
      Promise.resolve({
        cards: [card("Platform engineer")],
        complete: true,
        pagesRead: 1,
        notes: [],
      }),
    );
    const ordinary = await collectSource({
      source,
      lane: "browser",
      readPage,
      navigateFallback: fallback,
    });
    expect(ordinary.needsYou).not.toBe(true);
    expect(ordinary.complete).toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
    const http = await collectSource({
      source,
      lane: "http",
      readPage,
      browserAccessAuthorized: true,
    });
    expect(http.requiresBrowser).toBe(true);
    expect(http.accessBlocked).not.toBe(true);
    const optedIn = await collectSource({
      source,
      lane: "browser",
      readPage,
      browserAccessAuthorized: true,
      navigateFallback: fallback,
    });
    expect(optedIn.complete).toBe(true);
    expect(optedIn.notes.join(" ")).not.toContain(`HTTP ${status}`);
    expect(optedIn.cards).toHaveLength(1);
    expect(fallback).toHaveBeenCalledTimes(2);
  },
);

test("a successful access step rechecks rendered inventory before claiming coverage", async () => {
  const readPage = vi
    .fn()
    .mockRejectedValueOnce(new DiscoveryPageReadError(401))
    .mockResolvedValue({
      html: '<main><h1>Open jobs</h1><article><h2><a href="/jobs/1">Platform engineer</a></h2><p>Example Company</p><p>Berlin</p></article></main>',
      finalUrl: source.url,
    });
  const result = await collectSource({
    source,
    lane: "browser",
    readPage,
    browserAccessAuthorized: true,
    navigateFallback: () =>
      Promise.resolve({
        cards: [card("Platform engineer")],
        complete: false,
        pagesRead: 1,
        notes: [],
      }),
  });
  expect(readPage).toHaveBeenCalledTimes(2);
  expect(result.complete).toBe(true);
  expect(result.notes.join(" ")).not.toContain("HTTP 401");
});

test("completed browser coverage replaces the initial load-more warning", async () => {
  const result = await collectSource({
    source,
    readPage: () =>
      Promise.resolve({
        finalUrl: source.url,
        html: '<main>Loading</main><script src="app.js"></script>',
      }),
    navigateFallback: () =>
      Promise.resolve({
        cards: [
          {
            sourceId: source.id,
            sourceLabel: source.label,
            url: `${source.url}/job`,
            title: "Analyst",
            text: "Analyst",
            cardFingerprint: "one",
          },
        ],
        pagesRead: 2,
        complete: true,
        notes: ["Every observed forward control was exhausted."],
      }),
  });
  expect(result.complete).toBe(true);
  expect(result.notes).toEqual([
    "Every observed forward control was exhausted.",
  ]);
});

test("missing title/company parses and a different heading still reach the model with the complete listing", async () => {
  const middle = "Special requirement in the middle: Albanian and TypeScript.";
  const text = "Duties ".repeat(8000) + middle + " Details".repeat(8000);
  const chatWithTools = vi.fn<LLMClient["chatWithTools"]>((messages) => {
    expect(messages[1].content).toContain(middle);
    expect(messages[1].content).toContain("The last requirement");
    return Promise.resolve({
      content: JSON.stringify({
        jobs: [
          {
            id: 0,
            title: "",
            company: "",
            location: "",
            workModes: [],
            sourceJobId: null,
            employmentType: null,
            seniority: null,
            salaryText: null,
            isListing: true,
          },
        ],
      }),
    });
  });
  const result = await readListings({
    cards: [card("Inxhinier Softueri")],
    client: { chatWithTools },
    readPage: (url) =>
      Promise.resolve({
        finalUrl: url,
        html: `<main><h2>Përshkrimi</h2><p>${text}</p><p>The last requirement</p></main><script>app()</script>`,
      }),
  });
  expect(result.failures).toEqual([]);
  expect(result.jobs[0]).toMatchObject({
    title: "Inxhinier Softueri",
    company: "Company not stated",
  });
  expect(result.jobs[0]?.description).toContain(middle);
  expect(result.jobs[0]?.description).toContain("The last requirement");
  expect(chatWithTools).toHaveBeenCalledOnce();
});
