import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
  type ExecuteExactlyOneFinalActionInput,
} from "./application-submission-browser-hands";

interface FixtureServer {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

let browser: Browser | null = null;
const activeContexts: BrowserContext[] = [];
const activeServers: FixtureServer[] = [];

function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${requestUrl.pathname}`);
    if (
      requestUrl.pathname === "/submit" ||
      requestUrl.pathname === "/submit-confirmed"
    ) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        requestUrl.pathname === "/submit-confirmed"
          ? "<main>Thank you for applying. We have received your application. Reference: SYN-42.</main>"
          : "<main>fixture submitted page</main>",
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<form id=application action='/submit?token=fixture-secret'><button id=send type=submit>Send application</button></form>",
    );
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      });
    });
  });
}

async function createPage(html: string): Promise<{
  page: Page;
  server: FixtureServer;
}> {
  if (!browser) {
    throw new Error("The fixture browser is not running.");
  }
  const server = await startFixtureServer();
  activeServers.push(server);
  const context = await browser.newContext();
  activeContexts.push(context);
  const page = await context.newPage();
  await page.goto(`${server.baseUrl}/form`);
  await page.setContent(html);
  return { page, server };
}

function expectedOrigin(page: Page): string {
  return new URL(page.url()).origin;
}

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterEach(async () => {
  while (activeContexts.length > 0) {
    await activeContexts
      .pop()
      ?.close()
      .catch(() => undefined);
  }
  while (activeServers.length > 0) {
    await activeServers
      .pop()
      ?.close()
      .catch(() => undefined);
  }
});

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  browser = null;
}, 120_000);

describe("source-generic application browser hands", () => {
  test("enumerates visible enabled final controls with deterministic identities", async () => {
    const { page } = await createPage(
      `<form action="/submit?token=fixture-secret">
         <button type="button">Not final</button>
         <button id="send" type="submit"> Send application </button>
         <button type="submit" disabled>Disabled</button>
         <input type="submit" value="Hidden" style="display:none">
       </form>`,
    );

    const first = await observeApplicationForm(page);
    const second = await observeApplicationForm(page);

    expect(first).toEqual(second);
    expect(first.controls).toHaveLength(1);
    expect(first.controls[0]).toMatchObject({
      kind: "button",
      label: "Send application",
      action: {
        origin: expectedOrigin(page),
        safePath: "/submit",
      },
      identity: {
        ref: "final-control-1",
      },
    });
    expect(first.identity.revision).toBe(1);
    expect(first.identity.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("blocks zero and multiple final controls without issuing an action", async () => {
    const zero = await createPage("<form><input name=email></form>");
    const zeroObservation = await observeApplicationForm(zero.page);
    const zeroResult = await executeExactlyOneFinalAction(zero.page, {
      expectedObservation: zeroObservation.identity,
      expectedControl: {
        ref: "final-control-0",
        signature: "a".repeat(64),
      },
      expectedPageOrigin: expectedOrigin(zero.page),
      allowedOrigins: [expectedOrigin(zero.page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });
    expect(zeroResult).toMatchObject({
      outcome: "not_submitted",
      reason: "no_final_control",
      facts: { actionIssued: false },
    });

    const multiple = await createPage(
      "<form><button type=submit>One</button><button type=submit>Two</button></form>",
    );
    const multipleObservation = await observeApplicationForm(multiple.page);
    const multipleResult = await executeExactlyOneFinalAction(multiple.page, {
      expectedObservation: multipleObservation.identity,
      expectedControl: multipleObservation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(multiple.page),
      allowedOrigins: [expectedOrigin(multiple.page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });
    expect(multipleResult).toMatchObject({
      outcome: "not_submitted",
      reason: "ambiguous_final_controls",
      facts: { actionIssued: false },
    });
  });

  test("rejects a rerendered observation before any click", async () => {
    const { page } = await createPage(
      "<form><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    await page.locator("#send").evaluate((element) => {
      element.textContent = "Send updated application";
    });

    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });
    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "stale_observation",
      facts: { actionIssued: false },
    });
  });

  test("requires an allowed stable origin and rejects origin drift", async () => {
    const { page } = await createPage(
      "<form><button type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: "https://other.example.com",
      allowedOrigins: ["https://other.example.com"],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });
    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "origin_drift",
      facts: { actionIssued: false },
    });
  });

  test("rejects a cross-origin formaction override without issuing a request", async () => {
    const { page, server } = await createPage(
      "<form action='/submit'><button type=submit formaction='https://other.example/submit'>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);

    expect(observation.controls[0]).toMatchObject({
      action: { origin: "https://other.example", safePath: "/submit" },
    });
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });

    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "origin_drift",
      facts: { actionAttempted: false, actionIssued: false },
    });
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toEqual([]);
  });

  test("runs a last-instant veto and never clicks when vetoed", async () => {
    const { page, server } = await createPage(
      "<form><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => false,
    });
    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "vetoed",
      facts: { actionIssued: false },
    });
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toEqual([]);
  });

  test("fails closed at runtime when an untyped caller omits the veto", async () => {
    const { page, server } = await createPage(
      "<form action='/submit'><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    const withoutVeto = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
    } as unknown as ExecuteExactlyOneFinalActionInput;
    const result = await executeExactlyOneFinalAction(page, withoutVeto);

    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "vetoed",
      facts: { actionIssued: false },
    });
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toEqual([]);
  });

  test("issues exactly one fixture click and reports uncertainty, never submission", async () => {
    const { page, server } = await createPage(
      "<form action='/submit?token=fixture-secret'><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });

    expect(result).toMatchObject({
      outcome: "outcome_uncertain",
      reason: "confirmation_timeout",
      facts: {
        actionIssued: true,
        actionCompleted: true,
      },
    });
    expect(result.outcome).not.toBe("submitted");
    await page.waitForTimeout(100);
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toHaveLength(1);
  });

  test("reports not sent when the site refused the connection and nothing answered", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const { page } = await createPage(
      `<form method=post action='http://127.0.0.1:${closedPort}/apply'><input name=a value=x><button id=send type=submit>Send application</button></form>`,
    );
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page), `http://127.0.0.1:${closedPort}`],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });

    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "site_unreachable",
      facts: { actionIssued: true },
    });
  });

  test("a click that never reached the page can be pressed again", async () => {
    const { page, server } = await createPage(
      "<form action='/submit'><button id=send type=submit>Send application</button></form><div id=cover style='position:fixed;inset:0;z-index:10'></div>",
    );
    const observation = await observeApplicationForm(page);
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
      clickTimeoutMs: 500,
    };
    expect(await executeExactlyOneFinalAction(page, input)).toMatchObject({
      outcome: "not_submitted",
      reason: "action_error",
      facts: { actionIssued: false },
    });

    await page.evaluate(() => document.getElementById("cover")?.remove());
    expect(await executeExactlyOneFinalAction(page, input)).toMatchObject({
      outcome: "outcome_uncertain",
      reason: "confirmation_timeout",
      facts: { actionIssued: true },
    });
    await page.waitForTimeout(100);
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toHaveLength(1);
  });

  test("counts the employer page's receipt confirmation as submitted", async () => {
    const { page, server } = await createPage(
      "<form action='/submit-confirmed'><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });

    expect(result).toMatchObject({
      outcome: "submitted",
      reason: "employer_confirmation",
      confirmation: {
        destination: { safePath: "/submit-confirmed" },
        summary: "The site confirmed receipt. Reference: SYN-42.",
      },
      facts: { actionIssued: true, actionCompleted: true },
    });
    expect(
      server.requests.filter((request) => request.includes("/submit-confirmed")),
    ).toHaveLength(1);
  });

  test("an overlay that prevents click dispatch leaves the form not submitted, not uncertain", async () => {
    const { page, server } = await createPage(
      "<form action='/submit'><button id=send type=submit>Send application</button><div id=overlay></div></form>",
    );
    await page.locator("#overlay").evaluate((element) => {
      element.setAttribute(
        "style",
        "position:fixed;inset:0;background:white;z-index:1000;",
      );
    });
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
      clickTimeoutMs: 50,
    });

    // Playwright never got past its clickability wait, so no click reached
    // the page: nothing was sent and the prepared form can be sent again.
    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "action_error",
      facts: {
        actionAttempted: true,
        actionIssued: false,
        actionCompleted: false,
      },
    });
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toEqual([]);
  });

  test("rechecks the effective formaction after the final veto", async () => {
    const { page, server } = await createPage(
      "<form action='/submit'><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    let vetoCalls = 0;
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: async () => {
        vetoCalls += 1;
        if (vetoCalls === 2) {
          await page.locator("#send").evaluate((element) => {
            element.setAttribute("formaction", "https://other.example/submit");
          });
        }
        return true;
      },
    });

    expect(vetoCalls).toBe(2);
    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "stale_observation",
      facts: { actionAttempted: false, actionIssued: false },
    });
    expect(
      server.requests.filter((request) => request.includes("/submit")),
    ).toEqual([]);
  });

  test("serializes concurrent attempts so a second call cannot reuse the same observation", async () => {
    const { page } = await createPage(
      "<form><button id=send type=submit>Send application</button></form>",
    );
    const observation = await observeApplicationForm(page);
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    } as const;
    const results = await Promise.all([
      executeExactlyOneFinalAction(page, input),
      executeExactlyOneFinalAction(page, input),
    ]);

    expect(
      results.filter((result) => result.outcome === "outcome_uncertain"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.outcome === "not_submitted"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.outcome === "not_submitted"),
    ).toMatchObject({
      reason: "stale_observation",
    });
  });
});

test.each([
  { error: "Select at least one skill.", label: "Skills" },
  { error: "Upload a nonempty TXT, PDF, DOC or DOCX file.", label: "Resume" },
])(
  "records explicit field rejection as not submitted: $label",
  async ({ error, label }) => {
    const { page, server } =
      await createPage(`<form novalidate action="/submit">
    <label>${label}<input name="answer" aria-describedby="field-error"></label>
    <span id="field-error" role="alert"></span><button type="submit">Send application</button></form>
    <script>document.querySelector('form').onsubmit = event => {
      event.preventDefault(); document.getElementById('field-error').textContent = ${JSON.stringify(error)};
    };</script>`);
    const observation = await observeApplicationForm(page);
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      veto: () => true,
    };
    const result = await executeExactlyOneFinalAction(page, input);
    expect(result).toMatchObject({
      outcome: "not_submitted",
      reason: "form_validation_failed",
      validationErrors: [error],
      facts: {
        actionAttempted: true,
        actionIssued: true,
        actionCompleted: true,
      },
    });
    expect(server.requests.some((request) => request.startsWith("POST"))).toBe(
      false,
    );
    // Fixing the field permits another deliberate attempt on the same form.
    await page.evaluate(() => {
      document.querySelector<HTMLFormElement>("form")!.onsubmit = (event) => {
        event.preventDefault();
        document.body.textContent = "We have received your application";
      };
      document.getElementById("field-error")!.textContent = "";
    });
    const corrected = await observeApplicationForm(page);
    expect(
      (
        await executeExactlyOneFinalAction(page, {
          ...input,
          expectedObservation: corrected.identity,
          expectedControl: corrected.controls[0]!.identity,
        })
      ).outcome,
    ).toBe("submitted");
  },
);

test("waits for a delayed receipt before calling a final send uncertain", async () => {
  const { page } =
    await createPage(`<form><button type="submit">Send application</button></form>
    <script>document.querySelector('form').onsubmit = event => {event.preventDefault();
      setTimeout(() => {document.body.textContent = 'We have received your application';}, 1_300);};</script>`);
  const observation = await observeApplicationForm(page);
  expect(
    (
      await executeExactlyOneFinalAction(page, {
        expectedObservation: observation.identity,
        expectedControl: observation.controls[0]!.identity,
        expectedPageOrigin: expectedOrigin(page),
        allowedOrigins: [expectedOrigin(page)],
        veto: () => true,
        confirmationTimeoutMs: 2_000,
      })
    ).outcome,
  ).toBe("submitted");
});
