import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "./application-submission-browser-hands";
import { clickPresent } from "./present-control";

const origin = "http://replica.test";
const form = `<!doctype html>
  <style>
    body { margin: 0; }
    header { position: sticky; top: 0; height: 68px; background: white; }
    main { padding: 532px 0 524px; }
    button { display: block; margin: auto; height: 40px; }
    aside { position: fixed; inset: 0; background: white; }
  </style>
  <header id="sticky-header" onclick="document.body.dataset.press = 'header'">Site header</header>
  <main><form action="/submit" method="post">
    <button type="submit"><span>Submit application</span></button>
  </form></main>
  <script>
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      document.body.dataset.press = 'submit';
      fetch(event.target.action, { method: 'POST' });
    });
  </script>`;

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test.each(["click", "submit"] as const)(
  "%s reaches the form button below a sticky header and reports a persistent overlay",
  async (tool) => {
    const page = await browser.newPage({
      viewport: { width: 800, height: 600 },
    });
    const submissions: string[] = [];
    try {
      await page.route(`${origin}/**`, async (route) => {
        if (route.request().method() === "POST") {
          submissions.push(route.request().url());
          await route.fulfill({ status: 204 });
        } else {
          await route.fulfill({ contentType: "text/html", body: form });
        }
      });
      await page.goto(`${origin}/form`);
      const mechanics = createPlaywrightApplyPageMechanics(page);
      await mechanics.scroll("bottom");
      const button = page.getByRole("button", { name: "Submit application" });
      expect(
        await button.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          )?.id;
        }),
      ).toBe("sticky-header");

      const press = async (callId: string) => {
        const raw = await mechanics.readPage();
        const control = raw.actions.find(
          ({ label }) => label === "Submit application",
        )!;
        const ref = control.ref ?? `a${control.index}`;
        if (tool === "click") {
          const result = await mechanics.clickElement(ref);
          return {
            pressed: result.ok,
            message: result.ok ? "" : result.error,
            requests: result.clickFacts?.requestsAfterClick,
          };
        }
        const observation = await observeApplicationForm(page, {
          finalActionTargets: [{ ref, label: control.label }],
        });
        const result = await executeExactlyOneFinalAction(page, {
          expectedObservation: observation.identity,
          expectedControl: observation.controls[0]!.identity,
          expectedPageOrigin: origin,
          allowedOrigins: [origin],
          veto: () => true,
          callId,
        });
        return {
          pressed: result.facts.actionCompleted,
          message:
            result.outcome === "outcome_uncertain" ? result.siteMessage : "",
          requests: result.facts.requestsAfterClick,
        };
      };

      const sent = await press("sticky-header");
      expect(await page.locator("body").getAttribute("data-press")).toBe(
        "submit",
      );
      expect(sent.pressed).toBe(true);
      expect(submissions).toEqual([`${origin}/submit`]);
      expect(sent.requests).toMatchObject([
        { method: "POST", path: "/submit" },
      ]);

      await page.evaluate(() => {
        const overlay = document.createElement("aside");
        overlay.setAttribute("aria-label", "Privacy choices");
        overlay.innerHTML =
          '<div style="height: 100%">Choose your preferences</div>';
        overlay.addEventListener("click", () => {
          document.body.dataset.press = "overlay";
        });
        document.body.append(overlay);
        delete document.body.dataset.press;
      });
      const blocked = await press("persistent-overlay");
      expect(blocked.pressed).toBe(false);
      expect(blocked.message).toContain("Privacy choices");
      expect(blocked.requests).toEqual([]);
      expect(await page.locator("body").getAttribute("data-press")).toBeNull();
      expect(submissions).toEqual([`${origin}/submit`]);
    } finally {
      await page.close();
    }
  },
);

test("a parent-page overlay covering a framed control is reported", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <iframe srcdoc="<button onclick=&quot;this.textContent='Pressed'&quot;>Continue</button>"></iframe>
      <aside aria-label="Parent overlay" style="position: fixed; inset: 0"
        onclick="this.dataset.pressed = 'yes'"></aside>
    `);
    const button = page.frameLocator("iframe").getByRole("button");
    await button.waitFor();
    await expect(clickPresent(button)).rejects.toThrow('"Parent overlay"');
    expect(await page.locator("aside").getAttribute("data-pressed")).toBeNull();
    expect(await button.textContent()).toBe("Continue");

    await page.locator("aside").evaluate((overlay) => overlay.remove());
    await clickPresent(button);
    expect(await button.textContent()).toBe("Pressed");
  } finally {
    await page.close();
  }
});
