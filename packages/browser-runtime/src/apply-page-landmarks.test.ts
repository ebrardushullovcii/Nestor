import { chromium } from "playwright";
import { expect, test } from "vitest";
import { buildApplyFormObservation } from "@nestor/browser-agent";
import { readRawApplyPage } from "./apply-page-mechanics";

test("application snapshots retain landmark facts and every control for the model", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<h1>Apply for Software Engineer</h1>
      <nav><label>Region<select><option selected>Europe</option></select></label></nav>
      <form role="search" aria-label="Job search"><label>Find jobs<input type="search" value="Engineer"></label></form>
      <main><form aria-label="Application"><fieldset><legend>About you</legend><label>Full name<input name="name" value="Synthetic Person" required></label></fieldset></form></main>
      <footer><label>Site language<select><option selected>English</option></select></label></footer>
      <div role="navigation"><label>Category<input value="Engineering"></label></div>
      <div role="contentinfo"><label>Newsletter<input type="email"></label></div>`);
    const raw = await readRawApplyPage(page);
    const observation = buildApplyFormObservation(
      raw,
      new Date().toISOString(),
    );
    for (const [label, sections] of [
      ["Region", ["nav"]],
      ["Find jobs", ["search", "Job search"]],
      ["Full name", ["Application", "About you"]],
      ["Site language", ["footer"]],
      ["Category", ["navigation"]],
      ["Newsletter", ["contentinfo"]],
    ] as const) {
      expect(
        raw.controls.find((control) => control.label === label)?.sectionPath,
      ).toEqual(expect.arrayContaining([...sections]));
      expect(
        observation.controls.find((control) => control.label === label)
          ?.sectionPath,
      ).toEqual(expect.arrayContaining([...sections]));
    }
    expect(observation.controls).toHaveLength(raw.controls.length);
  } finally {
    await browser.close();
  }
}, 30_000);
