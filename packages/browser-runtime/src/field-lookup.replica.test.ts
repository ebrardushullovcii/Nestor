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
 * A Greenhouse-shaped "Location (City)" box whose geocoder knows the city as
 * "Pristina" only (Customer.io, R5 application 35). Typing returns once the
 * lookup has answered, with what it offered, so the model sees the choice.
 */

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = "";
const log = join(mkdtempSync(join(tmpdir(), "nestor-city-")), "posts.log");

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

const sent = (): Array<Record<string, string>> => {
  try {
    return readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { path: string; fields: Record<string, string> },
      )
      .filter((entry) => entry.path === "/city-lookup/apply/1")
      .map((entry) => entry.fields);
  } catch {
    return [];
  }
};

test("type_keys and type return the city lookup's answer, including when it offers nothing", async () => {
  const page = await browser!.newPage();
  try {
    await page.goto(`${base}/city-lookup/apply/1`);
    const raw = createPlaywrightApplyPageMechanics(page);
    const ref = (await raw.readPage()).controls.find(
      (c) => c.id === "city",
    )!.ref!;

    const started = Date.now();
    const unknown = await raw.typeKeys!(ref, "Prishtina");
    // The debounce and the geocoder's answer both came before the return.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_200);
    expect(unknown).toMatchObject({
      ok: true,
      optionList: { open: true, busy: false, options: [] },
    });

    await raw.pressKey(ref, "ControlOrMeta+A");
    await raw.pressKey(undefined, "Backspace");
    const known = await raw.typeKeys!(ref, "Pristina");
    expect(known).toMatchObject({
      ok: true,
      optionList: { open: true, busy: false, options: ["Pristina, Kosovo"] },
    });

    // The offered row is on the page read with its own handle.
    const row = (await raw.readPage()).clickables.find(
      (c) => c.role === "option" && c.label === "Pristina, Kosovo",
    );
    expect(row?.ref).toBeTruthy();
    expect(await raw.clickElement(row!.ref!)).toMatchObject({ ok: true });
    expect(await page.locator("#location").inputValue()).toBe(
      "Pristina, Kosovo",
    );

    const typed = await raw.fillText(ref, "Priština");
    expect(typed).toMatchObject({
      ok: true,
      optionList: { open: true, busy: false, options: ["Pristina, Kosovo"] },
    });
  } finally {
    await page.close();
  }
}, 30_000);

test("the Customer.io turns pick the city the lookup offers and the form is accepted", async () => {
  const page = await browser!.newPage();
  const before = sent().length;
  try {
    await page.goto(`${base}/city-lookup/apply/1`);
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
        // A fictional applicant; no owner profile or browser data is used.
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
          title: "Platform Engineer",
          company: "Cloud Tools",
          location: "Remote",
          description: "Replica role",
        },
        reusableAnswers: [],
        documents: [],
      },
      application: {
        jobId: "replica",
        applicationId: "replica",
        startingUrl: `${base}/city-lookup/apply/1`,
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
        const city = seen.controls.find((c) => c.label.includes("Location"))!;
        const current = turn++;
        const call = (name: string, args: object) => ({
          content: "",
          toolCalls: [
            {
              id: `city-${current}`,
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
              ],
            });
          // The model's own turns at 20:06:38 and 20:07:46-20:08:00.
          case 1:
            return call("type_keys", { ref: city.ref, text: "Prishtina" });
          case 2:
            return call("press_key", {
              ref: city.ref,
              key: "ControlOrMeta+A",
            });
          case 3:
            return call("type_keys", { ref: city.ref, text: "Pristina" });
          case 4: {
            const row = seen.clickables.find(
              (c) => c.role === "option" && c.label === "Pristina, Kosovo",
            )!;
            return call("click", { ref: row.ref });
          }
          case 5:
            return call("submit_application", {
              ref: seen.actions.find((a) => a.label === "Submit application")!
                .ref,
            });
          default:
            return call("finish", { reason: "Application received" });
        }
      },
    });
    // Prishtina: the lookup answered with nothing, and said so.
    expect(toolResults.get("city-1")).toContain(`"options":[]`);
    expect(toolResults.get("city-1")).not.toContain(`"busy":true`);
    // Pristina: the offered city is in the type_keys result itself.
    expect(toolResults.get("city-3")).toContain(
      `"options":["Pristina, Kosovo"]`,
    );
    expect(sent().slice(before)).toEqual([
      expect.objectContaining({ location: "Pristina, Kosovo" }),
    ]);
  } finally {
    await page.close();
  }
}, 60_000);
