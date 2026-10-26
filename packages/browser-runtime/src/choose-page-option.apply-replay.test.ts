import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import replay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/picker-option-result.json";
import { choosePageOption } from "./choose-page-option";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

test("native picker replay returns typed absence and its offered choices without changing selection", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<select aria-label="Country">${replay.offered.map((option) => `<option>${option}</option>`).join("")}</select>`,
    );
    const control = page.getByLabel("Country");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: replay.offered,
      },
    );
    expect(await control.inputValue()).toBe(replay.offered[0]);
  } finally {
    await page.close();
  }
});

test("custom picker replay reports its own choices, then permits the saved fallback", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<label>Country<input role="combobox" aria-controls="country-options"></label><div id="country-options" role="listbox">${replay.offered.map((option) => `<div role="option" onclick="document.querySelector('input').value=this.textContent">${option}</div>`).join("")}</div><div role="listbox"><div role="option">${replay.unrelated}</div></div>`,
    );
    const control = page.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject(
      {
        ok: false,
        reason: "option_not_offered",
        offeredOptions: replay.offered,
      },
    );
    expect(await choosePageOption(page, control, replay.offered[0]!)).toEqual({
      ok: true,
      observedValue: replay.offered[0],
    });
    expect(await control.inputValue()).toBe(replay.offered[0]);
  } finally {
    await page.close();
  }
}, 15_000);

test("an unfinished empty list is uncertain, not proof that an option does not exist", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      '<label>Country<input role="combobox" aria-controls="country-options" aria-busy="true"></label><div id="country-options" role="listbox"></div>',
    );
    const result = await choosePageOption(
      page,
      page.getByRole("combobox"),
      replay.missing,
    );
    expect(result).toMatchObject({ ok: false, offeredOptions: [] });
    expect("reason" in result).toBe(false);
  } finally {
    await page.close();
  }
}, 15_000);

test("a picker in a frame reports only that frame's choices despite matching list ids", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<div id="country-options" role="listbox"><div role="option" onclick="document.body.dataset.wrongChoice='yes'">${replay.missing}</div></div><iframe></iframe>`,
    );
    const frame = page.frames().find((entry) => entry !== page.mainFrame())!;
    await frame.setContent(
      `<label>Country<input role="combobox" aria-controls="country-options"></label><div id="country-options" role="listbox">${replay.offered.map((option) => `<div role="option" onclick="document.querySelector('input').value=this.textContent">${option}</div>`).join("")}</div>`,
    );
    const control = frame.getByRole("combobox");
    expect(await choosePageOption(page, control, replay.missing)).toMatchObject({
      ok: false,
      reason: "option_not_offered",
      offeredOptions: replay.offered,
    });
    expect(await page.locator("body").getAttribute("data-wrong-choice")).toBeNull();
    expect(await choosePageOption(page, control, replay.offered[0]!)).toEqual({
      ok: true,
      observedValue: replay.offered[0],
    });
    expect(await control.inputValue()).toBe(replay.offered[0]);
  } finally {
    await page.close();
  }
}, 15_000);
