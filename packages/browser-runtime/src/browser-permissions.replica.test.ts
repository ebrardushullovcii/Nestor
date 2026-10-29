import { createServer, type Server } from "node:http";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createApplyPageHands,
  withBrowserPermissions,
} from "@nestor/browser-agent";
import { BrowserAgentPermissionsSchema } from "@nestor/contracts";
import {
  createPlaywrightApplyPageMechanics,
  createPlaywrightApplyPageSession,
} from "./apply-page-mechanics";
import { allowPrepareOnlyRunNavigation } from "./playwright-application-flow";

let server: Server;
let browser: Browser;
let base = "";
const posts: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", base || "http://127.0.0.1")
      .pathname;
    if (request.method === "POST") {
      posts.push(path);
      request.resume();
      response.writeHead(303, {
        Location: "/jobs",
        "Set-Cookie": "syntheticSession=yes; Path=/; SameSite=Lax",
      });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "text/html");
    if (path === "/google-session") {
      response.writeHead(303, {
        Location: "/jobs",
        "Set-Cookie": "syntheticGoogleSession=yes; Path=/; SameSite=Lax",
      });
      response.end();
    } else if (path === "/register/google") {
      response.end(
        "<h1>Create an account to continue</h1><form method='post' action='/account'><label>Password<input type='password'></label><button>Create account</button><button type='button' onclick=\"location.href='/google-session'\">Continue with Google</button></form>",
      );
    } else if (path === "/jobs") {
      response.end(
        "<h1>Job results</h1><a href='/jobs/1'>Software engineer</a>",
      );
    } else if (path === "/captcha") {
      response.end(
        "<h1>Application</h1><form method='post' action='/application'><label><input type='checkbox' name='human'>I am not a robot</label><button>Submit application</button></form>",
      );
    } else {
      const register = path === "/register";
      const label = register ? "Create account" : "Sign in";
      response.end(
        `<h1>${label}</h1><form method='post' action='${register ? "/account" : "/session"}' onsubmit="fetch('/application',{method:'POST',body:'should-be-blocked'}).catch(()=>{})"><label>Email<input type='email' name='email'></label><label>Password<input type='password' name='password' autocomplete='${register ? "new-password" : "current-password"}'></label><button>${label}</button></form>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Replica did not bind a port.");
  base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function open(context: BrowserContext, path: string) {
  const page = await context.newPage();
  const session = createPlaywrightApplyPageSession({ page });
  await session.installPrepareOnlyGuard({
    intermediateMutationsAuthorized: false,
    allowedOrigins: [],
  });
  allowPrepareOnlyRunNavigation(page, `${base}${path}`);
  await page.goto(`${base}${path}`);
  return { page, hands: createApplyPageHands(session) };
}

async function enterSyntheticLogin(page: Page) {
  // The person entering credentials is a precondition, never an agent tool.
  await page.getByLabel("Email").fill("synthetic@example.test");
  await page.getByLabel("Password").fill("synthetic-replica-password");
}

test("Google sign-up opt-in follows the provider button beside an empty password form without authorizing other writes", async () => {
  const context = await browser.newContext();
  try {
    const { page, hands } = await open(context, "/register/google");
    const initial = await hands.observe();
    const google = initial.actions.find(
      (entry) => entry.label === "Continue with Google",
    )!;
    const before = posts.length;
    const off = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        signIn: true,
        createAccounts: true,
      }),
    });
    expect(await off.clickElement(google.ref)).toMatchObject({ ok: false });
    expect(page.url()).toBe(`${base}/register/google`);
    const on = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    const observed = await on.observe();
    expect(observed.blocker?.requiresPerson).toBe(false);
    const account = observed.actions.find(
      (entry) => entry.label === "Create account",
    )!;
    expect(await on.clickElement(account.ref)).toMatchObject({ ok: false });
    expect(await on.clickElement(google.ref)).toMatchObject({ ok: true });
    await page.waitForURL(`${base}/jobs`);
    expect(
      (await context.cookies(base)).some(
        (cookie) => cookie.name === "syntheticGoogleSession",
      ),
    ).toBe(true);
    await page.evaluate(() =>
      fetch("/application", { method: "POST", body: "blocked" }).catch(
        () => undefined,
      ),
    );
    expect(posts.slice(before)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("search mechanics install a closed guard before the exact sign-in POST", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${base}/login`);
    await enterSyntheticLogin(page);
    const hands = withBrowserPermissions(
      createApplyPageHands(createPlaywrightApplyPageMechanics(page)),
      {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
        }),
      },
    );
    const action = (await hands.observe()).actions.find(
      (entry) => entry.label === "Sign in",
    )!;
    const before = posts.length;
    expect(await hands.clickElement(action.ref)).toMatchObject({ ok: true });
    await page.waitForURL(`${base}/jobs`);
    expect(posts.slice(before)).toEqual(["/session"]);
    // The exact grant does not persist as a general mutation window.
    await page.evaluate(() =>
      fetch("/application", { method: "POST", body: "blocked" }).catch(
        () => undefined,
      ),
    );
    expect(posts.slice(before)).toEqual(["/session"]);
  } finally {
    await context.close();
  }
});

test.each(["signIn", "createAccounts"] as const)(
  "%s uses only its exact POST, preserves its session and leaves application sending fenced",
  async (kind) => {
    const context = await browser.newContext();
    try {
      const { page, hands } = await open(
        context,
        kind === "signIn" ? "/login" : "/register",
      );
      await enterSyntheticLogin(page);
      const action = (await hands.observe()).actions.find(
        (entry) =>
          entry.label === (kind === "signIn" ? "Sign in" : "Create account"),
      )!;
      const before = posts.length;
      expect(
        await withBrowserPermissions(hands, {}).clickElement(action.ref),
      ).toMatchObject({ ok: false });
      expect(posts.length).toBe(before);
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          [kind]: true,
        }),
      });
      expect(await guarded.clickElement(action.ref)).toMatchObject({
        ok: true,
      });
      await page.waitForURL(`${base}/jobs`);
      expect(posts.slice(before)).toEqual([
        kind === "signIn" ? "/session" : "/account",
      ]);
      const nextTab = await context.newPage();
      await nextTab.goto(`${base}/jobs`);
      expect(
        (await context.cookies(base)).some(
          (cookie) => cookie.name === "syntheticSession",
        ),
      ).toBe(true);
      expect((await hands.observe()).bodyTextExcerpt).toContain("Job results");
    } finally {
      await context.close();
    }
  },
);

test("CAPTCHA checkbox opt-in does not open an application POST window", async () => {
  const context = await browser.newContext();
  try {
    const { page, hands } = await open(context, "/captcha");
    const observed = await hands.observe();
    const box = observed.controls.find((entry) =>
      entry.label.includes("robot"),
    )!;
    const before = posts.length;
    expect(
      await withBrowserPermissions(hands, {}).setToggle(box.ref, true),
    ).toMatchObject({ ok: false });
    await expect.poll(() => page.getByRole("checkbox").isChecked()).toBe(false);
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        solveCaptchas: true,
      }),
    });
    expect(await guarded.setToggle(box.ref, true)).toMatchObject({ ok: true });
    expect(await page.getByRole("checkbox").isChecked()).toBe(true);
    const send = (await guarded.observe()).actions.find(
      (entry) => entry.label === "Submit application",
    )!;
    await guarded.clickElement(send.ref);
    expect(posts.length).toBe(before);
    expect(page.url()).toBe(`${base}/captcha`);
  } finally {
    await context.close();
  }
});

test("host-only autofill is invoked only with sign-in opt-in and its password is absent from observations", async () => {
  const context = await browser.newContext();
  try {
    const { page, hands } = await open(context, "/login");
    let fills = 0;
    const prepareBrowserCredentials = async (url: string) => {
      expect(url).toBe(`${base}/login`);
      fills++;
      await enterSyntheticLogin(page);
      return true;
    };
    await withBrowserPermissions(hands, {
      prepareBrowserCredentials,
    }).observe();
    expect(fills).toBe(0);
    const observed = await withBrowserPermissions(hands, {
      prepareBrowserCredentials,
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    }).observe();
    expect(fills).toBe(1);
    expect(
      observed.controls.find((entry) => entry.credentialRole === "password")
        ?.answered,
    ).toBe(true);
    expect(JSON.stringify(observed)).not.toContain(
      "synthetic-replica-password",
    );
  } finally {
    await context.close();
  }
});
