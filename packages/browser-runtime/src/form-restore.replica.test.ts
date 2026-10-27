import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  createApplyPageHands,
  runApplyAgent,
  type FormReplay,
} from "@nestor/browser-agent";
import { CandidateProfileSchema } from "@nestor/contracts";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import {
  allowPrepareOnlyRunNavigation,
  closePrepareOnlyFinalActionWindow,
  ensurePrepareOnlyMutationGuard,
  openPrepareOnlyFinalActionWindow,
} from "./playwright-application-flow";

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
});

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

test("a closed two-step form comes back step by step, with no model call", async () => {
  const page = await (await browser!.newContext()).newPage();
  await ensurePrepareOnlyMutationGuard(page, false, [], true);
  allowPrepareOnlyRunNavigation(page, `${base}/steps-shape/jobs/1`);
  await page.goto(`${base}/steps-shape/jobs/1`);
  const replay: FormReplay = {
    answers: [
      answer("First Name", "Alex"),
      answer("Last Name", "Vanguard"),
      answer("Email", "alex.vanguard@example.test"),
      answer("Years of experience", "8"),
      answer("LinkedIn", "linkedin.com/in/alex-vanguard"),
    ],
    attachments: [],
    // Fill followed the listing's "Apply" to reach the form.
    path: [
      {
        from: `${base}/steps-shape/jobs/1|`,
        tool: "follow_link",
        label: "Apply",
        href: `${base}/steps-shape/apply/1`,
      },
    ],
  };
  const first = await run(page, replay);
  expect(first.turns).toBe(0);
  expect(first.writes).toEqual([
    "Alex",
    "Vanguard",
    "alex.vanguard@example.test",
  ]);
  expect(first.result.outcome).toBe("paused");
  // "Save and Continue" is the person's: nothing was saved or sent.
  expect(posts()).toEqual([]);

  // The person presses it in their own window, which the fence opens for
  // them; the site keeps the step and shows the next.
  await openPrepareOnlyFinalActionWindow(page);
  await page.getByRole("button", { name: "Save and Continue" }).click();
  await page.waitForURL(/step=2/u);
  await closePrepareOnlyFinalActionWindow(page);
  const second = await run(page, replay);
  expect(second.turns).toBe(0);
  expect(second.writes).toEqual(["8", "linkedin.com/in/alex-vanguard"]);
  expect(second.result.outcome).toBe("prepared");
  expect(posts()).toEqual(["/steps-shape/apply/1/step/1"]);

  // Back on the saved step, the site shows its draft: nothing is retyped.
  allowPrepareOnlyRunNavigation(page, `${base}/steps-shape/apply/1?step=1`);
  await page.goto(`${base}/steps-shape/apply/1?step=1`);
  const third = await run(page, replay);
  expect(third.turns).toBe(0);
  expect(third.writes).toEqual([]);
}, 60_000);

test("a closed Needs-you form comes back with its open question still the person's, with no model call", async () => {
  const replay: FormReplay = {
    answers: [answer("First Name", "Alex"), answer("Last Name", "Vanguard")],
    attachments: [],
    path: [
      {
        from: `${base}/steps-shape/jobs/1|`,
        tool: "follow_link",
        label: "Apply",
        href: `${base}/steps-shape/apply/1`,
      },
    ],
  };
  const open = async () => {
    const page = await (await browser!.newContext()).newPage();
    await ensurePrepareOnlyMutationGuard(page, false, [], true);
    allowPrepareOnlyRunNavigation(page, `${base}/steps-shape/jobs/1`);
    await page.goto(`${base}/steps-shape/jobs/1`);
    return page;
  };
  const sent = posts().length;
  // The attempt before asked the person for their email; it is still open.
  const restored = await run(await open(), replay, ["Email *"]);
  expect(restored.turns).toBe(0);
  expect(restored.writes).toEqual(["Alex", "Vanguard"]);
  expect(restored.result.outcome).toBe("paused");
  expect(
    restored.result.pauses.flatMap((pause) =>
      (pause.questions ?? []).map((question) => question.prompt),
    ),
  ).toEqual([expect.stringMatching(/^Email/u)]);

  // A field nobody asked about means the page differs: the model reads it.
  const differs = await run(await open(), replay);
  expect(differs.turns).toBeGreaterThan(0);
  expect(posts()).toHaveLength(sent);
}, 60_000);
