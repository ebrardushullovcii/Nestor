import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readRawApplyPage } from "./apply-page-mechanics";
import { isCaptchaVerificationRequest } from "./captcha-verification";
import { pageMessageReadsAsFailure } from "./page-messages";
import {
  allowPrepareOnlyRunNavigation,
  ensurePrepareOnlyMutationGuard,
  readPrepareOnlyMutationGuardInPage,
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
  test("never open a window; their text is on the page read", async () => {
    const page = await guardedPage();
    let windows = 0;
    page.on("dialog", (dialog) => {
      windows += 1;
      void dialog.dismiss();
    });
    const answers = await page.evaluate(() => [
      window.alert(
        "Cannot contact reCAPTCHA. Check your connection and try again.",
      ),
      window.confirm("Leave this page?"),
      window.prompt("Your name"),
    ]);
    expect(windows).toBe(0);
    // Dismissed: a question is answered no, a prompt gets nothing.
    expect(answers).toEqual([undefined, false, null]);
    const { pageMessages } = await readRawApplyPage(page);
    expect(
      pageMessages?.map((message) => [message.kind, message.text]),
    ).toEqual([
      [
        "alert",
        "Cannot contact reCAPTCHA. Check your connection and try again.",
      ],
      ["confirm", "Leave this page?"],
      ["prompt", "Your name"],
    ]);
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

  test("its token request is left to the fence, which holds it outside the final click", async () => {
    const page = await guardedPage();
    const refusedByFence: string[] = [];
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText.includes("ERR_BLOCKED_BY_CLIENT"))
        refusedByFence.push(request.url());
    });
    await page.evaluate(async () => {
      for (const url of [
        "https://www.google.com/recaptcha/api2/reload?k=site-key",
        "https://collector.example.test/collect",
      ])
        await fetch(url, { method: "POST", body: "token" }).catch(
          () => undefined,
        );
    });
    const { refusals } = await page.evaluate(
      readPrepareOnlyMutationGuardInPage,
    );
    // The page's guard refuses the other site's post itself…
    expect((refusals ?? []).map((refusal) => refusal.url)).toEqual([
      "https://collector.example.test/collect",
    ]);
    // …and the network fence refused the token request: no final click.
    expect(refusedByFence).toContain(
      "https://www.google.com/recaptcha/api2/reload?k=site-key",
    );
    await page.context().close();
  });
});
