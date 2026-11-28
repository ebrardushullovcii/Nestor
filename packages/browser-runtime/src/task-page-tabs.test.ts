import type { ApplyRawPageHands } from "@nestor/contracts";
import { chromium, type Page } from "playwright";
import { expect, test, vi } from "vitest";
import { withTaskPageTabs } from "./task-page-tabs";

test.each([
  [
    "https://accounts.google.com/v3/signin/accountchooser?continue=fixture",
    "google_accounts_redirect",
  ],
  ["https://example.test/unavailable", "unknown"],
])("reports the Gmail probe landing at %s", async (url, status) => {
  const context = {
    pages: () => [],
    cookies: () => Promise.resolve([{ name: "fixture" }]),
    newPage: () => Promise.resolve(probe),
  };
  const probe = {
    context: () => context,
    goto: vi.fn().mockResolvedValue(undefined),
    url: () => url,
    close: vi.fn().mockResolvedValue(undefined),
  };
  const primary = { context: () => context } as unknown as Page;
  const hands = withTaskPageTabs(primary, () => ({}) as ApplyRawPageHands);

  expect(await hands.readMailboxSession?.()).toEqual({ status });
  expect(probe.goto).toHaveBeenCalledWith(
    "https://mail.google.com/mail/u/0/",
    expect.any(Object),
  );
  expect(probe.close).toHaveBeenCalledOnce();
});

test("reads a visible provider account control in the form's browser context", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const primary = await context.newPage();
    const url = "https://www.linkedin.com/feed/";
    const provider = "LinkedIn";
    const hands = withTaskPageTabs(primary, () => ({}) as ApplyRawPageHands);
    const accountMenu = '<button class="global-nav__me">Me</button>';
    let pageBody = accountMenu;
    const respond = vi.fn(() => pageBody);
    await context.route("**/*", (route) =>
      route.request().url() === url
        ? route.fulfill({ contentType: "text/html", body: respond() })
        : route.abort(),
    );
    const read = () => hands.readProviderSessions!();

    expect(await read()).toEqual([{ provider, status: "unknown" }]);
    expect(respond).not.toHaveBeenCalled();

    // A preference cookie gives the reader a page to inspect. The account
    // control is the evidence of sign-in.
    await context.addCookies([{ url, name: "theme", value: "dark" }]);
    expect(await read()).toEqual([{ provider, status: "signed_in" }]);
    expect(context.pages()).toEqual([primary]);

    pageBody = '<button class="global-nav__me" hidden>Me</button>';
    expect(await read()).toEqual([{ provider, status: "unknown" }]);
    expect(context.pages()).toEqual([primary]);

    pageBody = accountMenu;
    const existing = await context.newPage();
    await existing.goto(url);
    respond.mockClear();
    expect(await read()).toEqual([{ provider, status: "signed_in" }]);
    expect(respond).not.toHaveBeenCalled();
    expect(context.pages()).toEqual([primary, existing]);
  } finally {
    await browser.close();
  }
});
