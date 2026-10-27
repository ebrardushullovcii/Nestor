import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";

import { sendObserverSource } from "./send-observer";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The page with the observer, and the tokens it logged. */
async function observed(html: string, bound: boolean) {
  const page: Page = await browser.newPage();
  const logged: string[] = [];
  page.on("console", (message) => logged.push(message.text()));
  // A real origin: the observer reads the tab's session storage.
  await page.route("https://site.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.goto("https://site.test/apply");
  if (bound)
    await page.evaluate(() => {
      (
        window as unknown as Record<string, unknown>
      ).__nestorPreparedApplication = true;
    });
  await page.evaluate(sendObserverSource("unbound", "bound"));
  return { page, logged };
}

// Askable's role form: one "Apply" button whose handler posts with fetch.
const roleForm = `<form onsubmit="event.preventDefault()"><label>Name <input name="name" value="Robin"></label><button type="submit">Apply</button></form>`;

test("on a prepared form, the person's own press of its send is reported", async () => {
  const { page, logged } = await observed(roleForm, true);
  await page.click("button");
  expect(logged).toContain("bound");
  expect(logged).not.toContain("unbound");
  await page.close();
});

test("on a page that is not a prepared form, only a send-looking control gives the hint", async () => {
  const { page, logged } = await observed(
    `${roleForm}<button type="button">Submit application</button>`,
    false,
  );
  await page.click("text=Apply");
  expect(logged).toEqual([]);
  await page.click("text=Submit application");
  expect(logged).toEqual(["unbound"]);
  await page.close();
});
