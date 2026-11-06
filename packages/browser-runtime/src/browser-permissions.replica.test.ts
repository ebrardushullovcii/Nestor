import { createServer, type Server } from "node:http";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createApplyPageHands,
  withBrowserPermissions,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
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

test.each(["/dyn-apply", "/dyn-apply-button"])(
  "the model can choose website sign-in at %s and request the vault without exposing secrets",
  async (path) => {
    const context = await browser.newContext();
    try {
      const { page, hands } = await open(context, path);
      let fills = 0;
      const tools = withBrowserPermissions(hands, {
        prepareBrowserCredentials: async () => {
          fills++;
          await page.getByLabel("Email Address").fill("synthetic@example.test");
          await page
            .getByLabel("Password", { exact: true })
            .fill("synthetic-replica-password");
          return true;
        },
      });
      const registration = await tools.observe();
      expect(registration.blocker).toBeNull();
      expect(fills).toBe(0);
      const entry = registration.actions.find((a) => a.label === "Sign In")!;
      expect(await tools.clickElement(entry.ref)).toMatchObject({ ok: true });
      expect(await tools.prepareBrowserCredentials!(page.url())).toBe(true);
      const login = await tools.observe();
      expect(JSON.stringify(login)).not.toContain("synthetic-replica-password");
      const submit = login.actions.find((a) => a.label === "Sign In")!;
      expect(await tools.clickElement(submit.ref)).toMatchObject({ ok: true });
      expect(fills).toBe(1);
    } finally {
      await context.close();
    }
  },
);
