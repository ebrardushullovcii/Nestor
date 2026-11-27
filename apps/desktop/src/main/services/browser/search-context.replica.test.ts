import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import { CandidateProfileSchema, JobPostingSchema } from "@nestor/contracts";
import { createApplyPageHands, runJobSearchAgent } from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime";

/**
 * A whole-board read on the local Longboard replica with a scripted model:
 * every public listing is collected, and each request carries the newest
 * page view whole while page views the model moved past are folded to
 * receipts the model can read back with read_context_history.
 */
test("a long board is collected whole while earlier page views fold out of each request", async () => {
  const server = spawn(
    process.execPath,
    [
      resolve(
        import.meta.dirname,
        "../../../../test-fixtures/job-sites/serve.mjs",
      ),
    ],
    {
      env: { ...process.env, PORT: "0" },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const browser = await chromium.launch({ headless: true });
  try {
    let output = "";
    const base = await new Promise<string>((done, fail) => {
      const timer = setTimeout(
        () => fail(new Error("Fixture did not start")),
        10_000,
      );
      server.stderr?.on("data", (data: Buffer) => {
        output += data.toString();
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//u)?.[0];
        if (url) {
          clearTimeout(timer);
          done(url);
        }
      });
    });
    const start = `${base}longboard/jobs`;
    const page = await browser.newPage();
    await page.goto(start);
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    const requests: string[] = [];
    let turn = 0;
    let readThisPage = false;
    const result = await runJobSearchAgent({
      page,
      hands,
      config: {
        source: "target_site",
        maxSteps: 1,
        targetJobCount: 100,
        userProfile: CandidateProfileSchema.parse({
          id: "replica",
          yearsExperience: 3,
          baseResume: {
            id: "replica-resume",
            fileName: "synthetic.txt",
            uploadedAt: "2026-11-01T00:00:00.000Z",
            textContent: "Synthetic software engineering experience.",
            extractionStatus: "ready",
          },
        }),
        searchPreferences: {
          targetRoles: ["Software Engineer"],
          locations: ["Europe"],
        },
        startingUrls: [start],
        navigationPolicy: {
          allowedHostnames: ["127.0.0.1"],
          allowSubdomains: true,
        },
        promptContext: { siteLabel: "Longboard replica" },
      },
      llmClient: {
        chatWithTools: async (messages) => {
          requests.push(JSON.stringify(messages));
          const call = (name: string, args: object) => ({
            toolCalls: [
              {
                id: `turn-${++turn}`,
                type: "function" as const,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
          if (!readThisPage) {
            readThisPage = true;
            return call("extract_jobs", { pageType: "search_results" });
          }
          const next = (await hands.observe()).links.find(
            (link) => link.label === "Next",
          );
          if (next) {
            readThisPage = false;
            return call("next_page", { ref: next.ref });
          }
          return call("finish", {
            reason: "Read pages 1 to 6 of 6.",
            coverageComplete: true,
            remainingWork: [],
          });
        },
      },
      jobExtractor: {
        extractJobsFromPage: (input) =>
          Promise.resolve(
            [
              ...input.pageText.matchAll(
                /([^\n\]]+?) → (http:\/\/\S+\/longboard\/job\/(\d+))/gu,
              ),
            ]
              .filter(
                ([, , url]) => !input.excludedCanonicalUrls?.includes(url!),
              )
              .slice(0, input.maxJobs)
              .map(([, title, url, id]) =>
                JobPostingSchema.parse({
                  source: "target_site",
                  sourceJobId: id,
                  title: title!.trim(),
                  company: "Replica employer",
                  location: "Remote, Europe",
                  description: `${title} on the Longboard replica.`,
                  canonicalUrl: url,
                  salaryText: null,
                  applyPath: "unknown",
                  easyApplyEligible: false,
                  discoveredAt: new Date().toISOString(),
                }),
              ),
          ),
      },
    });
    expect(new Set(result.jobs.map((job) => job.canonicalUrl)).size).toBe(60);
    // Every request still holds the newest view whole; views the model has
    // moved past arrive as receipts naming their archive.
    const last = requests.at(-1)!;
    expect(last).toContain("[Page view search_view_");
    expect(last).toContain("read_context_history archive");
    const wholeViews = (request: string) =>
      (request.match(/Full search observation search_view_\d+/gu) ?? []).length;
    expect(Math.max(...requests.map(wholeViews))).toBeLessThanOrEqual(2);
    // The request no longer grows with every page read.
    expect(last.length).toBeLessThan(requests[2]!.length * 2);
  } finally {
    await browser.close();
    server.kill();
  }
}, 60_000);
