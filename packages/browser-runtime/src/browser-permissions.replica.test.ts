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
import {
  allowPrepareOnlyRunNavigation,
  createApplicationRunServiceWorkerSentinel,
} from "./playwright-application-flow";

let server: Server;
let browser: Browser;
let base = "";
const posts: string[] = [];

function dynamicAccountPage(button: boolean): string {
  const login = `<h1>Sign In</h1><form id="login">
    <label>Email Address<input type="email" name="email" autocomplete="username"></label>
    <label>Password<input type="password" name="password" autocomplete="current-password"></label>
    <button type="${button ? "button" : "submit"}" id="signin">Sign In</button>
    </form><button type="button">Create Account</button>`;
  return `<!doctype html><title>Create Account / Sign In</title><main>
    <h1>Create Account</h1><form method="post" action="/account">
    <label>Email Address<input type="email" name="email"></label>
    <label>Password<input type="password" autocomplete="new-password"></label>
    <label>Verify Password<input type="password" autocomplete="new-password"></label>
    <button>Create Account</button>
    <section><h2>Already have an account?</h2><button type="button" id="existing-account">Sign In</button></section>
    </form></main><script>
    globalThis.syntheticAuthPresses = 0;
    document.querySelector('#existing-account').onclick = () => {
      document.querySelector('main').innerHTML = ${JSON.stringify(login)};
      const authenticate = (event) => {
        event.preventDefault();
        globalThis.syntheticAuthPresses++;
        void fetch('/auth', {method:'POST',body:new URLSearchParams(new FormData(document.querySelector('#login')))}).catch(()=>{});
      };
      ${button ? "document.querySelector('#signin').onclick = authenticate;" : "document.querySelector('#login').onsubmit = authenticate;"}
    };
    </script>`;
}

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
    if (path === "/dyn-apply" || path === "/dyn-apply-button") {
      response.end(dynamicAccountPage(path.endsWith("-button")));
    } else if (path === "/google-session") {
      response.writeHead(303, {
        Location: "/jobs",
        "Set-Cookie": "syntheticGoogleSession=yes; Path=/; SameSite=Lax",
      });
      response.end();
    } else if (path === "/account-choices") {
      response.end(`<!doctype html><title>Sign In</title>
        <header><button onclick="document.querySelector('dialog').showModal()">Sign In</button></header>
        <main><h1>Sign In</h1><form method="post" action="/session">
          <label>Email Address<input type="email" name="email"></label>
          <label>Password<input type="password" name="password"></label>
          <button>Sign In</button></form><button>Create Account</button></main>
        <dialog><h2>Sign In</h2>
          <button type="button" aria-label="Sign in with Apple">Sign in with Apple</button>
          <button type="button" aria-label="Sign in with Google" onclick="location.href='/google-session'">Sign in with Google</button>
          <button type="button" aria-label="Sign in with LinkedIn">Sign in with LinkedIn</button>
          <button onclick="document.querySelector('dialog').close()">Sign in with email</button>
        </dialog>`);
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
  const sentinel = createApplicationRunServiceWorkerSentinel({
    context,
    targetUrl: `${base}${path}`,
  });
  sentinel.attachPage(page);
  page.once("close", () => sentinel.detach());
  const session = createPlaywrightApplyPageSession({ page, sentinel });
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

test.each(["/dyn-apply", "/dyn-apply-button"])(
  "same-URL registration-to-login at %s signs in through the host-filled JavaScript press once (B5)",
  async (path) => {
    const context = await browser.newContext();
    try {
      const { page, hands } = await open(context, path);
      const before = posts.length;
      const prepared: string[] = [];
      let registrationReads = 0;
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
        }),
        prepareBrowserCredentials: async (url) => {
          const password = page.locator(
            'input[autocomplete="current-password"]',
          );
          if ((await password.count()) !== 1) {
            registrationReads++;
            return false;
          }
          prepared.push(url);
          await password.fill("synthetic-host-only-password");
          return true;
        },
      });
      const registration = await guarded.observe();
      expect(registration.blocker?.code).toBe("account_creation_required");
      const create = registration.actions.find(
        (action) => action.label === "Create Account",
      )!;
      expect(await guarded.clickElement(create.ref)).toMatchObject({
        ok: false,
      });
      const entry = registration.actions.find(
        (action) => action.label === "Sign In",
      )!;
      expect(await guarded.clickElement(entry.ref)).toMatchObject({ ok: true });
      await page.locator('input[autocomplete="current-password"]').waitFor();
      const login = await guarded.observe();
      expect(page.url()).toBe(`${base}${path}`);
      // ADR 0012 (B5): after exact-site host autofill the existing-account
      // JavaScript Sign In is the agent's to press; nothing goes to the person.
      expect(login.blocker).toMatchObject({
        code: "site_login_required",
        requiresPerson: false,
      });
      expect(registrationReads).toBe(1);
      expect(prepared).toEqual([`${base}${path}`]);
      expect(
        login.controls.find((control) => control.credentialRole === "password")
          ?.answered,
      ).toBe(true);
      expect(JSON.stringify(login)).not.toContain(
        "synthetic-host-only-password",
      );
      const email = login.controls.find(
        (control) => control.credentialRole === "identifier",
      )!;
      expect(
        await guarded.fillText(email.ref, "synthetic@example.test"),
      ).toMatchObject({ ok: true });
      const submit = login.actions.find(
        (action) => action.label === "Sign In",
      )!;
      const result = await guarded.clickElement(submit.ref);
      expect(result).toMatchObject({ ok: true });
      // Its own one press: the site's handler ran once and sent exactly one
      // bounded same-origin POST, with no native form navigation.
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as { syntheticAuthPresses: number })
              .syntheticAuthPresses,
        ),
      ).toBe(1);
      expect(page.url()).toBe(`${base}${path}`);
      expect(posts.slice(before)).toEqual(["/auth"]);
      const after = await guarded.observe();
      expect(JSON.stringify(after)).not.toContain(
        "synthetic-host-only-password",
      );
      expect(after.url).not.toContain("synthetic-host-only-password");
      // Host autofill only ever targets this exact site; reading the page
      // again sends nothing more.
      expect(new Set(prepared)).toEqual(new Set([`${base}${path}`]));
      expect(posts.slice(before)).toEqual(["/auth"]);
    } finally {
      await context.close();
    }
  },
  20_000,
);

test.each(["/dyn-apply", "/dyn-apply-button"])(
  "Google alone cannot prepare or submit the password login at %s",
  async (path) => {
    const context = await browser.newContext();
    try {
      const { page, hands } = await open(context, path);
      const before = posts.length;
      let prepared = 0;
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          googleSignIn: true,
        }),
        prepareBrowserCredentials: () => {
          prepared++;
          return Promise.resolve(false);
        },
      });
      const registration = await guarded.observe();
      const entry = registration.actions.find(
        (action) => action.label === "Sign In",
      )!;
      expect(await guarded.clickElement(entry.ref)).toMatchObject({ ok: true });
      await page.locator('input[autocomplete="current-password"]').waitFor();
      const login = await guarded.observe();
      const email = login.controls.find(
        (control) => control.credentialRole === "identifier",
      )!;
      expect(
        await guarded.fillText(email.ref, "synthetic@example.test"),
      ).toMatchObject({ ok: false });
      const submit = login.actions.find(
        (action) => action.label === "Sign In",
      )!;
      expect(await guarded.clickElement(submit.ref)).toMatchObject({
        ok: false,
      });
      expect(prepared).toBe(0);
      expect(
        await page
          .locator('input[autocomplete="current-password"]')
          .inputValue(),
      ).toBe("");
      expect(
        await page.evaluate(
          () =>
            (globalThis as unknown as { syntheticAuthPresses: number })
              .syntheticAuthPresses,
        ),
      ).toBe(0);
      expect(posts.slice(before)).toEqual([]);
      expect(page.url()).toBe(`${base}${path}`);
    } finally {
      await context.close();
    }
  },
);

test("two-stage sign-in opens provider choices without a password or registration grant, then uses only enabled Google", async () => {
  const context = await browser.newContext();
  try {
    const { page, hands } = await open(context, "/account-choices");
    const before = posts.length;
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    const first = await guarded.observe();
    expect(first.blocker?.code).toBe("site_login_required");
    const entry = first.actions.find(
      (action) => action.label === "Sign In" && !action.inForm,
    )!;
    const submit = first.actions.find(
      (action) => action.label === "Sign In" && action.inForm,
    )!;
    const password = first.controls.find(
      (control) => control.credentialRole === "password",
    )!;
    expect(await guarded.clickElement(submit.ref)).toMatchObject({ ok: false });
    expect(
      await guarded.fillText(password.ref, "not-an-agent-credential"),
    ).toMatchObject({ ok: false });
    expect(await guarded.clickElement(entry.ref)).toMatchObject({ ok: true });
    await expect(page.locator("dialog").isVisible()).resolves.toBe(true);
    const google = (await guarded.observe()).actions.find(
      (action) => action.label === "Sign in with Google",
    )!;
    expect(google.visible).toBe(true);
    expect(await guarded.clickElement(google.ref)).toMatchObject({ ok: false });
    const googleOnly = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(await googleOnly.clickElement(google.ref)).toMatchObject({
      ok: true,
    });
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
}, 30_000);

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
}, 30_000);

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
