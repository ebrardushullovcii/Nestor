import finalMutationReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/intermediate-final-mutations.json";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ApplyRequestPermit } from "@nestor/contracts";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Request,
} from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  allowPrepareOnlyRunNavigation,
  ensurePrepareOnlyMutationGuard,
  getPrepareOnlyRequestPermit,
  openPrepareOnlyAttachmentUploadWindow,
  openPrepareOnlyIntermediateMutationWindow,
  readPrepareOnlyMutationGuardInPage,
  registerPrepareOnlyPreparedValue,
} from "./playwright-application-flow";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";

/**
 * Fill in for me sends nothing without the person's own click, except the
 * selected resume. Each case here is one the send-path review proved could
 * leave under the old field and step-save windows.
 */

interface Hit {
  method: string;
  path: string;
  query: string;
}

interface Site {
  baseUrl: string;
  hits: Hit[];
  html: (path: string, body: string) => void;
  close: () => Promise<void>;
}

async function startSite(redirectTo?: () => string): Promise<Site> {
  const hits: Hit[] = [];
  const pages = new Map<string, string>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      hits.push({
        method: request.method ?? "GET",
        path: url.pathname,
        query: url.search,
      });
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Headers", "*");
      const page = pages.get(url.pathname);
      if (page !== undefined) {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(page);
        return;
      }
      if (url.pathname === "/upload-leaves" && redirectTo) {
        response.writeHead(307, { Location: redirectTo() });
        response.end();
        return;
      }
      if (url.pathname === "/go") {
        response.writeHead(302, { Location: "/api/submit?applicationId=42" });
        response.end();
        return;
      }
      if (url.pathname === "/api/next") {
        response.writeHead(302, { Location: "/api/submit?applicationId=42" });
        response.end();
        return;
      }
      if (url.pathname === "/upload-final" && !url.search) {
        response.writeHead(307, {
          Location: "/upload-final?action=submit&final=true",
        });
        response.end();
        return;
      }
      if (url.pathname === "/upload-stays" && !url.search) {
        response.writeHead(307, { Location: "/upload-stays?part=2" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"uploaded":true}');
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const site: Site = {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    html: (path, body) => pages.set(path, body),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  sites.push(site);
  return site;
}

let browser: Browser | null = null;
const sites: Site[] = [];
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await Promise.all(sites.splice(0).map((site) => site.close()));
});
afterAll(async () => {
  await browser?.close();
  browser = null;
}, 120_000);

/** A page in Fill in for me: no saves authorized, attachments authorized. */
async function fillPage(site: Site, path: string) {
  const context = await browser!.newContext();
  contexts.push(context);
  const page = await context.newPage();
  await ensurePrepareOnlyMutationGuard(page, false, [], true);
  await page.goto(`${site.baseUrl}${path}`);
  return page;
}

const writes = (site: Site) =>
  site.hits.filter((hit) => !["GET", "HEAD", "OPTIONS"].includes(hit.method));

const resume = {
  name: "robin-ashford.pdf",
  mimeType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic resume bytes"),
};

/** Posts the selected resume the way an upload script does. */
const postResume = (page: Awaited<ReturnType<typeof fillPage>>, url: string) =>
  page.evaluate(
    async ({ url, name, bytes }) => {
      const body = new FormData();
      body.append(
        "file",
        new File([new Uint8Array(bytes)], name, { type: "application/pdf" }),
      );
      try {
        return (await fetch(url, { method: "POST", body })).ok;
      } catch {
        return false;
      }
    },
    { url, name: resume.name, bytes: [...resume.bytes] },
  );

describe("Fill in for me sends nothing but the selected resume", () => {
  test("handlers that send on input, select, picker open, and Next/Continue finals all stay on the page", async () => {
    const site = await startSite();
    site.html(
      "/form",
      `<input id="name" name="name" onchange="fetch('/api/application',{method:'POST',body:JSON.stringify({name:this.value})}).catch(()=>{})">
       <select id="country" onchange="fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({country:this.value})}).catch(()=>{})"><option value=""></option><option value="PT">Portugal</option></select>
       <button id="picker" type="button" onclick="fetch('/api/apply-now',{method:'POST',body:'{}'}).catch(()=>{})">Choose a country</button>
       <button id="next" type="button" onclick="fetch('/api/finalize',{method:'POST',body:JSON.stringify({name:document.getElementById('name').value})}).catch(()=>{})">Next</button>
       <button id="continue" type="button" onclick="fetch('/api/save',{method:'POST',body:JSON.stringify({name:document.getElementById('name').value,final:true})}).catch(()=>{})">Continue</button>`,
    );
    const page = await fillPage(site, "/form");
    await registerPrepareOnlyPreparedValue(page, "Robin Ashford");
    await page.fill("#name", "Robin Ashford");
    await page.locator("#name").dispatchEvent("change");
    await page.selectOption("#country", "PT");
    await page.click("#picker");
    await page.click("#next");
    await page.click("#continue");
    await page.waitForTimeout(300);
    expect(writes(site)).toEqual([]);
  });

  test("a save window cannot be opened in Fill at all", async () => {
    const site = await startSite();
    site.html("/form", "<input>");
    const page = await fillPage(site, "/form");
    await expect(
      openPrepareOnlyIntermediateMutationWindow(page),
    ).rejects.toThrow(/outside the explicit intermediate-mutation authority/u);
  });

  test("reads and GraphQL queries pass; a GET naming a final action, analytics, mutations and beacons do not", async () => {
    const site = await startSite();
    site.html("/form", "<input>");
    const page = await fillPage(site, "/form");
    const outcomes = await page.evaluate(async () => {
      const ok = (input: string, init?: RequestInit) =>
        fetch(input, init).then(
          (response) => response.ok,
          () => false,
        );
      return {
        read: await ok("/api/jobs/42"),
        submitRead: await ok("/api/submit?applicationId=42"),
        analytics: await ok("/api/analytics", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "submit" }),
        }),
        graphQlRead: await ok("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "query Job { job { id } }" }),
        }),
        graphQlSubmitQuery: await ok("/graphql?op=Submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: "query SubmitApplication { submitApplication { id } }",
          }),
        }),
        graphQlMutation: await ok("/graphql?op=Save", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "mutation Save { save { id } }" }),
        }),
        beacon: navigator.sendBeacon("/api/collect", "event=submit"),
      };
    });
    expect(outcomes).toMatchObject({
      read: true,
      submitRead: false,
      analytics: false,
      graphQlRead: true,
      graphQlSubmitQuery: false,
      graphQlMutation: false,
    });
    await page.waitForTimeout(200);
    expect(site.hits.map((hit) => hit.path)).not.toContain("/api/submit");
    // The one write that left is the GraphQL query the page loads itself with.
    expect(writes(site).map((hit) => `${hit.path}${hit.query}`)).toEqual([
      "/graphql",
    ]);
  });

  test("the Apply agent's completion probes and generated final shapes never leave", async () => {
    const site = await startSite();
    site.html("/form", "<input>");
    const page = await fillPage(site, "/form");
    await registerPrepareOnlyPreparedValue(page, "Robin Ashford");
    const verbs = [
      "submit",
      "absenden",
      "envoyer",
      "postuler",
      "enviar",
      "inviare",
      "verzenden",
      "wyslij",
      "Fertig",
      "Terminé",
      "✓",
      "",
    ];
    const bodies = [
      ...finalMutationReplay.completionProbes.map((probe) => ({
        path: probe.path,
        body: probe.body,
      })),
      ...verbs.flatMap((verb) =>
        ["/api/autosave/field", "/graphql", "/api/v2/answers/save"].map(
          (path) => ({
            path,
            body: JSON.stringify({ action: verb, name: "Robin Ashford" }),
          }),
        ),
      ),
    ];
    const results = await page.evaluate(
      async (requests) =>
        Promise.all(
          requests.map(({ path, body }) =>
            fetch(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }).then(
              (response) => response.ok,
              () => false,
            ),
          ),
        ),
      bodies,
    );
    expect(results.every((sent) => !sent)).toBe(true);
    expect(writes(site)).toEqual([]);
  });

  test("the exact resume uploads with a permit; a redirect that stays on its endpoint is followed", async () => {
    const site = await startSite();
    site.html("/form", '<input type="file" name="resume">');
    const page = await fillPage(site, "/form");
    const requests: Request[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") requests.push(request);
    });
    await openPrepareOnlyAttachmentUploadWindow(page, resume, "resume");
    expect(await postResume(page, "/upload-stays")).toBe(true);
    expect(writes(site).map((hit) => `${hit.path}${hit.query}`)).toEqual([
      "/upload-stays",
      "/upload-stays?part=2",
    ]);
    const carrier = requests.find((request) =>
      request.url().endsWith("/upload-stays"),
    )!;
    expect(getPrepareOnlyRequestPermit(carrier)).toEqual({
      actionKind: "upload",
      frameOrigin: site.baseUrl,
      method: "POST",
      endpoint: `${site.baseUrl}/upload-stays`,
      authorizedCarrier: carrier,
      file: {
        field: "resume",
        name: resume.name,
        size: resume.bytes.byteLength,
        sha256: createHash("sha256").update(resume.bytes).digest("hex"),
      },
      uploadLeg: "file",
    } satisfies ApplyRequestPermit);
  });

  test.each(["same-origin", "cross-origin"] as const)(
    "an upload redirected to /api/submit (%s) is never followed",
    async (where) => {
      const elsewhere = await startSite();
      const site = await startSite(() =>
        where === "same-origin"
          ? "/api/submit"
          : `${elsewhere.baseUrl}/api/submit`,
      );
      site.html("/form", '<input type="file" name="resume">');
      const page = await fillPage(site, "/form");
      const requests: Request[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") requests.push(request);
      });
      await openPrepareOnlyAttachmentUploadWindow(page, resume, "resume");
      expect(await postResume(page, "/upload-leaves")).toBe(false);
      await page.waitForTimeout(200);
      expect(writes(site).map((hit) => hit.path)).toEqual(["/upload-leaves"]);
      expect(writes(elsewhere)).toEqual([]);
      expect(
        getPrepareOnlyRequestPermit(
          requests.find((request) => request.url().endsWith("/upload-leaves"))!,
        ),
      ).toBeNull();
    },
  );

  test('"Done" after the upload window is shut cannot carry the file', async () => {
    const site = await startSite();
    site.html(
      "/form",
      `<input type="file" name="resume">
       <button id="done" type="button">Done</button>`,
    );
    const page = await fillPage(site, "/form");
    const session = createPlaywrightApplyPageSession({ page });
    await openPrepareOnlyAttachmentUploadWindow(page, resume, "resume");
    // What the executor does before every press that is not a field write.
    await session.closeUploadWindow();
    expect(await postResume(page, "/upload-ok")).toBe(false);
    await page.waitForTimeout(200);
    expect(writes(site)).toEqual([]);
  });
  test("a read that redirects to a final action is not followed there", async () => {
    const site = await startSite();
    site.html("/form", "<input>");
    const page = await fillPage(site, "/form");
    const sent = await page.evaluate(() =>
      fetch("/api/next").then(
        (response) => response.ok,
        () => false,
      ),
    );
    expect(sent).toBe(false);
    expect(site.hits.map((hit) => hit.path)).toContain("/api/next");
    expect(site.hits.map((hit) => hit.path)).not.toContain("/api/submit");
  });

  test("an upload redirected to its own path with ?action=submit&final=true is not followed", async () => {
    const site = await startSite();
    site.html("/form", '<input type="file" name="resume">');
    const page = await fillPage(site, "/form");
    await openPrepareOnlyAttachmentUploadWindow(page, resume, "resume");
    expect(await postResume(page, "/upload-final")).toBe(false);
    expect(writes(site).map((hit) => `${hit.path}${hit.query}`)).toEqual([
      "/upload-final",
    ]);
  });

  test("a native select's value never leaves, though the run declared its label", async () => {
    const site = await startSite();
    site.html(
      "/form",
      `<label for="country">Country</label>
       <select id="country" name="country"><option value=""></option><option value="PT">Portugal</option></select>`,
    );
    const page = await fillPage(site, "/form");
    const session = createPlaywrightApplyPageSession({ page });
    const select = (await session.readPage()).controls.find(
      (control) => control.id === "country",
    )!;
    await registerPrepareOnlyPreparedValue(page, "Portugal");
    await session.chooseOption(select.ref ?? `c${select.index}`, "Portugal");
    const sent = await page.evaluate(() =>
      fetch("/api/save?country=PT").then(
        (response) => response.ok,
        () => false,
      ),
    );
    expect(sent).toBe(false);
    expect(site.hits.map((hit) => hit.path)).not.toContain("/api/save");
  });

  test("GraphQL is read by its parser: a CR-hidden mutation and a defaulted answer never pass", async () => {
    const site = await startSite();
    site.html("/form", "<input>");
    const page = await fillPage(site, "/form");
    await registerPrepareOnlyPreparedValue(page, "robin@example.test");
    const results = await page.evaluate(async () => {
      const post = (query: string) =>
        fetch("/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        }).then(
          (response) => response.ok,
          () => false,
        );
      return [
        await post("# just a note\rmutation Save { save { id } }"),
        await post(
          // The default spells the answer with a GraphQL escape.
          'query Check($email: String = "robin\\u0040example.test") { exists(email: $email) }',
        ),
        await post("query Posting { posting { title } }"),
      ];
    });
    expect(results).toEqual([false, false, true]);
  });
  test("a navigation the page starts, or its redirect, never reaches a final action", async () => {
    const site = await startSite();
    site.html(
      "/form",
      `<button id="assign" type="button" onclick="location.assign('/api/submit?applicationId=42')">x</button>
       <a id="hop" href="/go">Continue</a>`,
    );
    // A blocked navigation leaves an error page, so each starts fresh.
    for (const id of ["#assign", "#hop"]) {
      const page = await fillPage(site, "/form");
      await page.click(id, { noWaitAfter: true });
      await page.waitForTimeout(400);
    }
    expect(site.hits.map((hit) => hit.path)).not.toContain("/api/submit");
    expect(site.hits.map((hit) => hit.path)).toContain("/go");
  });

  test("a radio's own value never leaves when it is chosen, though its label was declared", async () => {
    const site = await startSite();
    site.html(
      "/form",
      `<fieldset><legend>Country</legend>
       <label><input type="radio" id="pt" name="country" value="PT"
         onchange="fetch('/api/save?country=' + this.value).catch(() => {})">Portugal</label>
       <label><input type="radio" id="es" name="country" value="ES">Spain</label></fieldset>`,
    );
    const page = await fillPage(site, "/form");
    const session = createPlaywrightApplyPageSession({ page });
    const radio = (await session.readPage()).controls.find(
      (control) => control.id === "pt",
    )!;
    await session.setToggle(radio.ref ?? `c${radio.index}`, true);
    await page.waitForTimeout(300);
    expect(await page.isChecked("#pt")).toBe(true);
    expect(site.hits.map((hit) => hit.path)).not.toContain("/api/save");
  });
  test("the run's own navigation is good once: the page cannot reuse it", async () => {
    const site = await startSite();
    site.html("/apply", "<p>Apply</p>");
    const context = await browser!.newContext();
    contexts.push(context);
    const page = await context.newPage();
    await ensurePrepareOnlyMutationGuard(page, false, [], true);
    allowPrepareOnlyRunNavigation(page, `${site.baseUrl}/apply`);
    await page.goto(`${site.baseUrl}/apply`);
    await page.evaluate(() => location.assign("/apply?applicationId=42"));
    await page.waitForTimeout(400);
    expect(
      site.hits.filter((hit) => hit.path === "/apply").map((hit) => hit.query),
    ).toEqual([""]);
  });

  test('a checkbox without a value attribute never sends its "on"', async () => {
    const site = await startSite();
    site.html(
      "/form",
      `<label><input id="check" name="consent" type="checkbox"
         onchange="fetch('/api/save?consent=' + this.value).catch(() => {})">I agree</label>`,
    );
    const page = await fillPage(site, "/form");
    const session = createPlaywrightApplyPageSession({ page });
    const check = (await session.readPage()).controls.find(
      (control) => control.id === "check",
    )!;
    await session.setToggle(check.ref ?? `c${check.index}`, true);
    await page.waitForTimeout(300);
    expect(await page.isChecked("#check")).toBe(true);
    expect(site.hits.map((hit) => hit.path)).not.toContain("/api/save");
  });
});

test("every request the page guard refuses is on record, with what kind of body it had", async () => {
  const site = await startSite();
  site.html("/form", '<input type="file" name="resume">');
  const page = await fillPage(site, "/form");
  // No upload window is open: the file post is refused in the page.
  expect(await postResume(page, "/upload-ok")).toBe(false);
  const { refusals, blockedAttempts } = await page.evaluate(
    readPrepareOnlyMutationGuardInPage,
  );
  expect(refusals).toEqual([
    expect.objectContaining({
      kind: "fetch",
      method: "POST",
      url: `${site.baseUrl}/upload-ok`,
      body: "form_data",
    }),
  ]);
  // Only the record grows: what stops a run is unchanged.
  expect(blockedAttempts).toEqual([]);
});
