import { ok as assert } from "node:assert/strict";
import { describe, expect, test, vi } from "vitest";
import {
  createJobFinderAiClientFromEnvironment,
  createOpenAiCompatibleJobFinderAiClient,
} from "./index";
import {
  inferCompanyFromCanonicalUrl,
  normalizeCompositeTitle,
  normalizeTitleCompanyPair,
} from "./deterministic/job-extraction";
import { createEnvironment, mockJsonFetch } from "./test-fixtures";

type CapturedRequestBody = {
  messages?: Array<{ content: string }>;
};

function isCapturedRequestBody(value: unknown): value is CapturedRequestBody {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeBody = value as { messages?: unknown };
  if (maybeBody.messages == null) {
    return true;
  }

  return (
    Array.isArray(maybeBody.messages) &&
    maybeBody.messages.every((message) => {
      if (!message || typeof message !== "object") {
        return false;
      }

      return typeof (message as { content?: unknown }).content === "string";
    })
  );
}

function assertCapturedRequestBody(
  value: unknown,
): asserts value is CapturedRequestBody {
  assert(isCapturedRequestBody(value), "capturedBody missing");
}

describe("normalizeCompositeTitle", () => {
  test("preserves role words when a separate location disproves the inferred suffix", () => {
    expect(
      normalizeCompositeTitle("Ingenieur für Datenplattformen", "Berlin"),
    ).toMatchObject({
      title: "Ingenieur für Datenplattformen",
      location: null,
    });
    expect(
      normalizeCompositeTitle("Senior Engineer Infrastructure", "London"),
    ).toMatchObject({
      title: "Senior Engineer Infrastructure",
      location: null,
    });
    expect(
      normalizeCompositeTitle("Backend Engineer New York", "New York, USA"),
    ).toMatchObject({
      title: "Backend Engineer",
      location: "New York",
    });
  });
  test("strips posted-at suffixes across supported languages", () => {
    expect(
      normalizeCompositeTitle(
        "Senior Product Designer Remote Posted 3 days ago",
      ),
    ).toMatchObject({
      title: "Senior Product Designer",
      location: "Remote",
      postedAtText: "Posted 3 days ago",
    });
    expect(
      normalizeCompositeTitle("Backend Engineer Prishtine 11 ditë"),
    ).toMatchObject({
      title: "Backend Engineer",
      location: "Prishtine",
      postedAtText: "11 ditë",
    });
    expect(
      normalizeCompositeTitle("Backend Engineer Prishtine 2 javë"),
    ).toMatchObject({
      title: "Backend Engineer",
      location: "Prishtine",
      postedAtText: "2 javë",
    });
    expect(
      normalizeCompositeTitle("Backend Engineer Prishtine 5 orë"),
    ).toMatchObject({
      title: "Backend Engineer",
      location: "Prishtine",
      postedAtText: "5 orë",
    });
  });

  test("does not strip bare Albanian week words without a numeric prefix", () => {
    expect(normalizeCompositeTitle("Marketing Specialist jave")).toMatchObject({
      title: "Marketing Specialist jave",
      location: null,
      postedAtText: null,
    });
  });

  test("does not treat a trailing role token with punctuation as a location", () => {
    expect(normalizeCompositeTitle("Senior Software Engineer.")).toMatchObject({
      title: "Senior Software Engineer.",
      location: null,
      postedAtText: null,
    });
  });

  test("extracts location hints like remote or hybrid", () => {
    expect(normalizeCompositeTitle("Staff Data Engineer Remote")).toMatchObject(
      {
        title: "Staff Data Engineer",
        location: "Remote",
        postedAtText: null,
      },
    );
    expect(normalizeCompositeTitle("Product Designer Hybrid")).toMatchObject({
      title: "Product Designer",
      location: "Hybrid",
      postedAtText: null,
    });
  });

  test("prefers multi-token trailing locations over single-token suffixes", () => {
    expect(normalizeCompositeTitle("Backend Engineer New York")).toMatchObject({
      title: "Backend Engineer",
      location: "New York",
    });
    expect(
      normalizeCompositeTitle("Product Designer San Francisco"),
    ).toMatchObject({
      title: "Product Designer",
      location: "San Francisco",
    });
    expect(
      normalizeCompositeTitle("Support Manager North Carolina"),
    ).toMatchObject({
      title: "Support Manager",
      location: "North Carolina",
    });
    expect(normalizeCompositeTitle("Data Analyst United States")).toMatchObject(
      {
        title: "Data Analyst",
        location: "United States",
      },
    );
    expect(
      normalizeCompositeTitle("Solutions Engineer Hong Kong"),
    ).toMatchObject({
      title: "Solutions Engineer",
      location: "Hong Kong",
    });
  });

  test("does not treat trailing role phrases as locations", () => {
    expect(normalizeCompositeTitle("Manager Field Operations")).toMatchObject({
      title: "Manager Field Operations",
      location: null,
    });
  });
});

describe("model transport recovery", () => {
  test("retries a transient provider overload before returning extracted jobs", async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = (() => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                code: "server_is_overloaded",
                message: "The model server is temporarily overloaded.",
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    jobs: [
                      {
                        title: "Backend Engineer",
                        company: "Signal Systems",
                        location: "Remote",
                        canonicalUrl:
                          "https://jobs.example.com/backend-engineer",
                        sourceJobId: "job_retry",
                        description: "Build reliable backend systems.",
                        applyPath: "unknown",
                        easyApplyEligible: false,
                        workMode: ["remote"],
                        keySkills: ["TypeScript"],
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }) as typeof fetch;

    try {
      const client = createOpenAiCompatibleJobFinderAiClient({
        apiKey: "test-key",
        baseUrl: "https://example.com/v1",
        model: "test-model",
      });
      const jobs = await client.extractJobsFromPage({
        pageText: "Backend Engineer at Signal Systems. Remote.",
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 5,
      });

      expect(requestCount).toBe(2);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.sourceJobId).toBe("job_retry");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("normalizeTitleCompanyPair", () => {
  test("repairs reversed title and company text around at separators", () => {
    expect(
      normalizeTitleCompanyPair({
        title: "Crossing Hurdles EMEA Remote at Software Engineer Fullstack",
        company: "Crossing Hurdles EMEA Remote",
      }),
    ).toMatchObject({
      title: "Software Engineer Fullstack",
      company: "Crossing Hurdles EMEA Remote",
    });
  });

  test("derives missing company from normal title at company text", () => {
    expect(
      normalizeTitleCompanyPair({
        title: "Backend Engineer at Signal Systems",
        company: null,
      }),
    ).toMatchObject({
      title: "Backend Engineer",
      company: "Signal Systems",
    });
  });
});

describe("inferCompanyFromCanonicalUrl", () => {
  test("returns the first non-generic path segment as the company", () => {
    expect(inferCompanyFromCanonicalUrl("https://example.com/acme/dev")).toBe(
      "Acme",
    );
    expect(inferCompanyFromCanonicalUrl("https://example.com/acme/jobs")).toBe(
      "Acme",
    );
    expect(
      inferCompanyFromCanonicalUrl(
        "https://example.com/jobs/acme/frontend-engineer",
      ),
    ).toBe("Acme");
  });

  test("treats pune as a generic job path segment", () => {
    expect(
      inferCompanyFromCanonicalUrl(
        "https://example.com/pune/frontend-engineer",
      ),
    ).toBeNull();
  });
});

describe("job extraction with openai-compatible client", () => {
  test("preserves extracted apply metadata when the model returns it", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              jobs: [
                {
                  title: "Frontend Engineer",
                  company: "Acme",
                  location: "Remote",
                  canonicalUrl: "https://jobs.example.com/frontend-engineer",
                  sourceJobId: "job_123",
                  description: "Build product experiences.",
                  summary: "Build product experiences.",
                  applyPath: "easy_apply",
                  easyApplyEligible: true,
                  workMode: ["remote"],
                  keySkills: ["React", "TypeScript"],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const jobs = await client.extractJobsFromPage({
        pageText: "Frontend Engineer role at Acme",
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 5,
      });

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        applyPath: "easy_apply",
        easyApplyEligible: true,
        summary: "Build product experiences.",
        postedAt: null,
        postedAtText: null,
        responsibilities: [],
        minimumQualifications: [],
        preferredQualifications: [],
      });
    } finally {
      restoreFetch();
    }
  });

  test("normalizes scalar work mode and key skills before validating extracted jobs", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              jobs: [
                {
                  title: "Frontend Engineer",
                  company: "Acme",
                  location: "Remote",
                  canonicalUrl: "https://jobs.example.com/frontend-engineer",
                  sourceJobId: "job_456",
                  description: "Build product experiences.",
                  summary: "Build product experiences.",
                  applyPath: "external_redirect",
                  easyApplyEligible: false,
                  workMode: "remote",
                  keySkills: "React",
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const jobs = await client.extractJobsFromPage({
        pageText: "Frontend Engineer role at Acme",
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 5,
      });

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        workMode: ["remote"],
        keySkills: ["React"],
        summary: "Build product experiences.",
      });
    } finally {
      restoreFetch();
    }
  });

  test("preserves richer extracted job fields and avoids synthetic posted dates", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              jobs: [
                {
                  title: "Senior Frontend Engineer",
                  company: "Acme",
                  location: "Remote",
                  canonicalUrl: "https://jobs.example.com/frontend-engineer",
                  sourceJobId: "job_rich",
                  description:
                    "Build product experiences for the core platform.",
                  summary: "Lead platform UI work.",
                  postedAtText: "Posted 3 days ago",
                  responsibilities: [
                    "Own the design-system frontend architecture",
                  ],
                  minimumQualifications: ["5+ years of React experience"],
                  preferredQualifications: ["Electron experience"],
                  seniority: "Senior",
                  employmentType: "Full-time",
                  department: "Engineering",
                  team: "Platform UI",
                  employerWebsiteUrl: "https://acme.example.com/careers",
                  benefits: ["Remote-first culture"],
                  applyPath: "easy_apply",
                  easyApplyEligible: true,
                  workMode: ["remote"],
                  keySkills: ["React", "Electron"],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const jobs = await client.extractJobsFromPage({
        pageText: "Senior Frontend Engineer role at Acme",
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 5,
      });

      expect(jobs[0]).toMatchObject({
        title: "Senior Frontend Engineer",
        postedAt: null,
        postedAtText: "Posted 3 days ago",
        responsibilities: ["Own the design-system frontend architecture"],
        minimumQualifications: ["5+ years of React experience"],
        preferredQualifications: ["Electron experience"],
        seniority: "Senior",
        employmentType: "Full-time",
        department: "Engineering",
        team: "Platform UI",
        employerWebsiteUrl: "https://acme.example.com/careers",
        employerDomain: "acme.example.com",
        benefits: ["Remote-first culture"],
      });
    } finally {
      restoreFetch();
    }
  });

  test("limits job-detail extraction results to one job", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              jobs: [
                {
                  title: "Frontend Engineer",
                  company: "Acme",
                  location: "Remote",
                  canonicalUrl: "https://jobs.example.com/frontend-engineer",
                  sourceJobId: "job_111",
                  description: "Build product experiences.",
                  applyPath: "easy_apply",
                  easyApplyEligible: true,
                  workMode: ["remote"],
                  keySkills: ["React"],
                },
                {
                  title: "Second Listing",
                  company: "Acme",
                  location: "Remote",
                  canonicalUrl: "https://jobs.example.com/frontend-engineer-2",
                  sourceJobId: "job_222",
                  description: "Should be ignored on detail pages.",
                  applyPath: "external_redirect",
                  easyApplyEligible: false,
                  workMode: ["remote"],
                  keySkills: ["TypeScript"],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const jobs = await client.extractJobsFromPage({
        pageText: "Frontend Engineer role at Acme",
        pageUrl: "https://jobs.example.com/frontend-engineer",
        pageType: "job_detail",
        maxJobs: 5,
      });

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.sourceJobId).toBe("job_111");
    } finally {
      restoreFetch();
    }
  });

  test("reports a failed read when the extracted jobs payload omits the top-level jobs array", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({ invalid: true }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      // A failed read is reported, never passed off as a page with no jobs.
      await expect(
        client.extractJobsFromPage({
          pageText: "Frontend Engineer role at Acme",
          pageUrl: "https://jobs.example.com/search",
          pageType: "search_results",
          maxJobs: 5,
        }),
      ).rejects.toThrow("Expected a top-level jobs array");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[AI Provider] extractJobsFromPage failed."),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Expected a top-level jobs array"),
      );
    } finally {
      restoreFetch();
      errorSpy.mockRestore();
    }
  });

  test("uses summary fallback for description on search-results pages when description is empty", async () => {
    const restoreFetch = mockJsonFetch({
      choices: [
        {
          message: {
            content: JSON.stringify({
              jobs: [
                {
                  title: "Frontend Engineer",
                  company: "Acme",
                  location: "Remote",
                  canonicalUrl: "https://jobs.example.com/frontend-engineer",
                  sourceJobId: "job_summary_fallback",
                  description: "",
                  summary:
                    "Build product experiences from the search results snippet.",
                  applyPath: "external_redirect",
                  easyApplyEligible: false,
                  workMode: ["remote"],
                  keySkills: ["React"],
                },
              ],
            }),
          },
        },
      ],
    });

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      const jobs = await client.extractJobsFromPage({
        pageText:
          "Frontend Engineer role at Acme with a visible summary snippet",
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 5,
      });

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.description).toBe(
        "Build product experiences from the search results snippet.",
      );
      expect(jobs[0]?.summary).toBe(
        "Build product experiences from the search results snippet.",
      );
    } finally {
      restoreFetch();
    }
  });

  test("uses lighter request limits for search-results extraction to reduce first-pass stalls", async () => {
    const originalFetch = globalThis.fetch;
    let capturedBody: unknown = null;

    globalThis.fetch = ((_, init) => {
      const requestBody = typeof init?.body === "string" ? init.body : "{}";
      capturedBody = JSON.parse(requestBody) as unknown;

      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({ jobs: [] }),
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          },
        ),
      );
    }) as typeof fetch;

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());

      await client.extractJobsFromPage({
        pageText: "x".repeat(15000),
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 20,
      });

      expect(capturedBody).not.toBeNull();
      assertCapturedRequestBody(capturedBody);
      const messages = capturedBody.messages ?? [];
      expect(messages[0]?.content).toContain("Return at most 12 jobs.");
      expect(messages[0]?.content).toContain(
        "card's own role text, including any requirements or restrictions",
      );
      const parsedUserPayload = JSON.parse(
        messages[1]?.content ?? "{}",
      ) as unknown;
      const pageText =
        parsedUserPayload && typeof parsedUserPayload === "object"
          ? (parsedUserPayload as { pageText?: unknown }).pageText
          : undefined;
      expect(
        typeof pageText === "string" ? pageText.length : 0,
      ).toBeLessThanOrEqual(8000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports search-results extraction timeouts clearly", async () => {
    vi.useFakeTimers();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const originalFetch = globalThis.fetch;

    globalThis.fetch = ((_, init) =>
      new Promise((_, reject) => {
        const signal = init?.signal as AbortSignal | undefined;

        if (signal?.aborted) {
          reject(new DOMException("This operation was aborted", "AbortError"));
          return;
        }

        signal?.addEventListener(
          "abort",
          () => {
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            );
          },
          { once: true },
        );
      })) as typeof fetch;

    try {
      const client =
        createJobFinderAiClientFromEnvironment(createEnvironment());
      const extractionPromise = client.extractJobsFromPage({
        pageText: "Frontend Engineer role at Acme",
        pageUrl: "https://jobs.example.com/search",
        pageType: "search_results",
        maxJobs: 5,
      });

      const rejected = expect(extractionPromise).rejects.toThrow(
        "Model request timed out",
      );
      // 240s is the total budget for search-results extraction; the idle
      // clock retries once inside it before the total deadline ends the run.
      await vi.advanceTimersByTimeAsync(240_001);

      await rejected;
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[AI Provider] extractJobsFromPage failed."),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Model request timed out"),
      );
    } finally {
      globalThis.fetch = originalFetch;
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

test("returns model rejection categories and reasons so inspected jobs are accounted for", async () => {
  const restore = mockJsonFetch({
    choices: [
      {
        message: {
          content: JSON.stringify({
            jobs: [
              {
                title: "Warehouse Lead",
                company: "Example",
                location: "Leeds",
                canonicalUrl: "https://jobs.example.test/warehouse",
                description: "Lead a warehouse team.",
                searchRejection: {
                  category: "role",
                  reason: "This plan asks for product design roles.",
                },
              },
            ],
          }),
        },
      },
    ],
  });
  try {
    const client = createJobFinderAiClientFromEnvironment(createEnvironment());
    const jobs = await client.extractJobsFromPage({
      pageText: "Warehouse Lead",
      pageUrl: "https://jobs.example.test",
      pageType: "search_results",
      maxJobs: 20,
      selectionContext: "Product design only",
    });
    expect(jobs[0]?.searchRejection).toEqual({
      category: "role",
      reason: "This plan asks for product design roles.",
    });
  } finally {
    restore();
  }
});
