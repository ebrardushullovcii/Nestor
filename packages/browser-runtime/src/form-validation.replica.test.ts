import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApplyPageHands } from "@nestor/browser-agent";
import { createPlaywrightApplyPageMechanics } from "./apply-page-mechanics";
import {
  observeApplicationForm,
  executeExactlyOneFinalAction,
} from "./application-submission-browser-hands";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

test("the model sees native, ARIA, linked and closed-shadow validation messages", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<label>Phone<input aria-invalid="true" aria-errormessage="phone-error"></label><p id="phone-error" role="alert">Choose the phone country before sending.</p><open-fields></open-fields><closed-fields></closed-fields>`,
    );
    await page.evaluate(() => {
      const open = document
        .querySelector("open-fields")!
        .attachShadow({ mode: "open" });
      open.innerHTML =
        '<label>Email<input type="email" required value="invalid" aria-describedby="email-error"></label><p id="email-error" role="alert">Enter a work email address.</p>';
      const closed = document
        .querySelector("closed-fields")!
        .attachShadow({ mode: "closed" });
      closed.innerHTML =
        '<label>Region<input required></label><p role="alert">The region is required.</p>';
      closed
        .querySelector("input")!
        .setCustomValidity("Choose a region from the list.");
    });
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    const observation = await hands.observe();
    const phone = observation.controls.find(
      (control) => control.label === "Phone",
    )!;
    expect(phone).toMatchObject({ invalid: true });
    expect(phone.validationMessage).toContain("aria-invalid=true");
    expect(phone.validationMessage).toContain("Choose the phone country");
    const text = JSON.stringify(observation);
    expect(text).toContain("typeMismatch");
    expect(text).toContain("Enter a work email address");
    expect(text).toContain("Choose a region from the list");
    expect(text).toContain("The region is required");
  } finally {
    await page.close();
  }
});

test("disabled and inert presses report their DOM state, including through the send adapter", async () => {
  const page = await browser.newPage();
  try {
    await page.route("http://replica.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<fieldset disabled><button>Disabled Send</button></fieldset><div inert><button>Inert Send</button></div><closed-send inert></closed-send><script>window.presses=0;document.querySelectorAll("button").forEach(button=>button.onclick=()=>window.presses++)</script>',
      }),
    );
    await page.goto("http://replica.test/form");
    await page.evaluate(() => {
      const root = document
        .querySelector("closed-send")!
        .attachShadow({ mode: "closed" });
      root.innerHTML = "<button>Closed inert Send</button>";
    });
    const hands = createApplyPageHands(
      createPlaywrightApplyPageMechanics(page),
    );
    const observation = await hands.observe();
    for (const label of ["Disabled Send", "Inert Send", "Closed inert Send"]) {
      const control = [...observation.actions, ...observation.clickables].find(
        (control) => control.label === label,
      )!;
      expect(control.disabled).toBe(true);
      const result = await hands.clickElement(control.ref);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toMatch(
          label === "Disabled Send" ? /disabled/iu : /inert/iu,
        );
      const form = await observeApplicationForm(page, {
        finalActionTargets: [{ ref: control.ref, label }],
      });
      const sent = await executeExactlyOneFinalAction(page, {
        expectedObservation: form.identity,
        expectedControl: form.controls[0]!.identity,
        expectedPageOrigin: "http://replica.test",
        allowedOrigins: ["http://replica.test"],
        veto: () => true,
        callId: label,
      });
      expect(sent.outcome).toBe("outcome_uncertain");
      if (sent.outcome === "outcome_uncertain")
        expect(sent.siteMessage).toMatch(
          label === "Disabled Send" ? /disabled/iu : /inert/iu,
        );
    }
    expect(
      await page.evaluate(
        () => (window as unknown as { presses: number }).presses,
      ),
    ).toBe(0);
  } finally {
    await page.close();
  }
});
