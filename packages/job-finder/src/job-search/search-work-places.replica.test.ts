import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createApplyPageHands, runJobSearchAgent } from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime";
import { CandidateProfileSchema } from "@nestor/contracts";
import { afterAll, beforeAll, expect, test } from "vitest";

/**
 * A browser collection on a local replica board, with a scripted model: a
 * person whose saved place is Europe but who may work in the United States
 * and remotely from home is told so, and a US-located card is collected for
 * fit to judge.
 */
let server: ChildProcess;
let base: string;
beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "../../../../apps/desktop/test-fixtures/job-sites/serve.mjs",
      ),
    ],
    {
      env: {
        ...process.env,
        PORT: "0",
        NESTOR_FIXTURE_SUBMISSIONS_LOG: join(
          mkdtempSync(join(tmpdir(), "nestor-search-work-places-")),
          "posts.log",
        ),
      },
    },
  );
  base = await new Promise<string>((resolve, reject) => {
    server.stderr!.on("data", (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
      if (url) resolve(url);
    });
    server.once("exit", () => reject(Error("Replica server exited")));
  });
}, 60_000);
afterAll(() => {
  server?.kill();
});

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();
const headlessShell = existsSync(executablePath) ? executablePath : undefined;

test("browser collection keeps a US card for a person who may work there, and is told where they can work", async () => {
  const browser = await chromium.launch({
    headless: true,
    ...(headlessShell ? { executablePath: headlessShell } : {}),
  });
  try {
    const page = await browser.newPage();
    const board = `${base}/atlas/`;
    await page.goto(board);
    const systems: string[] = [];
    const turns = [
      { name: "extract_jobs", args: { pageType: "search_results" } },
      {
        name: "finish",
        args: {
          reason: "Read page 1 of the board.",
          coverageComplete: false,
          remainingWork: ["Pages 2 to 15"],
        },
      },
    ];
    let turn = 0;
    // Only the page tools, not the raw page: a board the agent cannot page
    // mechanically, such as one that needs its location filter set, is
    // walked by the model.
    const result = await runJobSearchAgent({
      hands: createApplyPageHands(createPlaywrightApplyPageMechanics(page)),
      config: {
        source: "target_site",
        inventoryOnly: true,
        retainAllFound: true,
        maxSteps: 20,
        targetJobCount: 50,
        userProfile: CandidateProfileSchema.parse({
          id: "synthetic",
          firstName: "Robin",
          lastName: "Ashford",
          fullName: "Robin Ashford",
          headline: "Software engineer",
          summary: null,
          currentLocation: "Lisbon, Portugal",
          currentCity: "Lisbon",
          currentCountry: "Portugal",
          yearsExperience: 6,
          workEligibility: {
            authorizedWorkCountries: ["Portugal", "United States"],
            requiresVisaSponsorship: false,
            willingToRelocate: true,
            preferredRelocationRegions: ["Spain"],
            remoteEligible: true,
          },
          baseResume: {
            id: "resume",
            fileName: "synthetic.txt",
            uploadedAt: "2026-11-27T08:00:00.000Z",
          },
        }),
        searchPreferences: {
          targetRoles: ["Software Engineer"],
          locations: ["Europe"],
          workModes: ["remote", "hybrid"],
        },
        startingUrls: [board],
        navigationPolicy: {
          allowedHostnames: ["127.0.0.1"],
          allowSubdomains: false,
        },
        promptContext: {
          siteLabel: "Atlas Jobs",
          searchRequest: {
            intent: "",
            freshness: "any",
            sourceIds: "all",
            depth: "thorough",
          },
        },
      },
      llmClient: {
        chatWithTools: (messages) => {
          if (turn === 0)
            systems.push(
              String(
                messages.find((message) => message.role === "system")?.content,
              ),
            );
          const action = turns[turn++]!;
          return Promise.resolve({
            toolCalls: [
              {
                id: `turn-${turn}`,
                type: "function" as const,
                function: {
                  name: action.name,
                  arguments: JSON.stringify(action.args),
                },
              },
            ],
          });
        },
      },
      jobExtractor: {
        // Reads each card's own title, address and location from the page.
        extractJobsFromPage: async () => {
          const cards = await page.$$eval("article.job", (articles) =>
            articles.map((article) => ({
              href: article.querySelector("h2 a")!.getAttribute("href")!,
              title: article.querySelector("h2 a")!.textContent.trim(),
              location: article
                .querySelector(".job-location")!
                .textContent.trim(),
            })),
          );
          return cards.map((card) => {
            const url = new URL(card.href, board).href;
            return {
              sourceJobId: url,
              canonicalUrl: url,
              title: card.title,
              company: "Atlas employer",
              location: card.location,
              description: card.title,
              salaryText: null,
              summary: null,
              postedAt: null,
              workMode: [],
              applyPath: "unknown" as const,
              easyApplyEligible: false,
              keySkills: [],
            };
          });
        },
      },
    });

    // The model is told where the person lives, may work and would move.
    expect(systems).toHaveLength(1);
    expect(systems[0]).toContain('"locations":["Europe"]');
    expect(systems[0]).toContain(
      '"authorizedWorkCountries":["Portugal","United States"]',
    );
    expect(systems[0]).toContain('"preferredRelocationRegions":["Spain"]');
    expect(systems[0]).toContain('"remoteEligible":true');
    expect(systems[0]).toContain('"location":"Lisbon, Portugal"');
    // The US cards on the page are collected with the rest.
    const locations = result.jobs.map((job) => job.location ?? "");
    expect(locations.length).toBeGreaterThan(10);
    expect(
      locations.filter((location) => location.includes("United States")).length,
    ).toBeGreaterThan(0);
    expect(locations.some((location) => location.includes("Portugal"))).toBe(
      true,
    );
    console.info(
      "[work places replica]",
      JSON.stringify({
        collected: locations.length,
        unitedStates: locations.filter((location) =>
          location.includes("United States"),
        ),
      }),
    );
  } finally {
    await browser.close();
  }
}, 120_000);
