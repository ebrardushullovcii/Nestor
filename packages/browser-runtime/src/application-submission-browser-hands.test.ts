import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
  executeExactlyOneFinalAction,
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

test("a send returns observed page and request facts without deciding whether it arrived", async () => {
  const { page, server } = await createPage(
    `<form action='/submit-confirmed' method='post'><button>Apply</button></form>`,
  );
  const observation = await observeApplicationForm(page);
  const input = {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    veto: () => true,
    callId: "model_send_1",
  };
  const result = await executeExactlyOneFinalAction(page, input);
  expect(result.outcome).toBe("outcome_uncertain");
  expect(result.facts.requestsAfterClick).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        method: "POST",
        path: "/submit-confirmed",
        status: 200,
      }),
    ]),
  );
  if (result.outcome === "outcome_uncertain")
    expect(result.siteMessage).toContain("received your application");
  expect(server.acceptedSubmissions).toHaveLength(1);
  await executeExactlyOneFinalAction(page, input);
  expect(server.acceptedSubmissions).toHaveLength(1);
});
test("the browser never classifies an unfamiliar confirmation or English button label", async () => {
  const { page } = await createPage(
    `<button id='go'>Weiter</button><script>document.querySelector('button').onclick=()=>{document.body.innerHTML='<p>Your application has arrived. Thank you!</p>';};</script>`,
  );
  const observation = await observeApplicationForm(page, {
    finalActionTargets: [{ ref: "a0", label: "Weiter" }],
  });
  const result = await executeExactlyOneFinalAction(page, {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    veto: () => true,
    callId: "model_send_2",
  });
  expect(result.outcome).toBe("outcome_uncertain");
  if (result.outcome === "outcome_uncertain")
    expect(result.siteMessage).toContain(
      "Your application has arrived. Thank you!",
    );
});

test("Stop cancels a pending final click on its owned page so it cannot send later", async () => {
  const { page, server } = await createPage(
    "<form action='/submit-confirmed' method='post'><button>Apply</button></form>",
  );
  const observation = await observeApplicationForm(page);
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:999999;background:white";
    document.body.append(overlay);
  });
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = executeExactlyOneFinalAction(page, {
    expectedObservation: observation.identity,
    expectedControl: observation.controls[0]!.identity,
    expectedPageOrigin: expectedOrigin(page),
    allowedOrigins: [expectedOrigin(page)],
    veto: () => true,
    get callId() {
      timer = setTimeout(() => stop.abort(), 0);
      return "stopped_call";
    },
    signal: stop.signal,
  });
  try {
    await pending;
    expect(server.acceptedSubmissions).toHaveLength(0);
    expect(page.isClosed()).toBe(true);
  } finally {
    clearTimeout(timer);
  }
});
