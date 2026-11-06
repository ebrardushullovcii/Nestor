import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  createApplyPageHands,
  runApplyAgent,
  runJobSearchAgent,
  type FormReplay,
} from "@nestor/browser-agent";
import { CandidateProfileSchema } from "@nestor/contracts";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPlaywrightApplyPageMechanics,
  createPlaywrightApplyPageSession,
} from "./apply-page-mechanics";

/**
 * A closed two-step form brought back from what Fill left, on the
 * Workday-shaped replica the app's replica gate serves: no model call for a
 * screen that matches, the step's "Save and Continue" stays the person's, and
 * a step the site kept as its own draft is not retyped.
 */

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = "";
const log = join(mkdtempSync(join(tmpdir(), "nestor-restore-")), "posts.log");

beforeAll(async () => {
  server = spawn(
    process.execPath,
    [
      resolvePath(
        import.meta.dirname,
        "../../../apps/desktop/test-fixtures/job-sites/serve.mjs",
      ),
    ],
    { env: { ...process.env, PORT: "0", NESTOR_FIXTURE_SUBMISSIONS_LOG: log } },
  );
  base = await new Promise<string>((resolve, reject) => {
    server!.stderr!.on("data", (chunk: Buffer) => {
      const url = /http:\/\/127\.0\.0\.1:\d+/u.exec(String(chunk))?.[0];
      if (url) resolve(url);
    });
    server!.once("exit", () => reject(new Error("The replica server exited.")));
  });
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
}, 30_000);

const posts = (): string[] => {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { path: string }).path);
  } catch {
    return [];
  }
};

test("Gatekeeper remembers verification and all six detail reads reach content", async () => {
  const context = await browser!.newContext();
  try {
    const before = posts().length;
    for (let id = 1; id <= 6; id++) {
      const page = await context.newPage();
      await page.goto(`${base}/gatekeeper/security/${id}`);
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
              id: "resume",
              fileName: "synthetic.txt",
              textContent: "Synthetic experience",
              textUpdatedAt: new Date().toISOString(),
              uploadedAt: new Date().toISOString(),
              extractionStatus: "ready",
            },
          }),
          searchPreferences: { targetRoles: [], locations: [] },
          startingUrls: [`${base}/gatekeeper/security/${id}`],
          navigationPolicy: {
            allowedHostnames: ["127.0.0.1"],
            allowSubdomains: true,
          },
          promptContext: { siteLabel: "Gatekeeper replica" },
        },
        llmClient: {
          chatWithTools: () => {
            const action =
              ++turn === 1
                ? { name: "wait", args: { milliseconds: id === 1 ? 9000 : 0 } }
                : {
                    name: "finish",
                    args: {
                      reason: "The check cleared and the listing is readable.",
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
        jobExtractor: { extractJobsFromPage: () => Promise.resolve([]) },
      });
      expect(result.incomplete).toBe(false);
      expect(page.url()).toBe(`${base}/gatekeeper/jobs/${id}`);
      expect(await page.content()).toContain("What you will do");
      await page.close();
    }
    expect(
      (await context.cookies()).some(
        (cookie) => cookie.name === "fixture_gatekeeper_verified",
      ),
    ).toBe(true);
    expect(posts()).toHaveLength(before);
  } finally {
    await context.close();
  }
}, 30_000);

/** A model that, if it is ever asked, is counted and gives up. */
function countingModel() {
  let turns = 0;
  return {
    turns: () => turns,
    client: {
      chatWithTools: () => {
        turns += 1;
        return Promise.resolve({
          toolCalls: [
            {
              id: `call_${turns}`,
              type: "function" as const,
              function: {
                name: "finish",
                arguments: JSON.stringify({ reason: "Asked.", stuck: true }),
              },
            },
          ],
        });
      },
    },
  };
}

async function run(
  page: Page,
  replay: FormReplay,
  /** The questions the attempt before left with the person. */
  unanswered: readonly string[] = [],
) {
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    attachmentUploadsAuthorized: true,
    allowedOrigins: [],
  });
  const model = countingModel();
  const writes: string[] = [];
  const hands = createApplyPageHands(session);
  const fillText = hands.fillText;
  hands.fillText = (ref, value) => {
    writes.push(value);
    return fillText(ref, value);
  };
  const result = await runApplyAgent(
    {
      hands,
      safety: session,
      authority: {
        mode: "prepare_only",
        submitAuthorized: false,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "pause_for_user",
        allowedOrigins: [base],
      },
      sources: {
        profile: CandidateProfileSchema.parse({
          id: "candidate_restore",
          firstName: "Alex",
          lastName: "Vanguard",
          fullName: "Alex Vanguard",
          yearsExperience: 8,
          baseResume: {
            id: "resume_restore",
            fileName: "resume.txt",
            uploadedAt: "2026-09-01T09:00:00.000Z",
            textContent: "8 years of field engineering.",
            textUpdatedAt: "2026-09-01T09:00:00.000Z",
            extractionStatus: "ready",
          },
        }),
        resumeText: null,
        posting: {
          title: "Field Engineer",
          company: "Steps Replica",
          location: "Remote",
          description: "Keep customer systems running.",
        },
        reusableAnswers: [],
        documents: [],
      },
      application: {
        jobId: "job_restore",
        applicationId: "application_restore",
        startingUrl: `${base}/steps-shape/jobs/1`,
      },
      siteLabel: "Steps Replica",
      intermediateWritesAuthorized: false,
      replay,
      initialUnansweredPickerQuestions: unanswered.map((prompt) => ({
        prompt,
        options: [],
      })),
    },
    model.client,
  );
  return { result, turns: model.turns(), writes };
}

const answer = (question: string, value: string) => ({
  question,
  answer: value,
  source: "your matching saved answer or profile fact",
  sourceId: "profile.fullName",
  written: false,
  groundedIn: [],
});

test("a restored application gives prior answers to the model without writing or navigating for it", async () => {
  const context = await browser!.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${base}/steps-shape/apply/1`);
    const before = posts().length;
    const restored = await run(page, {
      answers: [answer("First Name", "Alex"), answer("Last Name", "Vanguard")],
      attachments: [],
      path: [],
    });
    expect(restored.turns).toBe(1);
    expect(restored.writes).toEqual([]);
    expect(restored.result.pauses).toEqual([]);
    expect(posts()).toHaveLength(before);
  } finally {
    await context.close();
  }
});
