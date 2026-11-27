import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createApplyPageHands,
  runApplyAgent,
  type ApplyAgentConfig,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";

/**
 * Text written into a rich-text box keeps the model's line breaks. The R7
 * email to Loop Machines arrived as one paragraph: the body was written with
 * textContent, and the field read back to the model was flattened too.
 */

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = "";
const log = join(mkdtempSync(join(tmpdir(), "nestor-rich-text-")), "posts.log");

// A fictional applicant; no owner profile or browser data is used.
const letter = [
  "Hi Paper Lantern team,",
  "",
  "I'd like to apply for the Product Engineer role. I have built and shipped editors like yours.",
  "",
  "Portfolio: https://portfolio.example.test/ | GitHub: https://github.example.test/applicant",
  "",
  "Best regards,",
  "Test Applicant",
  "+1 555 0100",
].join("\n");

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

const sent = (path: string): Array<Record<string, string>> => {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { path: string; fields: Record<string, string> },
      )
      .filter((entry) => entry.path === path)
      .map((entry) => entry.fields);
  } catch {
    return [];
  }
};

test("a mail compose body keeps every paragraph, and the model reads them back", async () => {
  const context = await browser!.newContext();
  const page = await context.newPage();
  // The person's own tab stays in front; the compose tab works behind it.
  const front = await context.newPage();
  try {
    await page.goto(`${base}/rich-text/compose`);
    await front.bringToFront();
    const raw = createPlaywrightApplyPageMechanics(page);
    const body = (await raw.readPage()).controls.find(
      (c) => c.label === "Message Body",
    )!;
    expect(body.tagName).toBe("contenteditable");

    const written = await raw.fillText(body.ref!, letter);
    expect(written).toMatchObject({ ok: true, observedValue: letter });
    expect(
      (await raw.readPage()).controls.find((c) => c.ref === body.ref)?.value,
    ).toBe(letter);
    // Each line is the editor's own block, as pressing Enter makes it.
    expect(await page.locator("#body > div").count()).toBe(
      letter.split("\n").length,
    );

    // Writing again replaces the message rather than adding to it.
    expect(await raw.fillText(body.ref!, letter)).toMatchObject({
      ok: true,
      observedValue: letter,
    });

    const before = sent("/rich-text/compose").length;
    const sendButton = (await raw.readPage()).actions.find(
      (a) => a.label === "Send",
    )!;
    await raw.clickElement(sendButton.ref!);
    await page.getByText("Message sent").waitFor();
    expect(sent("/rich-text/compose").slice(before)).toEqual([
      expect.objectContaining({
        body: letter,
        // What typing the letter by hand gives: a block per line, and an
        // empty block for each blank line.
        html: letter
          .split("\n")
          .map((line) => `<div>${line || "<br>"}</div>`)
          .join(""),
      }),
    ]);
  } finally {
    await context.close();
  }
}, 30_000);

test("an editor that keeps its own document gets the paragraphs the model wrote", async () => {
  const page = await browser!.newPage();
  const before = sent("/rich-text/apply/1").length;
  try {
    await page.goto(`${base}/rich-text/apply/1`);
    const raw = createPlaywrightApplyPageMechanics(page);
    const hands = createApplyPageHands(raw);
    const config: ApplyAgentConfig = {
      hands,
      authority: {
        mode: "autonomous_submit",
        submitAuthorized: true,
        preApprovedAttestationKinds: [],
        salaryDisclosure: "answer_from_profile",
        allowedOrigins: [],
      },
      sources: {
        profile: CandidateProfileSchema.parse({
          id: "replica",
          firstName: "Test",
          lastName: "Applicant",
          fullName: "Test Applicant",
          email: "synthetic@example.test",
          currentLocation: "Prishtina, Kosovo",
          yearsExperience: 3,
          baseResume: {
            id: "replica",
            fileName: "replica.txt",
            uploadedAt: "2026-11-01T00:00:00.000Z",
            textContent: "Synthetic applicant",
            extractionStatus: "ready",
          },
        }),
        resumeText: null,
        posting: {
          title: "Product Engineer",
          company: "Paper Lantern",
          location: "Remote",
          description: "Replica role",
        },
        reusableAnswers: [],
        documents: [],
      },
      application: {
        jobId: "replica",
        applicationId: "replica",
        startingUrl: `${base}/rich-text/apply/1`,
      },
      siteLabel: "Replica",
      intermediateWritesAuthorized: true,
      submitApplication: async ({ actionRef }) => {
        await raw.clickElement(actionRef);
        return { outcome: "submitted", content: "Application received" };
      },
    };
    const toolResults = new Map<string, string>();
    let turn = 0;
    await runApplyAgent(config, {
      chatWithTools: async (messages) => {
        for (const message of messages)
          if (message.role === "tool")
            toolResults.set(message.toolCallId, String(message.content));
        const seen = await hands.observe();
        const current = turn++;
        const call = (name: string, args: object) => ({
          content: "",
          toolCalls: [
            {
              id: `rich-${current}`,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        switch (current) {
          case 0:
            return call("fill_fields", {
              fields: [
                {
                  ref: seen.controls.find((c) => c.label.includes("name"))!.ref,
                  tool: "type",
                  text: "Test Applicant",
                  storedFactId: "profile.fullName",
                },
                {
                  ref: seen.controls.find((c) => c.label.includes("Cover"))!
                    .ref,
                  tool: "type",
                  text: letter,
                  groundedIn: ["the synthetic profile"],
                },
              ],
            });
          case 1:
            return call("submit_application", {
              ref: seen.actions.find((a) => a.label === "Submit application")!
                .ref,
            });
          default:
            return call("finish", { reason: "Application received" });
        }
      },
    });
    // The field summary the model gets back holds the letter, breaks and all.
    expect(toolResults.get("rich-0")).toContain(
      `answered: ${JSON.stringify(letter)}`,
    );
    // A form posts line breaks as CRLF.
    expect(
      sent("/rich-text/apply/1")
        .slice(before)
        .map((fields) => ({
          name: fields.name,
          cover_letter: fields.cover_letter?.replace(/\r\n/gu, "\n"),
        })),
    ).toEqual([{ name: "Test Applicant", cover_letter: letter }]);
  } finally {
    await page.close();
  }
}, 60_000);
