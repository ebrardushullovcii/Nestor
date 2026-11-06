import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { attachFile } from "./file-attachment";

let browser: Browser;
const pdf = {
  name: "synthetic-resume.pdf",
  mimeType: "application/pdf",
  bytes: new TextEncoder().encode("%PDF-1.4 synthetic"),
};
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

test.each([".pdf,.doc,.docx", "application/pdf", "application/*", ""])(
  'sets PDF on a hidden input accepting "%s"',
  async (accept) => {
    const page = await browser.newPage();
    await page.setContent(
      `<label>Resume Choose file<input hidden type="file" accept="${accept}"></label>`,
    );
    await attachFile(page, page.locator("input"), pdf);
    expect(
      await page
        .locator("input")
        .evaluate((node: HTMLInputElement) => [
          node.files?.[0]?.name,
          node.files?.[0]?.type,
        ]),
    ).toEqual([pdf.name, pdf.mimeType]);
    await page.close();
  },
);

test("refuses TXT before firing a file change on a PDF/Word-only input", async () => {
  const page = await browser.newPage();
  await page.setContent(
    '<input hidden type="file" accept=".pdf,.doc,.docx" onchange="document.body.dataset.changed = 1">',
  );
  await expect(
    attachFile(page, page.locator("input"), {
      ...pdf,
      name: "resume.txt",
      mimeType: "text/plain",
    }),
  ).rejects.toThrow("was not selected");
  expect(await page.locator("body").getAttribute("data-changed")).toBeNull();
  await page.close();
});

test.each(["button", "label", "frame"])(
  "opens the hidden input's own %s chooser",
  async (shape) => {
    const page = await browser.newPage();
    const html =
      shape === "label"
        ? '<label for="resume">Choose file</label><input hidden type="file" id="resume" accept=".pdf">'
        : '<div><button onclick="document.getElementById(\'resume\').click()">Choose file</button><input hidden type="file" id="resume" accept=".pdf"></div>';
    await page.setContent(
      shape === "frame"
        ? `<iframe srcdoc="${html.replaceAll('"', "&quot;")}"></iframe>`
        : html,
    );
    const input =
      shape === "frame"
        ? page.frameLocator("iframe").locator("input")
        : page.locator("input");
    await attachFile(page, input, { ...pdf, method: "chooser" });
    expect(
      await input.evaluate((node: HTMLInputElement) => node.files?.[0]?.name),
    ).toBe(pdf.name);
    await page.close();
  },
);

test("drops on the field's own zone without touching the neighboring cover-letter upload", async () => {
  const page = await browser.newPage();
  await page.setContent(
    `<form><div role="button" id="zone" ondrop="event.preventDefault(); this.dataset.file = event.dataTransfer.files[0].name"><p>Upload CV</p><input hidden type="file" accept=".pdf"></div><div><input type="file" id="letter"></div><button>Send</button></form>`,
  );
  await attachFile(page, page.locator("#zone input"), {
    ...pdf,
    method: "drop",
  });
  expect(await page.locator("#zone").getAttribute("data-file")).toBe(pdf.name);
  expect(await page.locator("#letter").inputValue()).toBe("");
  await page.close();
});

test("never presses an implicit form submit as a chooser", async () => {
  const page = await browser.newPage();
  await page.setContent(
    '<form onsubmit="event.preventDefault(); document.body.dataset.sent = 1"><div><input hidden type="file" accept=".pdf"><button>Send application</button></div></form>',
  );
  await expect(
    attachFile(page, page.locator("input"), { ...pdf, method: "chooser" }),
  ).rejects.toThrow("no reachable attachment target");
  expect(await page.locator("body").getAttribute("data-sent")).toBeNull();
  await page.close();
});

test("never presses a JavaScript send outside a form as a chooser", async () => {
  const page = await browser.newPage();
  await page.setContent(
    '<div><input hidden type="file" accept=".pdf"><button onclick="document.body.dataset.sent = 1">Send application</button></div>',
  );
  await expect(
    attachFile(page, page.locator("input"), { ...pdf, method: "chooser" }),
  ).rejects.toThrow("no reachable attachment target");
  expect(await page.locator("body").getAttribute("data-sent")).toBeNull();
  await page.close();
});

test("a chooser that selects nothing can recover by dropping on the same field", async () => {
  const page = await browser.newPage();
  await page.setContent(
    `<div id="zone" data-dropzone ondrop="event.preventDefault(); this.dataset.file = event.dataTransfer.files[0].name"><label for="resume">Resume</label><input hidden type="file" id="resume" accept=".pdf" onchange="this.value = ''"><button type="button" onclick="document.getElementById('resume').click()">Choose file or drop here</button></div>`,
  );
  await attachFile(page, page.locator("input"), { ...pdf, method: "chooser" });
  expect(await page.locator("input").inputValue()).toBe("");
  expect(await page.locator("#zone").getAttribute("data-file")).toBeNull();
  await attachFile(page, page.locator("input"), { ...pdf, method: "drop" });
  expect(await page.locator("#zone").getAttribute("data-file")).toBe(pdf.name);
  await page.close();
});

test("the add-file chooser skips Personio-shaped remove-file buttons", async () => {
  const page = await browser.newPage();
  await page.setContent(
    `<div><button type="button" aria-label="Remove CV" onclick="document.body.dataset.removed = 1">×</button><label for="cv">CV</label><input hidden type="file" id="cv" accept=".pdf"><button type="button" onclick="document.getElementById('cv').click()">Add file</button></div>`,
  );
  await attachFile(page, page.locator("input"), { ...pdf, method: "chooser" });
  expect(
    await page
      .locator("input")
      .evaluate((node: HTMLInputElement) => node.files?.[0]?.name),
  ).toBe(pdf.name);
  expect(await page.locator("body").getAttribute("data-removed")).toBeNull();
  await page.close();
});
