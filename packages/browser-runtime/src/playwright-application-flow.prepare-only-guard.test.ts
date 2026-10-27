import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/attachment-upload.json";
import stepReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/workday-step-saves.json";
import finalMutationReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/intermediate-final-mutations.json";
import responseTypesReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/mutation-response-types.json";
import responseReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/mutation-response.json";
import realShapes from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/real-upload-shapes.json";
import ashbyBind from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/ashby-upload-bind.json";
import greenhouseS3 from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/greenhouse-s3-post.json";
import workableS3 from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/workable-s3-post.json";
import { inspectPageMutationResponse } from "./mutation-response-body";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ApplyBlockedAttempt } from "@nestor/contracts";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  allowPrepareOnlyRunNavigation,
  closePrepareOnlyIntermediateMutationWindow,
  createApplicationRunServiceWorkerSentinel,
  closePrepareOnlyFinalActionWindow,
  ensurePrepareOnlyMutationGuard,
  getLatestBlockedPrepareOnlyAttempt,
  openPrepareOnlyFinalActionWindow,
  openPrepareOnlyAttachmentUploadWindow,
  openPrepareOnlyIntermediateMutationWindow,
  readServiceWorkerRegisterGuardInPage,
  readPrepareOnlyIntermediateWriteCount,
  drainPrepareOnlyIntermediateWrites,
  registerPrepareOnlyPreparedValueInPage,
  registerPrepareOnlyPreparedValue,
} from "./playwright-application-flow";
import {
  armPlaywrightApplicationFormAction,
  createPlaywrightApplyPageSession,
  readRawApplyPage,
} from "./apply-page-mechanics";

// Transport proofs use the actual request permit recorded by the fence.

async function postPermittedFile(
  page: Page,
  url: string,
  transport: "fetch" | "xhr",
) {
  await ensurePrepareOnlyMutationGuard(
    page,
    false,
    [new URL(page.url()).origin],
    true,
  );
  const bytes = Buffer.from("%PDF-1.4 synthetic body replay");
  await openPrepareOnlyAttachmentUploadWindow(page, {
    name: "synthetic.pdf",
    mimeType: "application/pdf",
    bytes,
  });
  await page.evaluate(
    async ({ url, transport, bytes }) => {
      const body = new FormData();
      body.append("key", "uploads/synthetic.pdf");
      body.append(
        "file",
        new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
        "synthetic.pdf",
      );
      if (transport === "fetch")
        await (await fetch(url, { method: "POST", body })).text();
      else
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", url);
          xhr.onload = () => resolve();
          xhr.onerror = () => reject(new Error("XHR failed"));
          xhr.send(body);
        });
    },
    { url, transport, bytes: [...bytes] },
  );
}

interface FixtureHit {
  kind: "request" | "upgrade";
  method: string;
  path: string;
  query: string;
  body: string;
}

interface FixtureServer {
  port: number;
  baseUrl: string;
  hits: FixtureHit[];
  registerHtml: (path: string, html: string) => void;
  registerScript: (path: string, js: string) => void;
  registerAttachment: (path: string, content: string) => void;
  registerJson: (path: string, value: unknown) => void;
  registerResponse: (
    path: string,
    entry: { status: number; type: string; body: string },
  ) => void;
  close: () => Promise<void>;
}

function startFixtureServer(): Promise<FixtureServer> {
  const hits: FixtureHit[] = [];
  const htmlRoutes = new Map<string, string>();
  const scriptRoutes = new Map<string, string>();
  const attachmentRoutes = new Map<string, string>();
  const jsonRoutes = new Map<string, unknown>();
  const responseRoutes = new Map<
    string,
    { status: number; type: string; body: string }
  >();
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.push({
        kind: "request",
        method: request.method ?? "GET",
        path: url.pathname,
        query: url.search,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const custom = responseRoutes.get(url.pathname);
      if (custom) {
        response.writeHead(
          custom.status,
          custom.type ? { "content-type": custom.type } : {},
        );
        response.end(custom.body);
        return;
      }
      const html = htmlRoutes.get(url.pathname);
      if (jsonRoutes.has(url.pathname)) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(jsonRoutes.get(url.pathname)));
        return;
      }
      if (html !== undefined) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      const script = scriptRoutes.get(url.pathname);
      if (script !== undefined) {
        response.writeHead(200, { "content-type": "text/javascript" });
        response.end(script);
        return;
      }
      const attachment = attachmentRoutes.get(url.pathname);
      if (attachment !== undefined) {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="report.txt"',
        });
        response.end(attachment);
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("fixture-ok");
    });
  });
  server.on("upgrade", (request) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    hits.push({
      kind: "upgrade",
      method: "GET",
      path: url.pathname,
      query: url.search,
      body: "",
    });
    request.destroy();
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        hits,
        registerHtml: (path, html) => {
          htmlRoutes.set(path, html);
        },
        registerResponse: (path, entry) => {
          responseRoutes.set(path, entry);
        },
        registerJson: (path, value) => {
          jsonRoutes.set(path, value);
        },
        registerScript: (path, js) => {
          scriptRoutes.set(path, js);
        },
        registerAttachment: (path, content) => {
          attachmentRoutes.set(path, content);
        },
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

const activeServers: FixtureServer[] = [];
const activeContexts: BrowserContext[] = [];

async function startTrackedServer(): Promise<FixtureServer> {
  const server = await startFixtureServer();
  activeServers.push(server);
  return server;
}

let browser: Browser | null = null;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 120_000);

afterEach(async () => {
  while (activeContexts.length > 0) {
    const context = activeContexts.pop();
    await context?.close().catch(() => undefined);
  }
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    await server?.close().catch(() => undefined);
  }
});

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  browser = null;
}, 120_000);

async function newGuardedPage(): Promise<{
  page: Awaited<ReturnType<BrowserContext["newPage"]>>;
}> {
  if (!browser) {
    throw new Error("The fixture browser is not running.");
  }
  const context = await browser.newContext();
  activeContexts.push(context);
  const page = await context.newPage();
  // The guard must exist before the first document script runs so early
  // native captures are denied inside the page itself.
  await ensurePrepareOnlyMutationGuard(page, false);
  return { page };
}

const requestHitsFor = (
  hits: readonly FixtureHit[],
  path: string,
): FixtureHit[] =>
  hits.filter((hit) => hit.kind === "request" && hit.path === path);

describe("Prepare-only guard real-Chromium fixtures", () => {
  test("the site's own Cloudflare bot check goes out from page load, carrying no answer; nothing else under /cdn-cgi/ does", async () => {
    // Workable: the fence refused the site's /cdn-cgi/challenge-platform/
    // beacon on every load, and its Submit then waited on Turnstile for good.
    const site = await startTrackedServer(),
      other = await startTrackedServer();
    site.registerHtml(
      "/bot-check",
      `<label>Name <input id="name"></label><output id="done"></output><script>
      window.post = async (url, body) => {
        try { await fetch(url, { method: "POST", body }); return "sent"; } catch { return "refused"; }
      };</script>`,
    );
    const { page } = await newGuardedPage();
    await page.goto(`${site.baseUrl}/bot-check`);
    await page.fill("#name", realShapes.firstName);
    await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
    const post = (url: string, body: string) =>
      page.evaluate(
        ({ url, body }) =>
          (
            window as unknown as {
              post: (u: string, b: string) => Promise<string>;
            }
          ).post(url, body),
        { url, body },
      );
    expect(
      await post(
        "/cdn-cgi/challenge-platform/h/b/jsd/oneshot/abc",
        "fingerprint-abc",
      ),
    ).toBe("sent");
    expect(await post("/cdn-cgi/rum", "fingerprint-abc")).toBe("refused");
    expect(
      await post(
        "/cdn-cgi/challenge-platform/h/b/jsd/oneshot/abc",
        `fingerprint ${realShapes.firstName}`,
      ),
    ).toBe("refused");
    expect(
      await post(
        `${other.baseUrl}/cdn-cgi/challenge-platform/h/b/jsd/oneshot/abc`,
        "fingerprint-abc",
      ),
    ).toBe("refused");
    expect(
      requestHitsFor(
        site.hits,
        "/cdn-cgi/challenge-platform/h/b/jsd/oneshot/abc",
      ),
    ).toHaveLength(1);
    expect(requestHitsFor(site.hits, "/cdn-cgi/rum")).toHaveLength(0);
    expect(other.hits.filter((hit) => hit.kind === "request")).toHaveLength(0);
  });

  test.each([false, true])(
    "the bot check also goes out from the blank frame Cloudflare runs it in (field saves allowed: %s)",
    async (saves) => {
      // Cloudflare's script sends its beacon from a hidden about:blank frame
      // it adds to the page: that frame runs as the page, on its origin.
      const site = await startTrackedServer();
      site.registerHtml(
        "/blank-frame-check",
        `<label>Name <input id="name"></label><script>
        window.postFromBlank = async (url, body) => {
          const frame = document.createElement("iframe");
          frame.style.display = "none";
          document.body.appendChild(frame);
          try { await frame.contentWindow.fetch(url, { method: "POST", body }); return "sent"; } catch { return "refused"; }
        };</script>`,
      );
      if (!browser) throw new Error("The fixture browser is not running.");
      const context = await browser.newContext();
      activeContexts.push(context);
      const page = await context.newPage();
      await ensurePrepareOnlyMutationGuard(page, saves);
      await page.goto(`${site.baseUrl}/blank-frame-check`);
      await page.fill("#name", realShapes.firstName);
      await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
      const post = (url: string, body: string) =>
        page.evaluate(
          ({ url, body }) =>
            (
              window as unknown as {
                postFromBlank: (u: string, b: string) => Promise<string>;
              }
            ).postFromBlank(url, body),
          { url, body },
        );
      expect(
        await post("/cdn-cgi/challenge-platform/h/g/jsd/oneshot/abc", "fp-abc"),
      ).toBe("sent");
      // The frame gets nothing the page itself would not: no answer, no
      // other path. The site receives neither (below), whichever layer
      // refuses them: a frame made after the answers were registered may
      // only meet the network fence.
      await post(
        "/cdn-cgi/challenge-platform/h/g/jsd/oneshot/abc",
        `fp ${realShapes.firstName}`,
      );
      await post("/cdn-cgi/profile", "fp-abc");
      expect(
        requestHitsFor(
          site.hits,
          "/cdn-cgi/challenge-platform/h/g/jsd/oneshot/abc",
        ),
      ).toHaveLength(1);
      expect(requestHitsFor(site.hits, "/cdn-cgi/profile")).toHaveLength(0);
    },
  );

  test.each([false, true])(
    "a native GET submission carrying answers that nothing authorized is refused (field saves allowed: %s)",
    async (saves) => {
      // Sol's reproduction: a completed form in a shadow root, whose GET put
      // name, email and phone in the address, with no blocked attempt.
      const site = await startTrackedServer();
      site.registerHtml(
        "/shadow-form",
        `<role-form></role-form><script>customElements.define("role-form", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<form action="/shadow-form/sent"><label>Name <input id="name" name="name"></label><button type="submit">Apply</button></form>'; } });</script>`,
      );
      site.registerHtml("/shadow-form/sent", "<h1>Thanks</h1>");
      if (!browser) throw new Error("The fixture browser is not running.");
      const context = await browser.newContext();
      activeContexts.push(context);
      const page = await context.newPage();
      await ensurePrepareOnlyMutationGuard(page, saves);
      await page.goto(`${site.baseUrl}/shadow-form`);
      await page.fill("#name", realShapes.firstName);
      await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
      await page.click("button");
      await page.waitForTimeout(500);
      expect(requestHitsFor(site.hits, "/shadow-form/sent")).toHaveLength(0);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toMatchObject({
        kind: "network_request",
        method: "GET",
      });
      // The person's own window lets it through. (The refused navigation
      // left an error page: open the form again.)
      allowPrepareOnlyRunNavigation(page, `${site.baseUrl}/shadow-form`);
      await page.goto(`${site.baseUrl}/shadow-form`);
      await page.fill("#name", realShapes.firstName);
      await openPrepareOnlyFinalActionWindow(page, 10_000);
      await page.click("button");
      await page.waitForURL(/\/shadow-form\/sent/u);
      expect(requestHitsFor(site.hits, "/shadow-form/sent")).toHaveLength(1);
    },
  );

  test("a send pressed in the person's window is recorded, even when the page holds its request back", async () => {
    // Workable's Submit waits on a check of its own before any request
    // leaves; the page stays on "Submitting…".
    const site = await startTrackedServer();
    site.registerHtml(
      "/hold",
      `<form id="apply"><label>Name <input id="name" name="name"></label><button type="submit">Submit application</button></form><script>
      document.getElementById('apply').addEventListener('submit', (event) => { event.preventDefault(); event.target.querySelector('button').textContent = 'Submitting…'; });</script>`,
    );
    const { page } = await newGuardedPage();
    await page.goto(`${site.baseUrl}/hold`);
    await page.fill("#name", realShapes.firstName);
    await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
    // Before the person has the page, the press is blocked, not a send.
    await page.click("button");
    expect((await readRawApplyPage(page)).sendPressedAt).toBeUndefined();
    await openPrepareOnlyFinalActionWindow(page, 60_000);
    const before = Date.now();
    await page.click("button");
    const pressed = (await readRawApplyPage(page)).sendPressedAt;
    expect(pressed).toBeDefined();
    expect(Date.parse(pressed!)).toBeGreaterThanOrEqual(before - 1_000);
  });

  test("Fill: Greenhouse's real storage POST (encryption, 201, utf8 and token in the policy) gets through with its receipt", async () => {
    const site = await startTrackedServer(),
      storage = await startTrackedServer();
    const policy = Buffer.from(JSON.stringify(greenhouseS3.policy)).toString(
      "base64",
    );
    site.registerJson("/uncacheable_attributes/presigned_fields", {
      url: storage.baseUrl + "/storage",
      resume: {
        key: greenhouseS3.keyTemplate,
        fields: { ...greenhouseS3.fields, policy },
      },
    });
    storage.registerResponse("/storage", {
      status: 201,
      type: "application/xml",
      body: greenhouseS3.receipt.replace("STORAGE", storage.baseUrl),
    });
    site.registerHtml(
      "/greenhouse",
      `<label>First Name<input id="first"></label><label for="resume">Attach</label><input id="resume" type="file"><output id="result"></output><script>
      document.getElementById('resume').addEventListener('change', async function () {
        const file = this.files[0];
        const signed = await (await fetch('/uncacheable_attributes/presigned_fields?fields[]=resume')).json();
        const body = new FormData();
        body.append('utf8', '✓');
        for (const key in signed.resume.fields) body.append(key, signed.resume.fields[key]);
        body.append('key', signed.resume.key.replace('{timestamp}', String(Date.now())).replace('{unique_id}', 'abc123'));
        body.append('authenticity_token', '1234');
        body.append('Content-Type', 'application/octet-stream');
        body.append('file', file);
        this.value = '';
        const status = await new Promise((resolve) => { const xhr = new XMLHttpRequest(); xhr.open('POST', signed.url); xhr.onloadend = () => resolve(xhr.status); xhr.send(body); });
        document.getElementById('result').textContent = String(status);
      });</script>`,
    );
    const { page } = await newGuardedPage();
    await page.goto(`${site.baseUrl}/greenhouse`);
    const session = createPlaywrightApplyPageSession({ page });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: false,
      attachmentUploadsAuthorized: true,
      allowedOrigins: [],
    });
    await page.fill("#first", realShapes.firstName);
    await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
    const resume = (await session.readPage()).controls.find(
      (field) => field.inputType === "file",
    )!;
    const response = page
      .waitForResponse(`${storage.baseUrl}/storage`)
      .catch(() => null);
    await session.uploadFile(resume.ref ?? `c${resume.index}`, {
      name: realShapes.fileName,
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4 synthetic upload bytes"),
    });
    await page.waitForFunction(
      () => !!document.getElementById("result")?.textContent,
    );
    expect(await page.locator("#result").textContent()).toBe("201");
    expect(requestHitsFor(storage.hits, "/storage")).toHaveLength(1);
    const observed = await response;
    if (!observed) throw Error("No upload response");
    expect(await inspectPageMutationResponse(page, observed)).toMatchObject({
      accepted: true,
    });
  });

  test("Fill: Workable's storage POST (an empty utf8 field, the file's type) gets through", async () => {
    const site = await startTrackedServer(),
      storage = await startTrackedServer();
    const Policy = Buffer.from(JSON.stringify(workableS3.policy)).toString(
      "base64",
    );
    // Workable's presign is a GET on the form's own site.
    site.registerJson("/api/v1/jobs/REPLICA1/form/upload/resume", {
      uploadPostUrl: {
        url: storage.baseUrl + "/",
        fields: { ...workableS3.fields, Policy },
        path: workableS3.fields.key,
      },
    });
    storage.registerResponse("/", {
      status: 204,
      type: "text/plain",
      body: "",
    });
    site.registerHtml(
      "/workable",
      `<label>First name<input id="first"></label><label for="resume">Resume</label><input id="resume" type="file"><output id="result"></output><script>
      document.getElementById('resume').addEventListener('change', async function () {
        const file = this.files[0];
        const signed = (await (await fetch('/api/v1/jobs/REPLICA1/form/upload/resume')).json()).uploadPostUrl;
        const body = new FormData();
        body.append('Content-Type', file.type);
        Object.keys(signed.fields).forEach((key) => body.append(key, signed.fields[key]));
        body.append('file', file);
        const status = await new Promise((resolve) => { const xhr = new XMLHttpRequest(); xhr.open('POST', signed.url); xhr.onloadend = () => resolve(xhr.status); xhr.send(body); });
        document.getElementById('result').textContent = String(status);
      });</script>`,
    );
    const { page } = await newGuardedPage();
    await page.goto(`${site.baseUrl}/workable`);
    const session = createPlaywrightApplyPageSession({ page });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: false,
      attachmentUploadsAuthorized: true,
      allowedOrigins: [],
    });
    await page.fill("#first", realShapes.firstName);
    await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
    const resume = (await session.readPage()).controls.find(
      (field) => field.inputType === "file",
    )!;
    await session.uploadFile(resume.ref ?? `c${resume.index}`, {
      name: realShapes.fileName,
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4 synthetic upload bytes"),
    });
    await page.waitForFunction(
      () => !!document.getElementById("result")?.textContent,
    );
    expect(await page.locator("#result").textContent()).toBe("204");
    expect(requestHitsFor(storage.hits, "/")).toHaveLength(1);
  });

  test("Fill: Ashby's upload binds the stored file to the form once, and no answer leaves", async () => {
    const site = await startTrackedServer(),
      storage = await startTrackedServer();
    const key = realShapes.keyPrefix + realShapes.fileName;
    const policy = Buffer.from(
      JSON.stringify({
        ...replay.policy,
        conditions: [...replay.policy.conditions, { key }],
      }),
    ).toString("base64");
    site.registerJson("/api/non-user-graphql", {
      data: {
        fileUploadHandle: {
          handle: ashbyBind.handle,
          url: storage.baseUrl + "/storage",
          fields: { ...replay.fields, key, Policy: policy },
        },
      },
    });
    storage.registerJson("/storage", { uploaded: true });
    site.registerHtml(
      "/ashby",
      `<label>Name<input id="name"></label><label>Resume<input id="resume" type="file"></label><output id="result"></output><script>
      const bind = ${JSON.stringify(ashbyBind)};
      const shapes = ${JSON.stringify({ presignQuery: realShapes.presignQuery })};
      const graphql = (operationName, variables, query) =>
        fetch('/api/non-user-graphql', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationName, variables, query }) }).then((r) => r.ok, () => false);
      const ids = { organizationHostedJobsPageName: 'synthetic', formRenderIdentifier: bind.formRenderIdentifier, formDefinitionIdentifier: bind.formDefinitionIdentifier };
      document.getElementById('resume').addEventListener('change', async function () {
        const file = this.files[0];
        const signed = (await (await fetch('/api/non-user-graphql', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationName: 'ApiCreateFileUploadHandle', variables: { organizationHostedJobsPageName: 'synthetic', fileUploadContext: 'NonUserFormEngine', filename: file.name, contentType: file.type, contentLength: file.size }, query: shapes.presignQuery }) })).json()).data.fileUploadHandle;
        const body = new FormData();
        body.append('Content-Type', file.type);
        for (const [key, value] of Object.entries(signed.fields)) body.append(key, value);
        body.append('file', file);
        const stored = await fetch(signed.url, { method: 'POST', body }).then((r) => r.ok, () => false);
        const name = document.getElementById('name').value;
        const result = {
          stored,
          smuggled: await graphql('ApiSetFormValueToFile', { ...ids, path: name, fileHandle: signed.handle }, bind.bindQuery),
          bound: await graphql('ApiSetFormValueToFile', { ...ids, path: bind.path, fileHandle: signed.handle }, bind.bindQuery),
          again: await graphql('ApiSetFormValueToFile', { ...ids, path: bind.path, fileHandle: signed.handle }, bind.bindQuery),
          saved: await graphql('ApiSetFormValue', { ...ids, path: '_systemfield_name', value: name }, bind.saveQuery),
        };
        document.getElementById('result').textContent = JSON.stringify(result);
      });</script>`,
    );
    const { page } = await newGuardedPage();
    await page.goto(`${site.baseUrl}/ashby`);
    const session = createPlaywrightApplyPageSession({ page });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: false,
      attachmentUploadsAuthorized: true,
      allowedOrigins: [],
    });
    await page.fill("#name", realShapes.name);
    await registerPrepareOnlyPreparedValue(page, realShapes.name);
    const resume = (await session.readPage()).controls.find(
      (field) => field.inputType === "file",
    )!;
    await session.uploadFile(resume.ref ?? `c${resume.index}`, {
      name: realShapes.fileName,
      mimeType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.4 synthetic upload bytes"),
    });
    await page.waitForFunction(
      () => !!document.getElementById("result")?.textContent,
    );
    expect(
      JSON.parse((await page.locator("#result").textContent()) ?? "{}"),
    ).toEqual({
      stored: true,
      smuggled: false,
      bound: true,
      again: false,
      saved: false,
    });
    expect(requestHitsFor(storage.hits, "/storage")).toHaveLength(1);
    const graphqlBodies = requestHitsFor(site.hits, "/api/non-user-graphql")
      .filter((hit) => hit.method === "POST")
      .map((hit) => JSON.parse(hit.body) as { operationName: string });
    expect(graphqlBodies.map((body) => body.operationName)).toEqual([
      "ApiCreateFileUploadHandle",
      "ApiSetFormValueToFile",
    ]);
    expect(JSON.stringify(graphqlBodies)).not.toContain(realShapes.name);
  });

  test.each(["ashby", "greenhouse"] as const)(
    "scrubbed real %s request shape uploads after Name is filled",
    async (shape) => {
      const site = await startTrackedServer(),
        storage = await startTrackedServer();
      const key = realShapes.keyPrefix + realShapes.fileName;
      const policy = Buffer.from(
        JSON.stringify({
          ...replay.policy,
          conditions: [...replay.policy.conditions, { key }],
        }),
      ).toString("base64");
      const fields = { ...replay.fields, key, Policy: policy };
      site.registerJson("/api/non-user-graphql", {
        data: {
          fileUploadHandle: { url: storage.baseUrl + "/storage", fields },
        },
      });
      site.registerJson("/uncacheable_attributes/presigned_fields", {
        url: storage.baseUrl + "/storage",
        resume: { key: "uploads/{timestamp}/{unique_id}/${filename}", fields },
      });
      storage.registerJson("/storage", {
        uploaded: true,
        uploadId: "synthetic-upload-1",
      });
      site.registerHtml(
        "/real-shape",
        `<label>Name<input id="name"></label><label>Resume<input id="resume" type="file"></label><output id="result"></output><script>
      document.getElementById('resume').addEventListener('change',async function(){
        const file=this.files[0];
        try{
          const shape=${JSON.stringify(shape)};
          const signed=shape==='ashby'? (await(await fetch('/api/non-user-graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'ApiCreateFileUploadHandle',variables:{organizationHostedJobsPageName:'synthetic',fileUploadContext:'NonUserFormEngine',filename:file.name,contentType:file.type,contentLength:file.size},query:${JSON.stringify(realShapes.presignQuery)}})})).json()).data.fileUploadHandle : await(await fetch('/uncacheable_attributes/presigned_fields?fields[]=resume')).json();
          const body=new FormData();
          if(shape==='greenhouse'){body.append('utf8','✓');body.append('authenticity_token','1234');body.append('Content-Type','application/octet-stream');}
          for(const [key,value]of Object.entries(shape==='ashby'?signed.fields:signed.resume.fields)) if(shape==='ashby'||key!=='Content-Type')body.append(key,value);
          if(shape==='greenhouse') body.set('key',signed.resume.key.replace('{timestamp}',String(Date.now())).replace('{unique_id}','abc123'));
          body.append('file',file);
          if(shape==='greenhouse')this.value='';
          const status=shape==='ashby'?(await fetch(signed.url,{method:'POST',body})).status:await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',signed.url);xhr.onload=()=>resolve(xhr.status);xhr.onerror=reject;xhr.send(body);});
          document.getElementById('result').textContent=status===200?'uploaded':'refused';
        }catch(error){document.getElementById('result').textContent='failed '+String(error);}
      });</script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${site.baseUrl}/real-shape`);
      const session = createPlaywrightApplyPageSession({ page });
      // Fill in for me: no save authority, so only the upload may leave.
      await session.installPrepareOnlyGuard({
        intermediateMutationsAuthorized: false,
        attachmentUploadsAuthorized: true,
        allowedOrigins: [],
      });
      await page.fill("#name", realShapes.name);
      await registerPrepareOnlyPreparedValue(page, realShapes.name);
      await registerPrepareOnlyPreparedValue(page, realShapes.firstName);
      await registerPrepareOnlyPreparedValue(page, realShapes.lastName);
      const file = {
        name: realShapes.fileName,
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.4 synthetic upload bytes"),
      };
      const resume = (await session.readPage()).controls.find(
        (field) => field.inputType === "file",
      )!;
      const response = page
        .waitForResponse(`${storage.baseUrl}/storage`)
        .catch(() => null);
      await session.uploadFile(resume.ref ?? `c${resume.index}`, file);
      await page.waitForFunction(
        () => !!document.getElementById("result")?.textContent,
      );
      expect(
        await page.locator("#result").textContent(),
        JSON.stringify({
          blocked: await getLatestBlockedPrepareOnlyAttempt(page),
          site: site.hits.map((hit) => hit.path),
          storage: storage.hits.map((hit) => hit.path),
        }),
      ).toBe("uploaded");
      expect(requestHitsFor(storage.hits, "/storage")).toHaveLength(1);
      const observed = await response;
      if (!observed) throw Error("No upload response");
      Object.assign(observed, { text: () => new Promise<string>(() => {}) });
      expect(await inspectPageMutationResponse(page, observed)).toMatchObject({
        accepted: true,
        body: { uploaded: true },
      });
      await drainPrepareOnlyIntermediateWrites(page);
      expect(readPrepareOnlyIntermediateWriteCount(page)).toBe(0);
      for (const path of realShapes.refusedPaths) {
        await openPrepareOnlyAttachmentUploadWindow(page, file);
        const forwarded = await page.evaluate(
          async ({ url, name, bytes, fields }) => {
            try {
              const body = new FormData();
              for (const [key, value] of Object.entries(fields))
                body.append(key, value);
              body.append(
                "file",
                new File([new Uint8Array(bytes)], name, {
                  type: "application/pdf",
                }),
              );
              await fetch(url, { method: "POST", body });
              return true;
            } catch {
              return false;
            }
          },
          {
            url: storage.baseUrl + path,
            name: file.name,
            bytes: [...file.bytes],
            fields,
          },
        );
        expect(forwarded).toBe(false);
        expect(requestHitsFor(storage.hits, path)).toHaveLength(0);
      }
    },
  );

  test.each(
    ["fetch", "xhr"].flatMap((transport) =>
      ["form", "blob", "file"].map((body) => ({ transport, body })),
    ),
  )(
    "embedded upload response replay: $transport $body",
    async ({ transport, body }) => {
      const site = await startTrackedServer(),
        storage = await startTrackedServer();
      site.registerHtml("/body-upload", "<p>Upload</p>");
      const { page } = await newGuardedPage();
      await page.goto(`${site.baseUrl}/body-upload`);
      await ensurePrepareOnlyMutationGuard(page, false, [site.baseUrl], true);
      const file = {
        name: realShapes.fileName,
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.4 synthetic body replay"),
      };
      const cases = [
        ...responseReplay.refused.map((body) => ({
          body,
          accepted: false,
          plain: false,
        })),
        ...responseReplay.accepted.map((body) => ({
          body,
          accepted: true,
          plain: false,
        })),
        ...responseReplay.plainText.map((entry) => ({
          body: entry.text,
          accepted: entry.accepted,
          plain: true,
        })),
      ];
      for (const [index, entry] of cases.entries()) {
        const pathname = `/upload-body-${index}`,
          url = storage.baseUrl + pathname;
        if (entry.plain && typeof entry.body === "string")
          storage.registerAttachment(pathname, entry.body);
        else storage.registerJson(pathname, entry.body);
        await openPrepareOnlyAttachmentUploadWindow(page, file);
        const response = page.waitForResponse(url);
        await page.evaluate(
          async ({ url, transport, body, name, bytes }) => {
            const blob = new Blob([new Uint8Array(bytes)], {
              type: "application/pdf",
            });
            let payload: Blob | FormData =
              body === "file"
                ? new File([blob], name, { type: "application/pdf" })
                : blob;
            if (body === "form") {
              const form = new FormData();
              form.append("key", "uploads/" + name);
              form.append("file", blob, name);
              payload = form;
            }
            if (transport === "fetch")
              await (
                await fetch(url, { method: "POST", body: payload })
              ).text();
            else
              await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", url);
                xhr.onload = () => resolve();
                xhr.onerror = () => reject(new Error("XHR failed"));
                xhr.send(payload);
              });
          },
          { url, transport, body, name: file.name, bytes: [...file.bytes] },
        );
        const observed = await response;
        Object.assign(observed, { text: () => new Promise<string>(() => {}) });
        expect(await inspectPageMutationResponse(page, observed)).toMatchObject(
          {
            body: entry.body,
            accepted: entry.accepted,
          },
        );
      }
    },
  );
  test(
    "a retained human sign-in accepts native click, Enter, and requestSubmit once each while unrelated forms stay blocked",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/human-login",
        `<iframe name="result"></iframe>
         <form id="login" action="/session" method="post" target="result">
           <input id="email" name="email" type="email" required>
           <input id="password" name="password" type="password" required>
           <button id="signin">Sign in</button>
         </form>
         <form id="account" action="/create-account" method="post" target="result">
           <button id="create">Create account</button>
         </form>
         <form id="application" action="/submit-application" method="post" target="result">
           <button id="apply">Apply</button>
         </form>`,
      );
      const { page } = await newGuardedPage();
      const session = createPlaywrightApplyPageSession({ page });
      for (const method of ["click", "enter", "requestSubmit"] as const) {
        await page.goto(`${app.baseUrl}/human-login`);
        const action = (await session.readPage()).actions.find(
          (candidate) => candidate.label === "Sign in",
        );
        const ref = action?.ref ?? (action ? `a${action.index}` : null);
        expect(ref).toBeTruthy();
        await expect(
          armPlaywrightApplicationFormAction(page, "a999"),
        ).rejects.toThrow(/exact form action/i);
        await armPlaywrightApplicationFormAction(page, ref!);
        expect(
          await page.evaluate(() => {
            const state = (window as unknown as Record<string, unknown>)[
              "__nestorPrepareOnlyMutationGuardV1"
            ] as { authorizedFormActionWindow: { expiresAtMs: number } };
            return state.authorizedFormActionWindow.expiresAtMs;
          }),
        ).toBe(Number.MAX_SAFE_INTEGER);
        await page.click("#create");
        await page.click("#apply");
        await page.fill("#email", "fixture@example.test");
        await page.fill("#password", "synthetic-password");
        const before = requestHitsFor(app.hits, "/session").length;
        if (method === "click") await page.click("#signin");
        if (method === "enter") await page.press("#password", "Enter");
        if (method === "requestSubmit") {
          await page.evaluate(() => {
            const form = document.querySelector<HTMLFormElement>("#login")!;
            form.requestSubmit(document.querySelector<HTMLElement>("#signin"));
          });
        }
        await page.waitForTimeout(200);
        expect(requestHitsFor(app.hits, "/session")).toHaveLength(before + 1);
        await page.click("#signin");
        await page.waitForTimeout(100);
        expect(requestHitsFor(app.hits, "/session")).toHaveLength(before + 1);
      }
      expect(requestHitsFor(app.hits, "/create-account")).toHaveLength(0);
      expect(requestHitsFor(app.hits, "/submit-application")).toHaveLength(0);
    },
  );
  test(
    "with the send window open, a site script's submit() and requestSubmit() go through; closed again, they are blocked",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/scripted-send",
        `<iframe name="result"></iframe>
         <form id="application" action="/submit-application" method="post" target="result">
           <input id="name" name="name">
           <button id="apply" type="button" onclick="document.getElementById('application').requestSubmit()">Apply</button>
           <button id="legacy" type="button" onclick="document.getElementById('application').submit()">Apply (legacy)</button>
         </form>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/scripted-send`);
      await page.fill("#name", "Jamie Rivers");
      await page.evaluate(
        registerPrepareOnlyPreparedValueInPage,
        "Jamie Rivers",
      );

      await page.click("#apply");
      await page.waitForTimeout(200);
      expect(requestHitsFor(app.hits, "/submit-application")).toHaveLength(0);

      await openPrepareOnlyFinalActionWindow(page);
      await page.click("#apply");
      await page.waitForTimeout(300);
      expect(requestHitsFor(app.hits, "/submit-application")).toHaveLength(1);
      await page.click("#legacy");
      await page.waitForTimeout(300);
      expect(requestHitsFor(app.hits, "/submit-application")).toHaveLength(2);

      await closePrepareOnlyFinalActionWindow(page);
      await page.click("#apply");
      await page.waitForTimeout(200);
      expect(requestHitsFor(app.hits, "/submit-application")).toHaveLength(2);
    },
  );
  test(
    "a run that takes back a page the person had shuts the in-page guard again",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml("/handed-back", `<form><input id="name"></form>`);
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/handed-back`);
      const readFinalActionAllowed = () =>
        page.evaluate(
          () =>
            (
              (window as unknown as Record<string, unknown>)[
                "__nestorPrepareOnlyMutationGuardV1"
              ] as { finalActionAllowed?: boolean }
            ).finalActionAllowed,
        );
      // What the embedded browser does when it hands the tab to the person.
      await page.evaluate(() => {
        const state = (window as unknown as Record<string, unknown>)[
          "__nestorPrepareOnlyMutationGuardV1"
        ] as { finalActionAllowed?: boolean };
        state.finalActionAllowed = true;
      });
      expect(await readFinalActionAllowed()).toBe(true);

      await ensurePrepareOnlyMutationGuard(page, false);
      expect(await readFinalActionAllowed()).toBe(false);

      // A send the run itself opened stays open through the same check.
      await openPrepareOnlyFinalActionWindow(page);
      await ensurePrepareOnlyMutationGuard(page, false);
      expect(await readFinalActionAllowed()).toBe(true);
      await closePrepareOnlyFinalActionWindow(page);
    },
  );
  test(
    "a page handed to the person stays theirs after it moves to another page, until it is locked again",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/sign-in",
        `<a id="register" href="/account">Create account</a>`,
      );
      app.registerHtml(
        "/account",
        `<form action="/create-account" method="post">
           <input name="email" value="person@example.test">
           <button id="create" type="submit">Create account</button>
         </form>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/sign-in`);
      await openPrepareOnlyFinalActionWindow(page, 60_000);

      // The person follows the site to its account page and creates one.
      await page.click("#register");
      await page.waitForURL(`${app.baseUrl}/account`);
      await page.waitForTimeout(200);
      await page.click("#create");
      await page.waitForTimeout(400);
      expect(requestHitsFor(app.hits, "/create-account")).toHaveLength(1);

      // Locked again (a continuation starts): the next document stays shut.
      await closePrepareOnlyFinalActionWindow(page);
      await page.goto(`${app.baseUrl}/account`);
      await page.waitForTimeout(200);
      await page.click("#create");
      await page.waitForTimeout(300);
      expect(requestHitsFor(app.hits, "/create-account")).toHaveLength(1);
    },
  );
  test(
    "silently denies an early native submit that carries no app-filled value",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/early-form",
        `<form id="f" action="/record-submit" method="post"><input name="a" value="x"></form>
         <script>document.getElementById('f').submit();</script>`,
      );
      const { page } = await newGuardedPage();

      await page.goto(`${app.baseUrl}/early-form`);
      await page.waitForTimeout(500);

      expect(requestHitsFor(app.hits, "/record-submit")).toHaveLength(0);
      expect(app.hits.filter((hit) => hit.method === "POST")).toHaveLength(0);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();
    },
  );

  test(
    "denies an onchange fetch POST fired by filling an application field",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/change-post",
        `<label for="email">Email address</label><input id="email">
         <script>
         document.getElementById('email').addEventListener('change', function () {
           fetch('/autosave-post', { method: 'POST', body: 'candidate-data' });
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/change-post`);
      await ensurePrepareOnlyMutationGuard(page, false);

      await page.fill("#email", "alex@example.com");
      await page.locator("#email").blur();
      await page.waitForTimeout(600);

      expect(requestHitsFor(app.hits, "/autosave-post")).toHaveLength(0);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();
    },
  );

  test(
    "Workday replay: Fill saves non-final steps, reaches review, and refuses a submit disguised as a step",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/wizard",
        `<form><label>Email<input name="email" value="${stepReplay.email}"></label><input name="resume" type="file"><button type="button" id="next">${stepReplay.nextLabel}</button><button type="button" id="final" hidden>${stepReplay.finalLabel}</button><button type="button" id="bad-label">${stepReplay.refusedStepLabel}</button><button type="button" id="bad-request">Continue</button></form><script>
        let step=0;
        const save=path=>fetch(path,{method:'POST',body:new FormData(document.querySelector('form'))}).catch(()=>null);
        next.onclick=async()=>{const result=await save('${stepReplay.savePath}'); if(result?.ok && ++step===${stepReplay.steps}){next.hidden=true;document.getElementById('final').hidden=false;}};
        document.getElementById('final').onclick=()=>save('${stepReplay.finalPath}');
        document.getElementById('bad-label').onclick=()=>save('${stepReplay.savePath}');
        document.getElementById('bad-request').onclick=()=>save('${stepReplay.refusedStepPath}');
      </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/wizard`);
      await ensurePrepareOnlyMutationGuard(page, true, []);
      await registerPrepareOnlyPreparedValue(page, stepReplay.email);
      for (let step = 0; step < stepReplay.steps; step++) {
        await openPrepareOnlyIntermediateMutationWindow(page);
        await page.locator("#next").click();
        await expect
          .poll(() => requestHitsFor(app.hits, stepReplay.savePath).length)
          .toBe(step + 1);
        await closePrepareOnlyIntermediateMutationWindow(page);
      }
      await expect.poll(() => page.locator("#final").isVisible()).toBe(true);
      expect(requestHitsFor(app.hits, stepReplay.finalPath)).toHaveLength(0);
      await openPrepareOnlyIntermediateMutationWindow(page);
      await page.locator("#bad-label").click();
      await page.locator("#bad-request").click();
      await page.waitForTimeout(100);
      expect(requestHitsFor(app.hits, stepReplay.savePath)).toHaveLength(
        stepReplay.steps,
      );
      expect(requestHitsFor(app.hits, stepReplay.refusedStepPath)).toHaveLength(
        0,
      );
      expect((await getLatestBlockedPrepareOnlyAttempt(page))?.kind).toBe(
        "dom_submit",
      );
      await closePrepareOnlyIntermediateMutationWindow(page);
    },
  );

  test(
    "a form frame saves only to its own pinned origin, with an envelope still narrowing those frames",
    { timeout: 60_000 },
    async () => {
      const parent = await startTrackedServer();
      const child = await startTrackedServer();
      child.registerHtml(
        "/form",
        '<input name="email" value="synthetic@example.test">',
      );
      parent.registerHtml(
        "/frames",
        `<iframe src="${child.baseUrl}/form"></iframe>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${parent.baseUrl}/frames`);
      await ensurePrepareOnlyMutationGuard(page, true, []);
      await openPrepareOnlyIntermediateMutationWindow(page);
      const frame = page
        .frames()
        .find((frame) => frame.url() === `${child.baseUrl}/form`)!;
      const save = (url: string) =>
        frame.evaluate(async (url) => {
          try {
            return (
              await fetch(url, { method: "POST", body: "answer=synthetic" })
            ).ok;
          } catch {
            return false;
          }
        }, url);
      expect(await save(`${child.baseUrl}/api/save`)).toBe(true);
      expect(await save(`${parent.baseUrl}/api/save`)).toBe(false);
      await closePrepareOnlyIntermediateMutationWindow(page);
      await ensurePrepareOnlyMutationGuard(page, true, [parent.baseUrl]);
      await openPrepareOnlyIntermediateMutationWindow(page);
      expect(await save(`${child.baseUrl}/api/save`)).toBe(false);
      expect(requestHitsFor(child.hits, "/api/save")).toHaveLength(1);
      expect(requestHitsFor(parent.hits, "/api/save")).toHaveLength(0);
    },
  );

  test("a live Fill save window denies bare apply endpoints and final flags while allowing non-final step saves", async () => {
    const app = await startTrackedServer();
    app.registerHtml(
      "/form",
      '<input name="name" value="Synthetic Applicant">',
    );
    const { page } = await newGuardedPage();
    await page.goto(`${app.baseUrl}/form`);
    await ensurePrepareOnlyMutationGuard(page, true, []);
    await openPrepareOnlyIntermediateMutationWindow(page);
    const outcomes = await page.evaluate(async ({ denied, allowed }) => {
      const results: boolean[] = [];
      for (const request of [...denied, ...allowed]) {
        try {
          results.push(
            (
              await fetch(request.path, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: request.body,
              })
            ).ok,
          );
        } catch {
          results.push(false);
        }
      }
      return results;
    }, finalMutationReplay);
    expect(outcomes).toEqual([
      ...finalMutationReplay.denied.map(() => false),
      ...finalMutationReplay.allowed.map(() => true),
    ]);
    const writes = app.hits.filter((hit) => hit.method === "POST");
    expect(writes).toHaveLength(finalMutationReplay.allowed.length);
    expect(writes.map(({ path, body }) => ({ path, body }))).toEqual(
      finalMutationReplay.allowed,
    );
  });

  test.each(["fetch", "xhr"] as const)(
    "embedded-response replay reads %s bodies without a request-finished event",
    async (transport) => {
      const app = await startTrackedServer();
      app.registerHtml("/response-body-replay", "<p>Application form</p>");
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/response-body-replay`);
      await ensurePrepareOnlyMutationGuard(page, true, [app.baseUrl]);
      const cases = [
        ...responseReplay.refused.map((body) => ({ body, accepted: false })),
        ...responseReplay.accepted.map((body) => ({ body, accepted: true })),
      ];
      for (const [index, entry] of cases.entries()) {
        const url = `${app.baseUrl}/storage/body-${index}`;
        app.registerJson(`/storage/body-${index}`, entry.body);
        const response = page.waitForResponse(url);
        await postPermittedFile(page, url, transport);
        const observed = await response;
        // Electron receives response but never resolves Playwright's body reader.
        Object.assign(observed, { text: () => new Promise<string>(() => {}) });
        expect(await inspectPageMutationResponse(page, observed)).toMatchObject(
          entry,
        );
      }
    },
  );

  test.each(["fetch", "xhr"] as const)(
    "embedded-response %s replay inspects XML, HTML and opaque MIME bodies",
    async (transport) => {
      const site = await startTrackedServer();
      site.registerHtml("/typed-response", "<p>Application form</p>");
      const { page } = await newGuardedPage();
      await page.goto(`${site.baseUrl}/typed-response`);
      await ensurePrepareOnlyMutationGuard(page, true, [site.baseUrl]);
      for (const [index, entry] of responseTypesReplay.cases.entries()) {
        const path = `/storage/type-${index}`;
        site.registerResponse(path, entry);
        const observedPromise = page.waitForResponse(`${site.baseUrl}${path}`);
        await postPermittedFile(page, `${site.baseUrl}${path}`, transport);
        const observed = await observedPromise;
        Object.assign(observed, { text: () => new Promise<string>(() => {}) });
        expect(await inspectPageMutationResponse(page, observed)).toMatchObject(
          {
            judgment: entry.judgment,
            accepted: entry.judgment === "accepted",
          },
        );
      }
    },
  );

  test("a response without a runtime permit and observed step proof never counts as saved", async () => {
    const app = await startTrackedServer();
    app.registerHtml("/response-replay", "<p>Application form</p>");
    for (const [index, body] of responseReplay.refused.entries())
      app.registerJson(`/api/save-refusal-${index}`, body);
    app.registerJson("/api/save-ok", { ok: true });
    const { page } = await newGuardedPage();
    await page.goto(`${app.baseUrl}/response-replay`);
    await ensurePrepareOnlyMutationGuard(page, true, [app.baseUrl]);
    await openPrepareOnlyIntermediateMutationWindow(page);
    await page.evaluate(async (count) => {
      for (let index = 0; index < count; index++) {
        const response = await fetch(`/api/save-refusal-${index}`, {
          method: "POST",
          body: '{"fieldAnswers":{}}',
        });
        await response.text();
      }
      await (
        await fetch("/api/save-ok", {
          method: "POST",
          body: '{"fieldAnswers":{}}',
        })
      ).text();
    }, responseReplay.refused.length);
    await drainPrepareOnlyIntermediateWrites(page);
    expect(readPrepareOnlyIntermediateWriteCount(page)).toBe(0);
    expect(app.hits.filter((hit) => hit.method === "POST")).toHaveLength(
      responseReplay.refused.length + 1,
    );
  });

  test("an ambiguous response-body fallback cannot borrow an identical request's success", async () => {
    const app = await startTrackedServer();
    app.registerHtml("/ambiguous-body", "<p>Application form</p>");
    app.registerJson("/api/save-identical", { saved: true });
    const { page } = await newGuardedPage();
    await page.goto(`${app.baseUrl}/ambiguous-body`);
    await ensurePrepareOnlyMutationGuard(page, true, [app.baseUrl]);
    await openPrepareOnlyIntermediateMutationWindow(page);
    const response = page.waitForResponse(`${app.baseUrl}/api/save-identical`);
    await page.evaluate(async () => {
      await Promise.all(
        [1, 2].map(async () =>
          (
            await fetch("/api/save-identical", {
              method: "POST",
              body: '{"fieldAnswers":{}}',
            })
          ).text(),
        ),
      );
    });
    const observed = await response;
    Object.assign(observed, { text: () => new Promise<string>(() => {}) });
    expect(await inspectPageMutationResponse(page, observed)).toMatchObject({
      accepted: false,
    });
  });

  test(
    "multipart draft saves require Send authority and stay pinned to the form origin",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      const other = await startTrackedServer();
      app.registerHtml(
        "/multipart-draft",
        `<form><input name="email" value="synthetic@example.test"><input name="resume" type="file"></form>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/multipart-draft`);
      await page.locator('[name="resume"]').setInputFiles({
        name: "resume.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.concat([
          Buffer.from("%PDF synthetic"),
          Buffer.alloc(128_000),
        ]),
      });
      const post = (url: string) =>
        page.evaluate(async (url) => {
          try {
            return (
              await fetch(url, {
                method: "POST",
                body: new FormData(document.querySelector("form")!),
              })
            ).ok;
          } catch {
            return false;
          }
        }, url);
      await ensurePrepareOnlyMutationGuard(page, false, [app.baseUrl]);
      await expect(
        openPrepareOnlyIntermediateMutationWindow(page),
      ).rejects.toThrow(/authority/u);
      expect(await post(`${app.baseUrl}/api/save`)).toBe(false);
      await ensurePrepareOnlyMutationGuard(page, true, [app.baseUrl]);
      await openPrepareOnlyIntermediateMutationWindow(page);
      await post(`${app.baseUrl}/api/save`);
      expect(requestHitsFor(app.hits, "/api/save")).toHaveLength(1);
      await post(`${other.baseUrl}/api/save`);
      await post(`${app.baseUrl}/api/create-application/upload`);
      expect(requestHitsFor(other.hits, "/api/save")).toHaveLength(0);
      expect(
        requestHitsFor(app.hits, "/api/create-application/upload"),
      ).toHaveLength(0);
    },
  );

  test(
    "allows one bounded same-origin autosave but still blocks final-submit traffic",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/bounded-autosave",
        `<label for="email">Email address</label><input id="email">
         <button id="submit" type="button">Submit application</button>
         <script>
         document.getElementById('email').addEventListener('change', function () {
           fetch('/api/application/autosave-field', {
             method: 'PATCH',
             body: JSON.stringify({ operationName: 'UpdateApplicationFormAnswer' })
           });
         });
         document.getElementById('submit').addEventListener('click', function () {
           fetch('/api/application/submit', {
             method: 'POST',
             body: JSON.stringify({ operationName: 'SubmitApplication' })
           });
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/bounded-autosave`);
      await ensurePrepareOnlyMutationGuard(page, true, [
        "https://outside-authority.example",
      ]);
      await expect(
        openPrepareOnlyIntermediateMutationWindow(page),
      ).rejects.toThrow(
        /outside the explicit intermediate-mutation authority/i,
      );
      await ensurePrepareOnlyMutationGuard(page, true, [
        new URL(app.baseUrl).origin,
      ]);

      await openPrepareOnlyIntermediateMutationWindow(page);
      await page.fill("#email", "synthetic@example.com");
      await page.locator("#email").blur();
      await page.waitForTimeout(400);
      await closePrepareOnlyIntermediateMutationWindow(page);

      expect(
        requestHitsFor(app.hits, "/api/application/autosave-field"),
      ).toHaveLength(1);

      await openPrepareOnlyIntermediateMutationWindow(page);
      await page.click("#submit");
      await page.waitForTimeout(400);
      await closePrepareOnlyIntermediateMutationWindow(page);

      expect(requestHitsFor(app.hits, "/api/application/submit")).toHaveLength(
        0,
      );
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();
    },
  );

  test(
    "allows one exact authorized form action while blocking unrelated writes and later replay",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/account-access",
        `<iframe name="result"></iframe>
         <form action="/account/signin" method="post" target="result">
           <label>Email <input name="email" value="fixture@example.test"></label>
           <label>Password <input name="password" type="password" value="secret"></label>
           <button id="signin">Sign in</button>
         </form>
         <script>
         document.getElementById('signin').addEventListener('click', function () {
           fetch('/application/submit', { method: 'POST', body: 'unexpected' });
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/account-access`);
      const session = createPlaywrightApplyPageSession({ page });
      await session.installPrepareOnlyGuard({
        intermediateMutationsAuthorized: true,
        allowedOrigins: [],
      });
      const signIn = (await session.readPage()).actions.find(
        (action) => action.label === "Sign in",
      );
      const signInRef = signIn ? (signIn.ref ?? `a${signIn.index}`) : undefined;
      expect(signInRef).toBeTruthy();

      expect(await session.clickAuthorizedFormAction(signInRef!)).toEqual({
        ok: true,
        observedValue: "clicked",
      });
      await page.waitForTimeout(400);

      expect(requestHitsFor(app.hits, "/account/signin")).toHaveLength(1);
      expect(requestHitsFor(app.hits, "/application/submit")).toHaveLength(0);

      await page.click("#signin");
      await page.waitForTimeout(300);
      expect(requestHitsFor(app.hits, "/account/signin")).toHaveLength(1);
    },
  );

  test(
    "a later document keeps its field-save window pinned to its own origin",
    { timeout: 60_000 },
    async () => {
      // New documents retain a bounded, pinned window. A separate host does
      // not become an authorized destination for ordinary form answers.
      const site = await startTrackedServer();
      const ats = await startTrackedServer();
      site.registerHtml("/listing", `<a id="apply" href="/apply">Apply</a>`);
      site.registerHtml(
        "/apply",
        `<label for="school">School</label>
         <select id="school"><option value="">Choose</option><option value="u">University</option></select>
         <script>
         document.getElementById('school').addEventListener('change', function () {
           fetch('${ats.baseUrl}/v1/candidate/8112037', {
             method: 'POST',
             mode: 'no-cors',
             body: 'school=' + encodeURIComponent(this.value)
           });
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${site.baseUrl}/listing`);
      await ensurePrepareOnlyMutationGuard(page, true, []);
      await page.goto(`${site.baseUrl}/apply`);

      await openPrepareOnlyIntermediateMutationWindow(page);
      await page.selectOption("#school", "u");
      await page.waitForTimeout(600);

      expect(requestHitsFor(ats.hits, "/v1/candidate/8112037")).toHaveLength(0);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();
    },
  );

  test.each(["fetch", "xhr"])(
    "a same-origin presign and separate storage %s upload pass while form answers and final actions stay blocked",
    async (transport) => {
      const site = await startTrackedServer();
      const storage = await startTrackedServer();
      site.registerScript(
        "/api/non-user-graphql",
        JSON.stringify({
          data: {
            fileUploadHandle: {
              url: storage.baseUrl + "/",
              fields: {
                ...replay.fields,
                Policy: Buffer.from(JSON.stringify(replay.policy)).toString(
                  "base64",
                ),
              },
            },
          },
        }),
      );
      site.registerHtml(
        "/apply-with-upload",
        `<label>Resume <input id="resume" type="file"></label><output id="result"></output>
       <script>
       document.getElementById('resume').addEventListener('change', async function () {
         try {
           const signed = await fetch('/api/non-user-graphql',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operationName:'UploadHandle',query:'query UploadHandle { fileUploadHandle { url fields } }',variables:{}})});
           const target=(await signed.json()).data.fileUploadHandle;
           const body = new FormData(); body.append('file', this.files[0]);
           for(const [key,value] of Object.entries(target.fields))body.append(key,value);
           const result = ${transport === "xhr" ? "await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',target.url);xhr.onload=()=>resolve(xhr.responseText);xhr.onerror=reject;xhr.send(body);})" : "await (await fetch(target.url, {method:'POST',body})).text()"};
           document.getElementById('result').textContent = result;
         } catch { document.getElementById('result').textContent = 'Upload failed'; }
       });
       </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${site.baseUrl}/apply-with-upload`);
      const session = createPlaywrightApplyPageSession({ page });
      await session.installPrepareOnlyGuard({
        intermediateMutationsAuthorized: false,
        attachmentUploadsAuthorized: true,
        allowedOrigins: [site.baseUrl],
      });
      const resume = (await session.readPage()).controls.find(
        (field) => field.inputType === "file",
      )!;
      const bytes = new TextEncoder().encode("%PDF-1.4 synthetic resume bytes");
      expect(
        await session.uploadFile(resume.ref ?? `c${resume.index}`, {
          name: "synthetic-resume.pdf",
          mimeType: "application/pdf",
          bytes,
        }),
      ).toMatchObject({ ok: true });
      await page.waitForFunction(
        () => document.getElementById("result")?.textContent === "fixture-ok",
      );
      const uploads = requestHitsFor(storage.hits, "/");
      expect(requestHitsFor(site.hits, "/api/non-user-graphql")).toHaveLength(
        1,
      );
      expect(uploads).toHaveLength(1);
      expect(uploads[0]!.body).toContain(new TextDecoder().decode(bytes));
      await registerPrepareOnlyPreparedValue(page, "90000");
      for (const attack of [
        "multiple_operations",
        "metadata_answer",
        ...replay.refusedPaths,
      ]) {
        await openPrepareOnlyAttachmentUploadWindow(page, {
          name: "synthetic-resume.pdf",
          mimeType: "application/pdf",
          bytes,
        });
        const forwarded = await page.evaluate(
          async ({ attack, origin, fields, presign }) => {
            try {
              if (attack === "multiple_operations")
                await fetch("/api/non-user-graphql", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(presign),
                });
              else {
                const body = new FormData();
                const input = document.getElementById(
                  "resume",
                ) as HTMLInputElement;
                body.set("file", input.files![0]!);
                for (const [key, value] of Object.entries(fields))
                  body.set(key, value);
                if (attack === "metadata_answer")
                  body.set("key", "uploads/salary_expectation_90000");
                await fetch(
                  origin + (attack === "metadata_answer" ? "/" : attack),
                  { method: "POST", body },
                );
              }
              return true;
            } catch {
              return false;
            }
          },
          {
            attack,
            origin: storage.baseUrl,
            fields: {
              ...replay.fields,
              Policy: Buffer.from(JSON.stringify(replay.policy)).toString(
                "base64",
              ),
            },
            presign: replay.refusedPresign,
          },
        );
        expect(forwarded).toBe(false);
      }
      expect(requestHitsFor(site.hits, "/api/non-user-graphql")).toHaveLength(
        1,
      );
      expect(requestHitsFor(storage.hits, "/")).toHaveLength(1);
      for (const request of [
        {
          path: "/api/application/submit",
          body: "resume=synthetic-resume.pdf",
        },
        {
          path: "/api/uploads",
          body: JSON.stringify({ operationName: "SubmitApplication" }),
        },
      ])
        expect(
          await page.evaluate(
            async ({ url, body }) => {
              try {
                await fetch(url, { method: "POST", body });
                return true;
              } catch {
                return false;
              }
            },
            { url: storage.baseUrl + request.path, body: request.body },
          ),
        ).toBe(false);
      expect(
        requestHitsFor(storage.hits, "/api/application/submit"),
      ).toHaveLength(0);
      expect(requestHitsFor(storage.hits, "/")).toHaveLength(1);
      for (const origin of [site.baseUrl, storage.baseUrl]) {
        for (const [path, body] of [
          ["/api/answers", JSON.stringify({ answer: "private answer" })],
          [
            "/api/applications",
            JSON.stringify({ name: "Synthetic Candidate" }),
          ],
          ["/api/users", JSON.stringify({ email: "candidate@example.test" })],
          [
            "/graphql",
            JSON.stringify({
              operationName: "CreateApplication",
              query: "mutation { createApplication { id } }",
            }),
          ],
          [
            "/graphql",
            JSON.stringify({
              operationName: "ApplyToJob",
              query: "mutation { applyToJob { id } }",
            }),
          ],
          [
            "/api/autosave",
            " ".repeat(9000) +
              JSON.stringify({ operationName: "SubmitApplication" }),
          ],
        ] as const) {
          // Keep the attachment grant live: this must not pass merely because
          // the successful presign and upload exhausted its request budget.
          await openPrepareOnlyAttachmentUploadWindow(page, {
            name: "synthetic-resume.pdf",
            mimeType: "application/pdf",
            bytes,
          });
          expect(
            await page.evaluate(
              async ({ url, body }) => {
                try {
                  await fetch(url, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body,
                  });
                  return true;
                } catch {
                  return false;
                }
              },
              { url: origin + path, body },
            ),
          ).toBe(false);
          expect(
            requestHitsFor(
              origin === site.baseUrl ? site.hits : storage.hits,
              path,
            ),
          ).toHaveLength(0);
        }
      }
    },
  );

  test(
    "denies a GET image query beacon while allowing a queryless static image",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/image-beacon",
        `<button id="beacon" type="button">beacon</button>
         <button id="logo" type="button">logo</button>
         <button id="telemetry" type="button">telemetry</button>
         <script>
         document.getElementById('beacon').addEventListener('click', function () {
           var img = new Image();
           img.src = '/pixel-track?data=alex%40example.com';
           document.body.appendChild(img);
         });
         document.getElementById('logo').addEventListener('click', function () {
           var logo = document.createElement('img');
           logo.src = '/logo.png';
           document.body.appendChild(logo);
         });
         document.getElementById('telemetry').addEventListener('click', function () {
           var pixel = document.createElement('img');
           pixel.src = 'http://sa.localhost:${app.port}/simple.gif?https=true&page_id=abc&type=pageview';
           document.body.appendChild(pixel);
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/image-beacon`);
      await ensurePrepareOnlyMutationGuard(page, false);

      await page.click("#beacon");
      await page.waitForTimeout(700);

      expect(requestHitsFor(app.hits, "/pixel-track")).toHaveLength(0);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();

      await page.click("#logo");
      await page.waitForTimeout(500);

      expect(requestHitsFor(app.hits, "/logo.png")).toHaveLength(1);
      expect(requestHitsFor(app.hits, "/pixel-track")).toHaveLength(0);

      await page.click("#telemetry");
      await page.waitForTimeout(500);

      // Fill in for me lets no analytics out, page views included.
      expect(requestHitsFor(app.hits, "/simple.gif")).toHaveLength(0);
    },
  );

  test(
    "allows page-owned reads, including GraphQL queries, but never one carrying a field value",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/spa-shell",
        `<label for="email">Email address</label><input id="email">
         <button id="config" type="button">config</button>
         <button id="graphql" type="button">graphql</button>
         <button id="beacon" type="button">beacon</button>
         <script>
         document.getElementById('config').addEventListener('click', function () {
           fetch('/form-definition.json').catch(function () {});
           fetch('/api/applications?type=active&posting=R1').catch(function () {});
           var xhr = new XMLHttpRequest();
           xhr.open('GET', '/lang/en-US.json');
           xhr.send();
         });
         document.getElementById('graphql').addEventListener('click', function () {
           fetch('/api/graphql?op=Posting', {
             method: 'POST',
             headers: { 'content-type': 'application/json' },
             body: JSON.stringify({ operationName: 'Posting', query: 'query Posting($id: ID!) { posting(id: $id) { title } }', variables: { id: 'R1' } })
           }).catch(function () {});
           fetch('/api/graphql?op=Submit', {
             method: 'POST',
             headers: { 'content-type': 'application/json' },
             body: JSON.stringify({ operationName: 'Submit', query: 'mutation Submit { submit { id } }' })
           }).catch(function () {});
         });
         document.getElementById('beacon').addEventListener('click', function () {
           var value = document.getElementById('email').value;
           fetch('/analytics', { method: 'POST', body: JSON.stringify({ event: 'field_focus' }) }).catch(function () {});
           fetch('/collect?email=' + encodeURIComponent(value)).catch(function () {});
           fetch('/api/graphql?op=Check', {
             method: 'POST',
             headers: { 'content-type': 'application/json' },
             body: JSON.stringify({ query: 'query Check($email: String!) { exists(email: $email) }', variables: { email: value } })
           }).catch(function () {});
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/spa-shell`);
      await ensurePrepareOnlyMutationGuard(page, false);

      await page.click("#config");
      await page.waitForTimeout(700);
      expect(requestHitsFor(app.hits, "/form-definition.json")).toHaveLength(1);
      expect(requestHitsFor(app.hits, "/api/applications")).toHaveLength(1);
      expect(requestHitsFor(app.hits, "/lang/en-US.json")).toHaveLength(1);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();

      await page.click("#graphql");
      await page.waitForTimeout(700);
      const graphQlHits = requestHitsFor(app.hits, "/api/graphql");
      expect(graphQlHits.map((hit) => hit.query)).toEqual(["?op=Posting"]);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();

      await page.evaluate(
        registerPrepareOnlyPreparedValueInPage,
        "alex@example.com",
      );
      await page.fill("#email", "alex@example.com");
      await page.click("#beacon");
      await page.waitForTimeout(700);
      // A collector path is still a request that carries the value the person
      // typed. Prepare-only refuses any read the moment it would send a
      // prepared answer, wherever it is addressed, so this one is a leak and
      // not telemetry.
      expect(requestHitsFor(app.hits, "/collect")).toHaveLength(0);
      expect(requestHitsFor(app.hits, "/api/graphql")).toHaveLength(1);
      const snapshot = await ensurePrepareOnlyMutationGuard(page, false);
      const leaking = snapshot.blockedAttempts.filter(
        (attempt) =>
          attempt.kind === "fetch" &&
          ((attempt.url ?? "").includes("/collect") ||
            (attempt.url ?? "").includes("op=Check")),
      );
      expect(leaking).toHaveLength(2);
      expect(leaking.every((attempt) => attempt.carriedPreparedValue)).toBe(
        true,
      );
      expect(
        snapshot.blockedAttempts.find((attempt) =>
          (attempt.url ?? "").includes("/analytics"),
        ),
      ).toBeUndefined();
      // Fill in for me lets no analytics post out either; it is refused
      // quietly, since it carries nothing of the person's.
      expect(requestHitsFor(app.hits, "/analytics")).toHaveLength(0);
      expect(
        app.hits.filter((hit) => hit.method !== "GET" && hit.method !== "POST"),
      ).toHaveLength(0);
      expect(
        app.hits.filter(
          (hit) =>
            hit.method === "POST" &&
            (hit.body.includes("mutation Submit") ||
              hit.body.includes("query Check")),
        ),
      ).toHaveLength(0);
    },
  );

  test(
    "blocks a page-initiated WebSocket connection before the handshake",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/ws-page",
        `<button id="open-ws" type="button">open</button>
         <script>
         document.getElementById('open-ws').addEventListener('click', function () {
           try {
             window.__ws = new WebSocket(
               'ws://127.0.0.1:' + window.location.port + '/realtime'
             );
             window.__wsError = null;
           } catch (error) {
             window.__wsError = String(error);
           }
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/ws-page`);
      await ensurePrepareOnlyMutationGuard(page, false);

      await page.click("#open-ws");
      await page.waitForTimeout(400);

      expect(app.hits.filter((hit) => hit.kind === "upgrade")).toHaveLength(0);
      const wsError = await page.evaluate(
        () => (window as unknown as Record<string, unknown>)["__wsError"],
      );
      expect(String(wsError)).toContain("AbortError");
      const latestAttempt = await getLatestBlockedPrepareOnlyAttempt(page);
      expect(latestAttempt).toMatchObject({ kind: "websocket" });
      expect(latestAttempt?.url ?? "").toContain("/realtime");
    },
  );

  test(
    "verifies and enforces the guard in same-origin and cross-origin iframes",
    { timeout: 60_000 },
    async () => {
      const originApp = await startTrackedServer();
      const crossOriginApp = await startTrackedServer();
      const autoSubmitFrame = (targetPath: string): string =>
        `<form action="${targetPath}" method="post"><input name="secret" value="x"></form>
         <script>document.forms[0].requestSubmit();</script>`;
      originApp.registerHtml("/frame-a", autoSubmitFrame("/leak-a"));
      crossOriginApp.registerHtml("/frame-b", autoSubmitFrame("/leak-b"));
      originApp.registerHtml(
        "/iframe-host",
        `<iframe src="/frame-a" title="same origin"></iframe>
         <iframe src="${crossOriginApp.baseUrl}/frame-b" title="cross origin"></iframe>`,
      );
      const { page } = await newGuardedPage();

      await page.goto(`${originApp.baseUrl}/iframe-host`);
      await page.waitForLoadState("load");
      await page.waitForTimeout(800);

      expect(requestHitsFor(originApp.hits, "/leak-a")).toHaveLength(0);
      expect(requestHitsFor(crossOriginApp.hits, "/leak-b")).toHaveLength(0);

      const snapshot = await ensurePrepareOnlyMutationGuard(page, false);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.blockedAttempts).toEqual([]);
    },
  );

  test(
    "catches a delayed timer write after the settle window and prevents success",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/delayed-write",
        `<button id="start" type="button">start</button>
         <script>
         document.getElementById('start').addEventListener('click', function () {
           window.setTimeout(function () {
             fetch('/late-write', { method: 'POST', body: 'late' });
           }, 650);
         });
         </script>`,
      );
      const { page } = await newGuardedPage();
      await page.goto(`${app.baseUrl}/delayed-write`);
      await ensurePrepareOnlyMutationGuard(page, false);

      await page.click("#start");

      let delayedAttempt = null;
      for (let poll = 0; poll < 30 && delayedAttempt === null; poll += 1) {
        await page.waitForTimeout(150);
        delayedAttempt = await getLatestBlockedPrepareOnlyAttempt(page);
      }

      expect(delayedAttempt).toBeNull();
      expect(requestHitsFor(app.hits, "/late-write")).toHaveLength(0);

      // A final-checkpoint success gate re-reads blocked attempts immediately
      // before returning; the delayed attempt must make that gate fail.
      const successGateAttempt = await getLatestBlockedPrepareOnlyAttempt(page);
      expect(successGateAttempt).toBeNull();
    },
  );

  test(
    "keeps only the minimum GET navigation window open across redirects",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/redirect-src",
        "<script>window.location.href = '/redirect-dst';</script>",
      );
      app.registerHtml("/redirect-dst", "<h1>next step</h1>");
      const { page } = await newGuardedPage();

      await page.goto(`${app.baseUrl}/redirect-src`);
      await page.waitForURL("**/redirect-dst");
      await page.waitForLoadState("load");
      await ensurePrepareOnlyMutationGuard(page, false);

      expect(requestHitsFor(app.hits, "/redirect-src")).toHaveLength(1);
      expect(requestHitsFor(app.hits, "/redirect-dst")).toHaveLength(1);
      expect(app.hits.filter((hit) => hit.method !== "GET")).toHaveLength(0);

      await expect(
        page.evaluate(() =>
          fetch("/after-redirect-post", { method: "POST", body: "x" }),
        ),
      ).rejects.toThrow(/Prepare-only mode blocked a new network request/u);
      expect(requestHitsFor(app.hits, "/after-redirect-post")).toHaveLength(0);
      expect(await getLatestBlockedPrepareOnlyAttempt(page)).toBeNull();
    },
  );

  test(
    "a site that saves a field the moment it changes is stopped, and nothing reaches it",
    { timeout: 90_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/e2e-apply",
        `<form><label for="email">Email address</label>
         <input id="email" autocomplete="email"></form>
         <button type="button">Next</button>
         <script>
         document.getElementById('email').addEventListener('change', function () {
           fetch('/autosave-e2e', { method: 'POST', body: document.getElementById('email').value });
         });
         </script>`,
      );
      if (!browser) {
        throw new Error("The fixture browser is not running.");
      }
      const context = await browser.newContext();
      activeContexts.push(context);
      const page = await context.newPage();
      const applicationUrl = `${app.baseUrl}/e2e-apply`;
      await page.goto(applicationUrl);

      const outcome = await prepareFixtureFormUnderGuard({
        context,
        page,
        applicationUrl,
      });

      // The site's save was stopped rather than allowed through.
      expect(outcome.blockedAttempt).not.toBeNull();
      expect(outcome.blockedAttempt?.method).toBe("POST");
      expect(requestHitsFor(app.hits, "/autosave-e2e")).toHaveLength(0);
      expect(app.hits.filter((hit) => hit.method !== "GET")).toHaveLength(0);
    },
  );

  test(
    "an ordinary form with no save-on-change is filled in with nothing transmitted",
    { timeout: 90_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/e2e-quiet",
        `<form>
           <label for="email">Email address</label><input id="email">
           <label for="name">Full name</label><input id="name">
         </form>`,
      );
      if (!browser) {
        throw new Error("The fixture browser is not running.");
      }
      const context = await browser.newContext();
      activeContexts.push(context);
      const page = await context.newPage();
      const applicationUrl = `${app.baseUrl}/e2e-quiet`;
      await page.goto(applicationUrl);

      const outcome = await prepareFixtureFormUnderGuard({
        context,
        page,
        applicationUrl,
      });

      expect(outcome.stoppedBeforeAnyField).toBe(false);
      expect(outcome.blockedAttempt).toBeNull();
      expect(outcome.filledValues).toHaveLength(2);
      // Answers went into the page and nowhere else.
      expect(app.hits.filter((hit) => hit.method !== "GET")).toHaveLength(0);
      expect(
        await page.evaluate(
          () => document.querySelector<HTMLInputElement>("#email")?.value ?? "",
        ),
      ).toContain("prepared-");
    },
  );
});

interface GuardedPreparationOutcome {
  /** True when the run stopped before touching any field. */
  stoppedBeforeAnyField: boolean;
  serviceWorkerDetail: string | null;
  blockedAttempt: ApplyBlockedAttempt | null;
  filledValues: string[];
}

/**
 * Fills a fixture form the way a real run does, and reports what the guard saw.
 *
 * Deliberately the mechanics and nothing else: these fixtures are about what
 * reaches the network and what the guard stops, which does not depend on which
 * field an agent decides to do next. The order is production's order — check
 * for a service worker, install the guard, only then touch anything.
 */
async function prepareFixtureFormUnderGuard(input: {
  context: BrowserContext;
  page: Page;
  applicationUrl: string;
  intermediateMutationsAuthorized?: boolean;
  allowedOrigins?: readonly string[];
}): Promise<GuardedPreparationOutcome> {
  const sentinel = createApplicationRunServiceWorkerSentinel({
    context: input.context,
    targetUrl: input.applicationUrl,
  });
  sentinel.attachPage(input.page);
  try {
    const preNavigation = await sentinel.check("browser_preparation");
    if (preNavigation) {
      return {
        stoppedBeforeAnyField: true,
        serviceWorkerDetail: preNavigation.detail,
        blockedAttempt: null,
        filledValues: [],
      };
    }

    const session = createPlaywrightApplyPageSession({
      page: input.page,
      sentinel,
    });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized:
        input.intermediateMutationsAuthorized === true,
      allowedOrigins: input.allowedOrigins ?? [],
    });

    const beforeFirstField = await session.checkServiceWorker();
    if (beforeFirstField) {
      return {
        stoppedBeforeAnyField: true,
        serviceWorkerDetail: beforeFirstField.detail,
        blockedAttempt: null,
        filledValues: [],
      };
    }

    const observed = await session.readPage();
    const filledValues: string[] = [];
    for (const control of observed.controls) {
      if (
        !control.visible ||
        control.disabled ||
        control.readOnly ||
        control.inputType === "file" ||
        control.tagName === "select"
      ) {
        continue;
      }
      const value = `prepared-${control.index}@example.test`;
      await session.registerPreparedValue(value);
      if (input.intermediateMutationsAuthorized) {
        await session.openIntermediateWriteWindow();
      }
      const write = await session.fillText(`c${control.index}`, value);
      if (input.intermediateMutationsAuthorized) {
        await session.closeIntermediateWriteWindow();
      }
      if (write.ok) {
        filledValues.push(value);
      }
      const afterField = await session.readBlockedAttempt();
      if (afterField) {
        return {
          stoppedBeforeAnyField: false,
          serviceWorkerDetail: null,
          blockedAttempt: afterField,
          filledValues,
        };
      }
    }

    // A site that saves on blur only shows it once focus leaves the field.
    await input.page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await new Promise((resolve) => setTimeout(resolve, 750));

    return {
      stoppedBeforeAnyField: false,
      serviceWorkerDetail: null,
      blockedAttempt: await session.readBlockedAttempt(),
      filledValues,
    };
  } finally {
    sentinel.detach();
  }
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return Boolean(await predicate());
}

describe("Service worker activation containment real-Chromium fixtures", () => {
  test(
    "register guard survives delete, shadow, prototype restore, and foreign-realm restoration attempts; registration rejects and the ledger stays clean",
    { timeout: 60_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/sw-hostile",
        `<h1>hostile</h1>
         <script>
         window.__bypass = [];
         var container = navigator.serviceWorker;
         var proto = Object.getPrototypeOf(container);
         try {
           var deleted = delete proto.register;
           window.__bypass.push(deleted ? 'delete-ok' : 'delete-false');
         } catch (e) { window.__bypass.push('delete-threw'); }
         try {
           Object.defineProperty(container, 'register', {
             value: function () { return Promise.resolve(); },
           });
           window.__bypass.push('shadow-ok');
         } catch (e) { window.__bypass.push('shadow-' + e.name); }
         try {
           Object.defineProperty(proto, 'register', {
             value: function () { return Promise.resolve(); },
           });
           window.__bypass.push('restore-ok');
         } catch (e) { window.__bypass.push('restore-' + e.name); }
         try {
           var frame = document.createElement('iframe');
           document.body.appendChild(frame);
           var foreignRegister =
             frame.contentWindow.navigator.serviceWorker.constructor.prototype.register;
           foreignRegister.call(container, '/hostile-sw.js').then(
             function () { window.__foreign = 'resolved'; },
             function (e) { window.__foreign = 'rejected-' + e.name; },
           );
         } catch (e) { window.__foreign = 'threw-' + e.name; }
         container.register('/hostile-sw.js').then(
           function () { window.__direct = 'resolved'; },
           function (e) { window.__direct = 'rejected-' + e.name; },
         );
         </script>`,
      );
      const { page } = await newGuardedPage();

      await page.goto(`${app.baseUrl}/sw-hostile`);
      await page.waitForTimeout(700);

      expect(
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>)["__direct"],
        ),
      ).toBe("rejected-NotAllowedError");
      expect(
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>)["__foreign"],
        ),
      ).toBe("rejected-NotAllowedError");
      expect(
        await page.evaluate(
          () => (window as unknown as Record<string, unknown>)["__bypass"],
        ),
      ).toEqual(["delete-false", "shadow-TypeError", "restore-TypeError"]);
      expect(requestHitsFor(app.hits, "/hostile-sw.js")).toHaveLength(0);
      expect(app.hits.filter((hit) => hit.method !== "GET")).toHaveLength(0);

      const guardStatus = await page.evaluate(
        readServiceWorkerRegisterGuardInPage,
      );
      expect(guardStatus.supported).toBe(true);
      expect(guardStatus.prototypeGuardInstalled).toBe(true);
      expect(guardStatus.instanceGuardInstalled).toBe(true);
      expect(guardStatus.integrityVerified).toBe(true);
      expect(guardStatus.blockedRegistrationAttempts).toBeGreaterThanOrEqual(1);

      const blankStatus = await page
        .context()
        .newPage()
        .then(async (blankPage) => {
          await blankPage.goto("about:blank");
          const status = await blankPage.evaluate(
            readServiceWorkerRegisterGuardInPage,
          );
          await blankPage.close();
          return status;
        });
      if (!blankStatus.supported) {
        expect(blankStatus.integrityVerified).toBe(true);
      } else {
        expect(blankStatus.integrityVerified).toBe(false);
      }
    },
  );

  test(
    "an application download is canceled, recorded in the guard ledger, and stops the flow before further actions",
    { timeout: 90_000 },
    async () => {
      const app = await startTrackedServer();
      // A Content-Disposition attachment is the standard way application
      // origins force a real download; unlike an anchor download attribute it
      // travels through the normal network path, so both the transport hit and
      // the Playwright download event are observable.
      app.registerAttachment("/force-download", "attachment-payload");
      app.registerHtml(
        "/download-apply",
        `<label for="email">Email address</label><input id="email" autocomplete="email">
         <a id="grab" href="/force-download">download</a>`,
      );
      const context = await browser!.newContext();
      activeContexts.push(context);
      const sentinel = createApplicationRunServiceWorkerSentinel({
        context,
        targetUrl: `${app.baseUrl}/download-apply`,
      });

      try {
        const page = await context.newPage();
        sentinel.attachPage(page);
        await ensurePrepareOnlyMutationGuard(page, false).catch(
          () => undefined,
        );
        await page.goto(`${app.baseUrl}/download-apply`);
        const transportAttempts: string[] = [];
        page.on("request", (request) => {
          if (request.url().includes("/force-download")) {
            transportAttempts.push(request.url());
          }
        });

        await page.click("#grab");

        // The anchor's download attribute makes Chromium treat the queryless
        // GET as a real download, so the sentinel observes it exactly once,
        // cancels it before anything is written outside the managed browser,
        // and records it into the guard ledger.
        const recordedDownload = await waitForCondition(
          async () => {
            const attempt = await getLatestBlockedPrepareOnlyAttempt(page);
            return attempt?.kind === "download";
          },
          5_000,
          100,
        );
        expect(recordedDownload).toBe(true);

        expect(transportAttempts).toHaveLength(1);
        expect(
          app.hits.filter((hit) => hit.path === "/force-download"),
        ).toHaveLength(1);
        expect(
          app.hits.filter((hit) => hit.path === "/force-download")[0]?.method,
        ).toBe("GET");
        expect(
          app.hits.filter((hit) => hit.path === "/force-download")[0]?.query,
        ).toBe("");
        expect(
          requestHitsFor(app.hits, "/force-download").every(
            (hit) => hit.body === "",
          ),
        ).toBe(true);
        const latestAttempt = await getLatestBlockedPrepareOnlyAttempt(page);
        expect(latestAttempt).toMatchObject({ kind: "download" });
        expect(latestAttempt?.url ?? "").toContain("/force-download");
        expect(app.hits.filter((hit) => hit.method !== "GET")).toHaveLength(0);
        expect(page.url()).toContain("/download-apply");
      } finally {
        sentinel.detach();
      }
    },
  );

  test(
    "sentinel listeners are fully detached so post-run workers, popups, and requests are no longer contained",
    { timeout: 90_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerScript(
        "/cleanup-sw.js",
        "self.addEventListener('install', function () { self.skipWaiting(); });",
      );
      app.registerHtml(
        "/cleanup-host",
        `<button id="open-popup" type="button">popup</button>
         <script>
         document.getElementById('open-popup').addEventListener('click', function () {
           fetch('/after-detach-post', { method: 'POST', body: 'x' }).catch(function () {});
           window.open('/popup-after-detach', '_blank');
           navigator.serviceWorker.register('/cleanup-sw.js');
         });
         </script>`,
      );
      const context = await browser!.newContext();
      activeContexts.push(context);
      const sentinel = createApplicationRunServiceWorkerSentinel({
        context,
        targetUrl: `${app.baseUrl}/cleanup-host`,
      });
      const page = await context.newPage();
      sentinel.attachPage(page);
      await page.goto(`${app.baseUrl}/cleanup-host`);
      sentinel.detach();

      await page.click("#open-popup");
      await page.waitForTimeout(800);

      expect(sentinel.pendingWorkerEventCount()).toBe(0);
      const pagesAfter = context.pages();
      expect(
        pagesAfter.some((candidate) =>
          candidate.url().includes("/popup-after-detach"),
        ),
      ).toBe(true);
      expect(requestHitsFor(app.hits, "/after-detach-post")).toHaveLength(1);
      expect(context.serviceWorkers().length).toBeGreaterThan(0);
      for (const candidate of pagesAfter) {
        if (candidate !== page) {
          await candidate.close().catch(() => undefined);
        }
      }
    },
  );

  test(
    "an already-active same-origin service worker stops the run before any field is touched",
    { timeout: 120_000 },
    async () => {
      const app = await startTrackedServer();
      app.registerHtml(
        "/active-seed",
        `<h1>seed</h1><script>navigator.serviceWorker.register('/active-sw.js');</script>`,
      );
      app.registerScript(
        "/active-sw.js",
        `self.addEventListener('install', function () { self.skipWaiting(); });
         self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });`,
      );
      app.registerHtml(
        "/active-apply",
        `<form><label for="email">Email address</label><input id="email"></form>`,
      );
      if (!browser) {
        throw new Error("The fixture browser is not running.");
      }
      const context = await browser.newContext();
      activeContexts.push(context);
      const seedPage = await context.newPage();
      await seedPage.goto(`${app.baseUrl}/active-seed`);
      const seededActive = await waitForCondition(
        () => context.serviceWorkers().length > 0,
        20_000,
        250,
      );
      expect(seededActive).toBe(true);

      const applyPage = await context.newPage();
      const applicationUrl = `${app.baseUrl}/active-apply`;
      await applyPage.goto(applicationUrl);

      const outcome = await prepareFixtureFormUnderGuard({
        context,
        page: applyPage,
        applicationUrl,
      });

      expect(outcome.stoppedBeforeAnyField).toBe(true);
      expect(outcome.serviceWorkerDetail).toContain("/active-sw.js");
      expect(outcome.filledValues).toHaveLength(0);
      // The field the run never reached is still empty.
      expect(
        await applyPage.evaluate(
          () =>
            document.querySelector<HTMLInputElement>("#email")?.value ?? null,
        ),
      ).toBe("");
      expect(app.hits.filter((hit) => hit.method !== "GET")).toHaveLength(0);
    },
  );
});

test.each(["click", "enter"] as const)(
  "automation %s stays blocked without site-DOM notices, then person handoff sends once",
  async (action) => {
    const app = await startTrackedServer();
    app.registerHtml(
      "/review-required",
      `<form action="/manual-send" method="post" target="receipt">
    <input id="name" name="name"><button id="send" type="submit">Send application</button></form><iframe name="receipt"></iframe>`,
    );
    const { page } = await newGuardedPage();
    await page.goto(`${app.baseUrl}/review-required`);
    await page.fill("#name", "Synthetic Person");
    await page.evaluate(
      registerPrepareOnlyPreparedValueInPage,
      "Synthetic Person",
    );
    if (action === "click") await page.click("#send");
    else await page.press("#send", "Enter");
    expect(requestHitsFor(app.hits, "/manual-send")).toHaveLength(0);
    expect(await page.locator("#nestor-send-review-required").count()).toBe(0);
    await openPrepareOnlyFinalActionWindow(page);
    await page.click("#send");
    await page.waitForTimeout(200);
    expect(requestHitsFor(app.hits, "/manual-send")).toHaveLength(1);
  },
);
