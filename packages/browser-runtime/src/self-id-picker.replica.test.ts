import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createApplyPageHands,
  runApplyAgent,
  type ApplyAgentConfig,
  type ApplyFormObservation,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";
import { choosePageOption } from "./choose-page-option";

/**
 * A Greenhouse-shaped form whose voluntary self-identification dropdowns are
 * drawn the way React-Select draws them (Cloudflare, R6 run 04: select
 * "Male" left "Female" chosen and the tool reported success; Anthropic, runs
 * 03 and 05: dropdowns reported success holding nothing, a failed one left
 * its menu over the next fields, and a redrawn form ended the first batch).
 */

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let base = "";
const log = join(mkdtempSync(join(tmpdir(), "nestor-self-id-")), "posts.log");

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
      .filter((entry) => entry.path === "/self-id/apply/1")
      .map((entry) => entry.fields);
  } catch {
    return [];
  }
};

const chosen = (page: Page, name: string) =>
  page.locator(`input[type=hidden][name="${name}"]`).inputValue();

const openPage = async () =>
  browser!.newPage({ viewport: { width: 1262, height: 661 } });

const SELF_ID = [
  ["gender", "Male"],
  ["hispanic", "No"],
  ["veteran", "I am not a protected veteran"],
] as const;

test("each dropdown gets the asked option while its menu scrolls the page open", async () => {
  const page = await openPage();
  try {
    await page.goto(`${base}/self-id/apply/1?background=1`);
    const raw = createPlaywrightApplyPageMechanics(page);
    for (const [id, option] of SELF_ID) {
      const ref = (await raw.readPage()).controls.find(
        (c) => c.id === id,
      )!.ref!;
      expect(await raw.chooseOption(ref, option)).toMatchObject({
        ok: true,
        observedValue: option,
      });
      expect(await chosen(page, id)).toBe(option);
    }
    // Every menu scrolled the page as it opened.
    expect(await page.evaluate("window.__menuScrolls")).toBe(SELF_ID.length);
  } finally {
    await page.close();
  }
}, 60_000);

test("a picker that commits a different row than the one pressed reports that row, never success", async () => {
  const page = await openPage();
  try {
    // Pressing "Male" commits the row drawn above it.
    await page.setContent(`<label for="g">Gender</label>
      <div class="select__control"><div class="select__value-container">
        <input id="g" role="combobox" aria-controls="g-list">
      </div></div>
      <div id="g-list" role="listbox" hidden>
        ${["Female", "Male"].map((text) => `<div role="option">${text}</div>`).join("")}
      </div>
      <script>
        const input = document.getElementById('g'), list = document.getElementById('g-list');
        input.onfocus = () => { list.hidden = false; };
        input.oninput = () => { list.hidden = false; };
        list.querySelectorAll('[role=option]').forEach((row, index, rows) => {
          row.onmousedown = (event) => event.preventDefault();
          row.onclick = () => {
            const shown = document.createElement('div');
            shown.className = 'select__single-value';
            shown.textContent = rows[Math.max(0, index - 1)].textContent;
            input.before(shown); input.value = ''; list.hidden = true;
          };
        });
      </script>`);
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      "Male",
    );
    expect(result.ok).toBe(false);
    expect(result.ok || result.error).toContain('"Female"');
  } finally {
    await page.close();
  }
}, 30_000);

test("a dropdown that does not offer the answer closes again and the next dropdowns fill", async () => {
  const page = await openPage();
  try {
    await page.goto(`${base}/self-id/apply/1?background=1`);
    const raw = createPlaywrightApplyPageMechanics(page);
    const refs = async () =>
      Object.fromEntries(
        (await raw.readPage()).controls.map((c) => [c.id, c.ref!]),
      );
    const missing = await raw.chooseOption((await refs()).gender!, "Nonbinary");
    expect(missing).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      optionList: { open: false },
    });
    expect(await page.getByRole("listbox").count()).toBe(0);
    for (const [id, option] of SELF_ID.slice(1)) {
      expect(await raw.chooseOption((await refs())[id]!, option)).toMatchObject(
        { ok: true, observedValue: option },
      );
      expect(await chosen(page, id)).toBe(option);
    }
  } finally {
    await page.close();
  }
}, 60_000);

test("a dropdown's choices are read for the person without choosing one", async () => {
  const page = await openPage();
  try {
    await page.goto(`${base}/self-id/apply/1?background=1`);
    const raw = createPlaywrightApplyPageMechanics(page);
    const ref = (await raw.readPage()).controls.find(
      (c) => c.id === "gender",
    )!.ref!;
    expect(await raw.readOptions!(ref)).toEqual([
      "Male",
      "Female",
      "Decline To Self Identify",
    ]);
    expect(await chosen(page, "gender")).toBe("");
    expect(await page.getByRole("listbox").count()).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

function agentConfig(
  page: Page,
  url: string,
): {
  config: ApplyAgentConfig;
  hands: ReturnType<typeof createApplyPageHands>;
} {
  const raw = createPlaywrightApplyPageMechanics(page);
  const hands = createApplyPageHands(raw);
  return {
    hands,
    config: {
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
          title: "Senior Design Engineer",
          company: "Replica Networks",
          location: "Hybrid",
          description: "Replica role",
        },
        reusableAnswers: [],
        documents: [],
      },
      application: {
        jobId: "replica",
        applicationId: "replica",
        startingUrl: url,
      },
      siteLabel: "Replica",
      intermediateWritesAuthorized: true,
      submitApplication: async ({ actionRef }) => {
        await raw.clickElement(actionRef);
        return { outcome: "submitted", content: "Application received" };
      },
    },
  };
}

/** The 04 turn-1 batch, in its order, on the replica's fields. */
function turnOneBatch(seen: ApplyFormObservation) {
  const ref = (id: string) =>
    seen.controls.find((c) => c.nativeIdentity?.includes(`"${id}"`))!.ref;
  return {
    fields: [
      { tool: "type", ref: ref("first_name"), text: "Test" },
      { tool: "type", ref: ref("last_name"), text: "Applicant" },
      { tool: "type", ref: ref("email"), text: "synthetic@example.test" },
      { tool: "select", ref: ref("sponsorship"), option: "No" },
      { tool: "set_checkbox", ref: ref("privacy"), checked: true },
      ...SELF_ID.map(([id, option]) => ({
        tool: "select",
        ref: ref(id),
        option,
      })),
    ],
  };
}

async function replay(
  url: string,
  beforeBatch?: (page: Page) => Promise<void>,
) {
  const page = await openPage();
  const before = sent().length;
  try {
    await page.goto(url);
    const { config, hands } = agentConfig(page, url);
    let planned: ApplyFormObservation | null = null;
    const toolResults = new Map<string, string>();
    let turn = 0;
    await runApplyAgent(config, {
      chatWithTools: async (messages) => {
        for (const message of messages)
          if (message.role === "tool")
            toolResults.set(message.toolCallId, String(message.content));
        const current = turn++;
        const call = (name: string, args: object) => ({
          content: "",
          toolCalls: [
            {
              id: `self-id-${current}`,
              type: "function" as const,
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        if (current === 0) {
          // The model plans from the page it was shown at the start.
          planned ??= await hands.observe();
          await beforeBatch?.(page);
          return call("fill_fields", turnOneBatch(planned));
        }
        if (current === 1) {
          const seen = await hands.observe();
          return call("submit_application", {
            ref: seen.actions.find((a) => a.label === "Submit application")!
              .ref,
          });
        }
        return call("finish", { reason: "Application received" });
      },
    });
    return {
      // The batch's own lines, before the page it returns.
      result: (toolResults.get("self-id-0") ?? "").split("\n\n")[0]!,
      posts: sent().slice(before),
    };
  } finally {
    await page.close();
  }
}

test("the 04 turn-1 batch fills every dropdown with the asked option", async () => {
  const { result, posts } = await replay(
    `${base}/self-id/apply/1?background=1`,
  );
  expect(result).toMatch(/Gender — Select\.\.\. now holds "Male"/u);
  expect(result).not.toContain('holds "Female"');
  expect(posts).toEqual([
    expect.objectContaining({
      first_name: "Test",
      sponsorship: "No",
      privacy: "1",
      gender: "Male",
      hispanic: "No",
      veteran: "I am not a protected veteran",
    }),
  ]);
}, 90_000);

test("a batch planned before the page redrew its form follows each field to its new ref", async () => {
  const { result, posts } = await replay(
    `${base}/self-id/apply/1?background=1&hydrate=1500`,
    async (page) => {
      await page.waitForFunction("window.__hydrated === true", undefined, {
        timeout: 10_000,
      });
    },
  );
  expect(result).not.toContain("not attempted");
  expect(result).toContain("the page redrew that field");
  expect(posts).toEqual([
    expect.objectContaining({
      first_name: "Test",
      last_name: "Applicant",
      sponsorship: "No",
      gender: "Male",
      hispanic: "No",
      veteran: "I am not a protected veteran",
    }),
  ]);
}, 90_000);

test("a dropdown handed to the person carries its choices", async () => {
  const page = await openPage();
  try {
    const url = `${base}/self-id/apply/1`;
    await page.goto(url);
    const { config, hands } = agentConfig(page, url);
    const outcome = await runApplyAgent(config, {
      chatWithTools: async () => {
        const seen = await hands.observe();
        const gender = seen.controls.find((c) =>
          c.nativeIdentity?.includes('"gender"'),
        )!;
        return {
          content: "",
          toolCalls: [
            {
              id: "ask",
              type: "function" as const,
              function: {
                name: "finish",
                arguments: JSON.stringify({
                  reason: "Only the person can answer this.",
                  needsPerson: true,
                  forPerson: [gender.ref],
                }),
              },
            },
          ],
        };
      },
    });
    const question = outcome.pauses.find(
      (pause) => pause.code === "question_needs_you",
    )?.questions?.[0];
    expect(question).toMatchObject({
      answerControlType: "single_choice",
      answerOptions: ["Male", "Female", "Decline To Self Identify"],
    });
    expect(await chosen(page, "gender")).toBe("");
  } finally {
    await page.close();
  }
}, 60_000);
