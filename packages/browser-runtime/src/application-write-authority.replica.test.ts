import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createApplyPageHands,
  withBrowserPermissions,
} from "@nestor/browser-agent";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";
import {
  ensurePrepareOnlyMutationGuard,
  readPrepareOnlyMutationGuardInPage,
  getBlockedPrepareOnlyAttempts,
  openPrepareOnlyIntermediateMutationWindow,
  closePrepareOnlyIntermediateMutationWindow,
} from "./playwright-application-flow";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

async function fixture(variant = "js") {
  const hits: { method: string; path: string }[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    hits.push({ method: req.method!, path: url.pathname });
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "text/html");
      if (url.pathname.startsWith("/draft/redirect")) {
        res.writeHead(Number(url.pathname.slice(-3)), { location: "/submit" });
        res.end();
        return;
      }
      if (req.method !== "GET") {
        res.end("ok");
        return;
      }
      res.end(
        `<h1>Sign In</h1><form method="get" action="${variant === "cross" ? "http://localhost:1/auth" : "/auth"}"><input autocomplete="username" value="jamie@example.test"><input type="password" autocomplete="current-password" value="synthetic-secret"><button>Sign In</button>${variant === "create-alternative" ? `<button type="button" onclick="location.href='/register'">Create Account</button>` : variant === "create-submit-button" ? "<button>Create Account</button>" : ""}</form>${variant === "native" ? "" : `<script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();await fetch('${variant === "create" ? "/api/users" : "/auth"}',{method:'POST',body:new URLSearchParams(new FormData(e.target))});document.body.innerHTML='<h1>Application</h1><input aria-label="First name"><textarea aria-label="Answer"></textarea>';}</script>`}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(origin);
  await ensurePrepareOnlyMutationGuard(page, true, [origin]);
  const session = createPlaywrightApplyPageSession({ page });
  const raw = await session.readPage();
  const action = raw.actions.find((item) => item.label === "Sign In")!;
  return {
    page,
    session,
    origin,
    hits,
    ref: action.ref ?? `a${action.index}`,
    close: async () => {
      await context.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("host-filled JS login declaring GET uses POST once, then ordinary structured autosaves; no send", async () => {
  const f = await fixture();
  try {
    expect(
      await f.session.clickAuthorizedLoginAction!({ ref: f.ref, frame: null }),
    ).toMatchObject({ ok: true });
    expect(
      await f.page
        .getByRole("heading", { name: "Application", exact: true })
        .isVisible(),
    ).toBe(true);
    expect(f.hits.filter((hit) => hit.path === "/auth")).toEqual([
      { method: "POST", path: "/auth" },
    ]);
    await openPrepareOnlyIntermediateMutationWindow(f.page);
    const saves = await f.page.evaluate(async () => {
      const a = await fetch("/api/candidate/42", {
        method: "PATCH",
        body: JSON.stringify({ firstName: "Jamie" }),
      });
      const b = await fetch("/draft/save", {
        method: "POST",
        body: JSON.stringify({ answer: "I submit weekly reports" }),
      });
      return [a.ok, b.ok];
    });
    expect(saves).toEqual([true, true]);
    await f.page.evaluate(() => {
      void fetch("/graphql", {
        method: "POST",
        body: JSON.stringify({ query: "mutation Save { submitApplication }" }),
      }).catch(() => undefined);
      void fetch("/api/draft?action=submit", {
        method: "POST",
        body: "{}",
      }).catch(() => undefined);
    });
    await closePrepareOnlyIntermediateMutationWindow(f.page);
    await f.page.evaluate(() => {
      void fetch("/api/candidate/42", {
        method: "PATCH",
        body: '{"firstName":"Jamie"}',
      }).catch(() => undefined);
    });
    await f.page.waitForTimeout(150);
    expect(f.hits.filter((hit) => hit.method !== "GET")).toEqual([
      { method: "POST", path: "/auth" },
      { method: "PATCH", path: "/api/candidate/42" },
      { method: "POST", path: "/draft/save" },
    ]);
    expect(
      (await f.page.evaluate(readPrepareOnlyMutationGuardInPage)).refusals,
    ).toHaveLength(3);
  } finally {
    await f.close();
  }
}, 20_000);

// A real login form often offers "Create Account" beside Sign In as a
// non-submitting navigation button. It must not block the exact saved-account
// Sign In; a submitting Create Account still does (below).
test("an in-form non-submitting Create Account does not block the exact saved-account Sign In", async () => {
  const f = await fixture("create-alternative");
  try {
    expect(
      await f.session.clickAuthorizedLoginAction!({ ref: f.ref, frame: null }),
    ).toMatchObject({ ok: true });
    expect(
      await f.page
        .getByRole("heading", { name: "Application", exact: true })
        .isVisible(),
    ).toBe(true);
    expect(f.hits.filter((hit) => hit.method !== "GET")).toEqual([
      { method: "POST", path: "/auth" },
    ]);
    expect(f.hits.some((hit) => hit.path === "/register")).toBe(false);
  } finally {
    await f.close();
  }
}, 20_000);

test("the browser-agent sign-in caller reaches the same exact press through its own checks", async () => {
  const f = await fixture("create-alternative");
  try {
    let prepared = 0;
    const hands = withBrowserPermissions(createApplyPageHands(f.session), {
      browserPermissions: {
        signIn: true,
        googleSignIn: false,
        createAccounts: false,
        solveCaptchas: false,
      },
      // Host-only: the fixture page already carries its synthetic secret.
      prepareBrowserCredentials: () => {
        prepared += 1;
        return Promise.resolve(true);
      },
    });
    const page = await hands.observe();
    const signIn = page.actions.find((action) => action.label === "Sign In")!;
    expect(await hands.clickElement(signIn.ref)).toMatchObject({ ok: true });
    expect(prepared).toBeGreaterThan(0);
    expect(f.hits.filter((hit) => hit.method !== "GET")).toEqual([
      { method: "POST", path: "/auth" },
    ]);
    expect(f.hits.some((hit) => hit.path === "/register")).toBe(false);
  } finally {
    await f.close();
  }
}, 20_000);

test.each([
  "cross",
  "native",
  "create",
  "creation-control",
  "create-submit-button",
])(
  "login cannot authorize %s form navigation",
  async (variant) => {
    const f = await fixture(variant);
    try {
      if (variant === "creation-control")
        await f.page.locator("form").evaluate((form) => {
          const create = document.createElement("input");
          create.type = "submit";
          create.value = "Create account";
          form.append(create);
        });
      await f.session.clickAuthorizedLoginAction!({ ref: f.ref, frame: null });
      expect(f.page.url()).toBe(f.origin + "/");
      expect(f.hits).toEqual([{ method: "GET", path: "/" }]);
    } finally {
      await f.close();
    }
  },
  20_000,
);

test.each([307, 308])(
  "a bounded intermediate write cannot redirect to final submit (%s)",
  async (status) => {
    const f = await fixture();
    try {
      await openPrepareOnlyIntermediateMutationWindow(f.page);
      await f.page.evaluate((code) => {
        void fetch("/draft/redirect" + code, {
          method: "POST",
          body: '{"firstName":"Jamie"}',
        }).catch(() => undefined);
      }, status);
      await f.page.waitForTimeout(250);
      expect(
        f.hits.some((hit) => hit.path === "/draft/redirect" + status),
      ).toBe(true);
      expect(f.hits.some((hit) => hit.path === "/submit")).toBe(false);
      expect(
        (await getBlockedPrepareOnlyAttempts(f.page)).length,
      ).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  },
);
