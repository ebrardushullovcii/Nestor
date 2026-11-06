import { chromium } from "playwright";
import { expect, test } from "vitest";
import { readRawApplyPage } from "./apply-page-mechanics";

test("native tab buttons retain their role in the root and child-frame readers without submitting", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<form onsubmit="event.preventDefault(); document.body.dataset.submitted='true'"><button type="button" role="tab" onclick="document.querySelector('#panel').hidden=false">Application</button><section id="panel" hidden><label>Name<input name="name"></label></section></form><iframe srcdoc="<form><button type='button' role='tab'>Application details</button></form>"></iframe>`,
    );
    const raw = await readRawApplyPage(page);
    expect(raw.actions.filter((action) => action.role === "tab")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Application", submitsForm: false }),
        expect.objectContaining({
          label: "Application details",
          submitsForm: false,
        }),
      ]),
    );
    await page.getByRole("tab", { name: "Application", exact: true }).click();
    expect(await page.locator("#panel").isVisible()).toBe(true);
    expect(
      await page.locator("body").getAttribute("data-submitted"),
    ).toBeNull();
  } finally {
    await browser.close();
  }
});

test("anchor tabs have one action handle rather than an ordinary-link route", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<nav role="tablist"><a role="tab" href="https://example.test/job">Overview</a><a role="tab" href="https://example.test/job/application">Application</a></nav><a href="https://example.test/privacy">Privacy</a><iframe srcdoc="<a role='tab' href='https://example.test/details'>Application details</a>"></iframe>`,
    );
    const raw = await readRawApplyPage(page);
    expect(
      raw.actions
        .filter((action) => action.role === "tab")
        .map((action) => action.label),
    ).toEqual(["Overview", "Application", "Application details"]);
    expect(raw.links.map((link) => link.label)).toEqual(["Privacy"]);
    expect(raw.clickables.filter((entry) => entry.role === "tab")).toEqual([]);
  } finally {
    await browser.close();
  }
});

test("the mutation count includes opaque and blocked requests independently of attachment matching", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://127.0.0.1:47950/**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<h1>Synthetic request counter</h1>",
      }),
    );
    await page.route("https://uploads.example.test/**", (route) =>
      route.abort("blockedbyclient"),
    );
    await page.goto("http://127.0.0.1:47950/counter");
    expect((await readRawApplyPage(page)).networkMutationCount).toBe(0);
    await page.evaluate(async () => {
      for (const method of ["GET", "HEAD", "OPTIONS"])
        await fetch("/read", { method });
    });
    expect((await readRawApplyPage(page)).networkMutationCount).toBe(0);
    await page.evaluate(async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"])
        await fetch("/opaque", {
          method,
          body: "opaque payload with no filename",
        });
      await fetch("https://uploads.example.test/attachment", {
        method: "POST",
        body: "unmatched payload",
      }).catch(() => undefined);
    });
    const raw = await readRawApplyPage(page);
    expect(raw.networkMutationCount).toBe(5);
    expect(raw.uploads ?? []).toEqual([]);
  } finally {
    await browser.close();
  }
});
