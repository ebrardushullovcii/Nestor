import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PreparedFormSnapshot } from "@nestor/contracts";
import {
  capturePreparedForm,
  describePreparedFormAttachments,
} from "./prepared-form-recovery";

const FORM = `<form><label>Email <input type="email" name="email" value="a@example.test"></label></form>`;

describe("capturing a prepared form for refill", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  async function capture(html: string) {
    const page = await browser.newPage();
    try {
      await page.route("https://jobs.example/apply", (route) =>
        route.fulfill({ contentType: "text/html", body: html }),
      );
      await page.goto("https://jobs.example/apply");
      return await capturePreparedForm(page);
    } finally {
      await page.close();
    }
  }

  test("a plain native form is captured", async () => {
    expect((await capture(FORM))?.fields).toHaveLength(1);
  });

  test("an unrelated widget with its own open root does not block capture", async () => {
    const snapshot = await capture(`${FORM}
      <aside id="chat"></aside>
      <script>document.getElementById("chat").attachShadow({mode:"open"}).innerHTML = "<p>Hi</p>";</script>`);
    expect(snapshot?.fields).toHaveLength(1);
  });

  test("a field inside an open shadow root keeps the original page", async () => {
    expect(
      await capture(`${FORM}
      <div id="host"></div>
      <script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML = '<input name="city" value="Synthetic">';</script>`),
    ).toBeNull();
  });

  test("a form-associated custom element keeps the original page", async () => {
    expect(
      await capture(`<form><input name="email" value="a@example.test"><x-salary></x-salary></form>
      <script>customElements.define("x-salary", class extends HTMLElement {
        static formAssociated = true;
        constructor() { super(); this.attachInternals(); }
      });</script>`),
    ).toBeNull();
  });

  test("a custom element that may hold a closed root beside the fields keeps the original page", async () => {
    expect(
      await capture(`<form><input name="email" value="a@example.test"><x-pick></x-pick></form>
      <script>customElements.define("x-pick", class extends HTMLElement {
        constructor() { super(); this.attachShadow({mode:"closed"}).innerHTML = '<input name="start">'; }
      });</script>`),
    ).toBeNull();
  });
});

test("saved files resolve to exactly one resume or asset record by name and bytes", () => {
  const sha = "a".repeat(64);
  const snapshot = {
    url: "https://jobs.example/apply",
    structure: "b".repeat(64),
    fields: [
      {
        type: "file",
        value: "",
        checked: false,
        selected: [],
        files: [
          { name: "resume.pdf", type: "application/pdf", size: 3, sha256: sha },
        ],
        disabled: false,
        readOnly: false,
      },
    ],
  } as PreparedFormSnapshot;
  const resume = {
    kind: "resume_export" as const,
    id: "export",
    name: "resume.pdf",
    sha256: sha,
  };
  expect(describePreparedFormAttachments(snapshot, [resume])).toEqual([resume]);
  expect(describePreparedFormAttachments(snapshot, [])).toBeNull();
  expect(
    describePreparedFormAttachments(snapshot, [
      { ...resume, sha256: "c".repeat(64) },
    ]),
  ).toBeNull();
  expect(
    describePreparedFormAttachments(snapshot, [
      resume,
      { ...resume, kind: "candidate_asset", id: "asset" },
    ]),
  ).toBeNull();
});
