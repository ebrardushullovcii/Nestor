import http from "node:http";
import { installPageMessageRecorderInPage } from "./page-messages";
import { ensurePrepareOnlyMutationGuard } from "./playwright-application-flow";
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
  recheckLastFinalAction,
  isSiteUnreachableError,
  observeApplicationForm,
} from "./application-submission-browser-hands";

interface FixtureServer {
  readonly baseUrl: string;
  readonly requests: string[];
  readonly acceptedSubmissions: string[];
  readonly close: () => Promise<void>;
}

let browser: Browser | null = null;
const activeContexts: BrowserContext[] = [];
const activeServers: FixtureServer[] = [];
const LARGE_SYNTHETIC_FINAL_ATTACHMENT = Buffer.from(
  "Synthetic final form test bytes only.\n".repeat(3_000),
);

function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = [];
  const acceptedSubmissions: string[] = [];
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(`${request.method ?? "GET"} ${requestUrl.pathname}`);
    if (requestUrl.pathname === "/api/apply" && request.method === "POST") {
      const mode = requestUrl.searchParams.get("mode") ?? "accepted";
      if (mode === "accepted") acceptedSubmissions.push(requestUrl.pathname);
      response.writeHead(mode === "pending" ? 202 : 200, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          mode === "refused"
            ? { ok: false, errors: ["Application rejected"], next: "/thanks" }
            : mode === "pending"
              ? { ok: true, status: "pending", next: "/thanks" }
              : { ok: true, next: "/thanks" },
        ),
      );
      return;
    }
    if (requestUrl.pathname === "/thanks") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Thanks for applying</h1><p>We'll be in touch.</p>");
      return;
    }
    if (
      ["/submit-json-refused", "/submit-pending"].includes(requestUrl.pathname)
    ) {
      response.writeHead(
        requestUrl.pathname === "/submit-pending" ? 202 : 200,
        { "content-type": "application/json" },
      );
      response.end(
        requestUrl.pathname === "/submit-pending"
          ? JSON.stringify({ status: "pending" })
          : JSON.stringify({ errors: [{ message: "Validation rejected" }] }),
      );
      return;
    }
    if (
      requestUrl.pathname === "/submit-no-cookies" &&
      request.method === "POST"
    ) {
      if (request.headers.cookie) {
        response.writeHead(403);
        response.end("Application not submitted: unexpected credentials.");
        return;
      }
      acceptedSubmissions.push(requestUrl.pathname);
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>We have received your application.</h1>");
      return;
    }
    if (
      requestUrl.pathname === "/submit-multipart" &&
      request.method === "POST"
    ) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        if (
          !body.includes(LARGE_SYNTHETIC_FINAL_ATTACHMENT) ||
          !body.includes(Buffer.from("Synthetic Example"))
        ) {
          response.writeHead(400);
          response.end(
            "Application not submitted: incomplete file or answers.",
          );
          return;
        }
        acceptedSubmissions.push(requestUrl.pathname);
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<h1>We have received your application.</h1>");
      });
      return;
    }
    if (
      ["/submit-redirect307", "/submit-redirect308"].includes(
        requestUrl.pathname,
      )
    ) {
      response.writeHead(requestUrl.pathname.endsWith("307") ? 307 : 308, {
        location: "/submit-lost",
      });
      response.end();
      return;
    }
    if (
      requestUrl.pathname === "/submit-late-response" &&
      request.method === "POST"
    ) {
      acceptedSubmissions.push(requestUrl.pathname);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<main>fixture submitted page</main>");
      }, 400);
      return;
    }
    if (requestUrl.pathname === "/submit-lost" && request.method === "POST") {
      request.resume();
      request.on("end", () => {
        acceptedSubmissions.push(requestUrl.pathname);
        request.socket.destroy();
      });
      return;
    }
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
    if (
      ["/submit-state", "/submit-state-received"].includes(requestUrl.pathname)
    ) {
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end("Application not submitted.");
        return;
      }
      acceptedSubmissions.push(requestUrl.pathname);
      response.writeHead(303, {
        location:
          requestUrl.pathname === "/submit-state-received"
            ? "/application/confirmation-received"
            : "/application/confirmation",
      });
      response.end();
      return;
    }
    if (requestUrl.pathname === "/application/confirmation") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>Your request is now in the queue.</h1>");
      return;
    }
    if (requestUrl.pathname === "/application/confirmation-received") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<h1>We have received your application.</h1>");
      return;
    }
    if (
      requestUrl.pathname === "/submit" ||
      requestUrl.pathname === "/apply" ||
      requestUrl.pathname === "/submit-confirmed"
    ) {
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end("Application not submitted.");
        return;
      }
      acceptedSubmissions.push(requestUrl.pathname);
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
        acceptedSubmissions,
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

  test("a JS-enhanced native form confirms its one POST to the exact action", async () => {
    const { page, server } =
      await createPage(`<form action='/submit-confirmed'><button type=submit>Send application</button></form><script>
      document.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        const response = await fetch(event.target.action, {method:'POST',body:'synthetic=yes'});
        document.body.innerHTML = await response.text();
      };
    </script>`);
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      confirmationTimeoutMs: 1000,
      veto: () => true,
    });
    expect(result.outcome).toBe("submitted");
    expect(result.facts.requestsAfterClick).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/submit-confirmed",
        status: 200,
        finalSubmit: true,
      }),
    ]);
    expect(
      server.requests.filter((request) => request === "POST /submit-confirmed"),
    ).toHaveLength(1);
    expect(server.acceptedSubmissions).toEqual(["/submit-confirmed"]);
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
      "<form method=post action='/submit-confirmed'><button id=send type=submit>Send application</button></form>",
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
    expect(server.acceptedSubmissions).toEqual(["/submit-confirmed"]);
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
      reason: "stale_control",
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

test.each([false, true])(
  "a final-form redirect still needs visible employer receipt: received=%s",
  async (received) => {
    const path = received ? "/submit-state-received" : "/submit-state";
    const { page, server } = await createPage(
      `<form method=post action='${path}'><button>Submit Application</button></form>`,
    );
    await ensurePrepareOnlyMutationGuard(page, false);
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
      received ? "submitted" : "outcome_uncertain",
    );
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === `POST ${path}`),
    ).toHaveLength(1);
    expect(server.acceptedSubmissions).toEqual([path]);
  },
);

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

test("an uncertain send keeps each request after the click: method, host, path, status and which one was the submit", async () => {
  // Workable's shape: the submit, the site's bot check beside it, and a
  // request that never got an answer; then no confirmation on the page.
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const body = JSON.stringify({
    operationName: "ApiSubmitSingleApplicationFormAction",
    query:
      "mutation ApiSubmitSingleApplicationFormAction { submitSingleApplicationFormAction { ok } }",
  });
  const { page } =
    await createPage(`<main><button id="send">Submit Application</button></main>
    <script>document.getElementById('send').onclick = async () => {
      await fetch('/api/graphql?status=200&token=fixture-secret', {method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(body)}});
      await fetch('/cdn-cgi/challenge-platform/h/g/jsd/oneshot/abc', {method:'POST',body:'fp'});
      await fetch('http://127.0.0.1:${closedPort}/events', {method:'POST',body:'x'}).catch(() => undefined);
    };</script>`);
  const observation = await observeApplicationForm(page, {
    finalActionTargets: [{ ref: "a0", label: "Submit Application" }],
  });
  const result = await executeExactlyOneFinalAction(page, {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    confirmationTimeoutMs: 800,
    veto: () => true,
  });
  expect(result.outcome).toBe("outcome_uncertain");
  const host = new URL(page.url()).host;
  expect(result.facts.requestsAfterClick).toEqual([
    {
      method: "POST",
      host,
      path: "/api/graphql",
      status: 200,
      failure: null,
      finalSubmit: true,
    },
    {
      method: "POST",
      host,
      path: "/cdn-cgi/challenge-platform/h/g/jsd/oneshot/abc",
      status: 200,
      failure: null,
      finalSubmit: false,
    },
    {
      method: "POST",
      host: `127.0.0.1:${closedPort}`,
      path: "/events",
      status: null,
      failure: "net::ERR_CONNECTION_REFUSED",
      finalSubmit: false,
    },
  ]);
  expect(result.facts.requestsObservedDuringAction).toBe(3);
  // The query string never reaches the record: it can carry answers.
  expect(JSON.stringify(result.facts)).not.toContain("fixture-secret");
});

test.each(["json refusal", "accepted pending", "field rejection"])(
  "a receipt-looking page cannot override the final operation's %s",
  async (shape) => {
    const submitPath =
      shape === "json refusal"
        ? "/submit-json-refused"
        : shape === "accepted pending"
          ? "/submit-pending"
          : "/submit";
    const { page, server } =
      await createPage(`<form action='${submitPath}'><label>Email<input id=email aria-describedby=error></label><p id=error role=alert></p><button>Send application</button></form>
      <script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();
        await fetch('${submitPath}',{method:'POST'});
        ${shape === "field rejection" ? "document.getElementById('error').textContent='Please enter a valid email.';" : ""}
        document.body.insertAdjacentHTML('beforeend','<h1>We have received your application.</h1>');
      };</script>`);
    const observation = await observeApplicationForm(page);
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      veto: () => true,
      confirmationTimeoutMs: 500,
    };
    const result = await executeExactlyOneFinalAction(page, input);
    expect(result.outcome).toBe("outcome_uncertain");
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === `POST ${submitPath}`)
        .length,
    ).toBeLessThanOrEqual(1);
  },
);

test.each(["accepted", "refused", "pending"])(
  "a JavaScript redirect retains its exact final JSON response judgment: %s",
  async (mode) => {
    const { page, server } =
      await createPage(`<form><button>Apply</button></form><script>
    document.querySelector('form').onsubmit=event=>{event.preventDefault();fetch('/api/apply?mode=${mode}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Synthetic Example'})})
      .then(response=>response.json()).then(data=>{location.href=data.next;});};
  </script>`);
    await ensurePrepareOnlyMutationGuard(page, false);
    const observation = await observeApplicationForm(page);
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      veto: () => true,
      confirmationTimeoutMs: 700,
    };
    const result = await executeExactlyOneFinalAction(page, input);
    expect(await page.locator("h1").innerText()).toBe("Thanks for applying");
    if (mode === "accepted")
      expect(["submitted", "outcome_uncertain"]).toContain(result.outcome);
    else expect(result.outcome).toBe("outcome_uncertain");
    expect(server.acceptedSubmissions).toEqual(
      mode === "accepted" ? ["/api/apply"] : [],
    );
    expect(
      server.requests.filter((request) => request === "POST /api/apply"),
    ).toHaveLength(1);
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === "POST /api/apply"),
    ).toHaveLength(1);
  },
);

test.each(["shadow receipt", "stale FAQ receipt"])(
  "reads fresh employer proof in a %s",
  async (shape) => {
    const prior =
      shape === "stale FAQ receipt"
        ? "<aside>FAQ: Thank you for applying is the receipt message.</aside>"
        : "";
    const receipt =
      shape === "shadow receipt"
        ? "const host=document.createElement('section'); document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<h1>We have received your application.</h1>';"
        : "document.body.insertAdjacentHTML('beforeend','<h1>We have received your application.</h1>');";
    const { page, server } =
      await createPage(`${prior}<form action='/submit'><button>Send application</button></form>
      <script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();await fetch('/submit',{method:'POST'});${receipt}};</script>`);
    const observation = await observeApplicationForm(page);
    const result = await executeExactlyOneFinalAction(page, {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      veto: () => true,
      confirmationTimeoutMs: 500,
    });
    expect(result.outcome).toBe("submitted");
    expect(
      server.requests.filter((request) => request === "POST /submit"),
    ).toHaveLength(1);
  },
);

test.each(["late receipt", "late response"])(
  "read-only recheck observes a %s without retrying",
  async (shape) => {
    const submitPath =
      shape === "late response" ? "/submit-late-response" : "/submit";
    const { page, server } =
      await createPage(`<form action='${submitPath}'><button>Send application</button></form><script>
    document.querySelector('form').onsubmit=async event=>{event.preventDefault();
      await fetch('${submitPath}',{method:'POST'});
      ${shape === "late receipt" ? "await new Promise(resolve=>setTimeout(resolve,400));" : ""}
      document.body.innerHTML='<h1>We have received your application.</h1>';
    };</script>`);
    const observation = await observeApplicationForm(page);
    const input = {
      expectedObservation: observation.identity,
      expectedControl: observation.controls[0]!.identity,
      expectedPageOrigin: expectedOrigin(page),
      allowedOrigins: [expectedOrigin(page)],
      veto: () => true,
      confirmationTimeoutMs: 100,
      pageBindingKey: "synthetic-application-one",
    };
    expect((await executeExactlyOneFinalAction(page, input)).outcome).toBe(
      "outcome_uncertain",
    );
    expect(
      await recheckLastFinalAction(page, {
        ...input,
        expectedObservation: { ...observation.identity, revision: 2 },
      }),
    ).toBeNull();
    await page.waitForTimeout(500);
    expect(
      await recheckLastFinalAction(page, {
        expectedObservation: input.expectedObservation,
        expectedControl: input.expectedControl,
      }),
    ).toBeNull();
    expect(
      await recheckLastFinalAction(page, {
        ...input,
        pageBindingKey: "synthetic-application-two",
      }),
    ).toBeNull();
    const rechecks = await Promise.all([
      recheckLastFinalAction(page, input),
      recheckLastFinalAction(page, input),
    ]);
    expect(rechecks.filter(Boolean)).toHaveLength(1);
    expect(rechecks.find(Boolean)).toMatchObject({
      outcome: "submitted",
      confirmation: {
        summary: "The site confirmed receipt of the application.",
      },
    });
    expect(await recheckLastFinalAction(page, input)).toBeNull();
    await executeExactlyOneFinalAction(page, input);
    expect(
      server.requests.filter((request) => request === `POST ${submitPath}`),
    ).toHaveLength(1);
    expect(server.acceptedSubmissions).toEqual([submitPath]);
  },
);

test("a hidden shadow receipt does not confirm an application", async () => {
  const { page } =
    await createPage(`<form action='/submit'><button>Send application</button></form><script>
    document.querySelector('form').onsubmit=async event=>{event.preventDefault();await fetch('/submit',{method:'POST'});
      const host=document.createElement('section');document.body.append(host);host.attachShadow({mode:'open'}).innerHTML='<h1 style="opacity:0">We have received your application.</h1>';
    };</script>`);
  const observation = await observeApplicationForm(page);
  const input = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    veto: () => true,
    confirmationTimeoutMs: 200,
  };
  expect((await executeExactlyOneFinalAction(page, input)).outcome).toBe(
    "outcome_uncertain",
  );
  expect(await recheckLastFinalAction(page, input)).toBeNull();
});

test.each(["query", "method", "target"])(
  "the private native action %s participates in preflight identity",
  async (shape) => {
    const { page, server } = await createPage(
      `<form action='/submit?job=synthetic-one' method=post><button>Send application</button></form>`,
    );
    const observation = await observeApplicationForm(page);
    await page.locator("form").evaluate((form, kind) => {
      if (kind === "query")
        form.setAttribute("action", "/submit?job=synthetic-two");
      if (kind === "method") form.setAttribute("method", "get");
      if (kind === "target") form.setAttribute("target", "_blank");
    }, shape);
    const changed = await observeApplicationForm(page);
    expect(changed.identity).not.toEqual(observation.identity);
    expect(JSON.stringify(observation)).not.toContain("synthetic-one");
    expect(
      (
        await executeExactlyOneFinalAction(page, {
          expectedObservation: observation.identity,
          expectedControl: observation.controls[0]!.identity,
          expectedPageOrigin: expectedOrigin(page),
          allowedOrigins: [expectedOrigin(page)],
          veto: () => true,
          confirmationTimeoutMs: 100,
        })
      ).outcome,
    ).toBe("not_submitted");
    expect(
      server.requests.filter((request) => request === "POST /submit"),
    ).toHaveLength(0);
  },
);

test.each([
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_CONNECTION_RESET",
  "net::ERR_TIMED_OUT",
])("%s does not prove a request never reached the employer", (error) => {
  expect(isSiteUnreachableError(error)).toBe(false);
});

test("a lost response keeps one click and a repeated call never issues another click", async () => {
  const { page, server } =
    await createPage(`<form action='/submit-lost' method=post><button>Send application</button></form><script>
    window.syntheticClicks=0;document.querySelector('form').onsubmit=async event=>{event.preventDefault();window.syntheticClicks++;
      await fetch('/submit-lost',{method:'POST',body:'synthetic-attempt=lost-response'}).catch(()=>undefined);
    };</script>`);
  await ensurePrepareOnlyMutationGuard(page, false);
  const observation = await observeApplicationForm(page);
  const input = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    veto: () => true,
    confirmationTimeoutMs: 700,
  };
  expect((await executeExactlyOneFinalAction(page, input)).outcome).toBe(
    "outcome_uncertain",
  );
  const delivered = [...server.acceptedSubmissions];
  expect(delivered.length).toBeGreaterThanOrEqual(1);
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>).syntheticClicks,
    ),
  ).toBe(1);
  await executeExactlyOneFinalAction(page, input);
  expect(server.acceptedSubmissions).toEqual(delivered);
});
