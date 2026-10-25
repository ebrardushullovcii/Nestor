import {
  CandidateProfileSchema,
  JobPostingSchema,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import type { JobExtractor, LLMClient } from "../agent/contracts";
import { buildApplyFormObservation } from "../apply/page-hands";
import type { ApplyPageHands } from "../apply/types";
import type { AgentConfig } from "../types";
import type { Page } from "playwright";
import { buildExtractionSelectionContext, describeNonPosting, runJobSearchAgent } from "./job-search-agent";
import { createSearchResultCache } from "./search-result-cache";
import { createJobSearchPrompts } from "./job-search-prompts";
import { describeSearchGoal } from "./move-reviewer";

test("a wide request and related roles reach browsing, extraction and off-site review", () => {
  const run = config({
    searchPreferences: {
      targetRoles: ["Backend Engineer"],
      jobFamilies: ["Platform Engineer", "API Engineer"],
      locations: ["United States"],
      excludedLocations: ["Canada"],
      employmentTypes: ["Full-time"],
    },
    promptContext: {
      siteLabel: "Jobs",
      searchRequest: { intent: "Include related roles", breadth: "wide", freshness: "any", sourceIds: "all" },
      searchGuidance: { selectivity: "best_matches", remoteCountsAsAnyLocation: true },
    },
  });
  const prompt = createJobSearchPrompts(run).system;
  const extraction = JSON.parse(buildExtractionSelectionContext(run, [])) as {
    goals: AgentConfig["searchPreferences"];
    searchGuidance: { selectivity: string };
  };
  expect(prompt).toContain("find a broad pool of plausible jobs");
  expect(prompt).toContain("Platform Engineer, API Engineer");
  expect(prompt).toContain('"excludedLocations":["Canada"]');
  expect(extraction.goals).toEqual(run.searchPreferences);
  expect(extraction.searchGuidance.selectivity).toBe("wide_net");
  expect(describeSearchGoal(run)).toContain("broad pool");
});

function rawPage(overrides: Partial<RawApplyPage> = {}): RawApplyPage {
  return {
    url: "https://jobs.example.test/search?q=engineer",
    title: "Jobs",
    bodyText: "Platform Engineer at Northwind. Data Engineer at Contoso.",
    controls: [],
    actions: [{ index: 0, label: "Next page", visible: true, disabled: false }],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
    ...overrides,
  };
}

function hands(pages: { current: RawApplyPage }): ApplyPageHands {
  return {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(pages.current, "2026-09-14T10:00:00.000Z"),
      ),
    navigate: (url) => {
      pages.current = rawPage({ url });
      return Promise.resolve({ ok: true, url });
    },
    clickElement: () => {
      pages.current = rawPage({
        url: "https://jobs.example.test/search?q=engineer&page=2",
      });
      return Promise.resolve({ ok: true, observedValue: "clicked" });
    },
    scroll: () => Promise.resolve({ ok: true, observedValue: "down" }),
    wait: () => Promise.resolve(),
    goBack: () => Promise.resolve({ ok: true, url: pages.current.url ?? "" }),
    readText: () => Promise.resolve(pages.current.bodyText),
    fillText: (_ref, value) =>
      Promise.resolve({ ok: true, observedValue: value }),
    chooseOption: (_ref, option) =>
      Promise.resolve({ ok: true, observedValue: option }),
    setToggle: () => Promise.resolve({ ok: true, observedValue: "checked" }),
    uploadFile: (_ref, file) =>
      Promise.resolve({ ok: true, observedValue: file.name }),
    clickAction: () => Promise.resolve({ ok: true, observedValue: "clicked" }),
    followLink: () =>
      Promise.resolve({ ok: true, url: pages.current.url ?? "" }),
  };
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    source: "target_site",
    maxSteps: 60,
    targetJobCount: 10,
    userProfile: CandidateProfileSchema.parse({
      id: "candidate_test",
      firstName: "Robin",
      lastName: "Ashford",
      fullName: "Robin Ashford",
      headline: "Platform engineer",
      summary: "Builds dependable internal tools.",
      currentLocation: "Manchester",
      yearsExperience: 8,
      baseResume: {
        id: "resume_test",
        fileName: "resume.txt",
        uploadedAt: "2026-09-01T09:00:00.000Z",
        textContent: "8 years of platform engineering.",
        textUpdatedAt: "2026-09-01T09:00:00.000Z",
        extractionStatus: "ready",
      },
      experiences: [
        {
          id: "experience_1",
          title: "Platform Engineer",
          companyName: "Northwind",
          startDate: "2020",
          isCurrent: true,
          summary: "Built reliable developer tooling.",
        },
      ],
      education: [
        {
          id: "education_1",
          degree: "BSc",
          fieldOfStudy: "Computer Science",
          schoolName: "Example University",
        },
      ],
    }),
    searchPreferences: {
      targetRoles: ["Platform Engineer"],
      locations: ["Manchester"],
    },
    startingUrls: ["https://jobs.example.test/search?q=engineer"],
    navigationPolicy: {
      allowedHostnames: ["jobs.example.test"],
      allowSubdomains: true,
    },
    promptContext: { siteLabel: "the example board" },
    ...overrides,
  };
}

function scripted(
  turns: Array<{ name: string; args?: Record<string, unknown> }>,
): LLMClient {
  let calls = 0;
  return {
    chatWithTools: () => {
      const turn = turns[Math.min(calls, turns.length - 1)];
      calls += 1;
      return Promise.resolve({
        toolCalls: [
          {
            id: `call_${calls}`,
            type: "function" as const,
            function: {
              name: turn.name,
              arguments: JSON.stringify(turn.args ?? {}),
            },
          },
        ],
      });
    },
  };
}

test("unmatched pages can progress past the no-saves window", async () => {
  const pages = { current: rawPage() };
  const liveHands = hands(pages);
  liveHands.navigate = (url) => {
    pages.current = rawPage({ url, bodyText: `A different page of unrelated vacancies: ${url}` });
    return Promise.resolve({ ok: true, url });
  };
  const turns = Array.from({ length: 10 }, (_, index) => [
    { name: "navigate", args: { url: `https://jobs.example.test/search?page=${index}` } },
    { name: "extract_jobs", args: { pageType: "search_results" } },
  ]).flat();
  const result = await runJobSearchAgent({
    hands: liveHands,
    config: config({ runControl: { noProgressStepLimit: 3 } }),
    llmClient: scripted([...turns, { name: "finish", args: { reason: "Results exhausted." } }]),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
  });
  expect(result.steps).toBe(21);
  expect(result.incomplete).toBe(false);
});

test("lists links after the view's limit and advances via the selected page control", async () => {
  const pages = { current: rawPage({ links: Array.from({ length: 205 }, (_, index) => ({
    index, label: `Page link ${index}`, href: `https://jobs.example.test/link/${index}`,
    visible: true, target: "", topOffset: index,
  })) }) };
  const liveHands = hands(pages);
  const click = vi.spyOn(liveHands, "clickElement");
  let answer = "";
  const model = scripted([
    { name: "list_links", args: { offset: 200 } },
    { name: "next_page", args: { ref: "a0" } },
    { name: "finish", args: { reason: "Last page." } },
  ]);
  const result = await runJobSearchAgent({
    hands: liveHands, config: config(), jobExtractor: extractor,
    llmClient: { chatWithTools: (messages, tools, options) => {
      const last = messages.at(-1);
      if (last?.role === "tool" && last.content.includes('"nextOffset"')) answer = last.content;
      return model.chatWithTools(messages, tools, options);
    } },
  });
  expect(JSON.parse(answer)).toMatchObject({ total: 205, nextOffset: null, links: [
    { ref: "l200" }, { ref: "l201" }, { ref: "l202" }, { ref: "l203" }, { ref: "l204" },
  ] });
  expect(click).toHaveBeenCalledWith("a0");
  expect(result.incomplete).toBe(false);
});

test.each(["job_detail", "explicit"])("a later model decision can correct a duplicate's earlier rejection (%s)", async (kind) => {
  let reads = 0;
  const result = await runJobSearchAgent({
    hands: hands({ current: rawPage() }), config: config(),
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "navigate", args: { url: "https://jobs.example.test/jobs/j1" } },
      { name: "extract_jobs", args: kind === "job_detail"
        ? { pageType: "job_detail" }
        : { pageType: "search_results", rejected: [{ url: "https://jobs.example.test/jobs/j1", category: "place", reason: "The model now confirms a different work location." }] } },
      { name: "finish", args: { reason: "Corrected the decision after reading more." } },
    ]),
    jobExtractor: { extractJobsFromPage: () => {
      reads += 1;
      return Promise.resolve([{ ...posting("Platform Engineer", "Northwind", "j1"),
        searchRejection: reads === 1 ? { category: "closed" as const, reason: "Provisional card reading." } : null,
      }]);
    } },
  });
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]?.searchRejection).toEqual(kind === "job_detail" ? null : {
    category: "place", reason: "The model now confirms a different work location.",
  });
});

function posting(title: string, company: string, id: string) {
  return {
    sourceJobId: id,
    canonicalUrl: `https://jobs.example.test/jobs/${id}`,
    title,
    company,
    location: "Manchester",
    workMode: ["hybrid" as const],
    applyPath: "unknown" as const,
    postedAt: "2026-09-10T09:00:00.000Z",
    salaryText: null,
    summary: `${title} at ${company}.`,
    description: `${title} at ${company}. Build things.`,
    easyApplyEligible: false,
    keySkills: ["TypeScript"],
  };
}

const extractor: JobExtractor = {
  extractJobsFromPage: vi.fn(() =>
    Promise.resolve([
      posting("Platform Engineer", "Northwind", "j1"),
      posting("Data Engineer", "Contoso", "j2"),
    ]),
  ),
};

test.each(["same", "text", "link", "unlinked"])(
  "results section reuse across filter routes checks all page evidence (%s)",
  async (change) => {
    const link = {
      index: 0,
      label: "Platform Engineer",
      href: "https://jobs.example.test/jobs/j1",
      visible: true,
      target: "",
      topOffset: 0,
    };
    const pages = { current: rawPage({ actions: [], links: [link] }) };
    const pageHands = hands(pages);
    pageHands.navigate = (url) => {
      pages.current = rawPage({
        url,
        actions: [],
        bodyText:
          change === "text"
            ? "Platform Engineer at Northwind. New restrictions."
            : pages.current.bodyText,
        links: [
          {
            ...link,
            href:
              change === "link"
                ? "https://jobs.example.test/jobs/j2"
                : link.href,
          },
        ],
      });
      return Promise.resolve({ ok: true, url });
    };
    const read = vi.fn(() =>
      Promise.resolve([
        posting(
          "Platform Engineer",
          "Northwind",
          change === "unlinked" ? "other" : "j1",
        ),
      ]),
    );
    const result = await runJobSearchAgent({
      config: config(),
      hands: pageHands,
      jobExtractor: { extractJobsFromPage: read },
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        {
          name: "navigate",
          args: { url: "https://jobs.example.test/search?filter=new" },
        },
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "Read both result pages." } },
      ]),
    });
    expect(read).toHaveBeenCalledTimes(change === "same" ? 1 : 2);
    expect(result.pagesCovered).toBe(2);
    expect(result.jobs).toHaveLength(1);
  },
);

describe("job search agent", () => {
  test("reports repeated bot checks to the model, lets it continue, and keeps jobs when it finishes blocked", async () => {
    const pages = { current: rawPage() };
    const pageHands = hands(pages);
    const navigate = vi.fn((url: string) => {
      pages.current = rawPage({
        url,
        title: "Just a moment...",
        bodyText: "Verifying your browser. Ray id changes on each request.",
        actions: [],
      });
      return Promise.resolve({ ok: true as const, url });
    });
    pageHands.navigate = navigate;
    const onCheckpoint = vi.fn();
    const modelReason =
      "The detail pages still ask for a bot check. Open jobs.example.test in the app's browser, get past the check, and search again. The jobs saved so far are kept.";
    const seen: string[] = [];
    const model = scripted([
      { name: "extract_jobs" },
      { name: "navigate", args: { url: "https://jobs.example.test/jobs/j1" } },
      { name: "navigate", args: { url: "https://jobs.example.test/jobs/j2" } },
      { name: "navigate", args: { url: "https://jobs.example.test/jobs/j3" } },
      {
        name: "finish",
        args: {
          blockedBy: "security_check",
          needsPerson: true,
          reason: modelReason,
        },
      },
    ]);
    const result = await runJobSearchAgent({
      hands: pageHands,
      config: config({ onCheckpoint }),
      llmClient: {
        chatWithTools: (messages, tools, options) => {
          seen.push(messages.map((message) => message.content).join("\n"));
          return model.chatWithTools(messages, tools, options);
        },
      },
      jobExtractor: extractor,
    });
    const fact =
      "This page is a bot check, seen twice in a row on jobs.example.test. Only the person can get past it. If it is still showing, finish this source with blockedBy: security_check and needsPerson: true, and tell the person to open jobs.example.test in the app's browser, get past the check, and search again. Jobs saved so far are kept.";
    expect(seen[2]).not.toContain(fact);
    expect(seen[3]).toContain(fact);
    expect(seen).toHaveLength(5);
    expect(navigate).toHaveBeenCalledTimes(3);
    expect(result.jobs.map((job) => job.sourceJobId)).toEqual(["j1", "j2"]);
    expect(onCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        collectedJobs: result.jobs,
      }),
    );
    expect(result).toMatchObject({
      incomplete: true,
      accessBlockerReason: "site_protection",
      parkedPageUrl: "https://jobs.example.test/jobs/j3",
      error: modelReason,
      phaseCompletionReason: modelReason,
    });
  });

  test("marks every search turn as search work so the provider picks its effort", async () => {
    const model = scripted([
      { name: "extract_jobs" },
      { name: "finish", args: { reason: "Read the jobs." } },
    ]);
    const tasks: Array<string | undefined> = [];
    await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config(),
      llmClient: {
        chatWithTools: (messages, tools, options) => {
          tasks.push(options?.reasoningTask);
          return model.chatWithTools(messages, tools, options);
        },
      },
      jobExtractor: extractor,
    });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tasks)).toEqual(new Set(["search"]));
  });

  test("allows a transient challenge to clear after waiting", async () => {
    const pages = {
      current: rawPage({
        title: "Just a moment...",
        bodyText: "Checking your browser",
      }),
    };
    const pageHands = hands(pages);
    pageHands.wait = () => {
      pages.current = rawPage();
      return Promise.resolve();
    };
    const result = await runJobSearchAgent({
      hands: pageHands,
      config: config(),
      llmClient: scripted([
        { name: "wait" },
        { name: "extract_jobs" },
        { name: "finish", args: { reason: "Read the jobs." } },
      ]),
      jobExtractor: extractor,
    });
    expect(result.jobs).toHaveLength(2);
    expect(result.incomplete).toBe(false);
    expect(result.accessBlockerReason).toBeUndefined();
  });

  test("refuses read-off items without their own title or link, so the agent can retry", () => {
    const page = "https://jobs.example.test/search?q=engineer";
    const posting = {
      title: "Platform Engineer",
      company: "Northwind",
      canonicalUrl: "https://jobs.example.test/jobs/123",
    };
    expect(describeNonPosting(posting, page, "search_results")).toBeNull();
    expect(
      describeNonPosting(
        { ...posting, title: "124,564" },
        page,
        "search_results",
      ),
    ).toBe("it has no job title");
    expect(
      describeNonPosting(
        { ...posting, title: "Northwind" },
        page,
        "search_results",
      ),
    ).toBe("its title is just the company name");
    expect(
      describeNonPosting(
        { ...posting, canonicalUrl: "https://jobs.example.test/" },
        page,
        "search_results",
      ),
    ).toBe("it has no link of its own");
    expect(
      describeNonPosting(
        { ...posting, canonicalUrl: page },
        page,
        "search_results",
      ),
    ).toBe("it has no link of its own");
    expect(
      describeNonPosting(
        { ...posting, canonicalUrl: "https://jobs.example.test/jobs/123" },
        "https://jobs.example.test/jobs/123",
        "job_detail",
      ),
    ).toBeNull();
  });

  test("turns precision and scale modes into distinct search instructions", () => {
    const precision = createJobSearchPrompts(
      config({
        promptContext: {
          siteLabel: "the example board",
          searchMode: "precision",
        },
      }),
    );
    const scale = createJobSearchPrompts(
      config({
        promptContext: { siteLabel: "the example board", searchMode: "scale" },
      }),
    );

    expect(precision.system).toContain("save only strong fits");
    expect(precision.system).toContain("over filling the list");
    expect(scale.system).toContain("find a broad pool of plausible jobs");
    expect(scale.system).toContain("borderline possibilities");
  });

  test("lets the saved AI search behavior decide how picky the run is and how remote counts", () => {
    const balanced = createJobSearchPrompts(
      config({
        promptContext: {
          siteLabel: "the example board",
          searchMode: "precision",
          searchGuidance: {
            selectivity: "balanced",
            remoteCountsAsAnyLocation: true,
          },
        },
      }),
    );
    const strict = createJobSearchPrompts(
      config({
        promptContext: {
          siteLabel: "the example board",
          // The saved choice wins over the run mode the caller passed.
          searchMode: "scale",
          searchGuidance: {
            selectivity: "best_matches",
            remoteCountsAsAnyLocation: false,
          },
        },
      }),
    );

    expect(balanced.system).toContain(
      "adjacent roles the person could plausibly do well",
    );
    expect(balanced.system).toContain("counts as matching their locations");
    expect(strict.system).toContain("save only strong fits");
    expect(strict.system).not.toContain("find a broad pool of plausible jobs");
    expect(strict.system).toContain(
      "do not count a remote posting as a location match",
    );
  });

  test("uses the person's exact goal, freshness choice, and profile outline", () => {
    const prompts = createJobSearchPrompts(
      config({
        promptContext: {
          siteLabel: "the example board",
          searchMode: "precision",
          searchRequest: {
            intent: "around engineering",
            breadth: "best_only",
            freshness: "recent",
            sourceIds: "all",
          },
        },
      }),
    );

    expect(prompts.system).toContain(
      'The person asked for: "around engineering"',
    );
    expect(prompts.system).toContain(
      "Freshness: prefer postings marked as recent",
    );
    expect(prompts.system).toContain("Builds dependable internal tools");
    expect(prompts.system).toContain(
      "Platform Engineer · at Northwind · 2020 to present",
    );
    expect(prompts.system).toContain(
      "BSc · Computer Science · Example University",
    );
    // Fit is judged afterwards from the full profile; every search turn
    // would otherwise resend the resume and each role's write-up.
    expect(prompts.system).not.toContain("8 years of platform engineering");
    expect(prompts.system).not.toContain("Built reliable developer tooling");
  });

  test("saves what it reads, tells the model what was already saved, and finishes in its own words", async () => {
    const pages = { current: rawPage() };
    const conversation: string[] = [];
    const llm = scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "click", args: { ref: "a0" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      {
        name: "finish",
        args: {
          reason: "The board has two postings that fit and no more pages",
        },
      },
    ]);
    const spyingLlm: LLMClient = {
      chatWithTools: (messages, tools, options) => {
        conversation.length = 0;
        for (const message of messages)
          conversation.push(`${message.role}: ${message.content}`);
        return llm.chatWithTools(messages, tools, options);
      },
    };

    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: spyingLlm,
      jobExtractor: extractor,
    });

    expect(result.jobs.map((job) => job.title)).toEqual([
      "Platform Engineer",
      "Data Engineer",
    ]);
    expect(result.jobs[0]?.discoveryMethod).toBe("browser_agent");
    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
    expect(conversation.join("\n")).toContain("Saved 2 new postings");
    expect(conversation.join("\n")).toContain(
      "2 on this page were already saved",
    );
  });

  test("an uncapped default search does not tell the model to stop at a numeric hint", () => {
    const prompts = createJobSearchPrompts(config({ retainAllFound: true }));
    expect(prompts.system).toContain("save all suitable results you find");
    expect(prompts.system).toContain("honor any limit in the person's request");
    expect(prompts.system).not.toContain("Find up to 10");
  });

  test("a conflicting goal does not promise to override Best matches only filters", () => {
    const request = {
      intent: "Find customer support roles instead",
      freshness: "any" as const,
      sourceIds: "all" as const,
    };
    const strict = createJobSearchPrompts(
      config({
        promptContext: {
          siteLabel: "Example",
          searchMode: "precision",
          searchRequest: request,
        },
      }),
    );
    expect(strict.system).toContain("cannot override them");
    expect(strict.system).toContain(
      "Explain the conflict in your finish reason",
    );
    expect(strict.system).toContain(
      "save no jobs: do not fall back to the saved role",
    );
    expect(strict.system).not.toContain("may narrow or redirect");
    const broad = createJobSearchPrompts(
      config({
        promptContext: {
          siteLabel: "Example",
          searchMode: "scale",
          searchRequest: request,
        },
      }),
    );
    expect(broad.system).toContain("may narrow or redirect");
  });

  test("the model sees the feed, goal and recency choice and selects original records", async () => {
    const catalog = ["Platform Engineer", "Data Engineer"].map((title, id) =>
      JobPostingSchema.parse({
        ...posting(title, "Example", String(id)),
        source: "target_site",
        discoveryMethod: "public_api",
        discoveredAt: "2026-09-20T10:00:00Z",
      }),
    );
    const model = scripted([
      { name: "list_catalog_jobs", args: { sort: "recent" } },
      { name: "save_catalog_jobs", args: { ids: [1] } },
      {
        name: "finish",
        args: { reason: "The data role fits the requested focus." },
      },
    ]);
    const seen: string[] = [];
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({
        sourceCatalog: catalog,
        promptContext: {
          siteLabel: "Example",
          searchRequest: {
            intent: "Find data roles",
            freshness: "recent",
            sourceIds: "all",
          },
        },
      }),
      llmClient: {
        chatWithTools: (messages, tools, options) => {
          seen.push(messages.map((message) => message.content).join("\n"));
          return model.chatWithTools(messages, tools, options);
        },
      },
      jobExtractor: extractor,
    });
    expect(seen[0]).toContain("Find data roles");
    expect(seen[0]).toContain("Freshness: prefer postings marked as recent");
    expect(seen[0]).toContain("public feed supplied 2 new postings");
    expect(result.jobs).toEqual([catalog[1]]);
    expect(result.phaseCompletionReason).toBe(
      "The data role fits the requested focus.",
    );
  });

  test.each(["extract_jobs"])(
    "%s cannot attribute another same-host board's postings to a complete source feed",
    async (tool) => {
      const ownUrl = "https://jobs.example.test/maple/shared-id";
      const otherUrl = "https://jobs.example.test/willow/shared-id";
      const catalogJob = JobPostingSchema.parse({
        ...posting("Platform Engineer", "Maple", "shared-id"),
        canonicalUrl: ownUrl,
        source: "target_site",
        discoveryMethod: "public_api",
        discoveredAt: "2026-09-20T10:00:00Z",
      });
      const otherJob = {
        ...posting("Account Executive", "Willow", "shared-id"),
        canonicalUrl: otherUrl,
      };
      const pages = {
        current: rawPage({ url: "https://jobs.example.test/willow" }),
      };
      const page = {
        url: () => pages.current.url,
        title: () => Promise.resolve("Willow Careers"),
        locator: () => ({
          innerText: () => Promise.resolve(pages.current.bodyText),
        }),
        evaluate: () =>
          Promise.resolve({
            structuredPostings: [
              {
                ...otherJob,
                postedAtText: null,
                employmentType: null,
                workModeHints: [],
              },
            ],
            cardContainers: [],
            elements: [],
            cardSignatures: [],
          }),
      } as unknown as Page;
      const seen: string[] = [];
      const model = scripted([
        { name: tool, args: { pageType: "search_results" } },
        { name: "read_catalog_job", args: { id: 0 } },
        { name: "save_catalog_jobs", args: { ids: [0] } },
        {
          name: "finish",
          args: { reason: "The source's engineering posting fits." },
        },
      ]);
      const checkpoint = vi.fn<NonNullable<AgentConfig["onCheckpoint"]>>();
      const result = await runJobSearchAgent({
        hands: hands(pages),
        page,
        config: config({
          sourceCatalog: [catalogJob],
          sourceCatalogComplete: true,
          onCheckpoint: checkpoint,
        }),
        llmClient: {
          chatWithTools: (messages, tools, options) => {
            seen.push(messages.map((message) => message.content).join("\n"));
            return model.chatWithTools(messages, tools, options);
          },
        },
        jobExtractor: {
          extractJobsFromPage: () => Promise.resolve([otherJob]),
        },
      });
      expect(result.jobs).toEqual([catalogJob]);
      expect(result.warning).toContain(
        "Ignored 1 posting outside this source's complete public feed",
      );
      expect(seen.join("\n")).toContain(
        "They were not saved under this source",
      );
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(checkpoint.mock.calls[0]?.[0].collectedJobs).toEqual([catalogJob]);
    },
  );

  test.each([false, undefined])(
    "an incomplete or unknown feed (%s) permits ordinary browser discoveries",
    async (sourceCatalogComplete) => {
      const catalogJob = JobPostingSchema.parse({
        ...posting("Platform Engineer", "Maple", "feed-job"),
        source: "target_site",
        discoveryMethod: "public_api",
        discoveredAt: "2026-09-20T10:00:00Z",
      });
      const browserJob = posting("Data Engineer", "Maple", "new-job");
      const result = await runJobSearchAgent({
        hands: hands({ current: rawPage() }),
        config: config({ sourceCatalog: [catalogJob], sourceCatalogComplete }),
        llmClient: scripted([
          { name: "extract_jobs", args: { pageType: "search_results" } },
          {
            name: "finish",
            args: { reason: "A newly discovered posting fits." },
          },
        ]),
        jobExtractor: {
          extractJobsFromPage: () => Promise.resolve([browserJob]),
        },
      });
      expect(result.jobs.map((job) => job.canonicalUrl)).toEqual([
        browserJob.canonicalUrl,
      ]);
      expect(result.warning).toBeUndefined();
    },
  );

  test("a single temporary model failure does not end the search", async () => {
    const pages = { current: rawPage() };
    const llm = scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { reason: "Two postings fit; no more pages" } },
    ]);
    let calls = 0;
    const flakyLlm: LLMClient = {
      chatWithTools: (messages, tools, options) => {
        calls += 1;
        if (calls === 2) {
          const error = new Error("Service unavailable");
          error.name = "ModelRequestHttpError";
          Reflect.set(error, "status", 503);
          return Promise.reject(error);
        }
        return llm.chatWithTools(messages, tools, options);
      },
    };

    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: flakyLlm,
      jobExtractor: extractor,
    });

    expect(calls).toBe(3);
    expect(result.jobs).toHaveLength(2);
    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("gives extraction the page's posting links without saving them automatically", async () => {
    const jobUrls = [
      "https://jobs.example.test/jobs/one",
      "https://jobs.example.test/jobs/two",
    ];
    const pages = {
      current: rawPage({
        links: jobUrls.map((href, index) => ({
          index,
          label: "Platform Engineer",
          href,
          target: "",
          visible: true,
          topOffset: 100 + index * 40,
        })),
      }),
    };
    const extractJobsFromPage = vi.fn<JobExtractor["extractJobsFromPage"]>(() =>
      Promise.resolve([]),
    );
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "Read the page." } },
      ]),
      jobExtractor: { extractJobsFromPage },
    });
    const extractionText = extractJobsFromPage.mock.calls[0]?.[0].pageText;
    for (const url of jobUrls) expect(extractionText).toContain(url);
    expect(extractionText).toContain("untrusted page evidence");
    expect(result.jobs).toEqual([]);
  });

  test("does not repair a title from a lower related-job heading", async () => {
    const pages = {
      current: rawPage({
        url: "https://jobs.example.test/jobs/risk",
        bodyText:
          "Data Engineer, Risk. About the role. Related jobs: Data Engineer, Payments.",
        headings: [
          { level: 1, text: "Data Engineer, Risk" },
          { level: 2, text: "Related jobs" },
          { level: 3, text: "Data Engineer, Payments" },
        ],
      }),
    };
    const detailExtractor: JobExtractor = {
      extractJobsFromPage: vi.fn(() =>
        Promise.resolve([
          {
            ...posting("Data Engineer, Risk", "Acme", "risk"),
            canonicalUrl: "https://jobs.example.test/jobs/risk",
          },
        ]),
      ),
    };

    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config({ startingUrls: ["https://jobs.example.test/jobs/risk"] }),
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "job_detail" } },
        { name: "finish", args: { reason: "The detail page was read." } },
      ]),
      jobExtractor: detailExtractor,
    });

    expect(result.jobs[0]?.title).toBe("Data Engineer, Risk");
  });

  test("reads a task-relevant same-site GET endpoint through the live browser session", async () => {
    const pages = { current: rawPage() };
    const get = vi.fn(
      (url: string, options: { headers: Record<string, string> }) => {
        void url;
        void options;
        return Promise.resolve({
          text: () => Promise.resolve('{"jobs":[{"id":"j1"}]}'),
          status: () => 200,
          statusText: () => "OK",
          headers: () => ({ "content-type": "application/json" }),
          ok: () => true,
        });
      },
    );
    const page = {
      url: () => pages.current.url ?? "",
      context: () => ({ request: { get } }),
    } as unknown as Page;

    await runJobSearchAgent({
      hands: hands(pages),
      page,
      config: config(),
      llmClient: scripted([
        {
          name: "read_page_api",
          args: {
            url: "/api/jobs?query=engineer",
            reason:
              "The results page loads its visible job cards from this endpoint.",
          },
        },
        {
          name: "finish",
          args: { reason: "The site API returned the job data needed." },
        },
      ]),
      jobExtractor: extractor,
    });

    const [requestedUrl, requestOptions] = get.mock.calls[0] ?? [];
    expect(requestedUrl).toBe(
      "https://jobs.example.test/api/jobs?query=engineer",
    );
    expect(requestOptions?.headers.accept).toContain("application/json");
  });

  test("reviews a task-relevant API-only origin before reading it directly", async () => {
    const pages = { current: rawPage() };
    const get = vi.fn(() =>
      Promise.resolve({
        text: () => Promise.resolve('{"jobs":[{"id":"j1"}]}'),
        status: () => 200,
        statusText: () => "OK",
        headers: () => ({ "content-type": "application/json" }),
        ok: () => true,
      }),
    );
    const page = {
      url: () => pages.current.url ?? "",
      context: () => ({ request: { get } }),
    } as unknown as Page;
    let agentTurn = 0;
    const reviews: string[] = [];
    const llmClient: LLMClient = {
      chatWithTools(messages, tools) {
        if (tools.some((tool) => tool.function.name === "decide")) {
          reviews.push(messages.map((message) => message.content).join("\n"));
          return Promise.resolve({
            toolCalls: [
              {
                id: "review_direct",
                type: "function" as const,
                function: {
                  name: "decide",
                  arguments: JSON.stringify({
                    allowed: true,
                    verdict: "The endpoint is the employer's job data service.",
                  }),
                },
              },
            ],
          });
        }
        agentTurn += 1;
        return scripted(
          agentTurn === 1
            ? [
                {
                  name: "read_page_api",
                  args: {
                    url: "https://api.employer.test/jobs",
                    reason:
                      "The page names this endpoint as its visible-card data source.",
                  },
                },
              ]
            : [
                {
                  name: "finish",
                  args: { reason: "The reviewed API returned the job data." },
                },
              ],
        ).chatWithTools(messages, tools);
      },
    };

    await runJobSearchAgent({
      hands: hands(pages),
      page,
      config: config(),
      llmClient,
      jobExtractor: extractor,
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain("https://api.employer.test/jobs");
    expect(get).toHaveBeenCalledOnce();
  });

  test("reviews every off-scope API redirect and refuses before following it", async () => {
    const pages = { current: rawPage() };
    const get = vi.fn(() =>
      Promise.resolve({
        text: () => Promise.resolve(""),
        status: () => 302,
        statusText: () => "Found",
        headers: () => ({ location: "https://tracker.invalid/jobs" }),
        ok: () => false,
      }),
    );
    const page = {
      url: () => pages.current.url ?? "",
      context: () => ({ request: { get } }),
    } as unknown as Page;
    let agentTurn = 0;
    const llmClient: LLMClient = {
      chatWithTools(messages, tools) {
        if (tools.some((tool) => tool.function.name === "decide")) {
          return Promise.resolve({
            toolCalls: [
              {
                id: "review_redirect",
                type: "function" as const,
                function: {
                  name: "decide",
                  arguments: JSON.stringify({
                    allowed: false,
                    verdict:
                      "This tracker is unrelated to reading the posting.",
                  }),
                },
              },
            ],
          });
        }
        agentTurn += 1;
        return scripted(
          agentTurn === 1
            ? [
                {
                  name: "read_page_api",
                  args: {
                    url: "/api/jobs",
                    reason:
                      "The results page says visible cards come from this endpoint.",
                  },
                },
              ]
            : [
                {
                  name: "finish",
                  args: { reason: "The unrelated redirect was refused." },
                },
              ],
        ).chatWithTools(messages, tools);
      },
    };

    await runJobSearchAgent({
      hands: hands(pages),
      page,
      config: config(),
      llmClient,
      jobExtractor: extractor,
    });

    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      "https://jobs.example.test/api/jobs",
      expect.objectContaining({ maxRedirects: 0 }),
    );
  });

  test("a sign-in wall the model reports becomes a typed blocker with the page it happened on", async () => {
    const pages = { current: rawPage() };
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: scripted([
        {
          name: "finish",
          args: {
            reason:
              "The results load, but every posting opens a sign-in page before the details",
            needsPerson: true,
            blockedBy: "sign_in",
          },
        },
      ]),
      jobExtractor: extractor,
    });

    expect(result.incomplete).toBe(true);
    expect(result.accessBlockerReason).toBe("auth_required");
    expect(result.parkedPageUrl).toBe(
      "https://jobs.example.test/search?q=engineer",
    );
    expect(result.error).toBe(
      "The results load, but every posting opens a sign-in page before the details.",
    );
  });

  test("a visible password form corrects a generic manual-step handoff to sign-in", async () => {
    const pages = {
      current: rawPage({
        title: "Sign in to see jobs",
        bodyText: "Sign in to view job listings.",
        controls: [
          {
            index: 0,
            tagName: "input",
            inputType: "password",
            role: "textbox",
            id: "password",
            name: "password",
            label: "Password",
            groupLabel: "",
            placeholder: "Password",
            autocomplete: "current-password",
            required: true,
            invalid: false,
            validationMessage: "",
            disabled: false,
            readOnly: false,
            visible: true,
            value: "",
            checked: false,
            multiple: false,
            options: [],
            selectedOptionLabel: "",
          },
        ],
      }),
    };
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: scripted([
        {
          name: "finish",
          args: {
            reason:
              "The source asks the person to sign in before showing jobs.",
            needsPerson: true,
            blockedBy: "manual_step",
          },
        },
      ]),
      jobExtractor: extractor,
    });

    expect(result.accessBlockerReason).toBe("auth_required");
    expect(result.error).toBe(
      "The source asks the person to sign in before showing jobs.",
    );
  });

  test("a stuck finish carries the model's report", async () => {
    const pages = { current: rawPage() };
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: scripted([
        {
          name: "finish",
          args: {
            reason: "Next page keeps returning the same ten postings",
            stuck: true,
          },
        },
      ]),
      jobExtractor: extractor,
    });

    expect(result.incomplete).toBe(true);
    expect(result.error).toContain(
      "because it got stuck: Next page keeps returning the same ten postings.",
    );
  });

  test("a source check returns the model's structured findings", async () => {
    const pages = { current: rawPage() };
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config({
        promptContext: {
          siteLabel: "the example board",
          taskPacket: {
            phase: "search_filter_probe",
            phaseGoal: "Prove which controls change results",
            knownFacts: [],
            avoidStrategyFingerprints: [],
            successCriteria: [],
            stopConditions: [],
          },
        },
      }),
      llmClient: scripted([
        {
          name: "extract_jobs",
          args: { pageType: "search_results", maxJobs: 2 },
        },
        {
          name: "finish",
          args: {
            reason: "The search box at the top narrows results by title",
            summary: "Search box narrows by title.",
            reliableControls: ["Top search box"],
            warnings: ["Location filter is decorative"],
          },
        },
      ]),
      jobExtractor: extractor,
    });

    expect(result.phaseCompletionMode).toBe("structured_finish");
    expect(result.phaseCompletionReason).toContain("search box");
    expect(result.debugFindings?.reliableControls).toEqual(["Top search box"]);
    expect(result.phaseEvidence?.warnings).toEqual([
      "Location filter is decorative",
    ]);
    expect(result.phaseEvidence?.routeSignals).toContain(
      "https://jobs.example.test/search",
    );
  });

  test("a resumed run starts with the jobs it already had and skips them on re-read", async () => {
    const pages = { current: rawPage() };
    const first = await runJobSearchAgent({
      hands: hands(pages),
      config: config(),
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "Done" } },
      ]),
      jobExtractor: extractor,
    });
    const checkpoints: unknown[] = [];
    const resumed = await runJobSearchAgent({
      hands: hands(pages),
      config: config({
        resumeCheckpoint: {
          revision: 3,
          savedAt: "2026-09-14T10:00:00.000Z",
          currentUrl: "https://jobs.example.test/search?q=engineer",
          lastStableUrl: "https://jobs.example.test/search?q=engineer",
          stepCount: 4,
          collectedJobs: first.jobs,
          visitedUrls: [],
          phaseEvidence: {
            visibleControls: [],
            successfulInteractions: [],
            routeSignals: [],
            attemptedControls: [],
            warnings: [],
            visualFindings: [],
          },
        },
        onCheckpoint: (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      }),
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "Done" } },
      ]),
      jobExtractor: extractor,
    });

    expect(resumed.jobs).toHaveLength(2);
    // Nothing new was saved, so no checkpoint was written on the re-read.
    expect(checkpoints).toHaveLength(0);
  });
});

describe("what the person sees while it runs", () => {
  test("reads all 60 unread catalog pages before saving the matching job", async () => {
    const catalog = Array.from({ length: 1_500 }, (_, id) =>
      JobPostingSchema.parse({
        ...posting(
          id === 1_499 ? "Platform Engineer" : "Other Role",
          "Cedar",
          String(id),
        ),
        source: "target_site",
        discoveredAt: "2026-10-01T10:00:00.000Z",
      }),
    );
    const turns = [
      ...Array.from({ length: 60 }, (_, page) => ({
        name: "list_catalog_jobs",
        args: { offset: page * 25 },
      })),
      { name: "save_catalog_jobs", args: { ids: [1_499] } },
      {
        name: "finish",
        args: {
          reason:
            "Found the matching role after reviewing the complete catalog.",
        },
      },
    ];
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({ sourceCatalog: catalog }),
      llmClient: scripted(turns),
      jobExtractor: extractor,
    });
    expect(result.jobs).toEqual([catalog[1_499]]);
    expect(result.steps).toBe(62);
    expect(result.incomplete).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("duplicate-only pagination still stalls despite new URLs", async () => {
    const pages = { current: rawPage() };
    const turns = Array.from({ length: 10 }, (_, page) => [
      {
        name: "navigate",
        args: { url: `https://jobs.example.test/search?page=${page}` },
      },
      { name: "extract_jobs", args: { pageType: "search_results" } },
    ]).flat();
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config({ runControl: { noProgressStepLimit: 3 } }),
      llmClient: scripted(turns),
      jobExtractor: extractor,
    });
    expect(result.jobs).toHaveLength(2);
    expect(result.steps).toBe(8);
    expect(result.error).toBe("Stopped: no new page content or listings in the last 6 steps.");
  });

  test("counts only repeated catalog pages in the stall warning window", async () => {
    const catalog = Array.from({ length: 150 }, (_, id) =>
      JobPostingSchema.parse({
        ...posting("Other Role", "Cedar", String(id)),
        source: "target_site",
        discoveredAt: "2026-10-01T10:00:00.000Z",
      }),
    );
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({
        sourceCatalog: catalog,
        runControl: { noProgressStepLimit: 3 },
      }),
      llmClient: scripted([
        ...Array.from({ length: 6 }, (_, page) => ({
          name: "list_catalog_jobs",
          args: { offset: page * 25 },
        })),
        { name: "list_catalog_jobs", args: { offset: 0 } },
      ]),
      jobExtractor: extractor,
    });
    expect(result.steps).toBe(12);
    expect(result.jobs).toEqual([]);
    expect(result.error).toBe("Stopped: no new page content or listings in the last 6 steps.");
  });

  test("unread catalog details keep progressing, but repeated details stall", async () => {
    const catalog = Array.from({ length: 6 }, (_, id) =>
      JobPostingSchema.parse({
        ...posting("Other Role", "Cedar", String(id)),
        source: "target_site",
        discoveredAt: "2026-10-01T10:00:00.000Z",
      }),
    );
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({
        sourceCatalog: catalog,
        runControl: { noProgressStepLimit: 3 },
      }),
      llmClient: scripted([
        ...catalog.map((_job, id) => ({
          name: "read_catalog_job",
          args: { id },
        })),
        { name: "read_catalog_job", args: { id: 0 } },
      ]),
      jobExtractor: extractor,
    });
    expect(result.steps).toBe(12);
    expect(result.error).toBe("Stopped: no new page content or listings in the last 6 steps.");
  });

  test("identical observations still stall", async () => {
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({ runControl: { noProgressStepLimit: 3 } }),
      llmClient: scripted([{ name: "observe" }]),
      jobExtractor: extractor,
    });
    expect(result.steps).toBe(6);
    expect(result.error).toBe("Stopped: no new page content or listings in the last 6 steps.");
  });

  test("turn notes are rewritten without tool names or handles", async () => {
    const { describeStepForPerson } = await import("./job-search-agent");
    expect(describeStepForPerson("observe → Page: https://x.test")).toBe(
      "Looking at the page.",
    );
    expect(describeStepForPerson('click → Pressed "Next page".')).toBe(
      'Pressing "Next page".',
    );
    expect(describeStepForPerson("type → Typed into c1. The page now:")).toBe(
      "Typing into a field.",
    );
    expect(describeStepForPerson("wait → Waited 2000ms.")).toBe(
      "Waiting for the page to settle.",
    );
    expect(describeStepForPerson("extract_jobs → Saved 12 new postings:")).toBe(
      "Saved 12 new postings.",
    );
    expect(describeStepForPerson("extract_jobs → Saved no new postings.")).toBe(
      "Read the page; nothing new here.",
    );
    expect(
      describeStepForPerson("navigate → Opened https://jobs.example.test/p2."),
    ).toBe("Opening https://jobs.example.test/p2.");
  });
  test("collects thousands of jobs across more than 300 productive turns", async () => {
    const pages = { current: rawPage() };
    const turns: Array<{ name: string; args?: Record<string, unknown> }> = [];
    for (let page = 0; page < 350; page += 1) {
      turns.push(
        {
          name: "navigate",
          args: { url: `https://jobs.example.test/search?page=${page}` },
        },
        { name: "extract_jobs", args: { pageType: "search_results" } },
      );
    }
    turns.push({ name: "finish", args: { reason: "All 350 pages read." } });
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config({ maxSteps: 240, retainAllFound: true }),
      llmClient: scripted(turns),
      jobExtractor: {
        extractJobsFromPage: ({ pageUrl }) => {
          const page = new URL(pageUrl).searchParams.get("page");
          return Promise.resolve(
            Array.from({ length: 10 }, (_, id) =>
              posting("Platform Engineer", "Northwind", `${page}_${id}`),
            ),
          );
        },
      },
    });
    expect(result.jobs).toHaveLength(3_500);
    expect(result.steps).toBe(701);
    expect(result.incomplete).toBe(false);
    expect(result.phaseCompletionReason).toBe("All 350 pages read.");
  });

  test("new jobs after a stall warning let the search continue", async () => {
    const pages = { current: rawPage() };
    const result = await runJobSearchAgent({
      hands: hands(pages),
      config: config({ runControl: { noProgressStepLimit: 3 } }),
      llmClient: scripted([
        { name: "observe" },
        { name: "observe" },
        { name: "observe" },
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "No more pages." } },
      ]),
      jobExtractor: extractor,
    });
    expect(result.jobs).toHaveLength(2);
    expect(result.incomplete).toBe(false);
  });

  test("repeated catalog reads cannot keep discovery alive without saves", async () => {
    const jobs = [
      JobPostingSchema.parse({
        ...posting("Platform Engineer", "Northwind", "catalog_1"),
        source: "target_site",
        discoveryMethod: "public_api",
        discoveredAt: "2026-09-14T10:00:00Z",
      }),
    ];
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({
        sourceCatalog: jobs,
        runControl: { noProgressStepLimit: 3 },
      }),
      llmClient: scripted([{ name: "list_catalog_jobs" }]),
      jobExtractor: extractor,
    });
    // The first read is new content; the next six repeated reads still stall.
    expect(result.steps).toBe(7);
    expect(result.jobs).toEqual([]);
    expect(result.error).toBe("Stopped: no new page content or listings in the last 6 steps.");
  });

  test("stops scrolling without saved jobs and reports the step window", async () => {
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config({ runControl: { noProgressStepLimit: 3 } }),
      llmClient: scripted([{ name: "scroll", args: { direction: "down" } }]),
      jobExtractor: extractor,
    });
    expect(result.steps).toBe(6);
    expect(result.error).toBe("Stopped: no new page content or listings in the last 6 steps.");
  });

  test("the wall-clock safety ceiling still stops a productive search", async () => {
    let elapsed = 0;
    const result = await runJobSearchAgent({
      hands: hands({ current: rawPage() }),
      config: config(),
      now: () => new Date(Date.parse("2026-09-14T10:00:00Z") + elapsed),
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "No more pages." } },
      ]),
      jobExtractor: {
        extractJobsFromPage: async (input) => {
          elapsed = 60 * 60_000;
          return extractor.extractJobsFromPage(input);
        },
      },
    });
    expect(result.jobs).toHaveLength(2);
    expect(result.incomplete).toBe(true);
    expect(result.error).toContain("ran out of time");
  });
});

test("binds extraction to the current redirected page and selection context (R3-069, R3-040)", async () => {
  const pages = { current: rawPage() };
  const liveHands = hands(pages);
  const readText = vi.fn(() => Promise.resolve(pages.current.bodyText));
  liveHands.readText = readText;
  const liveExtractor = vi.fn<JobExtractor["extractJobsFromPage"]>((input) => {
    expect(input.pageUrl).toBe("https://jobs.lever.example.test/real/jobs/one");
    const selection = JSON.parse(input.selectionContext ?? "{}") as {
      sourceInstructions: string[];
      targetRoles: string[];
    };
    expect(selection.sourceInstructions).toEqual([
      "Keep design roles; exclude non-design roles.",
    ]);
    expect(selection.targetRoles).toEqual(["Platform Engineer"]);
    return Promise.resolve([]);
  });
  const model = scripted([
    { name: "read_page" },
    { name: "extract_jobs", args: { pageType: "job_detail" } },
    { name: "finish", args: { reason: "No suitable jobs." } },
  ]);
  let turn = 0;
  await runJobSearchAgent({
    hands: liveHands,
    config: config({
      promptContext: {
        siteLabel: "local Atlas",
        siteInstructions: ["Keep design roles; exclude non-design roles."],
      },
    }),
    jobExtractor: { extractJobsFromPage: liveExtractor },
    llmClient: {
      chatWithTools: (messages, tools, options) => {
        if (++turn === 2)
          pages.current = rawPage({
            url: "https://jobs.lever.example.test/real/jobs/one",
            bodyText: "Real employer job",
          });
        return Promise.resolve(model.chatWithTools(messages, tools, options));
      },
    },
  });
  expect(liveExtractor).toHaveBeenCalledOnce();
});

test("considers supplied exact vacancies and country variants before substituting other jobs (R3-034)", () => {
  const prompts = createJobSearchPrompts(config());
  expect(prompts.system).toContain(
    "extract that vacancy before exploring other employer pages",
  );
  expect(prompts.system).toContain(
    "Check country/location variants separately",
  );
  expect(prompts.system).toContain("specific reason in your finish report");
});

test("keeps the producing page in saved postings and checkpoints after a cross-source visit", async () => {
  const pages = { current: rawPage() };
  const destination = "https://other-source.example.test/jobs/one";
  const result = await runJobSearchAgent({
    hands: hands(pages),
    config: config({
      startingUrls: [
        "https://jobs.example.test/search?q=engineer",
        destination,
      ],
      navigationPolicy: {
        ...config().navigationPolicy,
        allowedHostnames: ["jobs.example.test", "other-source.example.test"],
      },
      onCheckpoint: (checkpoint) => {
        expect(checkpoint.collectedJobs[0]?.producingPageUrl).toBe(destination);
      },
    }),
    llmClient: scripted([
      { name: "navigate", args: { url: destination } },
      { name: "extract_jobs", args: { pageType: "job_detail" } },
      { name: "finish", args: { reason: "Done" } },
    ]),
    jobExtractor: {
      extractJobsFromPage: () =>
        Promise.resolve([
          {
            sourceJobId: "one",
            canonicalUrl: destination,
            title: "Platform Engineer",
            company: "Other employer",
            location: "Manchester",
            description: "Platform engineering",
            salaryText: null,
            summary: null,
            postedAt: null,
            workMode: [],
            applyPath: "unknown",
            easyApplyEligible: false,
            keySkills: [],
          },
        ]),
    },
  });
  expect(result.jobs[0]?.producingPageUrl).toBe(destination);
});

test("carries rejected listings and duplicate/page counts without calling rejected jobs saved", async () => {
  const pages = { current: rawPage() };
  const posting = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "warehouse",
    applyPath: "unknown",
    easyApplyEligible: false,
    salaryText: null,
    canonicalUrl: "https://jobs.example.test/job/warehouse",
    title: "Warehouse lead",
    company: "Example",
    location: "Manchester",
    description: "Warehouse team leadership",
    discoveredAt: "2026-09-14T00:00:00.000Z",
    searchRejection: {
      category: "role",
      reason: "This search asks for engineering.",
    },
  });
  const jobExtractor: JobExtractor = {
    extractJobsFromPage: () => Promise.resolve([posting]),
  };
  const result = await runJobSearchAgent({
    page: {} as Page,
    hands: hands(pages),
    config: config(),
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { summary: "No engineering matches." } },
    ]),
    jobExtractor,
  });
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0]?.searchRejection?.category).toBe("role");
  expect(result.duplicateListings).toBe(1);
  expect(result.pagesCovered).toBeGreaterThan(0);
});

test("counts read catalog jobs left without a model decision as deferred", async () => {
  const pages = { current: rawPage() };
  const jobs = Array.from({ length: 3 }, (_, index) =>
    JobPostingSchema.parse({
      source: "target_site",
      sourceJobId: String(index),
      canonicalUrl: `https://jobs.example.test/${index}`,
      title: "Platform Engineer",
      company: "Example",
      location: "Manchester",
      workMode: [],
      salaryText: null,
      summary: null,
      postedAt: null,
      applyPath: "unknown",
      easyApplyEligible: false,
      description: "Platform engineering",
      discoveredAt: "2026-10-05T10:00:00.000Z",
    }),
  );
  const result = await runJobSearchAgent({
    page: {} as Page,
    hands: hands(pages),
    config: config({ sourceCatalog: jobs }),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
    llmClient: scripted([
      { name: "list_catalog_jobs", args: {} },
      {
        name: "save_catalog_jobs",
        args: {
          ids: [0],
          rejected: [
            { id: 1, category: "role", reason: "Outside these roles." },
          ],
        },
      },
      {
        name: "finish",
        args: { reason: "Stopped before assessing the last job." },
      },
    ]),
  });
  expect(result.jobs).toHaveLength(2);
  expect(result.deferredListingPageUrls).toHaveLength(1);
  expect(result.jobs[1]?.searchRejection?.reason).toBe("Outside these roles.");
});

test("counts another rendered result page even when pagination keeps the same address", async () => {
  const pages = { current: rawPage() };
  const pageHands = hands(pages);
  pageHands.clickAction = () => {
    pages.current = rawPage({
      bodyText: "Another page of jobs at the same address",
    });
    return Promise.resolve({ ok: true, observedValue: "next" });
  };
  pageHands.clickElement = pageHands.clickAction;
  const result = await runJobSearchAgent({
    page: {} as Page,
    hands: pageHands,
    config: config(),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "click", args: { ref: "a0" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { reason: "Both pages inspected" } },
    ]),
  });
  expect(result.pagesCovered).toBe(2);
  expect(result.coveredPageUrls).toEqual([
    pages.current.url,
    pages.current.url,
  ]);
});

test("reuses a freshly verified unchanged complete inventory and plan without model or listing reads", async () => {
  const catalog = [
    JobPostingSchema.parse({
      ...posting("Platform Engineer", "Northwind", "j1"),
      source: "target_site",
      discoveredAt: "2026-10-05T10:00:00Z",
    }),
  ];
  const resultCache = createSearchResultCache();
  const searchConfig = config({
    sourceCatalog: catalog,
    sourceCatalogComplete: true,
  });
  const model = scripted([
    { name: "list_catalog_jobs" },
    { name: "save_catalog_jobs", args: { ids: [0] } },
    { name: "finish", args: { reason: "Reviewed the complete inventory." } },
  ]);
  const first = await runJobSearchAgent({
    config: searchConfig,
    hands: hands({ current: rawPage() }),
    llmClient: model,
    jobExtractor: extractor,
    resultCache,
  });
  expect(first.jobs).toHaveLength(1);
  const pageHands = hands({ current: rawPage() });
  pageHands.observe = vi.fn(pageHands.observe);
  const unusedModel = { chatWithTools: vi.fn() } as unknown as LLMClient;
  const repeatConfig = structuredClone(searchConfig);
  repeatConfig.sourceCatalog![0].discoveredAt = "2026-10-05T11:00:00Z";
  const repeated = await runJobSearchAgent({
    config: repeatConfig,
    hands: pageHands,
    llmClient: unusedModel,
    jobExtractor: extractor,
    resultCache,
  });
  expect(repeated.jobs[0]?.canonicalUrl).toBe(first.jobs[0]?.canonicalUrl);
  expect(repeated.jobs[0]?.discoveredAt).toBe("2026-10-05T11:00:00Z");
  expect(repeated.steps).toBe(0);
  expect(unusedModel.chatWithTools).not.toHaveBeenCalled();
  expect(pageHands.observe).not.toHaveBeenCalled();
  for (const changed of [
    {
      ...repeatConfig,
      sourceCatalog: [
        { ...catalog[0], description: "Changed responsibilities" },
      ],
    },
    {
      ...repeatConfig,
      sourceCatalog: [
        ...catalog,
        { ...catalog[0], canonicalUrl: "https://jobs.example.test/new" },
      ],
    },
    { ...repeatConfig, sourceCatalog: [] },
    {
      ...repeatConfig,
      searchPreferences: {
        ...repeatConfig.searchPreferences,
        targetRoles: ["Designer"],
      },
    },
    {
      ...repeatConfig,
      userProfile: { ...repeatConfig.userProfile, summary: "Changed facts" },
    },
    { ...repeatConfig, sourceCatalogComplete: false },
    {
      ...repeatConfig,
      promptContext: {
        ...repeatConfig.promptContext,
        searchRequest: {
          intent: "",
          sourceIds: "all" as const,
          freshness: "recent" as const,
        },
      },
    },
  ]) {
    expect(resultCache.read(changed)).toBeNull();
    const judge = scripted([
      { name: "finish", args: { reason: "Judged changed inventory." } },
    ]);
    const judgeSpy = vi.spyOn(judge, "chatWithTools");
    await runJobSearchAgent({
      config: changed,
      hands: hands({ current: rawPage() }),
      llmClient: judge,
      jobExtractor: extractor,
      resultCache,
    });
    expect(judgeSpy).toHaveBeenCalled();
  }
  const failedCache = createSearchResultCache();
  failedCache.write(searchConfig, { ...first, incomplete: true });
  expect(failedCache.read(searchConfig)).toBeNull();
  const bounded = createSearchResultCache(1);
  bounded.write(searchConfig, first);
  bounded.write(
    { ...searchConfig, startingUrls: ["https://another.example.test"] },
    first,
  );
  expect(bounded.read(searchConfig)).toBeNull();
});

test("cached search judgments preserve prior listing details and do not share mutable results", () => {
  const job = JobPostingSchema.parse({
    ...posting("Platform Engineer", "Northwind", "j1"),
    source: "target_site",
    discoveredAt: "2026-10-05T10:00:00Z",
  });
  const input = config({ sourceCatalog: [job], sourceCatalogComplete: true });
  const cache = createSearchResultCache();
  cache.write(input, {
    jobs: [{ ...job, description: "The previously read full listing." }],
    steps: 3,
    transcriptMessageCount: 0,
  });
  const first = cache.read(input)!;
  expect(first.jobs[0].description).toBe("The previously read full listing.");
  first.jobs[0].description = "Changed by caller";
  expect(cache.read(input)?.jobs[0].description).toBe(
    "The previously read full listing.",
  );
});

test("complete browser index reuse requires matching plain and linked reads", async () => {
  const source = rawPage({
    actions: [],
    links: [
      {
        index: 0,
        label: "Platform Engineer",
        href: "https://jobs.example.test/jobs/j1",
        visible: true,
        target: "",
        topOffset: 0,
      },
      {
        index: 1,
        label: "Data Engineer",
        href: "https://jobs.example.test/jobs/j2",
        visible: true,
        target: "",
        topOffset: 0,
      },
    ],
  });
  const indexExtractor: JobExtractor = {
    extractJobsFromPage: () =>
      Promise.resolve([
        posting("Platform Engineer", "Northwind", "j1"),
        posting("Data Engineer", "Contoso", "j2"),
      ]),
  };
  const resultCache = createSearchResultCache();
  const pageHands = hands({ current: source });
  let linkedText = source.bodyText;
  pageHands.readLinkedText = () => Promise.resolve(linkedText);
  const input = config();
  const first = await runJobSearchAgent({
    config: input,
    hands: pageHands,
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      {
        name: "finish",
        args: { reason: "All index rows read.", reusableIndex: true },
      },
    ]),
    jobExtractor: indexExtractor,
    resultCache,
  });
  expect(first.jobs).toHaveLength(2);
  const observe = vi.spyOn(pageHands, "observe");
  const model = scripted([
    { name: "finish", args: { reason: "Changed index reviewed." } },
  ]);
  const judge = vi.spyOn(model, "chatWithTools");
  const readListings = vi.spyOn(indexExtractor, "extractJobsFromPage");
  readListings.mockClear();
  const repeated = await runJobSearchAgent({
    config: input,
    hands: pageHands,
    llmClient: model,
    jobExtractor: indexExtractor,
    resultCache,
  });
  expect(repeated.jobs).toEqual(first.jobs);
  expect(observe).toHaveBeenCalledOnce();
  expect(judge).not.toHaveBeenCalled();
  expect(readListings).not.toHaveBeenCalled();
  linkedText += " [Changed semantic item boundary]";
  await runJobSearchAgent({
    config: input,
    hands: pageHands,
    llmClient: model,
    jobExtractor: indexExtractor,
    resultCache,
  });
  expect(judge).toHaveBeenCalledOnce();
  judge.mockClear();
  source.bodyText += " A changed listing or a new job.";
  await runJobSearchAgent({
    config: input,
    hands: pageHands,
    llmClient: model,
    jobExtractor: indexExtractor,
    resultCache,
  });
  expect(judge).toHaveBeenCalled();
});

test.each([false, true])(
  "browser index reuse requires complete model-confirmed coverage (claim=%s)",
  async (claim) => {
    const indexExtractor: JobExtractor = {
      extractJobsFromPage: () =>
        Promise.resolve([
          posting("Platform Engineer", "Northwind", "j1"),
          posting("Data Engineer", "Contoso", "j2"),
        ]),
    };
    const resultCache = createSearchResultCache();
    // Require both the model's completeness judgment and linked coverage.
    const pageHands = hands({
      current: rawPage({
        links: claim
          ? []
          : [
              {
                index: 0,
                label: "Platform Engineer",
                href: "https://jobs.example.test/jobs/j1",
                target: "",
                topOffset: 0,
                visible: true,
              },
              {
                index: 1,
                label: "Data Engineer",
                href: "https://jobs.example.test/jobs/j2",
                target: "",
                topOffset: 0,
                visible: true,
              },
            ],
      }),
    });
    const input = config();
    await runJobSearchAgent({
      config: input,
      hands: pageHands,
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "Done.", reusableIndex: claim } },
      ]),
      jobExtractor: indexExtractor,
      resultCache,
    });
    const model = scripted([
      { name: "finish", args: { reason: "Review again." } },
    ]);
    const judge = vi.spyOn(model, "chatWithTools");
    await runJobSearchAgent({
      config: input,
      hands: pageHands,
      llmClient: model,
      jobExtractor: indexExtractor,
      resultCache,
    });
    expect(judge).toHaveBeenCalled();
  },
);

test("records the page model's rejections in saved checkpoints with their reasons", async () => {
  const rejectedUrl = "https://jobs.example.test/jobs/j2";
  const checkpoint = vi.fn<NonNullable<AgentConfig["onCheckpoint"]>>();
  const result = await runJobSearchAgent({
    hands: hands({ current: rawPage() }),
    config: config({ onCheckpoint: checkpoint }),
    jobExtractor: extractor,
    llmClient: scripted([
      {
        name: "extract_jobs",
        args: {
          pageType: "search_results",
          rejected: [
            {
              url: rejectedUrl,
              category: "role",
              reason: "Outside this plan's requested roles.",
            },
          ],
        },
      },
      { name: "finish", args: { reason: "One match, one rejected." } },
    ]),
  });
  expect(
    result.jobs.find((job) => job.canonicalUrl === rejectedUrl)
      ?.searchRejection,
  ).toEqual({
    category: "role",
    reason: "Outside this plan's requested roles.",
  });
  expect(
    checkpoint.mock.calls
      .at(-1)?.[0]
      .collectedJobs.find((job) => job.canonicalUrl === rejectedUrl)
      ?.searchRejection?.reason,
  ).toBe("Outside this plan's requested roles.");
});

test("a rejection that matches no listing on the page never drops the page's saves", async () => {
  const result = await runJobSearchAgent({
    hands: hands({ current: rawPage() }),
    config: config(),
    jobExtractor: extractor,
    llmClient: scripted([
      {
        name: "extract_jobs",
        args: {
          pageType: "search_results",
          rejected: [
            {
              url: "https://jobs.example.test/jobs/not-on-this-page",
              category: "role",
              reason: "Outside this plan's requested roles.",
            },
          ],
        },
      },
      { name: "finish", args: { reason: "Saved the page." } },
    ]),
  });
  expect(result.jobs.length).toBeGreaterThan(0);
  expect(result.jobs.every((job) => !job.searchRejection)).toBe(true);
});

test("a known posting wins over a later no-own-link rejection", async () => {
  const pages = { current: rawPage() };
  const canonicalUrl = pages.current.url;
  const posting = JobPostingSchema.parse({
    source: "target_site",
    sourceJobId: "known",
    canonicalUrl,
    title: "Platform Engineer",
    company: "Example",
    location: "Manchester",
    description: "Platform engineering",
    salaryText: null,
    applyPath: "unknown",
    easyApplyEligible: false,
    discoveredAt: "2026-10-05T10:00:00.000Z",
  });
  const result = await runJobSearchAgent({
    page: {} as Page,
    hands: hands(pages),
    config: config(),
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "job_detail" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { summary: "Checked the page." } },
    ]),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([posting]) },
  });
  expect(result.jobs).toHaveLength(1);
  expect(result.duplicateListings).toBe(1);
  expect(result.unreadableListings).toEqual([]);
});

test("one results page read repeatedly with changing text is one page covered", async () => {
  const pages = { current: rawPage() };
  let reads = 0;
  const pageHands = hands(pages);
  pageHands.readText = () =>
    Promise.resolve(`${pages.current.bodyText} Updated ${++reads}`);
  const result = await runJobSearchAgent({
    hands: pageHands,
    config: config(),
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { reason: "Read the one page" } },
    ]),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
  });
  expect(result.pagesCovered).toBe(1);
  expect(result.coveredPageUrls).toEqual([pages.current.url]);
});

test("counts results pages, not a page marked as something else", async () => {
  const pages = { current: rawPage() };
  const result = await runJobSearchAgent({
    hands: hands(pages),
    config: config(),
    llmClient: scripted([
      { name: "navigate", args: { url: "https://jobs.example.test/about" } },
      { name: "observe", args: { pageType: "other" } },
      { name: "navigate", args: { url: "https://jobs.example.test/results" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { reason: "Read the one results page" } },
    ]),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
  });
  // The start page it landed on is a results page; the about page is not.
  expect(result.pagesCovered).toBe(2);
  expect(result.coveredPageUrls).toEqual([
    "https://jobs.example.test/results",
    "https://jobs.example.test/search?q=engineer",
  ]);
});

test("counts every results page moved through, but not a posting's own page", async () => {
  const pages = { current: rawPage() };
  const result = await runJobSearchAgent({
    hands: hands(pages),
    config: config(),
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      {
        name: "navigate",
        args: { url: "https://jobs.example.test/search?q=engineer&page=2" },
      },
      {
        name: "navigate",
        args: { url: "https://jobs.example.test/search?q=engineer&page=3" },
      },
      {
        name: "navigate",
        args: { url: "https://jobs.example.test/search?q=engineer&page=3#top" },
      },
      { name: "navigate", args: { url: "https://jobs.example.test/jobs/j1" } },
      { name: "finish", args: { reason: "Read three results pages" } },
    ]),
    jobExtractor: {
      extractJobsFromPage: () =>
        Promise.resolve([
          {
            ...posting("Platform Engineer", "Northwind", "j1"),
            canonicalUrl: "https://jobs.example.test/jobs/j1",
          },
        ]),
    },
  });
  expect(result.pagesCovered).toBe(3);
  expect(result.coveredPageUrls).not.toContain(
    "https://jobs.example.test/jobs/j1",
  );
});

test("counts paginated and keyword result reads even when no extraction is needed", async () => {
  const pages = { current: rawPage() };
  const urls = [
    pages.current.url!,
    "https://jobs.example.test/search?q=engineer&page=2",
    "https://jobs.example.test/search?q=engineer&page=3",
    "https://jobs.example.test/search?q=operations",
    "https://jobs.example.test/search?q=support",
  ];
  const result = await runJobSearchAgent({
    hands: hands(pages),
    config: config(),
    llmClient: scripted([
      ...urls.flatMap((url) => [
        { name: "navigate", args: { url } },
        { name: "observe", args: { pageType: "search_results" } },
        { name: "observe", args: { pageType: "search_results" } },
      ]),
      { name: "navigate", args: { url: urls[0] } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      {
        name: "finish",
        args: { reason: "Read all results, no suitable jobs" },
      },
    ]),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
  });
  expect(result.pagesCovered).toBe(5);
  expect(result.coveredPageUrls).toEqual(urls);
});

test("counts only the pages this search loaded, one per page however its address is written", async () => {
  const pages = { current: rawPage() };
  const result = await runJobSearchAgent({
    hands: hands(pages),
    config: config({
      resumeCheckpoint: {
        revision: 1,
        savedAt: "2026-09-14T10:00:00.000Z",
        currentUrl: "https://jobs.example.test/search?q=engineer",
        lastStableUrl: "https://jobs.example.test/search?q=engineer",
        stepCount: 4,
        collectedJobs: [],
        // Loaded by the stopped search this one resumes.
        visitedUrls: [
          "https://jobs.example.test/search?q=engineer&page=7",
          "https://jobs.example.test/search?q=engineer&page=8",
        ],
        phaseEvidence: {
          visibleControls: [],
          successfulInteractions: [],
          routeSignals: [],
          attemptedControls: [],
          warnings: [],
          visualFindings: [],
        },
      },
    }),
    llmClient: scripted([
      { name: "extract_jobs", args: { pageType: "search_results" } },
      {
        name: "navigate",
        args: {
          url: "https://jobs.example.test/search?location=&q=designer&sort=new",
        },
      },
      {
        name: "navigate",
        args: { url: "https://jobs.example.test/search?q=designer&sort=new" },
      },
      { name: "finish", args: { reason: "Read two results pages" } },
    ]),
    jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
  });
  expect(result.pagesCovered).toBe(2);
});

describe("reading pages for less", () => {
  function longBoard(count: number): RawApplyPage {
    return rawPage({
      bodyText: [
        "Jobs",
        ...Array.from({ length: count }, (_, index) =>
          [
            `Platform Engineer ${index}`,
            `Employer ${index}`,
            "Manchester, United Kingdom",
            "Back end, Cloud, Developer tools",
          ].join("\n"),
        ),
      ].join("\n"),
      links: Array.from({ length: count }, (_, index) => ({
        index,
        label: `Platform Engineer ${index}`,
        href: `https://jobs.example.test/jobs/${index}`,
        target: "",
        visible: true,
        topOffset: index * 40,
      })),
    });
  }

  /** A page reader that returns the postings whose links it was handed, a dozen at most. */
  function linkReader() {
    return vi.fn<JobExtractor["extractJobsFromPage"]>((input) => {
      const ids = [
        ...input.pageText.matchAll(/→ https:\/\/jobs\.example\.test\/jobs\/(\d+)/gu),
      ].map((match) => match[1] ?? "");
      return Promise.resolve(
        ids
          .slice(0, Math.min(12, input.maxJobs))
          .map((id) => posting(`Platform Engineer ${id}`, `Employer ${id}`, id)),
      );
    });
  }

  test("a long results page is read in parts, so listings past the first dozen are read", async () => {
    const reader = linkReader();
    const result = await runJobSearchAgent({
      hands: hands({ current: longBoard(45) }),
      config: config({ retainAllFound: true }),
      llmClient: scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "Read the board." } },
      ]),
      jobExtractor: { extractJobsFromPage: reader },
    });
    expect(result.jobs).toHaveLength(45);
    expect(reader.mock.calls.length).toBeGreaterThan(3);
    expect(reader.mock.calls.length).toBeLessThan(15);
    for (const [call] of reader.mock.calls) {
      expect(call.pageText.length).toBeLessThan(8_000);
      expect(call.maxJobs).toBe(12);
    }
  });

  test("a timed-out part keeps successful reads and retries only the missing part before finishing", async () => {
    vi.useFakeTimers();
    try {
      const reader = linkReader();
      let slowSignal: AbortSignal | undefined;
      let slowText = "";
      let attempts = 0;
      const wrapped = vi.fn<JobExtractor["extractJobsFromPage"]>((input) => {
        if (!slowText && input.pageText.includes("→ https://jobs.example.test/jobs/0\n")) slowText = input.pageText;
        if (input.pageText === slowText) {
          attempts += 1;
          if (attempts === 1) {
            slowSignal = input.signal;
            return new Promise(() => undefined);
          }
        }
        return reader(input);
      });
      const answers: string[] = [];
      const model = scripted([
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "extract_jobs", args: { pageType: "search_results" } },
        { name: "finish", args: { reason: "All parts read." } },
      ]);
      const running = runJobSearchAgent({
        hands: hands({ current: longBoard(45) }), config: config({ retainAllFound: true }),
        jobExtractor: { extractJobsFromPage: wrapped },
        llmClient: { chatWithTools: (messages, tools, options) => {
          const last = messages.at(-1);
          if (last?.role === "tool") answers.push(last.content);
          return model.chatWithTools(messages, tools, options);
        } },
      });
      await vi.advanceTimersByTimeAsync(45_001);
      const result = await running;
      expect(slowSignal?.aborted).toBe(true);
      expect(result.jobs).toHaveLength(45);
      expect(attempts).toBe(2);
      expect(answers.some((answer) => answer.includes("could not be read this time"))).toBe(true);
      const counts = new Map<string, number>();
      for (const [call] of wrapped.mock.calls) counts.set(call.pageText, (counts.get(call.pageText) ?? 0) + 1);
      for (const [text, count] of counts) expect(count).toBe(text === slowText ? 2 : 1);
      expect(result.incomplete).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  test("reading an unchanged page again costs no page read and says so", async () => {
    const reader = linkReader();
    const answers: string[] = [];
    let turn = 0;
    const turns = [
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "extract_jobs", args: { pageType: "search_results" } },
      { name: "finish", args: { reason: "Done." } },
    ];
    await runJobSearchAgent({
      hands: hands({ current: longBoard(20) }),
      config: config(),
      llmClient: {
        chatWithTools: (messages) => {
          const last = messages.at(-1);
          if (last?.role === "tool") answers.push(last.content);
          const next = turns[Math.min(turn, turns.length - 1)];
          turn += 1;
          return Promise.resolve({
            toolCalls: [
              {
                id: `call_${turn}`,
                type: "function" as const,
                function: { name: next.name, arguments: JSON.stringify(next.args) },
              },
            ],
          });
        },
      },
      jobExtractor: { extractJobsFromPage: reader },
    });
    const firstReads = reader.mock.calls.length;
    expect(firstReads).toBeGreaterThan(0);
    expect(answers[1]).toContain("20 on this page were already saved");
    expect(answers[1]).toContain("have not changed");
    // No extra reads were made for the second, identical page.
    expect(reader.mock.calls.length).toBe(firstReads);
  });

  test("a repeated or malformed rejection is set aside, not a refused page read", async () => {
    const reader = linkReader();
    const result = await runJobSearchAgent({
      hands: hands({ current: longBoard(3) }),
      config: config(),
      llmClient: scripted([
        {
          name: "extract_jobs",
          args: {
            pageType: "search_results",
            rejected: [
              { url: "https://jobs.example.test/jobs/0", category: "place", reason: "On-site elsewhere." },
              { url: "https://jobs.example.test/jobs/0", category: "place", reason: "On-site elsewhere." },
              { url: "https://jobs.example.test/jobs/1", category: "nonsense", reason: "?" },
            ],
          },
        },
        { name: "finish", args: { reason: "Done." } },
      ]),
      jobExtractor: { extractJobsFromPage: reader },
    });
    expect(reader).toHaveBeenCalled();
    expect(result.jobs).toHaveLength(3);
    expect(result.jobs.find((job) => job.sourceJobId === "0")?.searchRejection?.category).toBe("place");
    expect(result.jobs.find((job) => job.sourceJobId === "1")?.searchRejection).toBeFalsy();
  });

  test("the page reader gets the goals and its rejections are kept unless the model decided", async () => {
    const reader = vi.fn<JobExtractor["extractJobsFromPage"]>((input) => {
      expect(JSON.parse(input.selectionContext ?? "{}")).toMatchObject({
        targetRoles: ["Platform Engineer"],
      });
      return Promise.resolve([
        {
          ...posting("Platform Engineer 0", "Employer 0", "0"),
          searchRejection: { category: "place" as const, reason: "US only." },
        },
        {
          ...posting("Platform Engineer 1", "Employer 1", "1"),
          searchRejection: { category: "role" as const, reason: "Sales role." },
        },
        posting("Platform Engineer 2", "Employer 2", "2"),
      ]);
    });
    const result = await runJobSearchAgent({
      hands: hands({ current: longBoard(3) }),
      config: config(),
      llmClient: scripted([
        {
          name: "extract_jobs",
          args: {
            pageType: "search_results",
            rejected: [
              { url: "https://jobs.example.test/jobs/1", category: "place", reason: "Office in Leeds." },
            ],
          },
        },
        { name: "finish", args: { reason: "Done." } },
      ]),
      jobExtractor: { extractJobsFromPage: reader },
    });
    const byId = new Map(result.jobs.map((job) => [job.sourceJobId, job]));
    expect(byId.get("0")?.searchRejection).toEqual({ category: "place", reason: "US only." });
    expect(byId.get("1")?.searchRejection).toEqual({ category: "place", reason: "Office in Leeds." });
    expect(byId.get("2")?.searchRejection).toBeFalsy();
  });

  test("a page that has not drawn yet is looked at again before the model sees it", async () => {
    const pages = { current: rawPage({ bodyText: "", actions: [] }) };
    const liveHands = hands(pages);
    let waits = 0;
    liveHands.wait = () => {
      waits += 1;
      if (waits === 2) pages.current = longBoard(2);
      return Promise.resolve();
    };
    let opening = "";
    await runJobSearchAgent({
      hands: liveHands,
      config: config(),
      llmClient: {
        chatWithTools: (messages) => {
          opening ||= messages.map((message) => message.content).join("\n");
          return Promise.resolve({
            toolCalls: [
              {
                id: "call_finish",
                type: "function" as const,
                function: { name: "finish", arguments: JSON.stringify({ reason: "Done." }) },
              },
            ],
          });
        },
      },
      jobExtractor: extractor,
    });
    expect(waits).toBe(2);
    expect(opening).toContain("Platform Engineer 1 → https://jobs.example.test/jobs/1");
    expect(opening).toContain("The page you landed on is shown below; work from it.");
    expect(opening).not.toContain("Begin by looking at the page.");
  });

  test("a scroll that changes nothing is answered without the page again", async () => {
    const answers: string[] = [];
    let turn = 0;
    await runJobSearchAgent({
      hands: hands({ current: longBoard(5) }),
      config: config(),
      llmClient: {
        chatWithTools: (messages) => {
          const last = messages.at(-1);
          if (last?.role === "tool") answers.push(last.content);
          turn += 1;
          const name = turn <= 2 ? "scroll" : "finish";
          return Promise.resolve({
            toolCalls: [
              {
                id: `call_${turn}`,
                type: "function" as const,
                function: {
                  name,
                  arguments: JSON.stringify(name === "scroll" ? { direction: "down" } : { reason: "Done." }),
                },
              },
            ],
          });
        },
      },
      jobExtractor: extractor,
    });
    expect(answers[0]).toContain("Scrolled down.");
    expect(answers[0]).toContain("same address, links and text");
    expect(answers[0]).not.toContain("Links:");
  });
});
