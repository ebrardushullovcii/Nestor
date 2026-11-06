import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { CandidateProfileSchema, JobPostingSchema } from "@nestor/contracts";
import { createApplyPageHands, runJobSearchAgent } from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();

test.skipIf(!existsSync(executablePath))(
  "search uses a vault login on a local replica and reads the full vacancy without exposing the secret",
  async () => {
    let signIns = 0;
    const requirement = "Final requirement: Albanian and TypeScript.";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      if (request.method === "POST") {
        signIns++;
        request.resume();
        response.end(
          `<main><h1>Interface Engineer</h1><p>Synthetic Employer · Europe</p><p>${"Complete duties. ".repeat(1800)}</p><p>${requirement}</p></main>`,
        );
      } else {
        response.end(
          '<main><h1>Sign in</h1><form method="post" action="/session"><label>Email<input name="email" type="email" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form></main>',
        );
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing fixture address");
    const url = `http://127.0.0.1:${address.port}/login`;
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(url);
      const prepare = vi.fn(async () => {
        await page
          .locator('input[type="email"]')
          .fill("synthetic@example.test");
        await page
          .locator('input[type="password"]')
          .fill("synthetic-local-password");
        return true;
      });
      const requests: string[] = [];
      let turn = 0;
      const result = await runJobSearchAgent({
        page,
        hands: createApplyPageHands(createPlaywrightApplyPageMechanics(page)),
        config: {
          source: "target_site",
          maxSteps: 1,
          targetJobCount: 1,
          userProfile: CandidateProfileSchema.parse({
            id: "replica",
            yearsExperience: 2,
            baseResume: {
              id: "replica-resume",
              fileName: "synthetic.txt",
              uploadedAt: new Date().toISOString(),
              textContent: "Synthetic interface engineering experience.",
              textUpdatedAt: new Date().toISOString(),
              extractionStatus: "ready",
            },
          }),
          searchPreferences: {
            targetRoles: ["Interface Engineer"],
            locations: ["Europe"],
          },
          startingUrls: [url],
          navigationPolicy: {
            allowedHostnames: ["127.0.0.1"],
            allowSubdomains: true,
          },
          promptContext: { siteLabel: "Local sign-in replica" },
          browserPermissions: {
            signIn: true,
            googleSignIn: false,
            createAccounts: true,
            solveCaptchas: true,
          },
          prepareBrowserCredentials: prepare,
        },
        llmClient: {
          chatWithTools: (messages) => {
            requests.push(JSON.stringify(messages));
            const action =
              ++turn === 1
                ? { name: "click", args: { ref: "a0" } }
                : turn === 2
                  ? { name: "extract_jobs", args: { pageType: "job_detail" } }
                  : {
                      name: "finish",
                      args: {
                        reason: "Signed in and read the complete vacancy.",
                      },
                    };
            return Promise.resolve({
              toolCalls: [
                {
                  id: `turn-${turn}`,
                  type: "function",
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
          extractJobsFromPage: (input) => {
            expect(input.pageText).toContain(requirement);
            return Promise.resolve([
              JobPostingSchema.parse({
                source: "target_site",
                sourceJobId: "1",
                title: "Interface Engineer",
                company: "Synthetic Employer",
                location: "Europe",
                description: input.pageText,
                canonicalUrl: page.url(),
                salaryText: null,
                applyPath: "unknown",
                easyApplyEligible: false,
                discoveredAt: new Date().toISOString(),
              }),
            ]);
          },
        },
      });
      expect(prepare).toHaveBeenCalled();
      expect(signIns).toBe(1);
      expect(result.incomplete, JSON.stringify(result)).toBe(false);
      expect(result.jobs[0]?.description).toContain(requirement);
      expect(result.jobs[0]?.description.length).toBeGreaterThan(20_000);
      expect(requests.join("\n")).not.toContain("synthetic-local-password");
    } finally {
      await browser.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  30_000,
);
