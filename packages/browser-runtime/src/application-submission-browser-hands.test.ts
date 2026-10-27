import http from "node:http";
import { installPageMessageRecorderInPage } from "./page-messages";
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
    if (requestUrl.pathname === "/api/graphql") {
      response.writeHead(
        Number(requestUrl.searchParams.get("status") ?? "200"),
        { "content-type": "application/json" },
      );
      response.end(
        JSON.stringify({ data: { submitApplicationFormAction: { ok: true } } }),
      );
      return;
    }
    if (requestUrl.pathname === "/submit-state") {
      response.writeHead(303, { location: "/application/confirmation" });
      response.end();
      return;
    }
    if (requestUrl.pathname === "/application/confirmation") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Your request is now in the queue.</h1>");
      return;
    }
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

  test("a page alert after the click is kept with the uncertain outcome, never read as sent or not sent", async () => {
    const { page } = await createPage(
      "<form onsubmit=\"event.preventDefault(); alert('Cannot contact reCAPTCHA. Check your connection and try again.')\"><button id=send type=submit>Send application</button></form>",
    );
    await page.evaluate(installPageMessageRecorderInPage);
    let windows = 0;
    page.on("dialog", (dialog) => {
      windows += 1;
      void dialog.dismiss();
    });
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1_000,
      veto: () => true,
    });
    expect(windows).toBe(0);
    expect(result).toMatchObject({
      outcome: "outcome_uncertain",
      reason: "confirmation_timeout",
      siteMessage:
        "Cannot contact reCAPTCHA. Check your connection and try again.",
    });
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
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
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
      server.requests.filter((request) =>
        request.includes("/submit-confirmed"),
      ),
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
      document.querySelector<HTMLFormElement>("form")!.onsubmit = async (
        event,
      ) => {
        event.preventDefault();
        document.body.innerHTML = await (
          await fetch("/submit-confirmed", { method: "POST" })
        ).text();
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
    <script>document.querySelector('form').onsubmit = async event => {event.preventDefault();
      await fetch('/submit-confirmed', {method:'POST'});
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

test.each([true, false])(
  "a policy-bound formless button issues one POST, confirmed=%s",
  async (confirmed) => {
    const path = confirmed ? "/submit-confirmed" : "/submit";
    const { page, server } = await createPage(`<main>
    <button>Upload file</button><button>Upload File</button><button>Yes</button><button>No</button><button aria-label="Open country list"></button>
    <input name="name" value="Robin Example"><input name="email" value="robin@example.test">
    <textarea name="motivation">The person's recorded answer.</textarea><textarea name="story">The person's recorded story.</textarea>
    <input name="country" value="Germany"><input name="github" value="https://github.com/robin-example"><input name="linkedin" value="https://linkedin.com/in/robin-example">
    <p>Resume attached: synthetic.pdf</p><button id="send" ${confirmed ? "" : 'type="button"'}>Submit Application</button>
    <script>document.querySelector('#send').onclick=async()=>{const r=await fetch('${path}',{method:'POST',body:JSON.stringify({answers:7,resume:'synthetic.pdf'})});${confirmed ? "document.body.innerHTML=await r.text();" : "await r.text();"}};</script>
  </main>`);
    expect((await observeApplicationForm(page)).controls).toHaveLength(0);
    const observation = await observeApplicationForm(page, {
      finalActionTargets: [{ ref: "a5", label: "Submit Application" }],
    });
    expect(observation.complete).toBe(true);
    expect(observation.controls).toHaveLength(1);
    expect(observation.controls[0]).toMatchObject({
      ordinal: 5,
      formIndex: -1,
      label: "Submit Application",
    });
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 200,
      veto: () => true,
    };
    const result = await executeExactlyOneFinalAction(page, input);
    expect(result.outcome).toBe(confirmed ? "submitted" : "outcome_uncertain");
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === `POST ${path}`),
    ).toHaveLength(1);
  },
);

test.each([
  "confirmed",
  "late final request",
  "autosave only",
  "failed final and successful analytics",
  "response only",
  "stale message",
])(
  "a JavaScript send needs its own successful final response and fresh page proof: %s",
  async (shape) => {
    const message =
      "Your application was successfully submitted. We appreciate your patience as your application is under review.";
    const field =
      shape === "autosave only"
        ? "setFormValue"
        : "submitSingleApplicationFormAction";
    const status =
      shape === "failed final and successful analytics" ? 500 : 200;
    const body = JSON.stringify({
      operationName: "ApiSubmitSingleApplicationFormAction",
      query: `mutation ApiSubmitSingleApplicationFormAction { ${field} { ok } }`,
    });
    const { page, server } =
      await createPage(`<main>${shape === "stale message" ? `<p>${message}</p>` : ""}<button id="send">Submit Application</button></main>
      <script>document.getElementById('send').onclick = async () => {
        ${shape === "late final request" ? "await new Promise(resolve => setTimeout(resolve, 150));" : ""}
        await fetch('/api/graphql?status=${status}', {method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(body)}});
        ${shape === "failed final and successful analytics" ? "await fetch('/events', {method:'POST'});" : ""}
        ${shape !== "response only" ? `document.body.textContent = ${JSON.stringify(message)};` : ""}
      };</script>`);
    const observation = await observeApplicationForm(page, {
      finalActionTargets: [{ ref: "a0", label: "Submit Application" }],
    });
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 600,
      veto: () => true,
    };
    const result = await executeExactlyOneFinalAction(page, input);
    expect(result.outcome).toBe(
      ["confirmed", "late final request"].includes(shape)
        ? "submitted"
        : "outcome_uncertain",
    );
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === "POST /api/graphql"),
    ).toHaveLength(1);
  },
);

test("the final form response can move to an explicit confirmation state without a phrase match", async () => {
  const { page, server } = await createPage(
    "<form method=post action='/submit-state'><button>Submit Application</button></form>",
  );
  const observation = await observeApplicationForm(page);
  const input = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    confirmationTimeoutMs: 1_000,
    veto: () => true,
  };
  expect((await executeExactlyOneFinalAction(page, input)).outcome).toBe(
    "submitted",
  );
  await executeExactlyOneFinalAction(page, input);
  expect(
    server.requests.filter((request) => request === "POST /submit-state"),
  ).toHaveLength(1);
});

test.each([true, false])(
  "a browser alert and a failed unrelated request do not decide submission: receipt=%s",
  async (received) => {
    const body = JSON.stringify({
      operationName: "SubmitApplication",
      query: "mutation SubmitApplication { submitApplication { ok } }",
    });
    const { page, server } =
      await createPage(`<button id='send'>Submit Application</button><script>
    document.getElementById('send').onclick = async () => {
      await fetch('/verification-unavailable', {method:'POST'}).catch(() => alert('Cannot contact the verification service.'));
      ${received ? `await fetch('/api/graphql', {method:'POST',body:${JSON.stringify(body)}}); document.body.textContent='Your application was successfully submitted';` : ""}
    };</script>`);
    await page.route("**/verification-unavailable", (route) =>
      route.abort("connectionrefused"),
    );
    const observation = await observeApplicationForm(page, {
      finalActionTargets: [{ ref: "a0", label: "Submit Application" }],
    });
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 700,
      veto: () => true,
    };
    expect((await executeExactlyOneFinalAction(page, input)).outcome).toBe(
      received ? "submitted" : "outcome_uncertain",
    );
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === "POST /api/graphql"),
    ).toHaveLength(received ? 1 : 0);
  },
);

test("a final response without a receipt cannot be retried because of later field feedback", async () => {
  const { page, server } =
    await createPage(`<form action='/submit'><label>Email<input id='email' value='robin@example.test'></label><button>Submit Application</button></form>
    <script>document.querySelector('form').onsubmit = async event => {
      event.preventDefault(); await fetch('/submit', {method:'POST'});
      document.getElementById('email').setCustomValidity('Please check this field.');
    };</script>`);
  const observation = await observeApplicationForm(page);
  const input = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    confirmationTimeoutMs: 500,
    veto: () => true,
  };
  expect((await executeExactlyOneFinalAction(page, input)).outcome).toBe(
    "outcome_uncertain",
  );
  await executeExactlyOneFinalAction(page, input);
  expect(
    server.requests.filter((request) => request === "POST /submit"),
  ).toHaveLength(1);
});

test.each(["two targets", "wrong label", "removed", "replaced after veto"])(
  "formless final controls fail closed: %s",
  async (shape) => {
    const { page, server } =
      await createPage(`<button id="one">Submit Application</button><button id="two">Send application</button>
    <script>document.querySelectorAll('button').forEach(b=>b.onclick=()=>fetch('/submit-confirmed',{method:'POST'}));</script>`);
    const targets =
      shape === "two targets"
        ? [
            { ref: "a0", label: "Submit Application" },
            { ref: "a1", label: "Send application" },
          ]
        : [
            {
              ref: "a0",
              label:
                shape === "wrong label"
                  ? "Different action"
                  : "Submit Application",
            },
          ];
    const observation = await observeApplicationForm(page, {
      finalActionTargets: targets,
    });
    if (shape === "removed")
      await page.locator("#one").evaluate((element) => element.remove());
    let calls = 0;
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]?.identity ?? {
        ref: "absent",
        signature: "a".repeat(64),
      },
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 100,
      veto: async () => {
        if (++calls === 2 && shape === "replaced after veto")
          await page.locator("#one").evaluate((element) => {
            element.textContent = "Different action";
          });
        return true;
      },
    });
    expect(result.outcome).toBe("not_submitted");
    expect(result.facts.actionIssued).toBe(false);
    expect(
      server.requests.filter((request) => request.startsWith("POST ")),
    ).toHaveLength(0);
  },
);
