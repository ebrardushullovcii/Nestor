import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Page } from "playwright";
import { expect, test, vi } from "vitest";
import { createBrowserAgentRuntime } from "./playwright-browser-runtime";

test("a lost access tab reopens with GET and keeps writes guarded until the person takes over", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "text/html");
    response.end(
      '<h1>Sign in</h1><form method="post"><label>Email<input name="email"></label><button>Sign in</button></form>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    await browser.newContext();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apply`;
    let restored: Page | null = null;
    const adopt = vi.fn((_key: string, page: Page) => {
      restored = page;
      return Promise.resolve();
    });
    const runtime = createBrowserAgentRuntime({
      userDataDir: "/unused",
      browserHost: {
        connect: () => Promise.resolve(browser),
        getOpenBrowser: () => Promise.resolve(browser),
        close: () => Promise.resolve(),
        assertAutomationSafe: () => Promise.resolve(),
      },
      onApplicationPageRestored: adopt,
    });
    await runtime.reloadApplicationPageBinding!("target_site", "waiting", url);
    expect(
      await runtime.focusApplicationPageBinding!("target_site", "waiting"),
    ).toBe(true);
    expect(
      await runtime.readApplicationPageBinding!("target_site", "waiting"),
    ).toMatchObject({ url });
    expect(adopt).toHaveBeenCalledOnce();
    await (restored as Page | null)?.evaluate(async () => {
      await fetch(location.href, {
        method: "POST",
        body: "must-not-send",
      }).catch(() => undefined);
    });
    expect(requests.filter((request) => request.startsWith("POST"))).toEqual(
      [],
    );
    await runtime.releaseApplicationPageBinding!("target_site", "waiting");
    expect((restored as Page | null)?.isClosed()).toBe(true);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 30_000);
