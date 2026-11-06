import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";
import { expect, test, vi } from "vitest";
import {
  ApplyExecutionResultSchema,
  CandidateProfileSchema,
  SavedJobSchema,
  type ApplyPageSession,
} from "@nestor/contracts";
import { createBrowserAgentRuntime } from "./playwright-browser-runtime";
import {
  createApplicationRunServiceWorkerSentinel,
  getBlockedPrepareOnlyAttempts,
  readPrepareOnlyMutationGuardInPage,
  installAccountWindowContainment,
  recordPrepareOnlyRunInterruption,
  openPrepareOnlyFinalActionWindow,
  openPrepareOnlyIntermediateMutationWindow,
  openPrepareOnlyAttachmentUploadWindow,
} from "./playwright-application-flow";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "./application-submission-browser-hands";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";

const PREPARED = "synthetic-prepared-value-7591";
type RequestLog = {
  side: "application" | "provider";
  method: string;
  path: string;
  body: string;
  cookie: string;
  status?: number;
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nestor-account-window-"));
  const requests: RequestLog[] = [];
  let applicationOrigin = "",
    providerOrigin = "";
  const listen = async (side: RequestLog["side"]) => {
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          void (async () => {
            const url = new URL(request.url ?? "/", "http://fixture");
            const entry: RequestLog = {
              side,
              method: request.method ?? "GET",
              path: url.pathname,
              body,
              cookie: request.headers.cookie ?? "",
            };
            requests.push(entry);
            response.on("finish", () => {
              entry.status = response.statusCode;
            });
            response.setHeader("Content-Type", "text/html");
            if (url.pathname === "/select") {
              response.end("Selected synthetic item");
              return;
            }
            if (
              ["/redirect-post", "/redirect-post-308"].includes(url.pathname)
            ) {
              response.writeHead(url.pathname.endsWith("308") ? 308 : 307, {
                location: applicationOrigin + "/submit",
              });
              response.end();
              return;
            }
            if (url.pathname === "/redirect-get") {
              response.writeHead(303, {
                location: applicationOrigin + "/callback",
              });
              response.end();
              return;
            }
            if (
              url.pathname === "/prepared-307" ||
              url.pathname === "/prepared-303"
            ) {
              response.writeHead(url.pathname.endsWith("307") ? 307 : 303, {
                location:
                  providerOrigin + "/prepared-destination?answer=" + PREPARED,
              });
              response.end();
              return;
            }
            if (url.pathname === "/navigation-post") {
              response.writeHead(303, {
                location: applicationOrigin + "/one-use-callback",
                "Set-Cookie":
                  "provider_after=synthetic-303; Path=/; SameSite=Lax",
              });
              response.end();
              return;
            }
            if (url.pathname === "/navigation-redirect") {
              response.writeHead(302, {
                location: applicationOrigin + "/one-use-callback",
              });
              response.end();
              return;
            }
            if (url.pathname === "/one-use-callback") {
              const count = requests.filter(
                (item) => item.path === "/one-use-callback",
              ).length;
              response.statusCode = count === 1 ? 200 : 409;
              response.end(
                count === 1
                  ? `<body>Single-use callback accepted<script>opener.postMessage({type:'synthetic-auth-return',url:location.href,origin:location.origin,hasOpener:!!opener},'*');close()</script>`
                  : "Single-use callback already consumed",
              );
              return;
            }
            if (url.pathname === "/submit") {
              response.end("Unexpected application write");
              return;
            }
            const placement = url.searchParams.get("placement") ?? "top";
            const behavior = url.searchParams.get("behavior") ?? "message";
            if (side === "application" && url.pathname === "/callback") {
              response.end(
                `<script>opener.postMessage('synthetic-auth-return','*');close()</script>`,
              );
              return;
            }
            const target = `${providerOrigin}/auth?behavior=${behavior}`;
            const click =
              behavior === "indirect-named"
                ? `document.querySelector('#native-account').click()`
                : behavior === "spa"
                  ? `history.pushState({},'',location.pathname+'#signin');window.lastPopup=window.open('${target}')`
                  : behavior === "same-tab"
                    ? `location.href='${applicationOrigin}/continued'`
                    : behavior === "named"
                      ? `window.open('${target}','existing-person-window')`
                      : behavior === "blank-first"
                        ? `window.open('')`
                        : behavior === "noopener"
                          ? `window.open('${target}','_blank','noopener')`
                          : behavior === "two"
                            ? `window.open('${target}');window.open('${target}')`
                            : `window.lastPopup=window.open('${target}')`;
            const button = `<button type="button" id="account" onclick="${click}">Choose account</button>${behavior === "indirect-named" ? `<a id="native-account" hidden target="provider-auth" href="${target}">Hidden provider route</a>` : ""}`;
            const relay = `<script>addEventListener('message',event=>{if(event.data==='synthetic-auth-return')parent.postMessage(event.data,'*')})</script>`;
            let html: string;
            if (side === "provider" && url.pathname === "/button")
              html = button + relay;
            else if (
              side === "provider" &&
              [
                "navigation-post",
                "deny-307",
                "deny-308",
                "prepared-body",
                "prepared-307",
                "prepared-303",
              ].includes(behavior)
            ) {
              const destination =
                behavior === "deny-307"
                  ? "/redirect-post"
                  : behavior === "deny-308"
                    ? "/redirect-post-308"
                    : behavior === "prepared-body"
                      ? "/prepared-destination"
                      : "/" + behavior;
              html = `<form method="POST" action="${destination}"><input type="hidden" name="payload" value="${behavior === "prepared-body" ? PREPARED : "synthetic=one"}"><button id="select">Synthetic account</button></form>`;
            } else if (side === "provider") {
              const action =
                behavior === "navigation-get"
                  ? `location.href='/navigation-redirect';`
                  : behavior === "prepared-query"
                    ? `location.href='/prepared-destination?answer=${PREPARED}';`
                    : behavior.startsWith("redirect-")
                      ? `await fetch('/${behavior}',{method:'POST',body:'synthetic=one'}).catch(()=>{});`
                      : behavior === "bad-post"
                        ? `await fetch('${applicationOrigin}/submit',{method:'POST',body:'${PREPARED}'}).catch(()=>{});`
                        : behavior === "leak-get"
                          ? `await fetch('/leak?answer=${PREPARED}').catch(()=>{});`
                          : behavior === "opener-submit"
                            ? `opener.document.forms[0].requestSubmit();`
                            : behavior === "grandchild"
                              ? `window.open('/extra');`
                              : `await fetch('/select',{method:'POST',body:'synthetic=one'});`;
              const returning =
                behavior === "callback"
                  ? `location.href='${applicationOrigin}/callback'`
                  : [
                        "grandchild",
                        "budget",
                        "navigation-get",
                        "prepared-query",
                      ].includes(behavior)
                    ? ""
                    : `opener.postMessage('synthetic-auth-return','*');close()`;
              html = `<button type="button" id="select" onclick="(async()=>{${action}${returning}})()">Synthetic account</button>`;
            } else
              html = `<form method="POST" action="/submit"><label>Prepared field<input name="prepared" value="${PREPARED}"></label><button>Send application</button></form><output id="messages">0</output>${placement === "frame" ? `<iframe src="${providerOrigin}/button?behavior=${behavior}"></iframe>` : button}<script>addEventListener('message',event=>{if(event.data==='synthetic-auth-return'||event.data?.type==='synthetic-auth-return'){const out=document.querySelector('#messages');out.textContent=String(Number(out.textContent)+1);out.dataset.returned=JSON.stringify({data:event.data,origin:event.origin})}})</script>`;
            // The actual synthetic fixture files and artifacts live outside the checkout.
            const file = join(
              directory,
              `${side}-${url.pathname.replace(/\W/gu, "_")}.html`,
            );
            await writeFile(file, html);
            response.end(await readFile(file));
          })().catch((error: unknown) => {
            response.statusCode = 500;
            response.end(String(error));
          });
        });
      },
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return server;
  };
  const application = await listen("application"),
    provider = await listen("provider");
  applicationOrigin = `http://127.0.0.1:${(application.address() as AddressInfo).port}`;
  providerOrigin = `http://localhost:${(provider.address() as AddressInfo).port}`;
  const artifactPath = join(directory, "synthetic.txt");
  await writeFile(artifactPath, "Synthetic resume only");
  return {
    applicationOrigin,
    providerOrigin,
    requests,
    artifactPath,
    close: async () => {
      await Promise.all(
        [application, provider].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function createTestJob() {
  return SavedJobSchema.parse({
    id: "job_visual_runtime",
    source: "target_site" as const,
    sourceJobId: "job_visual_runtime",
    discoveryMethod: "catalog_seed" as const,
    collectionMethod: "fallback_search" as const,
    canonicalUrl: "https://example.com/jobs/job_visual_runtime",
    applicationUrl: "https://example.com/apply/job_visual_runtime",
    title: "Senior Engineer",
    company: "Example Co",
    location: "Remote",
    workMode: ["remote" as const],
    applyPath: "external_redirect" as const,
    easyApplyEligible: false,
    postedAt: "2026-03-20T09:00:00.000Z",
    postedAtText: null,
    providerUpdatedAt: null,
    discoveredAt: "2026-03-20T10:00:00.000Z",
    firstSeenAt: null,
    lastSeenAt: null,
    lastVerifiedActiveAt: null,
    salaryText: null,
    normalizedCompensation: {
      currency: null,
      interval: null,
      minAmount: null,
      maxAmount: null,
      minAnnualUsd: null,
      maxAnnualUsd: null,
    },
    detailQuality: "detail_enriched" as const,
    summary: "Build resilient workflows.",
    description:
      "Upload resume and review required fields before final submit.",
    keySkills: ["TypeScript"],
    responsibilities: [],
    minimumQualifications: [],
    preferredQualifications: [],
    seniority: null,
    employmentType: null,
    department: null,
    team: null,
    employerWebsiteUrl: null,
    employerDomain: null,
    atsProvider: null,
    providerKey: null,
    providerBoardToken: null,
    providerIdentifier: null,
    titleTriageOutcome: "pass" as const,
    sourceIntelligence: null,
    screeningHints: {
      sponsorshipText: null,
      requiresSecurityClearance: null,
      relocationText: null,
      travelText: null,
      remoteGeographies: [],
      requiresConsentInterrupt: null,
      requiresConsentInterruptKind: null,
    },
    keywordSignals: [],
    benefits: [],
    status: "approved" as const,
    matchAssessment: {
      score: 91,
      reasons: ["Strong fit"],
      gaps: [],
      recommendation: "review_before_applying" as const,
      recommendationRationale: "Test fixture requires explicit review.",
      requirements: [],
    },
    provenance: [],
  });
}

const result = () =>
  ApplyExecutionResultSchema.parse({
    state: "paused",
    summary: "Local account proof",
    detail: "No real provider or application send",
    submittedAt: null,
    outcome: null,
    nextActionLabel: "Review",
  });
async function runFlow(
  placement: "top" | "frame",
  behavior: string,
  proof: (input: {
    session: ApplyPageSession;
    root: Page;
    context: BrowserContext;
    site: Awaited<ReturnType<typeof fixture>>;
    abort: AbortController;
    events: Array<{ page: Page; kind: string }>;
    handoff: () => ReturnType<
      NonNullable<
        ReturnType<
          typeof createBrowserAgentRuntime
        >["handApplicationPageToPerson"]
      >
    >;
  }) => Promise<void>,
) {
  const site = await fixture();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const events: Array<{ page: Page; kind: string }> = [];
  context.on("page", (page) => {
    const route = page.route.bind(page),
      init = page.addInitScript.bind(page);
    vi.spyOn(page, "route").mockImplementation(async (...args) => {
      const installed = await route(...args);
      events.push({ page, kind: "route-installed" });
      return installed;
    });
    vi.spyOn(page, "addInitScript").mockImplementation(async (...args) => {
      const installed = await init(...args);
      events.push({ page, kind: "init-installed" });
      return installed;
    });
    page.on("request", () => {
      events.push({ page, kind: "request" });
    });
  });
  let root: Page | null = null;
  const abort = new AbortController();
  const runtime = createBrowserAgentRuntime({
    userDataDir: "/unused",
    browserHost: {
      connect: () => Promise.resolve(browser),
      getOpenBrowser: () => Promise.resolve(browser),
      close: () => Promise.resolve(),
      assertAutomationSafe: () => Promise.resolve(),
    },
  });
  const url = `${site.applicationOrigin}/apply?placement=${placement}&behavior=${behavior}`;
  try {
    const execution = await runtime.executeApplicationFlow(
      "target_site",
      {
        job: { ...createTestJob(), canonicalUrl: url, applicationUrl: url },
        profile: CandidateProfileSchema.parse({
          id: "synthetic",
          fullName: "Robin Example",
          yearsExperience: 1,
          baseResume: {
            id: "synthetic",
            fileName: "synthetic.txt",
            uploadedAt: "2026-11-03T00:00:00.000Z",
            extractionStatus: "ready",
          },
        }),
        settings: {
          resumeFormat: "pdf",
          resumeTemplateId: "classic_ats",
          fontPreset: "inter_requisite",
          appearanceTheme: "system",
          humanReviewRequired: true,
          allowAutoSubmitOverride: false,
        },
        resumeArtifact: {
          id: "synthetic",
          jobId: "job_visual_runtime",
          source: "original_upload",
          sourceDocumentId: "synthetic",
          exportArtifactId: null,
          fileName: "synthetic.txt",
          filePath: site.artifactPath,
          approvedAt: "2026-11-03T00:00:00.000Z",
        },
        mode: "prepare_only",
        submitAuthorized: false,
        applicationPageBindingKey: "local-account-operation",
        prepareApplicationForm: async ({ session }) => {
          await session.installPrepareOnlyGuard({
            intermediateMutationsAuthorized: false,
            attachmentUploadsAuthorized: false,
            allowedOrigins: [],
          });
          await session.registerPreparedValue(PREPARED);
          await proof({
            session,
            root: root!,
            context,
            site,
            abort,
            events,
            handoff: () =>
              runtime.handApplicationPageToPerson!(
                "target_site",
                "local-account-operation",
              ),
          });
          return result();
        },
      },
      {
        signal: abort.signal,
        onAutomationPage: (page) => {
          root = page;
          return Promise.resolve();
        },
      },
    );
    expect(execution.state, execution.detail).toBe("paused");
    expect(
      (
        await runtime.readApplicationPageBinding!(
          "target_site",
          "local-account-operation",
        )
      )?.url,
    ).toBe(root!.url());
    expect(
      site.requests.filter(
        (request) =>
          request.side === "application" &&
          !["GET", "HEAD", "OPTIONS"].includes(request.method),
      ),
    ).toEqual([]);
  } finally {
    await browser.close();
    await site.close();
  }
}

async function open(input: {
  session: ApplyPageSession;
  site: Awaited<ReturnType<typeof fixture>>;
}) {
  const raw = await input.session.readPage();
  const action = raw.actions.find((item) => item.label === "Choose account")!;
  expect(action).toBeDefined();
  return input.session.clickOpeningAccountWindow!({
    ref: action.ref ?? `a${action.index}`,
    frame: action.frame ?? null,
    writeOrigins: [input.site.providerOrigin],
  });
}

test.each([
  ["top", "message"],
  ["top", "callback"],
  ["frame", "message"],
  ["frame", "callback"],
] as const)(
  "guarded account return preserves the actual operation: %s / %s",
  async (placement, behavior) => {
    await runFlow(placement, behavior, async (input) => {
      const before = await input.session.readPage();
      expect(await open(input)).toMatchObject({ kind: "opened" });
      const child = input.context.pages().find((page) => page !== input.root)!;
      expect(await child.opener()).toBe(input.root);
      expect(await child.evaluate(() => window.opener !== null)).toBe(true);
      const order = input.events
        .filter((event) => event.page === child)
        .map((event) => event.kind);
      expect(order.indexOf("route-installed")).toBeLessThan(
        order.indexOf("request"),
      );
      expect(order.indexOf("init-installed")).toBeLessThan(
        order.indexOf("request"),
      );
      const account = await input.session.readPage();
      expect(account.accountWindow).toEqual({
        origin: input.site.providerOrigin,
        pathname: "/auth",
        actionsLeft: 1,
      });
      const select = account.actions.find(
        (item) => item.label === "Synthetic account",
      )!;
      expect(
        await input.session.clickElement(select.ref ?? `a${select.index}`),
      ).toMatchObject({ ok: true });
      const after = await input.session.readPage();
      expect(after.accountWindow).toBeUndefined();
      expect(after.url).toBe(before.url);
      expect(child.isClosed()).toBe(true);
      expect(await input.root.locator("#messages").textContent()).toBe("1");
      expect(
        after.controls.find((item) => item.name === "prepared")?.value,
      ).toBe(PREPARED);
      expect(after.openedTabs).toEqual(before.openedTabs);
      expect(
        input.site.requests.filter(
          (request) => request.side === "provider" && request.method === "POST",
        ),
      ).toEqual([
        expect.objectContaining({ path: "/select", body: "synthetic=one" }),
      ]);
      expect(
        (await getBlockedPrepareOnlyAttempts(input.root)).filter(
          (attempt) => attempt.carriedPreparedValue,
        ),
      ).toEqual([]);
    });
  },
  30_000,
);

test.each(["blank-first", "noopener"])(
  "unsupported %s account windows remain closed with the prepared form intact",
  async (behavior) => {
    await runFlow("top", behavior, async (input) => {
      expect(await open(input)).toMatchObject({
        kind: "refused",
        reason: "window_blocked",
      });
      expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
      expect(input.context.pages()).toEqual([input.root]);
    });
  },
  30_000,
);

test("an active child blocks application writes and all short windows without replacing the binding", async () => {
  await runFlow("top", "message", async (input) => {
    expect(await open(input)).toMatchObject({ kind: "opened" });
    expect(await input.session.fillText("c0", "must-not-write")).toMatchObject({
      ok: false,
    });
    expect(await input.session.clickAuthorizedFormAction("a0")).toMatchObject({
      ok: false,
    });
    await expect(input.session.openIntermediateWriteWindow()).rejects.toThrow(
      "account window",
    );
    await expect(
      input.session.installPrepareOnlyGuard({
        intermediateMutationsAuthorized: true,
        allowedOrigins: [],
      }),
    ).rejects.toThrow("account window");
    await expect(openPrepareOnlyFinalActionWindow(input.root)).rejects.toThrow(
      "account window",
    );
    await expect(
      openPrepareOnlyIntermediateMutationWindow(input.root),
    ).rejects.toThrow("account window");
    await expect(
      openPrepareOnlyAttachmentUploadWindow(input.root, {
        name: "synthetic.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("account window");
    await input.root.evaluate(() => {
      void fetch("/submit", { method: "POST", body: "synthetic" }).catch(
        () => undefined,
      );
    });
    expect(
      (await getBlockedPrepareOnlyAttempts(input.root)).some(
        (attempt) =>
          ["fetch", "network_request"].includes(attempt.kind) &&
          attempt.method === "POST" &&
          attempt.url?.endsWith("/submit"),
      ),
    ).toBe(true);
    expect(
      input.site.requests.filter(
        (request) =>
          request.side === "application" && request.method === "POST",
      ),
    ).toEqual([]);
    expect(
      input.site.requests.filter((request) => request.path === "/submit"),
    ).toEqual([]);
    const child = input.context.pages().find((page) => page !== input.root)!;
    await child.close();
    expect((await input.session.readPage()).accountWindow).toBeUndefined();
    expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
  });
}, 30_000);

test("fresh account binding rejects changed labels and changed owner frames before any click", async () => {
  await runFlow("frame", "message", async (input) => {
    const raw = await input.session.readPage();
    const item = raw.actions.find((item) => item.label === "Choose account")!;
    const grant = {
      ref: item.ref ?? `a${item.index}`,
      frame: item.frame ?? null,
      writeOrigins: [input.site.providerOrigin],
    };
    const frame = input.root
      .frames()
      .find((frame) => frame !== input.root.mainFrame())!;
    await frame.locator("#account").evaluate((element) => {
      element.textContent = "Changed account";
    });
    expect(await input.session.clickOpeningAccountWindow!(grant)).toMatchObject(
      { kind: "refused", reason: "ref_changed" },
    );
    await frame.locator("#account").evaluate((element) => {
      element.textContent = "Choose account";
    });
    await input.session.readPage();
    expect(
      await input.session.clickOpeningAccountWindow!({
        ...grant,
        frame: { origin: input.site.applicationOrigin, pathname: "/wrong" },
      }),
    ).toMatchObject({ kind: "refused", reason: "frame_changed" });
    expect(input.context.pages()).toEqual([input.root]);
  });
}, 30_000);

test.each(["bad-post", "leak-get", "opener-submit", "redirect-post"])(
  "a child cannot send the application or its prepared value: %s",
  async (behavior) => {
    await runFlow("top", behavior, async (input) => {
      expect(await open(input)).toMatchObject({ kind: "opened" });
      const raw = await input.session.readPage();
      const action = raw.actions.find(
        (item) => item.label === "Synthetic account",
      )!;
      await input.session.clickElement(action.ref ?? `a${action.index}`);
      expect(
        input.site.requests.some(
          (request) =>
            request.body.includes(PREPARED) || request.path === "/leak",
        ),
      ).toBe(false);
      expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
      expect(
        (await getBlockedPrepareOnlyAttempts(input.root)).length,
      ).toBeGreaterThan(0);
    });
  },
  30_000,
);

test.each(["two", "grandchild"])(
  "a second account window ends the automation budget: %s",
  async (behavior) => {
    await runFlow("top", behavior, async (input) => {
      expect(await open(input)).toMatchObject({ kind: "opened" });
      if (behavior === "grandchild") {
        const raw = await input.session.readPage();
        const action = raw.actions.find(
          (item) => item.label === "Synthetic account",
        )!;
        await input.session.clickElement(action.ref ?? `a${action.index}`);
      }
      const next = await input.session.readPage();
      expect(next.accountWindow).toMatchObject({
        actionsLeft: 0,
        refusal: { reason: "second_window" },
      });
      expect(await input.session.clickElement("a0")).toMatchObject({
        ok: false,
      });
      expect(input.context.pages()).toHaveLength(2);
    });
  },
  30_000,
);

async function isolated(
  proof: (input: {
    session: ReturnType<typeof createPlaywrightApplyPageSession>;
    root: Page;
    context: BrowserContext;
    sentinel: ReturnType<typeof createApplicationRunServiceWorkerSentinel>;
    abort: AbortController;
    site: Awaited<ReturnType<typeof fixture>>;
  }) => Promise<void>,
  behavior = "message",
) {
  const site = await fixture(),
    browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const root = await context.newPage();
  const abort = new AbortController();
  await root.goto(`${site.applicationOrigin}/apply?behavior=${behavior}`);
  const sentinel = createApplicationRunServiceWorkerSentinel({
    context,
    targetUrl: root.url(),
  });
  sentinel.attachPage(root);
  const session = createPlaywrightApplyPageSession({
    page: root,
    sentinel,
    signal: abort.signal,
  });
  try {
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: false,
      allowedOrigins: [],
    });
    await session.registerPreparedValue(PREPARED);
    await proof({ session, root, context, sentinel, abort, site });
  } finally {
    sentinel.detach();
    await browser.close();
    await site.close();
  }
}

test("abort before release closes the blank child with zero child requests", async () => {
  await isolated(async (input) => {
    input.context.on("page", (child) => {
      const route = child.route.bind(child);
      vi.spyOn(child, "route").mockImplementation(async (...args) => {
        const installed = await route(...args);
        input.abort.abort();
        return installed;
      });
    });
    const raw = await input.session.readPage();
    const action = raw.actions.find((item) => item.label === "Choose account")!;
    expect(
      await input.session.clickOpeningAccountWindow!({
        ref: action.ref ?? `a${action.index}`,
        frame: null,
        writeOrigins: [input.site.providerOrigin],
      }),
    ).toMatchObject({ kind: "refused", reason: "aborted" });
    expect(input.context.pages()).toEqual([input.root]);
    expect(
      input.site.requests.filter((request) => request.path === "/auth"),
    ).toEqual([]);
    expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
  });
}, 30_000);

test("abort after claim leaves a loaded child to the host and a new attempt cannot act in it", async () => {
  await isolated(async (input) => {
    const raw = await input.session.readPage();
    const action = raw.actions.find((item) => item.label === "Choose account")!;
    const grant = {
      ref: action.ref ?? `a${action.index}`,
      frame: null,
      writeOrigins: [input.site.providerOrigin],
    };
    expect(await input.session.clickOpeningAccountWindow!(grant)).toMatchObject(
      { kind: "opened" },
    );
    const child = input.context.pages().find((page) => page !== input.root)!;
    input.abort.abort();
    input.sentinel.detach();
    expect(await input.session.clickElement("a0")).toMatchObject({
      ok: false,
      error: "aborted",
    });
    expect(() => input.session.readIntermediateWriteCount()).toThrow("aborted");
    await expect(input.session.readPage()).rejects.toThrow("aborted");
    expect(child.isClosed()).toBe(false);
    const nextSentinel = createApplicationRunServiceWorkerSentinel({
      context: input.context,
      targetUrl: input.root.url(),
    });
    nextSentinel.attachPage(input.root);
    const next = createPlaywrightApplyPageSession({
      page: input.root,
      sentinel: nextSentinel,
    });
    try {
      expect((await next.readPage()).accountWindow).toBeUndefined();
      expect(await next.clickOpeningAccountWindow!(grant)).toMatchObject({
        kind: "refused",
        reason: "busy",
      });
      expect(await next.adoptOpenedTab!(0)).toMatchObject({ ok: false });
    } finally {
      nextSentinel.detach();
    }
  });
}, 30_000);

test("a sentinel neither claims nor closes another page's popup during its arm", async () => {
  await isolated(async (input) => {
    const other = await input.context.newPage();
    await other.goto(`${input.site.providerOrigin}/button`);
    const claim = input.sentinel.armAccountWindow(
      "unrelated-test-token",
      Date.now() + 300,
    );
    const wait = other.waitForEvent("popup");
    await other.locator("#account").click();
    const child = await wait;
    expect(await claim).toBeNull();
    expect(child.isClosed()).toBe(false);
    expect(await child.opener()).toBe(other);
  });
}, 30_000);

test("ordinary clicks have no popup grant and prepared adoption never replaces the original", async () => {
  await isolated(async (input) => {
    const raw = await input.session.readPage();
    const action = raw.actions.find((item) => item.label === "Choose account")!;
    expect(
      await input.session.clickElement(action.ref ?? `a${action.index}`),
    ).toMatchObject({ ok: true });
    expect(
      await input.root.evaluate(
        () => (window as unknown as Record<string, unknown>).lastPopup,
      ),
    ).toBeNull();
    expect(await input.session.adoptOpenedTab!(0)).toMatchObject({ ok: false });
    expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
  });
}, 30_000);

test("a named-window reuse is refused before it can replace an unrelated person's tab", async () => {
  await isolated(async (input) => {
    const other = await input.context.newPage();
    await other.goto(input.site.providerOrigin + "/person");
    await other.evaluate(() => {
      window.name = "existing-person-window";
    });
    const oldUrl = other.url();
    const raw = await input.session.readPage();
    const action = raw.actions.find((item) => item.label === "Choose account")!;
    expect(
      await input.session.clickOpeningAccountWindow!({
        ref: action.ref ?? `a${action.index}`,
        frame: null,
        writeOrigins: [input.site.providerOrigin],
      }),
    ).toMatchObject({ kind: "refused", reason: "window_blocked" });
    expect(other.isClosed()).toBe(false);
    expect(other.url()).toBe(oldUrl);
  }, "named");
}, 30_000);

test("a same-tab account route remains on the original Page and reports no_window", async () => {
  await isolated(async (input) => {
    const original = input.root;
    const raw = await input.session.readPage();
    const action = raw.actions.find((item) => item.label === "Choose account")!;
    expect(
      await input.session.clickOpeningAccountWindow!({
        ref: action.ref ?? `a${action.index}`,
        frame: null,
        writeOrigins: [input.site.providerOrigin],
      }),
    ).toMatchObject({
      kind: "no_window",
      url: input.site.applicationOrigin + "/continued",
    });
    expect(input.context.pages()).toEqual([original]);
  }, "same-tab");
}, 30_000);

test("a provider 303 clears its POST body before the allowed application GET", async () => {
  await runFlow("top", "redirect-get", async (input) => {
    expect(await open(input)).toMatchObject({ kind: "opened" });
    const raw = await input.session.readPage();
    const action = raw.actions.find(
      (item) => item.label === "Synthetic account",
    )!;
    await input.session.clickElement(action.ref ?? `a${action.index}`);
    const callbacks = input.site.requests.filter(
      (request) =>
        request.side === "application" && request.path === "/callback",
    );
    expect(callbacks.length).toBeGreaterThan(0);
    expect(
      callbacks.every(
        (request) => request.method === "GET" && request.body === "",
      ),
    ).toBe(true);
  });
}, 30000);

test("target-blank links are refused and a slow model turn does not expire the account surface", async () => {
  await isolated(async (input) => {
    await input.root.locator("body").evaluate((element, url) => {
      element.insertAdjacentHTML(
        "beforeend",
        `<a id="external" target="_blank" href="${url}/auth">Account link</a>`,
      );
    }, input.site.providerOrigin);
    const raw = await input.session.readPage();
    const link = raw.links.find((item) => item.label === "Account link")!;
    expect(
      await input.session.clickOpeningAccountWindow!({
        ref: link.ref ?? `l${link.index}`,
        frame: null,
        writeOrigins: [input.site.providerOrigin],
      }),
    ).toMatchObject({ kind: "refused", reason: "window_blocked" });
    const action = raw.actions.find((item) => item.label === "Choose account")!;
    expect(
      await input.session.clickOpeningAccountWindow!({
        ref: action.ref ?? `a${action.index}`,
        frame: null,
        writeOrigins: [input.site.providerOrigin],
      }),
    ).toMatchObject({ kind: "opened" });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 91_000);
    try {
      expect((await input.session.readPage()).accountWindow?.actionsLeft).toBe(
        1,
      );
    } finally {
      clock.mockRestore();
    }
    expect(
      input.site.requests.filter(
        (request) => request.side === "provider" && request.method === "POST",
      ),
    ).toEqual([]);
    expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
  });
}, 30000);

test("SPA opener URL changes keep the account child and all original write refusals", async () => {
  await isolated(async (input) => {
    const off = vi.spyOn(input.root, "off");
    expect(await open(input)).toMatchObject({ kind: "opened" });
    const child = input.context.pages().find((page) => page !== input.root)!;
    await input.root.evaluate(() =>
      history.replaceState({}, "", location.pathname + "#still-signing-in"),
    );
    expect((await input.session.readPage()).accountWindow).toMatchObject({
      actionsLeft: 1,
    });
    expect(child.isClosed()).toBe(false);
    expect(await input.session.fillText("c0", "changed")).toMatchObject({
      ok: false,
    });
    await expect(
      input.session.registerPreparedValue("another value"),
    ).rejects.toThrow("finish or close");
    await expect(openPrepareOnlyFinalActionWindow(input.root)).rejects.toThrow(
      "finish or close",
    );
    await expect(
      openPrepareOnlyIntermediateMutationWindow(input.root),
    ).rejects.toThrow("finish or close");
    await expect(
      openPrepareOnlyAttachmentUploadWindow(input.root, {
        name: "synthetic.txt",
        mimeType: "text/plain",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow("finish or close");
    expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
    input.abort.abort();
    input.sentinel.detach();
    const removed = off.mock.calls.filter(
      ([event]) => String(event) === "domcontentloaded",
    );
    expect(new Set(removed.map((call) => call[1])).size).toBe(2);
    expect(child.isClosed()).toBe(false);
  }, "spa");
}, 30_000);

test("an indirect named-target native anchor is closed, recorded and refused", async () => {
  await isolated(async (input) => {
    expect(await open(input)).toMatchObject({
      kind: "refused",
      reason: "window_blocked",
    });
    await expect.poll(() => input.context.pages().length).toBe(1);
    expect(
      (await getBlockedPrepareOnlyAttempts(input.root)).some(
        (entry) => entry.kind === "popup_open",
      ),
    ).toBe(true);
    expect((await input.session.readPage()).accountWindow).toBeUndefined();
    expect(await input.session.fillText("c0", PREPARED)).toMatchObject({
      ok: true,
    });
  }, "indirect-named");
}, 30_000);

test("a disarmed sentinel cannot claim a token child after its opener await", async () => {
  await isolated(async (input) => {
    input.context.on("page", (child) => {
      const nativeOpener = child.opener.bind(child);
      vi.spyOn(child, "opener").mockImplementation(async () => {
        const opener = await nativeOpener();
        input.sentinel.disarmAccountWindow();
        return opener;
      });
    });
    expect(await open(input)).toMatchObject({
      kind: "refused",
      reason: "not_claimed",
    });
    await expect.poll(() => input.context.pages().length).toBe(1);
    expect(
      (await getBlockedPrepareOnlyAttempts(input.root)).some(
        (entry) => entry.kind === "popup_open",
      ),
    ).toBe(true);
    expect(
      input.site.requests.filter((entry) => entry.path === "/auth"),
    ).toEqual([]);
  });
}, 30_000);

test("blocked popup detection survives full and shrinking ledgers", async () => {
  await isolated(async (input) => {
    await input.root.evaluate(() => {
      for (let index = 0; index < 32; index++) window.open("/old-" + index);
    });
    expect((await getBlockedPrepareOnlyAttempts(input.root)).length).toBe(32);
    expect(await open(input)).toMatchObject({
      kind: "refused",
      reason: "window_blocked",
    });
  }, "named");
  await isolated(async (input) => {
    for (let index = 0; index < 32; index++)
      recordPrepareOnlyRunInterruption(input.root, {
        kind: "network_request",
        method: "POST",
        url: input.site.applicationOrigin + "/old-" + index,
        at: new Date(index).toISOString(),
      });
    await input.root.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.id = "old-ledger-frame";
      frame.src = src;
      document.body.append(frame);
    }, input.site.providerOrigin + "/button");
    await input.root
      .locator("#old-ledger-frame")
      .contentFrame()
      .locator("body")
      .evaluate(() => {
        for (let index = 0; index < 32; index++)
          window.open("/old-frame-" + index);
      });
    expect((await getBlockedPrepareOnlyAttempts(input.root)).length).toBe(64);
    expect(await open(input)).toMatchObject({ kind: "opened" });
    await input.root
      .locator("#old-ledger-frame")
      .evaluate((element) => element.remove());
    // Rollover keeps the length at 32. The popup is new by identity, not index.
    recordPrepareOnlyRunInterruption(input.root, {
      kind: "popup_open",
      method: "GET",
      url: input.site.providerOrigin + "/extra",
      at: new Date().toISOString(),
    });
    expect((await getBlockedPrepareOnlyAttempts(input.root)).length).toBe(32);
    expect((await input.session.readPage()).accountWindow).toMatchObject({
      actionsLeft: 0,
      refusal: { reason: "second_window" },
    });
  });
}, 30_000);

test("account request forwarding and target-close errors abort without rejected handlers", async () => {
  await isolated(async (input) => {
    const child = await input.context.newPage();
    const routeSpy = vi.spyOn(child, "route");
    await installAccountWindowContainment(child, {
      opener: input.root,
      writeOrigins: [input.site.providerOrigin],
    });
    const handler = routeSpy.mock.calls[0]![1];
    for (const failure of ["fetch", "fulfill"] as const) {
      const abort = vi.fn(() => Promise.reject(new Error("Target closed")));
      const request = {
        url: () => input.site.providerOrigin + "/auth",
        method: () => "POST",
        postData: () => "synthetic=one",
        postDataBuffer: () => Buffer.from("synthetic=one"),
        headers: () => ({}),
        frame: () => ({ url: () => input.site.providerOrigin + "/auth" }),
        isNavigationRequest: () => false,
      };
      const route = {
        request: () => request,
        fetch: () =>
          failure === "fetch"
            ? Promise.reject(new Error("Connection reset"))
            : Promise.resolve({ status: () => 200 }),
        fulfill: () => Promise.reject(new Error("Target closed")),
        abort,
      } as unknown as Route;
      await expect(
        Promise.resolve(handler(route, route.request())),
      ).resolves.toBeUndefined();
      expect(abort).toHaveBeenCalledWith("failed");
    }
  });
}, 30_000);

test("host handoff and final send explain an active child without opening a final window", async () => {
  await runFlow("top", "message", async (input) => {
    const original = await observeApplicationForm(input.root);
    const final = original.controls.find((item) =>
      item.label.includes("Send application"),
    )!;
    expect(final).toBeDefined();
    expect(await open(input)).toMatchObject({ kind: "opened" });
    expect(await input.handoff()).toEqual({
      ok: false,
      error:
        "An account window is open for this application; finish or close it first.",
    });
    expect(
      await executeExactlyOneFinalAction(input.root, {
        expectedObservation: original.identity,
        expectedControl: final.identity,
        expectedPageOrigin: input.site.applicationOrigin,
        allowedOrigins: [input.site.applicationOrigin],
        veto: () => true,
      }),
    ).toMatchObject({
      outcome: "not_submitted",
      reason: "account_window_open",
      facts: { actionAttempted: false, actionIssued: false },
    });
    expect((await input.session.readPage()).accountWindow).toMatchObject({
      actionsLeft: 1,
    });
  });
}, 30_000);

test.each(["navigation-get", "navigation-post"])(
  "single-use callback is consumed once through native %s return",
  async (behavior) => {
    await runFlow("top", behavior, async (input) => {
      await input.context.addCookies([
        {
          name: "application_current",
          value: "synthetic-current",
          url: input.site.applicationOrigin,
        },
        {
          name: "provider_current",
          value: "synthetic-provider",
          url: input.site.providerOrigin,
        },
      ]);
      const originalUrl = input.root.url();
      expect(await open(input)).toMatchObject({ kind: "opened" });
      const child = input.context.pages().find((page) => page !== input.root)!;
      const observed = await input.session.readPage();
      const select = observed.actions.find(
        (item) => item.label === "Synthetic account",
      )!;
      const clicked = await input.session.clickElement(
        select.ref ?? `a${select.index}`,
      );
      expect(clicked).toMatchObject({ ok: true });
      expect(child.isClosed()).toBe(true);
      expect(child.url()).toBe(
        input.site.applicationOrigin + "/one-use-callback",
      );
      const callbacks = input.site.requests.filter(
        (entry) => entry.path === "/one-use-callback",
      );
      expect(callbacks).toHaveLength(1);
      expect(callbacks[0]).toMatchObject({ method: "GET", status: 200 });
      expect(callbacks[0]!.cookie).toContain(
        "application_current=synthetic-current",
      );
      expect(await input.root.locator("#messages").textContent()).toBe("1");
      const returned = await input.root
        .locator("#messages")
        .getAttribute("data-returned");
      expect(JSON.parse(returned!)).toEqual({
        data: {
          type: "synthetic-auth-return",
          url: child.url(),
          origin: input.site.applicationOrigin,
          hasOpener: true,
        },
        origin: input.site.applicationOrigin,
      });
      expect(input.root.url()).toBe(originalUrl);
      expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
      expect((await input.session.readPage()).accountWindow).toBeUndefined();
      const providerRequest = input.site.requests.find(
        (entry) =>
          entry.path ===
          (behavior === "navigation-post"
            ? "/navigation-post"
            : "/navigation-redirect"),
      )!;
      expect(providerRequest.cookie).toContain(
        "provider_current=synthetic-provider",
      );
      if (behavior === "navigation-post") {
        expect(
          input.site.requests.filter(
            (entry) => entry.path === "/navigation-post",
          ),
        ).toHaveLength(1);
        expect(providerRequest).toMatchObject({ method: "POST", status: 303 });
        const later = await input.context.newPage();
        await later.goto(input.site.providerOrigin + "/cookie-proof");
        expect(
          input.site.requests.find((entry) => entry.path === "/cookie-proof")!
            .cookie,
        ).toContain("provider_after=synthetic-303");
        await later.close();
      }
    });
  },
  30_000,
);

test.each(["deny-307", "deny-308"])(
  "a provider %s navigation never POSTs to the application",
  async (behavior) => {
    await runFlow("top", behavior, async (input) => {
      expect(await open(input)).toMatchObject({ kind: "opened" });
      const child = input.context.pages().find((page) => page !== input.root)!;
      const raw = await input.session.readPage();
      const select = raw.actions.find(
        (item) => item.label === "Synthetic account",
      )!;
      const before = input.site.requests.length;
      const action = input.session.clickElement(
        select.ref ?? `a${select.index}`,
      );
      await expect
        .poll(async () =>
          (await getBlockedPrepareOnlyAttempts(input.root)).some(
            (entry) =>
              entry.kind === "network_request" && entry.method === "POST",
          ),
        )
        .toBe(true);
      expect(
        input.site.requests
          .slice(before)
          .filter((entry) => entry.side === "application"),
      ).toEqual([]);
      expect(
        input.site.requests.filter((entry) => entry.path === "/submit"),
      ).toEqual([]);
      expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
      await child.close();
      await action;
    });
  },
  30_000,
);

test.each(["prepared-query", "prepared-body", "prepared-307", "prepared-303"])(
  "an observed %s value is refused before the destination request",
  async (behavior) => {
    await runFlow("top", behavior, async (input) => {
      expect(await open(input)).toMatchObject({ kind: "opened" });
      const child = input.context.pages().find((page) => page !== input.root)!;
      const raw = await input.session.readPage();
      const select = raw.actions.find(
        (item) => item.label === "Synthetic account",
      )!;
      const action = input.session.clickElement(
        select.ref ?? `a${select.index}`,
      );
      await expect
        .poll(async () =>
          (await getBlockedPrepareOnlyAttempts(input.root)).some(
            (entry) =>
              entry.kind === "network_request" &&
              entry.carriedPreparedValue === true,
          ),
        )
        .toBe(true);
      expect(
        input.site.requests.filter(
          (entry) => entry.path === "/prepared-destination",
        ),
      ).toEqual([]);
      expect(
        input.site.requests.filter((entry) => entry.body.includes(PREPARED)),
      ).toEqual([]);
      expect(await input.root.locator("input").inputValue()).toBe(PREPARED);
      await child.close();
      await action;
    });
  },
  30_000,
);

// A pinned local provider exercises policy and both runtime transports. No real
// Google request is permitted: Chromium maps the host, and Node forwarding uses
// the same per-run TLS certificate and loopback port after the nonce probe.
import { createServer as createSecureServer } from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { createRequire } from "node:module";
import { createApplyPageHands } from "@nestor/browser-agent";
import { withBrowserPermissions } from "@nestor/browser-agent";
const fixtureRequire = createRequire(import.meta.url);
const { loadProviderFixture, providerArgs, installProviderTransport } =
  fixtureRequire(
    "../../../packages/ai-evals/scripts/isolated-app/provider-fixture.cjs",
  ) as {
    loadProviderFixture: (
      file: string,
      run: {
        label: string;
        userDataDir: string;
        testApi: boolean;
        net: string;
      },
    ) => { port: number; nonce: string };
    providerArgs: (fixture: unknown) => string[];
    installProviderTransport: (
      fixture: unknown,
      armed: () => boolean,
    ) => () => void;
  };
const TARGET_EMAIL = "target@example.test";
async function intendedIdentityFixture(
  mode: "popup" | "same_tab",
  variant = "basic",
  saves = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "nestor-google-identity-"));
  const key = join(directory, "key.pem"),
    certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=accounts.google.com",
      "-addext",
      "subjectAltName=DNS:accounts.google.com",
    ],
    { stdio: "pipe" },
  );
  const cert = await readFile(certPath),
    spki = createHash("sha256")
      .update(
        new X509Certificate(cert).publicKey.export({
          type: "spki",
          format: "der",
        }),
      )
      .digest("base64"),
    nonce = randomBytes(24).toString("hex");
  const requests: {
    side: string;
    method: string;
    path: string;
    email?: string;
  }[] = [];
  let applicationOrigin = "",
    armed = false,
    stage = 0;
  const form = () =>
    `<h1>Application</h1><form method="post" action="/submit"><label>Full name<input name="full_name" value="Jamie Rivers"></label><label>Referral code<input name="referral" value="${PREPARED}"></label><button>Submit application</button></form>`;
  const application = createServer();
  await new Promise<void>((resolve) =>
    application.listen(0, "127.0.0.1", resolve),
  );
  applicationOrigin = `http://127.0.0.1:${(application.address() as AddressInfo).port}`;
  application.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", applicationOrigin);
    if (url.pathname === "/start") {
      requests.push({
        side: "application",
        method: req.method ?? "GET",
        path: url.pathname,
      });
      res.writeHead(302, {
        location: `https://accounts.google.com/o/oauth2/v2/auth?scope=${variant === "extra_scope" ? "openid%20drive" : "openid%20email%20profile"}&state=synthetic-hidden-state`,
      });
      res.end();
      return;
    }
    requests.push({
      side: "application",
      method: req.method ?? "GET",
      path: url.pathname,
    });
    req.resume();
    res.setHeader("Content-Type", "text/html");
    if (url.pathname === "/callback")
      res.end(
        mode === "popup"
          ? `<script>opener.postMessage('identity-return',${JSON.stringify(applicationOrigin)});close()</script>`
          : `${form()}<p>Signed in</p>`,
      );
    else
      res.end(
        `${form()}<button type="button" onclick="${mode === "popup" ? "window.open('/start')" : "location.href='/start'"}">Sign up with Google</button><p id="status">Sign in first</p><script>addEventListener('message',event=>{if(event.origin===location.origin && event.data==='identity-return'){document.querySelector('#status').textContent='Signed in';document.querySelector('button[type=button]').remove()}})</script>`,
      );
  });
  const provider = createSecureServer(
    { key: await readFile(key), cert },
    (req, res) => {
      const url = new URL(req.url ?? "/", "https://accounts.google.com");
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const email = new URLSearchParams(body).get("email") ?? undefined;
        requests.push({
          side: "provider",
          method: req.method ?? "GET",
          path: url.pathname,
          ...(email ? { email } : {}),
        });
        res.setHeader("Content-Type", "text/html");
        if (url.pathname === `/__nestor_probe/${nonce}`) {
          res.end(nonce);
          return;
        }
        if (!armed) {
          res.writeHead(403);
          res.end("Mapping not proved");
          return;
        }
        if (url.pathname === "/o/oauth2/v2/auth") {
          res.writeHead(302, {
            location:
              url.searchParams.get("scope") === "drive"
                ? "/signin/oauth/consent"
                : "/v3/signin/accountchooser",
          });
          res.end();
        } else if (url.pathname === "/v3/signin/accountchooser")
          res.end(
            `<h1>Choose an account</h1>${(variant.startsWith("another") ? ["other@example.test"] : ["other@example.test", TARGET_EMAIL]).map((email) => `<form method="post" action="/select"><button name="email" value="${email}">${email}</button></form>`).join("")}${variant.startsWith("another") ? `<a href="/v3/signin/identifier">Use another account</a>` : ""}`,
          );
        else if (url.pathname === "/v3/signin/identifier")
          res.end(
            `<h1>Sign in</h1><form method="post" action="/identifier-next"><label>Email<input type="email" name="email" autocomplete="username"></label><button>Next</button></form>`,
          );
        else if (
          url.pathname === "/select" ||
          url.pathname === "/identifier-next"
        ) {
          res.writeHead(303, {
            location:
              variant === "later_scope"
                ? "/o/oauth2/v2/auth?scope=drive"
                : variant.endsWith("passkey")
                  ? "/v3/signin/speedbump/passkeyenrollment"
                  : variant === "stuck"
                    ? "/v3/signin/accountchooser"
                    : "/signin/oauth/consent",
          });
          res.end();
        } else if (url.pathname === "/v3/signin/speedbump/passkeyenrollment")
          // An optional offer between choosing the account and consent.
          res.end(
            `<h1>Sign in faster with a passkey</h1><p>${TARGET_EMAIL}</p><form method="post" action="/speedbump/create"><button>Create a passkey</button></form><form method="post" action="/speedbump/decline"><button>Not now</button></form>`,
          );
        else if (url.pathname === "/speedbump/decline") {
          res.writeHead(303, { location: "/signin/oauth/consent" });
          res.end();
        } else if (url.pathname === "/signin/oauth/consent")
          res.end(
            `<p>${TARGET_EMAIL}</p>${variant === "direct_app" ? `<button type="button" onclick="fetch('${applicationOrigin}/submit',{method:'POST',body:'synthetic=one'}).catch(()=>{})">Continue</button>` : `<form method="post" action="/confirm">${variant === "prepared" ? `<input type="hidden" name="extra" value="${PREPARED}">` : ""}<button>Continue</button></form>`}`,
          );
        else if (url.pathname === "/confirm" || url.pathname === "/stage") {
          if (variant === "budget") {
            res.end(
              `<p>${TARGET_EMAIL}</p><p>Stage ${++stage}</p><form method="post" action="/stage"><button>Next</button></form>`,
            );
            return;
          }
          res.writeHead(
            variant === "307" ? 307 : variant === "308" ? 308 : 303,
            {
              location:
                applicationOrigin +
                (variant === "307" || variant === "308"
                  ? "/submit"
                  : "/callback"),
            },
          );
          res.end();
        } else res.end("Unexpected provider request");
      });
    },
  );
  await new Promise<void>((resolve) =>
    provider.listen(0, "127.0.0.1", resolve),
  );
  const config = {
    label: "google-runtime",
    host: "accounts.google.com",
    port: (provider.address() as AddressInfo).port,
    certPath,
    spki,
    nonce,
  };
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  const pin = loadProviderFixture(configPath, {
    label: config.label,
    userDataDir: "/tmp/nestor-verify-google-runtime-test",
    testApi: true,
    net: "replica",
  });
  const restore = installProviderTransport(pin, () => armed);
  const browser = await chromium.launch({
    headless: true,
    args: providerArgs(pin),
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    const provider = url.origin === "https://accounts.google.com";
    return url.origin === applicationOrigin ||
      (provider && (armed || url.pathname === `/__nestor_probe/${nonce}`))
      ? route.fallback()
      : route.abort("blockedbyclient");
  });
  try {
    const probe = await context.newPage();
    await probe.goto(`https://accounts.google.com/__nestor_probe/${nonce}`);
    expect(await probe.locator("body").innerText()).toBe(nonce);
    armed = true;
    await probe.close();
    const root = await context.newPage();
    await root.goto(applicationOrigin + "/apply");
    const controller = new AbortController();
    const sentinel = createApplicationRunServiceWorkerSentinel({
      context,
      targetUrl: applicationOrigin + "/apply",
    });
    sentinel.attachPage(root);
    const session = createPlaywrightApplyPageSession({
      page: root,
      sentinel,
      signal: controller.signal,
    });
    await session.installPrepareOnlyGuard({
      intermediateMutationsAuthorized: saves,
      allowedOrigins: [],
    });
    await session.registerPreparedValue(PREPARED);
    await session.registerPreparedValue(TARGET_EMAIL);
    const chosen = vi.fn(),
      confirmed = vi.fn();
    // Read before every action, so a change mid-flow takes effect at once.
    const live = { email: TARGET_EMAIL, googleSignIn: true };
    const hands = withBrowserPermissions(createApplyPageHands(session), {
      readBrowserPermissions: () => ({
        googleSignIn: live.googleSignIn,
        signIn: false,
        createAccounts: false,
        solveCaptchas: false,
      }),
      readIntendedAccountEmail: () => live.email,
      onGoogleAccountSelected: chosen,
      onGoogleSignInConfirmed: confirmed,
    });
    return {
      root,
      session,
      hands,
      live,
      requests,
      context,
      controller,
      chosen,
      confirmed,
      applicationOrigin,
      close: async () => {
        await session.closeAccountWindow();
        sentinel.detach();
        await browser.close();
        restore();
        for (const server of [application, provider]) {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser.close();
    restore();
    for (const server of [application, provider]) {
      server.closeAllConnections();
      server.close();
    }
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function identityStep(
  input: Awaited<ReturnType<typeof intendedIdentityFixture>>,
  label: string,
) {
  const page = await input.hands.observe();
  const item = [...page.actions, ...page.links, ...page.clickables].find(
    (item) => item.label === label,
  )!;
  expect(item).toBeDefined();
  return input.hands.clickElement(item.ref);
}

test.each(["popup", "same_tab"] as const)(
  "intended identity %s basic callback retains the application and never sends",
  async (mode) => {
    const f = await intendedIdentityFixture(mode);
    try {
      const root = f.root;
      expect((await identityStep(f, "Sign up with Google")).ok).toBe(true);
      expect(await identityStep(f, TARGET_EMAIL)).toMatchObject({ ok: true });
      const seen = await f.hands.observe();
      expect(JSON.stringify(seen)).not.toContain("synthetic-hidden-state");
      expect(seen.accountWindow?.actionsLeft).toBe(3);
      expect(await identityStep(f, "Continue")).toMatchObject({ ok: true });
      await expect
        .poll(() => root.locator("body").innerText())
        .toContain("Signed in");
      expect(await root.getByLabel("Referral code").inputValue()).toBe(
        PREPARED,
      );
      expect(f.context.pages()).toEqual([root]);
      expect(f.chosen).toHaveBeenCalledExactlyOnceWith(TARGET_EMAIL);
      expect(f.confirmed).toHaveBeenCalledExactlyOnceWith(TARGET_EMAIL);
      expect(
        f.requests.filter((r) => r.side === "provider" && r.path === "/select"),
      ).toMatchObject([{ email: TARGET_EMAIL }]);
      expect(f.requests.filter((r) => r.path === "/callback")).toHaveLength(1);
      expect(
        f.requests.filter(
          (r) => r.side === "application" && r.method === "POST",
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
  45_000,
);

test.each(
  (["popup", "same_tab"] as const).flatMap((mode) =>
    ["extra_scope", "later_scope", "prepared", "direct_app", "307", "308"].map(
      (variant) => ({ mode, variant }),
    ),
  ),
)(
  "intended identity $mode blocks $variant without any application POST",
  async ({ mode, variant }) => {
    const f = await intendedIdentityFixture(mode, variant);
    try {
      await identityStep(f, "Sign up with Google");
      await identityStep(f, TARGET_EMAIL);
      const provider = f.context
        .pages()
        .find((page) => page.url().startsWith("https://accounts.google.com"))!;
      const result = await identityStep(f, "Continue");
      if (variant === "extra_scope" || variant === "later_scope") {
        expect(result.ok).toBe(false);
        expect(f.requests.filter((r) => r.path === "/confirm")).toEqual([]);
      } else if (mode === "same_tab" && variant === "direct_app") {
        const guard = await provider.evaluate(
          readPrepareOnlyMutationGuardInPage,
        );
        expect(
          guard.refusals?.some(
            (refusal) =>
              refusal.kind === "fetch" &&
              refusal.method === "POST" &&
              refusal.url === f.applicationOrigin + "/submit",
          ),
       ).toBe(true);
        expect(f.confirmed).toHaveBeenCalledExactlyOnceWith(TARGET_EMAIL);
      } else
        expect(
          (await getBlockedPrepareOnlyAttempts(f.root)).length,
        ).toBeGreaterThan(0);
      expect(
        f.requests.filter(
          (r) => r.side === "application" && r.method === "POST",
        ),
      ).toEqual([]);
      expect(f.requests.filter((r) => r.path === "/callback")).toEqual([]);
    } finally {
      await f.close();
    }
  },
  45_000,
);

test.each(["popup", "same_tab"] as const)(
  "intended identity %s refuses out-of-window writes, wrong text and cancelled actions",
  async (mode) => {
    const f = await intendedIdentityFixture(mode, "basic", true);
    try {
      await identityStep(f, "Sign up with Google");
      expect((await f.session.fillText("c0", "wrong@example.test")).ok).toBe(
        false,
      );
      await identityStep(f, TARGET_EMAIL);
      const provider = f.context
        .pages()
        .find((page) => page.url().startsWith("https://accounts.google.com"))!;
      await provider.evaluate(() =>
        fetch("/background?state=synthetic-hidden-state", {
          method: "POST",
          body: "outside",
        }).catch(() => undefined),
      );
      expect(f.requests.filter((r) => r.path === "/background")).toEqual([]);
      expect(
        JSON.stringify(await getBlockedPrepareOnlyAttempts(f.root)),
      ).not.toContain("synthetic-hidden-state");
      await provider.evaluate(() => {
        window.open("/extra");
      });
      expect((await f.session.readPage()).accountWindow).toMatchObject({
        actionsLeft: 0,
        refusal: { reason: "second_window" },
      });
      f.controller.abort();
      expect(await f.session.clickElement("a0")).toMatchObject({
        ok: false,
        error: "aborted",
      });
      expect(
        f.requests.filter(
          (r) => r.side === "application" && r.method === "POST",
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
  45_000,
);

test("intended identity grant keeps its action count across a slow model turn", async () => {
  const f = await intendedIdentityFixture("popup", "budget");
  try {
    const raw = await f.session.readPage();
    const entry = raw.actions.find(
      (action) => action.label === "Sign up with Google",
    )!;
    expect(
      await f.session.clickOpeningAccountWindow!({
        ref: entry.ref ?? `a${entry.index}`,
        frame: null,
        writeOrigins: ["https://accounts.google.com"],
        maxActions: 999,
        disclosableValues: [TARGET_EMAIL],
      }),
    ).toMatchObject({ kind: "opened" });
    for (let index = 0; index < 3; index++) {
      const current = await f.session.readPage();
      const action = current.actions.find(
        (action) =>
          action.label ===
          (index === 0 ? TARGET_EMAIL : index === 1 ? "Continue" : "Next"),
      )!;
      expect(
        (await f.session.clickElement(action.ref ?? `a${action.index}`)).ok,
      ).toBe(true);
    }
    const beforeExpiry = await f.session.readPage();
    expect(beforeExpiry.accountWindow?.actionsLeft).toBe(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 91_000);
    try {
      expect(
        (await f.session.clickElement(beforeExpiry.actions[0]!.ref ?? "a0")).ok,
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
    const current = await f.session.readPage();
    expect(current.accountWindow?.actionsLeft).toBe(0);
    expect(
      (await f.session.clickElement(current.actions[0]!.ref ?? "a0")).ok,
    ).toBe(false);
    expect(
      f.requests.filter((r) => r.side === "provider" && r.method === "POST"),
    ).toHaveLength(4);
  } finally {
    await f.close();
  }
}, 45_000);

test.each(["popup", "same_tab"] as const)(
  "intended identity %s uses another account only for canonical identifier, Next and basic confirmation",
  async (mode) => {
    const f = await intendedIdentityFixture(mode, "another");
    try {
      expect(await identityStep(f, "Sign up with Google")).toMatchObject({
        ok: true,
      });
      expect(await identityStep(f, "Use another account")).toMatchObject({
        ok: true,
      });
      const identifier = (await f.hands.observe()).controls[0]!;
      expect(
        await f.hands.fillText(identifier.ref, "wrong@example.test"),
      ).toMatchObject({ ok: false });
      expect(await identityStep(f, "Next")).toMatchObject({ ok: false });
      expect(
        await f.hands.fillText(identifier.ref, TARGET_EMAIL),
      ).toMatchObject({ ok: true });
      expect((await f.hands.observe()).controls[0]?.value).toBe(TARGET_EMAIL);
      expect(await identityStep(f, "Next")).toMatchObject({ ok: true });
      expect(await identityStep(f, "Continue")).toMatchObject({ ok: true });
      await expect
        .poll(() => f.root.locator("body").innerText())
        .toContain("Signed in");
      expect(
        f.requests.filter((request) => request.path === "/identifier-next"),
      ).toMatchObject([{ email: TARGET_EMAIL }]);
      expect(
        f.requests.filter(
          (request) =>
            request.side === "application" && request.method === "POST",
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
  45_000,
);

/** Moves the Node clock only; the provider and pages keep real time. */
function clockOffset() {
  const real = Date.now.bind(Date);
  let offset = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
  return {
    advance: (ms: number) => {
      offset += ms;
    },
    restore: () => spy.mockRestore(),
  };
}
const providerPosts = (
  f: Awaited<ReturnType<typeof intendedIdentityFixture>>,
  path?: string,
) =>
  f.requests.filter(
    (r) =>
      r.side === "provider" &&
      r.method === "POST" &&
      (!path || r.path === path),
  );

test.each(["popup", "same_tab"] as const)(
  "intended identity %s declines an optional passkey offer and survives slow turns through validated progress",
  async (mode) => {
    const f = await intendedIdentityFixture(mode, "passkey");
    const clock = clockOffset();
    try {
      expect((await identityStep(f, "Sign up with Google")).ok).toBe(true);
      // Each model turn below takes 80 s; three of them exceed one 90 s grant.
      clock.advance(80_000);
      expect(await identityStep(f, TARGET_EMAIL)).toMatchObject({ ok: true });
      const offer = await f.hands.observe();
      expect(offer.blocker).toBeNull();
      expect(offer.accountWindow?.actionsLeft).toBe(3);
      clock.advance(80_000);
      expect(await identityStep(f, "Not now")).toMatchObject({ ok: true });
      clock.advance(80_000);
      expect(await identityStep(f, "Continue")).toMatchObject({ ok: true });
      await expect
        .poll(() => f.root.locator("body").innerText())
        .toContain("Signed in");
      expect(await f.root.getByLabel("Referral code").inputValue()).toBe(
        PREPARED,
      );
      expect(f.context.pages()).toEqual([f.root]);
      expect(providerPosts(f, "/speedbump/create")).toEqual([]);
      expect(providerPosts(f, "/speedbump/decline")).toHaveLength(1);
      expect(providerPosts(f, "/select")).toMatchObject([
        { email: TARGET_EMAIL },
      ]);
      expect(providerPosts(f, "/confirm")).toHaveLength(1);
      expect(f.requests.filter((r) => r.path === "/callback")).toHaveLength(1);
      expect(f.confirmed).toHaveBeenCalledExactlyOnceWith(TARGET_EMAIL);
      expect(
        f.requests.filter(
          (r) => r.side === "application" && r.method === "POST",
        ),
      ).toEqual([]);
    } finally {
      clock.restore();
      await f.close();
    }
  },
  60_000,
);

test.each(["popup", "same_tab"] as const)(
  "intended identity %s counts only provider writes: typing and plain navigation spend no commit",
  async (mode) => {
    const f = await intendedIdentityFixture(mode, "another_passkey");
    try {
      await identityStep(f, "Sign up with Google");
      expect((await f.hands.observe()).accountWindow?.actionsLeft).toBe(4);
      expect(await identityStep(f, "Use another account")).toMatchObject({
        ok: true,
      });
      const identifier = (await f.hands.observe()).controls[0]!;
      expect(
        await f.hands.fillText(identifier.ref, TARGET_EMAIL),
      ).toMatchObject({ ok: true });
      expect((await f.hands.observe()).accountWindow?.actionsLeft).toBe(4);
      expect(await identityStep(f, "Next")).toMatchObject({ ok: true });
      expect((await f.hands.observe()).accountWindow?.actionsLeft).toBe(3);
      expect(await identityStep(f, "Not now")).toMatchObject({ ok: true });
      expect(await identityStep(f, "Continue")).toMatchObject({ ok: true });
      await expect
        .poll(() => f.root.locator("body").innerText())
        .toContain("Signed in");
      expect(providerPosts(f)).toHaveLength(3);
      expect(providerPosts(f, "/speedbump/create")).toEqual([]);
      expect(
        f.requests.filter(
          (r) => r.side === "application" && r.method === "POST",
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
  60_000,
);

test.each(["identity", "permission"] as const)(
  "a changed %s mid-flow stops the next Google action and renews nothing",
  async (change) => {
    const f = await intendedIdentityFixture("popup", "passkey");
    try {
      await identityStep(f, "Sign up with Google");
      expect(await identityStep(f, TARGET_EMAIL)).toMatchObject({ ok: true });
      if (change === "identity") f.live.email = "someone.else@example.test";
      else f.live.googleSignIn = false;
      const page = await f.hands.observe();
      expect(page.blocker).toMatchObject({ requiresPerson: true });
      expect((await identityStep(f, "Not now")).ok).toBe(false);
      expect(providerPosts(f, "/speedbump/decline")).toEqual([]);
      expect(providerPosts(f, "/confirm")).toEqual([]);
    } finally {
      await f.close();
    }
  },
  45_000,
);

test("an unchanged page after a choice is not renewed and the choice is not repeated", async () => {
  const f = await intendedIdentityFixture("popup", "stuck");
  const clock = clockOffset();
  try {
    await identityStep(f, "Sign up with Google");
    clock.advance(60_000);
    expect(await identityStep(f, TARGET_EMAIL)).toMatchObject({ ok: true });
    const again = await f.hands.observe();
    expect(again.blocker).toMatchObject({ requiresPerson: true });
    expect((await identityStep(f, TARGET_EMAIL)).ok).toBe(false);
    // No renewal happened: the original grant runs out on schedule.
    clock.advance(35_000);
    expect((await f.session.readPage()).accountWindow?.actionsLeft).toBe(0);
    expect(providerPosts(f, "/select")).toHaveLength(1);
  } finally {
    clock.restore();
    await f.close();
  }
}, 45_000);

test("the runtime renews only the same live surface after it moved to a new document", async () => {
  const f = await intendedIdentityFixture("popup", "passkey");
  try {
    await identityStep(f, "Sign up with Google");
    const opened = (await f.session.readPage()).accountWindow!;
    // The opening itself is not progress.
    expect(
      await f.session.renewAccountWindow!({
        origin: opened.origin,
        pathname: opened.pathname,
      }),
    ).toBe(false);
    const chooser = await f.session.readPage();
    const choice = chooser.actions.find(
      (action) => action.label === TARGET_EMAIL,
    )!;
    expect(
      (await f.session.clickElement(choice.ref ?? `a${choice.index}`)).ok,
    ).toBe(true);
    const moved = (await f.session.readPage()).accountWindow!;
    expect(moved.pathname).toBe("/v3/signin/speedbump/passkeyenrollment");
    expect(moved.actionsLeft).toBe(3);
    expect(
      await f.session.renewAccountWindow!({
        origin: moved.origin,
        pathname: "/signin/oauth/consent",
      }),
    ).toBe(false);
    expect(
      await f.session.renewAccountWindow!({
        origin: moved.origin,
        pathname: moved.pathname,
      }),
    ).toBe(true);
    // Once per new document, and never a restored commit.
    expect(
      await f.session.renewAccountWindow!({
        origin: moved.origin,
        pathname: moved.pathname,
      }),
    ).toBe(false);
    expect((await f.session.readPage()).accountWindow?.actionsLeft).toBe(3);
  } finally {
    await f.close();
  }
}, 45_000);

test.each(["popup", "same_tab"] as const)(
  "an unproven %s entry is looked at once more, then handed off with only its shape",
  async (mode) => {
    const f = await intendedIdentityFixture(mode, "extra_scope");
    try {
      await identityStep(f, "Sign up with Google");
      expect(await identityStep(f, TARGET_EMAIL)).toMatchObject({ ok: true });
      const consent = await f.hands.observe();
      expect(consent.blocker).toMatchObject({ requiresPerson: true });
      const detail = consent.blocker!.detail;
      expect(detail).toContain(
        "Nestor cannot prove this request is limited to your name, email and profile picture.",
      );
      expect(detail).toContain(
        "Recorded entry: accounts.google.com/o/oauth2/v2/auth (scope, state)",
      );
      for (const value of ["drive", "openid", "synthetic-hidden-state", "?"])
        expect(detail.replace("Recorded entry", "")).not.toContain(value);
      expect((await identityStep(f, "Continue")).ok).toBe(false);
      expect(f.requests.filter((r) => r.path === "/confirm")).toEqual([]);
      expect(
        f.requests.filter(
          (r) => r.side === "application" && r.method === "POST",
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  },
  45_000,
);
