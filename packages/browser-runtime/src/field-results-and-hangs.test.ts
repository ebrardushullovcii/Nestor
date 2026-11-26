import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createApplyPageHands,
  runApplyAgent,
  type ApplyAgentConfig,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";
import { choosePageOption } from "./choose-page-option";
import {
  fieldResultsForm,
  acceptFieldResultsSubmission,
} from "../../../apps/desktop/test-fixtures/job-finder/field-results";

let browser: Browser;
let server: Server;
let origin: string;
let accepted = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/send" && req.method === "POST") {
      acceptFieldResultsSubmission(req, res, () => accepted++);
    } else if (req.url === "/slow") {
      // A challenge widget's polling: always one request in flight.
      setTimeout(() => res.end("ok"), 2_000);
    } else if (req.url === "/poll") {
      res.end(
        "<script>setInterval(() => fetch('/slow'), 400); fetch('/slow');</script>",
      );
    } else if (req.url === "/board") {
      res.end(
        '<title>Listing replica</title><a target="_blank" href="/apply">Apply on company website</a>',
      );
    } else res.end(fieldResultsForm);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing replica address");
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve())),
  );
}, 60_000);

async function withPage(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    await run(page);
  } finally {
    await page.close();
  }
}

test("an already-open lazy calling-code list stays open and scrolls to Kosovo", async () => {
  await withPage(async (page) => {
    await page.goto(`${origin}/apply`);
    const picker = page.getByRole("combobox");
    await picker.click();
    const result = await choosePageOption(page, picker, "Kosovo");
    expect(result).toMatchObject({
      ok: true,
      observedValue: "Kosovo",
      optionList: {
        open: false,
        busy: false,
      },
    });
    expect(result.optionList?.options).toContain("Kosovo");
    expect(await page.getByLabel("Phone").inputValue()).toBe("+383");
  });
}, 15_000);

test("a busy list returns its drawn options and open/busy facts without claiming absence", async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<button role="combobox" aria-expanded="true" aria-controls="list">Country</button><div id="list" role="listbox" aria-busy="true"><div role="option">Albania</div></div>',
    );
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      "Kosovo",
    );
    expect(result).toMatchObject({
      ok: false,
      optionList: {
        open: true,
        busy: true,
        complete: false,
        options: ["Albania"],
      },
    });
    expect(result).not.toHaveProperty("reason", "option_not_offered");
  });
}, 15_000);

test.each(["followLink", "fillText"] as const)(
  "%s returns stale immediately when the observed element was replaced",
  async (method) => {
    await withPage(async (page) => {
      await page.goto(`${origin}/board`);
      if (method === "fillText")
        await page.setContent('<label>Email<input type="email"></label>');
      const hands = createPlaywrightApplyPageMechanics(page);
      const before = await hands.readPage();
      const ref =
        method === "followLink"
          ? before.links[0]!.ref!
          : before.controls[0]!.ref!;
      await page
        .locator(method === "followLink" ? "a" : "input")
        .evaluate((node) => node.replaceWith(node.cloneNode(true)));
      const result =
        method === "followLink"
          ? await hands.followLink(ref)
          : await hands.fillText(ref, "test@example.test");
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatch(/stale|missing|observe again/i);
      if (method === "followLink")
        expect(await hands.navigate(`${origin}/apply`)).toMatchObject({
          ok: true,
        });
    });
  },
  5_000,
);

test("a checkbox reverted by the site reports its resulting unchecked state", async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<label>Terms<input type="checkbox" style="opacity:0" onclick="queueMicrotask(()=>this.checked=false)"></label>',
    );
    const hands = createPlaywrightApplyPageMechanics(page);
    const control = (await hands.readPage()).controls[0]!;
    const result = await hands.setToggle(control.ref!, true);
    expect(result).toMatchObject({
      ok: false,
      controlState: { checked: false },
    });
    if (!result.ok) expect(result.error).toMatch(/"Terms" stayed unchecked/u);
  });
});

test("a hidden radio is set at once, and one that will not change says so at once with its label", async () => {
  await withPage(async (page) => {
    // Workday draws its own radio and hides the input (R4 run 06: 180 s).
    await page.setContent(
      '<fieldset><label><input type="radio" name="heard" style="visibility:hidden"> LinkedIn Job Post</label>' +
        '<label><input type="radio" name="heard" style="visibility:hidden" onclick="return false"> LinkedIn InMail</label></fieldset>',
    );
    const hands = createPlaywrightApplyPageMechanics(page);
    const [post, inMail] = (await hands.readPage()).controls;
    const started = Date.now();
    expect(await hands.setToggle(post!.ref!, true)).toMatchObject({
      ok: true,
      observedValue: "checked",
    });
    const refused = await hands.setToggle(inMail!.ref!, true);
    expect(refused).toMatchObject({
      ok: false,
      controlState: { checked: false },
    });
    if (!refused.ok)
      expect(refused.error).toMatch(
        /"LinkedIn InMail" stayed unchecked .*hidden or covered/u,
      );
    expect(Date.now() - started).toBeLessThan(3_000);
  });
}, 10_000);

test.each([
  ["option button", '<button type="button" aria-pressed="false">Yes</button>'],
  ["checkbox", '<label>Terms<input type="checkbox"></label>'],
])(
  "a vanished %s returns stale at once instead of waiting for it",
  async (_kind, html) => {
    await withPage(async (page) => {
      // Built In redirected away from its form (R4 run 08: 30 s).
      await page.setContent(html);
      const hands = createPlaywrightApplyPageMechanics(page);
      const read = await hands.readPage();
      const ref = (read.actions[0] ?? read.controls[0])!.ref!;
      await page.setContent("<p>Moved on</p>");
      const started = Date.now();
      const result = await hands.setToggle(ref, true);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatch(/stale|missing|observe again/iu);
      expect(Date.now() - started).toBeLessThan(3_000);
    });
  },
  10_000,
);

test("another frame's endless polling does not keep a picker waiting", async () => {
  await withPage(async (page) => {
    // Lever's location field with an hCaptcha frame open (R4 run 09: 180 s).
    await page.goto(`${origin}/board`);
    await page.setContent(
      `<label>Current location<input id="location"></label><iframe src="${origin}/poll"></iframe>`,
    );
    await page.waitForTimeout(500);
    const started = Date.now();
    const result = await choosePageOption(
      page,
      page.getByLabel("Current location"),
      "Prishtina, Kosovo",
    );
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
}, 20_000);

test("a list without the wanted choice returns the choices it shows", async () => {
  await withPage(async (page) => {
    await page.setContent(
      '<button role="combobox" aria-expanded="false" aria-controls="list" onclick="this.setAttribute(\'aria-expanded\',\'true\');list.hidden=false">Country</button>' +
        '<div id="list" role="listbox" hidden><div role="option">Albania</div><div role="option">Kosovo</div></div>',
    );
    const started = Date.now();
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      "Prishtina",
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: ["Albania", "Kosovo"],
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
}, 10_000);

test.each(["prepare_only", "autonomous_submit"] as const)(
  "%s returns every batch entry before one fresh page and preserves Send counts",
  async (mode) => {
    await withPage(async (page) => {
      accepted = 0;
      await page.goto(`${origin}/board`);
      const raw = createPlaywrightApplyPageMechanics(page);
      const hands = createApplyPageHands(raw);
      const config: ApplyAgentConfig = {
        hands,
        authority: {
          mode,
          submitAuthorized: mode === "autonomous_submit",
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
            email: "test@example.test",
            yearsExperience: 3,
            baseResume: {
              id: "replica",
              fileName: "replica.txt",
              uploadedAt: "2026-11-01T00:00:00.000Z",
              textContent: "Synthetic test applicant",
              extractionStatus: "ready",
            },
          }),
          resumeText: null,
          posting: {
            title: "Engineer",
            company: "Replica",
            location: "Remote",
            description: "Replica role",
          },
          reusableAnswers: [],
          documents: [],
        },
        application: {
          jobId: "replica",
          applicationId: "replica",
          startingUrl: `${origin}/board`,
        },
        siteLabel: "Replica",
        intermediateWritesAuthorized: true,
        submitApplication: async ({ actionRef }) => {
          await raw.clickElement(actionRef);
          return { outcome: "submitted", content: "Application received" };
        },
      };
      let turn = 0;
      let batchResult = "";
      await runApplyAgent(config, {
        chatWithTools: async (messages) => {
          const seen = await hands.observe();
          const field = (label: string) =>
            seen.controls.find((control) => control.label === label)!.ref;
          const call = (name: string, args: object) => ({
            content: "",
            toolCalls: [
              {
                id: `replica-${turn}`,
                type: "function" as const,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
          switch (turn++) {
            case 0:
              return call("follow_link", { ref: seen.links[0]!.ref });
            case 1:
              return call("fill_fields", {
                fields: [
                  {
                    tool: "type",
                    ref: field("Email"),
                    text: "test@example.test",
                  },
                  { tool: "set_checkbox", ref: field("Terms"), checked: true },
                  {
                    tool: "click",
                    ref: seen.clickables.find((entry) => entry.label === "N/A")!
                      .ref,
                  },
                  { tool: "click", ref: field("Calling code") },
                  {
                    tool: "select",
                    ref: field("Calling code"),
                    option: "Kosovo",
                  },
                  {
                    tool: "type",
                    ref: field("Phone"),
                    text: "+383 44 000 000",
                  },
                ],
              });
            case 2:
              batchResult = String(
                messages.filter((message) => message.role === "tool").at(-1)
                  ?.content,
              );
              return mode === "autonomous_submit"
                ? call("submit_application", {
                    ref: seen.actions.find(
                      (entry) => entry.label === "Send application",
                    )!.ref,
                  })
                : call("finish", { reason: "Filled" });
            default:
              return call("finish", { reason: "Application received" });
          }
        },
      });
      const pageStart = batchResult.indexOf("\n\nPage:");
      expect(pageStart).toBeGreaterThan(0);
      expect(batchResult.slice(0, pageStart)).toContain("6. type");
      expect(batchResult.slice(0, pageStart)).toContain('"checked":true');
      expect(batchResult.slice(0, pageStart)).toContain("Option list:");
      expect(batchResult.match(/\n\nPage:/g)).toHaveLength(1);
      expect(accepted).toBe(mode === "autonomous_submit" ? 1 : 0);
    });
  },
  30_000,
);
