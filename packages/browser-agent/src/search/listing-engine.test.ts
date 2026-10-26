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
import { readInventoryHtml, listingSignInRequired } from "./listing-html";
import { htmlToPlainText } from "./listing-detail-extraction";
import { listingClosedReason } from "./listing-status";
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
      Promise.resolve({ content: '{"keep":{"0":0}}' }),
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
  // Full bodies are retained; metadata excerpts let both fit in one read call.
  expect(client.chatWithTools).toHaveBeenCalledTimes(1);
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

test("identical cross-site cards share one full read, preserving each site's identity and the real employer", async () => {
  const first = {
    ...card("Backend Engineer"),
    companyHint: "Real Employer",
    locationHint: "Remote, Worldwide",
    sourceJobId: "7",
  };
  const alias = {
    ...first,
    url: "https://other.example/vacancies/abc",
    sourceId: "other",
    sourceJobId: "abc",
  };
  const readPage = vi.fn(() =>
    Promise.resolve({
      finalUrl: first.url,
      html: `<main><h1>Backend Engineer</h1><p>Real Employer · Remote, Worldwide</p><h2>Requirements</h2><p>${"Build production APIs with SQL. ".repeat(10)}</p><a href="/apply/7">Apply now</a></main>`,
    }),
  );
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.reject(
        new Error("Published corroborated facts need no model read"),
      ),
    ),
  };
  const result = await readListings({
    cards: [first, alias],
    readPage,
    client,
  });
  expect(result.failures).toEqual([]);
  expect(readPage).toHaveBeenCalledTimes(1);
  expect(client.chatWithTools).not.toHaveBeenCalled();
  expect(
    result.jobs.map((job) => [job.company, job.sourceJobId, job.applyUrl]),
  ).toEqual([
    ["Real Employer", "7", "https://board.example/apply/7"],
    ["Real Employer", "abc", null],
  ]);
  expect(result.jobs[1]?.description).toBe(result.jobs[0]?.description);
  readPage.mockClear();
  await readListings({
    cards: [
      first,
      {
        ...first,
        url: "https://board.example/another-opening",
        sourceJobId: "8",
      },
    ],
    readPage,
    client,
  });
  expect(readPage).toHaveBeenCalledTimes(2);
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
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.reject(new Error("No model transcription needed")),
    ),
  };
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
  expect(client.chatWithTools).not.toHaveBeenCalled();
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
    yearsExperience: 2,
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
  ) as { passages: string[]; listings: { passages: number[] }[] };
  expect(
    fitInput.listings[0].passages
      .map((id) => fitInput.passages[id])
      .join("\n\n"),
  ).toBe(job.description);
  const fit = {
    id: 1,
    s: verdict.score,
    why: verdict.summary,
    r: [verdict.role.assessment, verdict.role.explanation],
    p: [verdict.preferences.assessment, verdict.preferences.explanation],
    c: [verdict.coverage.assessment, verdict.coverage.explanation],
  };
  const requests: number[][] = [];
  const retryClient = {
    chatWithTools: vi.fn(
      (messages: Parameters<LLMClient["chatWithTools"]>[0]) => {
        const data = JSON.parse(messages[1].content) as {
          listings: { id: number }[];
        };
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
    jobs: [job, { ...job, id: 2 }],
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
            JSON.parse(messages[1]!.content) as { listings: { id: number }[] }
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
  const requestSchema =
    client.chatWithTools.mock.calls[0]![2]?.jsonSchema?.schema;
  expect(requestSchema).toMatchObject({
    properties: {
      fits: { type: "array", items: { properties: { id: { enum: [1] } } } },
    },
  });
});

test("closed text outside the job body remains hidden without an AI fit", async () => {
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.reject(new Error("Metadata already published")),
    ),
  };
  const listing = {
    ...card("Senior Visual Designer"),
    companyHint: "Real Employer",
    locationHint: "Manchester, United Kingdom",
  };
  const readPage = vi.fn((url: string) =>
    Promise.resolve({
      finalUrl: url,
      html: `<main><article><h1>Senior Visual Designer</h1><p>Real Employer</p><p>Manchester, United Kingdom</p><p>Design thoughtful visual systems and collaborate with researchers.</p></article><p role="status">This job is no longer accepting applications.</p></main>`,
    }),
  );
  const result = await readListings({ cards: [listing], readPage, client });
  expect(result.jobs[0]?.hiddenReason).toMatch(/^Closed:/);
  expect(result.jobs[0]?.description).toContain("visual systems");
  expect(client.chatWithTools).not.toHaveBeenCalled();
});

test("an expired published closing date closes a listing; posting age and future deadlines do not", () => {
  const yesterday = new Date(Date.now() - 2 * 86400000).toISOString();
  const tomorrow = new Date(Date.now() + 2 * 86400000).toISOString();
  expect(listingClosedReason("Apply now", yesterday)).toMatch(/^Closed:/);
  expect(
    listingClosedReason("Applications close on a future date", tomorrow),
  ).toBeNull();
  expect(listingClosedReason("Posted three months ago. Apply now.")).toBeNull();
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
  expect(client.chatWithTools).not.toHaveBeenCalled();
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

test("clear requested role variants need no model; ambiguous professions still use compact evidence", async () => {
  const client = {
    chatWithTools: vi.fn(() =>
      Promise.resolve({ content: '{"keep":{"0":0}}' }),
    ),
  };
  const goals = {
    targetRoles: ["Senior Backend Engineer"],
    relatedRoles: ["Platform Engineer"],
    strategy: "related_roles" as const,
  };
  const first = await screenCards({
    client,
    goals,
    cards: [
      card("Staff Backend Engineer"),
      card("Senior Platform Engineer - hybrid Manchester"),
    ],
  });
  expect(first.related).toHaveLength(2);
  expect(client.chatWithTools).not.toHaveBeenCalled();
  const ambiguous = {
    ...card("Solutions Engineer"),
    text: JSON.stringify({
      title: "Solutions Engineer",
      categories: { team: "Pre-sales" },
      location: "x".repeat(5000),
      companyEvidence: "y".repeat(5000),
    }),
  };
  const second = await screenCards({ client, goals, cards: [ambiguous] });
  expect(second.related).toEqual([]);
  expect(client.chatWithTools.mock.calls).toHaveLength(1);
});

test("follows counted opening directories without counting categories or navigation as vacancies", async () => {
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
  expect(result.cards.map((c) => c.title)).toEqual(["Data Analyst"]);
  expect(result.complete).toBe(true);
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

test("negative titles get a second look when cached full text names requested duties", async () => {
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
              0: messages[1].content.includes("Role-duty evidence") ? 1 : 0,
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
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
});

test("uncertain metadata expands only the unresolved listing; full descriptions stay intact", async () => {
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
  expect(client.chatWithTools).toHaveBeenCalledTimes(2);
  expect(readPage).toHaveBeenCalledTimes(1);
});

test("single vacancies also preserve explicitly labelled employer and location after their heading", async () => {
  const html =
    '<header>ATS brand</header><main><article><h1>Backend Engineer</h1><p class="company">Hiring Employer</p><p class="job-location">Berlin · Hybrid</p><h2>Responsibilities</h2><p>Build reliable production APIs and maintain scalable data services with a cross-functional engineering team.</p><a href="/apply">Apply</a></article></main>';
  const readPage = vi.fn(() => Promise.resolve({ html, finalUrl: source.url }));
  const inventory = await collectSource({ source, readPage });
  const client = {
    chatWithTools: vi.fn(() => Promise.reject(Error("No AI metadata needed"))),
  };
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
  expect(client.chatWithTools).not.toHaveBeenCalled();
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

test.each([404, 410, 500])(
  "a browser HTTP %s remains unreadable without an AI navigation attempt",
  async (status) => {
    const fallback = vi.fn(() =>
      Promise.reject(Error("No navigation on error pages")),
    );
    const result = await collectSource({
      source,
      lane: "browser",
      readPage: () => Promise.reject(new DiscoveryPageReadError(status)),
      navigateFallback: fallback,
    });
    expect(result.complete).toBe(false);
    expect(result.cards).toEqual([]);
    expect(result.needsYou).not.toBe(true);
    expect(result.notes.join(" ")).toContain(`HTTP ${status}`);
    expect(fallback).not.toHaveBeenCalled();
  },
);

test("zero cards can never inherit complete coverage from browser navigation", async () => {
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
  expect(inventory.complete).toBe(false);
  expect(inventory.notes.join(" ")).toContain("No listings were read");
});
