import { chromium } from "playwright";
import { expect, test } from "vitest";
import { buildApplyFormObservation } from "@nestor/browser-agent";
import { readRawApplyPage } from "./apply-page-mechanics";

test("search, navigation and footer defaults never become application answers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Apply for Software Engineer</h1>
      <nav><label>Region<select><option selected>Europe</option></select></label></nav>
      <form role="search"><label>Find jobs<input type="search" value="Engineer"></label><label>Department<select><option selected>Engineering</option></select></label></form>
      <main><form><label>Full name<input name="name" value="Synthetic Person" required></label><label>Preferred language<select><option selected>English</option></select></label></form></main>
      <footer><label>Site language<select><option selected>English</option></select></label></footer>`);
    const raw = await readRawApplyPage(page);
    expect(
      raw.controls.find((c) => c.label === "Site language")?.sectionPath,
    ).toContain("footer");
    const observation = buildApplyFormObservation(
      raw,
      new Date().toISOString(),
    );
    expect(observation.controls.map((c) => c.label)).toEqual([
      "Full name",
      "Preferred language",
    ]);
  } finally {
    await browser.close();
  }
}, 30_000);
