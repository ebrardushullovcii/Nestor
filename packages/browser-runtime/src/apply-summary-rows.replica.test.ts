import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import { expect, test } from "vitest";
import {
  ApplyStepReceiptSchema,
  CandidateProfileSchema,
} from "@nestor/contracts";
import {
  buildApplyFormObservation,
  checkClassifiedApplicationAnswers,
  reviewFieldKey,
} from "@nestor/browser-agent";
import { readRawApplyPage } from "./apply-page-mechanics";

// Council D1: a numbered review page's visible dt/dd rows are read from the
// live page with their frame, and a value the site swapped after the step was
// confirmed never binds that step's answer at Send.

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const STEP_ONE = `<!doctype html><title>Apply</title><p>Step 1 of 3</p><form><label>Referral code <input name="referral" value="LOCAL-REFERRAL-27"></label><button type="button">Save and Continue</button></form>`;
const REVIEW = `<!doctype html><title>Apply</title><p>Step 3 of 3</p><h1>Review your application</h1>
<dl id="answers">
  <dt>Referral code</dt><dd id="referral">LOCAL-REFERRAL-27</dd>
  <div><dt>Email</dt><dd>jamie@clientnest.example</dd></div>
  <dt style="display:none">Hidden note</dt><dd style="display:none">not shown</dd>
  <dt>Two values</dt><dd>first</dd><dd>second</dd>
</dl>
<iframe src="CHILD/embedded-review"></iframe>
<button>Submit application</button>`;

test("review rows are read live with their frame, and a swapped row value never binds an earlier step", async () => {
  const child = createServer((_req, res) =>
    res.end(
      `<!doctype html><dl><dt>Embedded row</dt><dd>embedded value</dd></dl>`,
    ),
  );
  const childOrigin = await listen(child);
  const site = createServer((req, res) =>
    res.end(
      req.url?.startsWith("/review")
        ? REVIEW.replace("CHILD", childOrigin)
        : STEP_ONE,
    ),
  );
  const origin = await listen(site);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // Step 1 as the agent confirmed it: the site prefilled the code and
    // Nestor never wrote it.
    await page.goto(`${origin}/apply`);
    const stepOne = buildApplyFormObservation(
      await readRawApplyPage(page),
      "2026-11-04T01:00:00.000Z",
    );
    const referral = stepOne.controls.find(
      (control) => control.label === "Referral code",
    )!;
    expect(referral.value).toBe("LOCAL-REFERRAL-27");
    const fieldKey = reviewFieldKey(stepOne, referral);
    const receipt = ApplyStepReceiptSchema.parse({
      kind: "advance",
      resultId: "application_7_attempt_1",
      url: `${origin}/apply`,
      origin,
      stepIndex: stepOne.step.index,
      stepTotal: stepOne.step.total,
      stepLabel: stepOne.step.label,
      instructions: "Step 1 of 3",
      fields: [
        {
          fieldKey,
          label: "Referral code",
          kind: "text",
          answerControlType: "text",
          required: false,
          readOnly: false,
          questionKind: "other",
          attestationKind: null,
          value: "LOCAL-REFERRAL-27",
          provenance: "site_unchanged",
        },
      ],
      at: "2026-11-04T01:00:00.000Z",
    });
    expect([receipt.stepIndex, receipt.stepTotal]).toEqual([1, 3]);

    await page.goto(`${origin}/review`);
    await page.frameLocator("iframe").locator("dd").waitFor();
    const reviewRaw = await readRawApplyPage(page);
    expect(reviewRaw.summaryRows?.filter((row) => !row.frame)).toEqual([
      { label: "Referral code", value: "LOCAL-REFERRAL-27" },
      { label: "Email", value: "jamie@clientnest.example" },
    ]);
    expect(reviewRaw.summaryRows?.filter((row) => row.frame)).toEqual([
      {
        label: "Embedded row",
        value: "embedded value",
        frame: { origin: childOrigin, pathname: "/embedded-review" },
      },
    ]);

    const send = async () => {
      const raw = await readRawApplyPage(page);
      const review = buildApplyFormObservation(raw, "2026-11-04T01:01:00.000Z");
      return checkClassifiedApplicationAnswers({
        client: {
          chatWithTools: (messages, tools) => {
            const questions = JSON.parse(
              String(messages.find((m) => m.role === "user")?.content),
            ) as { index: number }[];
            return Promise.resolve({
              toolCalls: [
                {
                  id: "read",
                  type: "function",
                  function: {
                    name: tools[0]!.function.name,
                    arguments: JSON.stringify({
                      plainIndexes: questions.map((entry) => entry.index),
                      flagged: [],
                      tags: questions.map((entry) => ({
                        index: entry.index,
                        kind: "other",
                        country: null,
                        sourceId: null,
                      })),
                    }),
                  },
                },
              ],
            });
          },
        },
        sources: {
          profile: CandidateProfileSchema.parse({
            id: "synthetic",
            firstName: "Jamie",
            lastName: "Example",
            fullName: "Jamie Example",
            email: "jamie@clientnest.example",
            yearsExperience: 6,
            baseResume: {
              id: "resume",
              fileName: "jamie-synthetic-resume.txt",
              uploadedAt: "2026-11-01T00:00:00.000Z",
              extractionStatus: "ready",
              textContent: "Jamie Example\nFrontend engineer.",
            },
          }),
          resumeText: "Jamie Example\nFrontend engineer.",
          posting: {
            title: "Frontend Engineer",
            company: "Clientnest Replica",
            location: "Berlin, Germany",
            description: "Build React interfaces.",
          },
          reusableAnswers: [],
          documents: [],
        },
        payDisclosed: false,
        application: {
          jobId: "7",
          applicationId: "application_7_attempt_1",
          resultId: "application_7_attempt_1",
          startingUrl: `${origin}/apply`,
        },
        answers: [
          { question: "Referral code", answer: "LOCAL-REFERRAL-27", fieldKey },
        ],
        formControls: review.controls,
        summaryRows: review.summaryRows ?? [],
        stepReceipts: [receipt],
        sendPage: {
          origin: review.origin,
          stepIndex: review.step.index,
          stepTotal: review.step.total,
        },
        formContext: { pageText: review.bodyTextExcerpt, fields: [] },
      });
    };
    expect(await send()).toEqual([
      {
        supported: true,
        reason: "The site filled this and Nestor left it unchanged.",
      },
    ]);

    // The site swaps the shown value after the step was confirmed.
    await page.evaluate(() => {
      document.querySelector("#referral")!.textContent = "OTHER-9";
    });
    expect(
      (await readRawApplyPage(page)).summaryRows?.find(
        (row) => row.label === "Referral code",
      )?.value,
    ).toBe("OTHER-9");
    const [swapped] = await send();
    expect(swapped).toMatchObject({
      supported: false,
      priorStep: "unverified",
    });
  } finally {
    await browser?.close();
    await close(site);
    await close(child);
  }
}, 30_000);
