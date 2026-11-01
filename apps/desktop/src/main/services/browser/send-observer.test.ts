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
  expect(logged.some((entry) => entry.startsWith("bound{"))).toBe(true);
  expect(logged).not.toContain("unbound");
  await page.close();
});

test.each([
  [
    "sign in",
    '<form onsubmit="event.preventDefault()"><input name="email"><input type="password"><button>Sign In</button></form>',
  ],
  [
    "account form with generic submit",
    '<form onsubmit="event.preventDefault()"><input name="name"><input type="password"><button>Submit</button></form>',
  ],
  [
    "wizard advance",
    '<form onsubmit="event.preventDefault()"><input name="first_name"><button>Save and continue</button></form>',
  ],
  ["entry button", "<h1>Engineer</h1><button>Apply now</button>"],
  [
    "newsletter",
    '<form onsubmit="event.preventDefault()"><input name="name"><input name="email"><button>Submit</button></form>',
  ],
  [
    "non-final numbered step",
    '<span aria-current="step">Step 1 of 4</span>' + roleForm,
  ],
])(
  "a prepared page's %s is not a final application press",
  async (_name, html) => {
    const { page, logged } = await observed(html, true);
    await page.locator("button").click();
    expect(logged).toEqual([]);
    await page.close();
  },
);

test("a script event cannot produce a person's send, and a real press retains only prior receipt phrases", async () => {
  const { page, logged } = await observed(
    "<aside>Thank you for applying.</aside>" + roleForm,
    true,
  );
  await page.locator("button").dispatchEvent("click");
  expect(logged).toEqual([]);
  await page.locator("button").click();
  const notice = logged.find((entry) => entry.startsWith("bound{"));
  expect(JSON.parse(notice!.slice("bound".length))).toEqual({
    confirmationBefore: ["thank you for applying"],
  });
  expect(notice).not.toContain("Robin");
  await page.close();
});

test("a shadow-root final control is observed while a separate password form is ignored", async () => {
  const { page, logged } = await observed(
    '<form><input type="password"><button>Sign in</button></form><section id="application"></section>',
    true,
  );
  await page.locator("#application").evaluate((host, html) => {
    host.attachShadow({ mode: "open" }).innerHTML = html;
  }, roleForm);
  await page.locator("#application button").click();
  expect(logged.some((entry) => entry.startsWith("bound{"))).toBe(true);
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
