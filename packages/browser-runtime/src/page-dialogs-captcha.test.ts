import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { isCaptchaVerificationRequest } from "./captcha-verification";
import { pageMessageReadsAsFailure } from "./page-messages";
import {
  allowPrepareOnlyRunNavigation,
  ensurePrepareOnlyMutationGuard,
} from "./playwright-application-flow";

let browser: Browser | null = null;
let server: http.Server | null = null;
let base = "";

beforeAll(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<h1>Apply</h1><button>Submit application</button>");
  });
  await new Promise<void>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve()),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function guardedPage() {
  const page = await (await browser!.newContext()).newPage();
  await ensurePrepareOnlyMutationGuard(page, false, [], true);
  allowPrepareOnlyRunNavigation(page, `${base}/apply`);
  await page.goto(`${base}/apply`);
  return page;
}

describe("a job page's own dialogs", () => {
  test("remain the site's native dialogs instead of being replaced by a request guard", async () => {
    const page = await guardedPage();
    let seen = 0;
    page.on("dialog", (dialog) => {
      seen++;
      void dialog.dismiss();
    });
    const answers = await page.evaluate(() => [
      window.alert("Site alert"),
      window.confirm("Leave?"),
      window.prompt("Name"),
    ]);
    expect(seen).toBe(3);
    expect(answers).toEqual([undefined, false, null]);
    await page.context().close();
  });

  test("a failed Submit's message reads as a failure", () => {
    for (const text of [
      "Cannot contact reCAPTCHA. Check your connection and try again.",
      "Something went wrong. Please try again.",
      "Your application could not be submitted.",
    ])
      expect(pageMessageReadsAsFailure(text)).toBe(true);
    expect(pageMessageReadsAsFailure("Thanks for applying!")).toBe(false);
  });
});

describe("the site's own CAPTCHA check", () => {
  test("names reCAPTCHA, hCaptcha and Turnstile requests only", () => {
    for (const url of [
      "https://www.google.com/recaptcha/api.js?render=explicit",
      "https://www.google.com/recaptcha/api2/reload?k=site-key",
      "https://www.google.com/recaptcha/api2/userverify?k=site-key",
      "https://www.recaptcha.net/recaptcha/enterprise/reload?k=site-key",
      "https://www.gstatic.com/recaptcha/releases/abc/recaptcha__en.js",
      "https://js.hcaptcha.com/1/api.js",
      "https://api.hcaptcha.com/getcaptcha/site-key",
      "https://challenges.cloudflare.com/turnstile/v0/api.js",
      "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/flow",
    ])
      expect(isCaptchaVerificationRequest(url)).toBe(true);
    for (const url of [
      "https://www.google.com/search?q=recaptcha",
      "https://evil.example/www.google.com/recaptcha/api2/reload",
      "https://www.google.com.evil.example/recaptcha/api2/reload",
      "https://xhcaptcha.com/collect",
      "https://challenges.cloudflare.com/other",
      "http://www.google.com/recaptcha/api2/reload",
    ])
      expect(isCaptchaVerificationRequest(url)).toBe(false);
  });
});
