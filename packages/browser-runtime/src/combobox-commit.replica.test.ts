import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { choosePageOption } from "./choose-page-option";
import { createPlaywrightApplyPageSession } from "./apply-page-mechanics";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

// Search text is cleared on commit, while the rendered value may abbreviate
// the menu label. This is the observed public phone/experience widget shape.
function picker(label: string, value: string, invalid = false) {
  return `<form><label for="answer">Question</label>
    <div class="select__control"><div class="select__value-container">
      <span class="select__placeholder">Select...</span>
      <input id="answer" role="combobox" aria-controls="options" aria-invalid="${invalid}">
    </div></div><div id="options" role="listbox" hidden></div></form>
    <script>
      const input = document.querySelector('input'), list = document.querySelector('[role=listbox]');
      const open = () => { list.hidden = false; list.innerHTML = '<div role="option"></div>';
        const row = list.firstChild; row.textContent = ${JSON.stringify(label)};
        row.onmousedown = event => event.preventDefault();
        row.onclick = () => {
          document.querySelector('.select__placeholder')?.remove();
          const selected = document.createElement('div'); selected.className = 'select__single-value';
          selected.innerHTML = ${JSON.stringify(value)}; input.before(selected);
          input.value = ''; input.style.opacity = '0'; list.hidden = true;
        };
      };
      input.onfocus = open; input.oninput = open;
      input.onkeydown = event => { if (event.key === 'ArrowDown') open(); if (event.key === 'Escape') list.hidden = true; };
    </script>`;
}

test.each([
  ["Kosovo +383", '<div class="iti__flag iti__xk"></div><span>+383</span>'],
  ["Yes", "Yes"],
])(
  "a committed %s uses the same evidence as the next page read",
  async (label, value) => {
    const page = await browser.newPage();
    try {
      await page.setContent(picker(label, value));
      const result = await choosePageOption(
        page,
        page.getByRole("combobox"),
        label,
      );
      expect(result).toEqual({ ok: true, observedValue: label });
      const observation = await createPlaywrightApplyPageSession({
        page,
      }).readPage();
      expect(
        observation.controls.find((control) => control.id === "answer"),
      ).toMatchObject({
        selectedOptionLabel: label,
        visible: true,
        invalid: false,
      });
      expect(await page.locator("input").inputValue()).toBe("");
    } finally {
      await page.close();
    }
  },
);

test.each([
  [
    "United States +1",
    '<div class="iti__flag iti__ca"></div><span>+1</span>',
    false,
  ],
  ["Kosovo +383", "<span>+383</span>", false],
  ["Yes", "<span hidden>Yes</span>", false],
  ["Yes", "Yes", true],
])(
  "abbreviation does not invent country, hidden selection, or validity: %s",
  async (label, value, invalid) => {
    const page = await browser.newPage();
    try {
      await page.setContent(picker(label, value, invalid));
      const result = await choosePageOption(
        page,
        page.getByRole("combobox"),
        label,
      );
      expect(result.ok).toBe(false);
    } finally {
      await page.close();
    }
  },
);
