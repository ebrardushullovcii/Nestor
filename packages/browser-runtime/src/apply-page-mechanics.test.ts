import { chromium, type Browser, type Locator } from "playwright";
import {
  CandidateProfileSchema,
  type CandidateReusableAnswer,
} from "@nestor/contracts";
import menuReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/handover-options.json";
import githubReplay from "../../../apps/desktop/test-fixtures/job-finder/apply-replays/github-username.json";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  buildApplyFormObservation,
  checkClassifiedApplicationAnswers,
} from "@nestor/browser-agent";

import {
  createPlaywrightApplyPageMechanics,
  readRawApplyPage,
  collectApplyDocumentSnapshot,
  APPLY_PAGE_SELECTORS,
} from "./apply-page-mechanics";

/**
 * Two lists the page draws itself, read one after the other.
 *
 * Shaped after a live board's form: a react-style combobox renders its choices
 * only while it is open, and every open list on the page has options sitting
 * in the DOM. Reading the nearest ones put a country list under a yes/no
 * question, so each control's choices must come from the list that control
 * itself names and only while that control says it is expanded.
 */
const PAGE = `
<!doctype html>
<html><body>
  <label for="agreements">Are you subject to any employment agreements?</label>
  <input id="agreements" role="combobox" aria-expanded="false" aria-controls="agreements-list" readonly />
  <div id="agreements-list" role="listbox" hidden></div>

  <label for="country">What is your current country of residence?</label>
  <input id="country" role="combobox" aria-expanded="false" aria-controls="country-list" readonly />
  <div id="country-list" role="listbox" hidden></div>

  <script>
    const lists = {
      "agreements": ["Yes", "No"],
      "country": ["Afghanistan", "Albania", "Algeria"],
    };
    for (const id of Object.keys(lists)) {
      const input = document.getElementById(id);
      const listbox = document.getElementById(id + "-list");
      input.addEventListener("click", () => {
        const open = input.getAttribute("aria-expanded") === "true";
        if (open) return;
        input.setAttribute("aria-expanded", "true");
        listbox.hidden = false;
        listbox.innerHTML = lists[id]
          .map((option) => '<div role="option">' + option + "</div>")
          .join("");
      });
      document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        input.setAttribute("aria-expanded", "false");
        listbox.hidden = true;
      });
    }
  </script>
</body></html>
`;

describe("reading the choices of lists the page draws itself", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  test("replica Application and nested history markup retains ancestry and distinct row identities", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<form><fieldset><legend>Application</legend>
        <section><h2>Contact details</h2><label for="email">Email *</label><input id="email" type="email" required></section>
        <section><h2>Work history (optional)</h2>
          <fieldset><legend>Work history 1</legend><label>Company<input name="work1Company" required></label><label>Job title<input name="work1Title" required></label><label>From<input name="work1From" type="month" required></label></fieldset>
          <fieldset><legend>Work history 2</legend><label>Company<input name="work2Company" required></label><label>Job title<input name="work2Title" required></label></fieldset>
        </section>
        <section><h2>Eligibility questions</h2><fieldset class="choices"><legend>Are you authorized to work in the job's country? *</legend><label><input type="radio" name="authorized" value="Yes" required>Yes</label><label><input type="radio" name="authorized" value="No" required>No</label></fieldset></section>
      </fieldset></form>`);
      const raw = await readRawApplyPage(page);
      const email = raw.controls.find((control) => control.id === "email")!;
      expect(email.sectionPath).toEqual(["Application", "Contact details"]);
      const one = raw.controls.find(
        (control) => control.name === "work1Company",
      )!;
      const title = raw.controls.find(
        (control) => control.name === "work1Title",
      )!;
      const two = raw.controls.find(
        (control) => control.name === "work2Company",
      )!;
      expect(one.sectionPath).toEqual([
        "Application",
        "Work history (optional)",
        "Work history 1",
      ]);
      expect(one.rowScopeKey).toBe(title.rowScopeKey);
      expect(one.rowScopeKey).not.toBe(two.rowScopeKey);
      expect(
        buildApplyFormObservation(raw, "2026-10-27T10:00:00Z").controls.find(
          (control) => control.label === "Email *",
        )?.credentialRole,
      ).toBeNull();
    } finally {
      await page.close();
    }
  });

  test("upload feedback changes page state without changing the field's instruction hint", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<form><div><p>Resume / CV *</p><button type="button">Attach resume</button>
        <input name="resume" type="file" aria-label="Resume / CV"><span aria-live="polite" id="feedback">No file selected</span>
        <p id="instruction">PDF only</p></div><label>Name<input name="name"></label></form>`);
      const before = await readRawApplyPage(page);
      const hint = before.controls.find(
        (control) => control.inputType === "file",
      )!.hint;
      await page
        .locator("input[type=file]")
        .setInputFiles({
          name: "synthetic.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("synthetic"),
        });
      await page.locator("#feedback").evaluate((element) => {
        element.textContent = "synthetic.pdf";
      });
      const uploaded = await readRawApplyPage(page);
      expect(
        uploaded.controls.find((control) => control.inputType === "file")!.hint,
      ).toBe(hint);
      expect(uploaded.bodyText).toContain("synthetic.pdf");
      await page.locator("#feedback").evaluate((element) => {
        element.textContent = "Write this in your own words";
      });
      expect((await readRawApplyPage(page)).bodyText).toContain(
        "Write this in your own words",
      );
      await page.locator("#instruction").evaluate((element) => {
        element.textContent = "Word documents only";
      });
      expect(
        (await readRawApplyPage(page)).controls.find(
          (control) => control.inputType === "file",
        )!.hint,
      ).not.toBe(hint);
    } finally {
      await page.close();
    }
  });

  test("Send keeps a div calling-code picker with the native phone in its form", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<form><label id="phone-label" for="input_phone">Phone</label>
        <div id="calling-code" role="combobox" aria-labelledby="phone-label" aria-valuetext="United Kingdom +44" aria-expanded="false">+44</div>
        <input id="input_phone" name="phone" type="tel" value="7700900123" required>
        <label for="address">Address</label><input id="address" name="address" role="combobox" value="Munchen, Germany" required>
      </form>`);
      const sources = {
        profile: CandidateProfileSchema.parse({
          id: "synthetic",
          phone: "+44 7700 900123",
          currentCity: "München",
          currentCountry: "Germany",
          yearsExperience: 3,
          baseResume: {
            id: "resume",
            fileName: "synthetic.txt",
            uploadedAt: "2026-10-27T12:00:00.000Z",
            extractionStatus: "ready",
          },
        }),
        resumeText: null,
        posting: {
          title: "Engineer",
          company: "Example",
          location: "Remote",
          description: "Build tools.",
        },
        reusableAnswers: [] as CandidateReusableAnswer[],
        documents: [],
      };
      const client = {
        chatWithTools: () =>
          Promise.resolve({
            toolCalls: [
              {
                id: "read",
                type: "function" as const,
                function: {
                  name: "report_question_kinds",
                  arguments: JSON.stringify({
                    plainIndexes: [0, 1, 2],
                    flagged: [],
                    tags: [
                      {
                        index: 0,
                        kind: "other",
                        country: null,
                        sourceId: null,
                      },
                      {
                        index: 1,
                        kind: "other",
                        country: null,
                        sourceId: "profile.phone",
                      },
                      {
                        index: 2,
                        kind: "other",
                        country: null,
                        sourceId: "profile.currentCity",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
      };
      const check = async (phone: string, address = "Munchen, Germany") => {
        const raw = await readRawApplyPage(page);
        const form = buildApplyFormObservation(raw, "2026-10-27T12:00:00.000Z");
        return checkClassifiedApplicationAnswers({
          client,
          sources,
          payDisclosed: false,
          answers: [
            { question: "Phone", answer: phone },
            { question: "Address", answer: address },
          ],
          formControls: form.controls,
          formContext: { pageText: raw.bodyText, fields: [] },
        });
      };
      expect(
        (await check("7700900123")).map((entry) => entry.supported),
      ).toEqual([true, true]);
      expect((await check("+44 7700 900123"))[0]?.supported).toBe(true);
      expect((await check("7700900124"))[0]?.supported).toBe(false);
      expect((await check("7700900123", "Munich, Germany"))[1]?.supported).toBe(
        false,
      );
      sources.reusableAnswers = [
        {
          id: "confirmed-address",
          kind: "other",
          label: "Address",
          question: "Address",
          answer: "Munich, Germany",
          roleFamilies: [],
          proofEntryIds: [],
        },
      ];
      expect((await check("7700900123", "Munich, Germany"))[1]?.supported).toBe(
        true,
      );
      expect((await check("7700900123", "Munich, Germany"))[1]?.supported).toBe(
        true,
      );
      expect((await check("7700900123", "Berlin, Germany"))[1]?.supported).toBe(
        false,
      );
      await page
        .locator("#calling-code")
        .evaluate((element) =>
          element.setAttribute("aria-valuetext", "France +33"),
        );
      expect((await check("7700900123"))[0]?.supported).toBe(false);
      await page.locator("#calling-code").evaluate((element) => {
        element.setAttribute("aria-valuetext", "United Kingdom +44");
        document.body.append(element);
      });
      expect((await check("7700900123"))[0]?.supported).toBe(false);
    } finally {
      await page.close();
    }
  });

  test.each(["form", "formless", "shadow", "iframe"] as const)(
    "Send binds national digits to the collapsed dialog button in its own %s widget",
    async (surface) => {
      const page = await browser.newPage();
      try {
        // The captured widget has no combobox role. Its button owns a hidden
        // dialog/listbox and exposes the current code in its name and child text.
        const html = `<form><label id="phone_label">Phone</label>
        <div data-role="illustrated-input"><div><div class="iti iti--input-container">
          <div class="iti__country-container">
            <button type="button" class="iti__selected-country" aria-expanded="false"
              aria-label="Change country for phone number, currently selected Slovenia (+386)"
              aria-haspopup="dialog" aria-controls="iti-0__country-selector" title="Slovenia">
              <div><div class="iti__flag"></div><div aria-hidden="true">⌄</div></div>
              <div class="iti__selected-dial-code">+386</div>
            </button>
            <div id="iti-0__country-selector" role="dialog" aria-modal="true" style="display:none">
              <ul role="listbox" aria-label="List of countries">
                <li role="option" aria-selected="false">United Kingdom (+44)</li>
                <li role="option" aria-selected="true">Slovenia (+386)</li>
              </ul>
            </div>
          </div>
          <input aria-required="true" aria-labelledby="phone_label" aria-describedby="phone_helper"
            maxlength="255" required id="input_phone" name="phone" type="tel"
            dir="auto" autocomplete="tel" inputmode="tel" value="31 000 111">
        </div></div></div><span id="phone_helper"></span></form>`;
        if (surface === "shadow") {
          await page.setContent('<main id="host"></main>');
          await page.locator("#host").evaluate((host, html) => {
            host.attachShadow({ mode: "open" }).innerHTML = html;
          }, html);
        } else if (surface === "iframe") {
          await page.setContent('<iframe title="Application"></iframe>');
          const frame = page
            .frames()
            .find((frame) => frame !== page.mainFrame());
          if (!frame) throw new Error("The replica iframe did not load.");
          await frame.setContent(html);
        } else {
          await page.setContent(
            surface === "formless"
              ? html.replace("<form>", "").replace("</form>", "")
              : html,
          );
        }
        const root = surface === "iframe" ? page.frameLocator("iframe") : page;
        const sources = {
          profile: CandidateProfileSchema.parse({
            id: "synthetic",
            phone: "+38631000111",
            yearsExperience: 3,
            baseResume: {
              id: "resume",
              fileName: "synthetic.txt",
              uploadedAt: "2026-10-27T12:00:00.000Z",
              extractionStatus: "ready",
            },
          }),
          resumeText: null,
          documents: [],
          reusableAnswers: [],
          posting: {
            title: "Engineer",
            company: "Example",
            location: "Remote",
            description: "Build tools.",
          },
        };
        const client = {
          chatWithTools: () =>
            Promise.resolve({
              toolCalls: [
                {
                  id: "read",
                  type: "function" as const,
                  function: {
                    name: "report_question_kinds",
                    arguments: JSON.stringify({
                      plainIndexes: [0],
                      flagged: [],
                      tags: [
                        {
                          index: 0,
                          kind: "other",
                          country: null,
                          sourceId: "profile.phone",
                        },
                      ],
                    }),
                  },
                },
              ],
            }),
        };
        const check = async (answer = "31 000 111") => {
          const raw = await readRawApplyPage(page);
          const form = buildApplyFormObservation(
            raw,
            "2026-10-27T12:00:00.000Z",
          );
          expect(form.controls).toHaveLength(1);
          return (
            await checkClassifiedApplicationAnswers({
              client,
              sources,
              payDisclosed: false,
              answers: [{ question: "Phone", answer }],
              formControls: form.controls,
              formContext: { pageText: raw.bodyText, fields: [] },
            })
          )[0]?.supported;
        };
        expect(await check()).toBe(true);
        expect(await check("31 000 112")).toBe(false);
        const button = root.locator("button");
        await button.evaluate((button) => {
          button.setAttribute(
            "aria-label",
            "Change country for phone number, currently selected United Kingdom (+44)",
          );
          const code = button.querySelector(".iti__selected-dial-code");
          if (code) code.textContent = "+44";
        });
        expect(await check()).toBe(false);
        // A stale accessible name or a code hidden by the page grants nothing.
        await button.locator(".iti__selected-dial-code").evaluate((code) => {
          code.textContent = "+386";
        });
        expect(await check()).toBe(false);
        await button.evaluate((button) => {
          button.setAttribute(
            "aria-label",
            "Change country for phone number, currently selected Slovenia (+386)",
          );
          button.style.opacity = "0";
        });
        expect(await check()).toBe(false);
        await button.evaluate((button) => {
          button.style.opacity = "1";
          button.parentElement?.parentElement?.parentElement?.append(button);
        });
        expect(await check()).toBe(false);
      } finally {
        await page.close();
      }
    },
  );

  test("a detached native read retains a checked challenge and never reads password or one-time-code values", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<label>Password <input type="password" value="synthetic-secret"></label>
        <label>Verification code <input autocomplete="one-time-code" value="123456"></label>
        <label><input type="checkbox" checked>I am not a robot</label>
        <p role="alert" hidden>Please verify you are human</p><p role="alert">Visible error</p>`);
      const source = `(${collectApplyDocumentSnapshot.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(Object.values(APPLY_PAGE_SELECTORS).join(", "))})),${JSON.stringify(APPLY_PAGE_SELECTORS)},true)`;
      const native =
        await page.evaluate<ReturnType<typeof collectApplyDocumentSnapshot>>(
          source,
        );
      const automated = await readRawApplyPage(page);
      expect(native.controls).toEqual(
        automated.controls.map((control, index) =>
          index < 2 ? { ...control, value: "" } : control,
        ),
      );
      expect(
        native.controls.map((control: { value: string }) => control.value),
      ).toEqual(["", "", "on"]);
      expect(native.controls[2]!.checked).toBe(true);
      expect(native.validationErrors).toEqual(["Visible error"]);
      expect(automated.validationErrors).toEqual(["Visible error"]);
      expect(JSON.stringify(native)).not.toContain("synthetic-secret");
      expect(JSON.stringify(native)).not.toContain("123456");
    } finally {
      await page.close();
    }
  });

  test.each([
    [
      "a button the clickable selector also matches",
      `<form><label>Name <input name="name"></label><button type="submit" onclick="void 0" data-testid="apply">Apply</button></form>`,
    ],
    [
      "a label span inside the button",
      `<form><label>Name <input name="name"></label><button type="submit"><span data-testid="apply-label">Apply</span></button></form>`,
    ],
    [
      "a form inside a shadow root",
      `<role-form></role-form><script>customElements.define("role-form", class extends HTMLElement { connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = '<form><label>Name <input name="name"></label><button type="submit"><span data-testid="apply-label">Apply</span></button></form>'; } });</script>`,
    ],
    [
      "a form inside a frame",
      `<iframe srcdoc='<form><label>Name <input name="name"></label><button type="submit"><span data-testid="apply-label">Apply</span></button></form>'></iframe>`,
    ],
  ])(
    "a submit button has one ref, with its form's action: %s",
    async (_case, html) => {
      const page = await browser.newPage();
      try {
        await page.setContent(html);
        await page.waitForTimeout(200);
        const read = await readRawApplyPage(page);
        expect(
          read.clickables.filter((entry) => /apply/iu.test(entry.label)),
        ).toEqual([]);
        expect(
          read.actions.filter((action) => action.label === "Apply"),
        ).toEqual([
          expect.objectContaining({ submitsForm: true, formMethod: "GET" }),
        ]);
      } finally {
        await page.close();
      }
    },
  );

  test("the detached read gives a button and what it holds one ref too", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<form><label>Name <input name="name"></label><button type="submit" onclick="void 0"><span data-testid="apply-label">Apply</span></button><button type="button">Clear</button></form>`,
      );
      const source = `(${collectApplyDocumentSnapshot.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(Object.values(APPLY_PAGE_SELECTORS).join(", "))})),${JSON.stringify(APPLY_PAGE_SELECTORS)},true)`;
      const native =
        await page.evaluate<ReturnType<typeof collectApplyDocumentSnapshot>>(
          source,
        );
      expect(
        native.clickables.filter((entry: { label: string }) =>
          /apply/iu.test(entry.label),
        ),
      ).toEqual([]);
      expect(
        native.actions.map(
          (action: { label: string; submitsForm?: boolean }) => [
            action.label,
            action.submitsForm,
          ],
        ),
      ).toEqual([
        ["Apply", true],
        ["Clear", false],
      ]);
    } finally {
      await page.close();
    }
  });

  test("a custom checkbox reads its state, never its icons' fallback text", async () => {
    // Workable's consent box: a div with the checkbox role around a hidden
    // native input and three icons, each with an SVG fallback in its desc.
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<label data-ui="gdpr"><div role="checkbox" aria-checked="true" aria-labelledby="consent-label" tabindex="0"><input tabindex="-1" aria-hidden="true" type="checkbox" name="gdpr" checked style="position:absolute;opacity:0">ICON ICON ICON</div><span id="consent-label"><span>I have read and accept the Privacy Notice.</span></span></label>`.replace(
          /ICON/g,
          '<svg aria-hidden="true" viewBox="0 0 14 14" width="16" height="16"><desc aria-hidden="true"><p>SVGs not supported by this browser.</p></desc><g><path d="M1 1h12v12H1z"></path></g></svg>',
        ),
      );
      const source = `(${collectApplyDocumentSnapshot.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(Object.values(APPLY_PAGE_SELECTORS).join(", "))})),${JSON.stringify(APPLY_PAGE_SELECTORS)},true)`;
      const native =
        await page.evaluate<ReturnType<typeof collectApplyDocumentSnapshot>>(
          source,
        );
      const automated = await readRawApplyPage(page);
      for (const read of [native.controls, automated.controls]) {
        const box = read.find(
          (control: { role: string }) => control.role === "checkbox",
        )!;
        expect(box).toMatchObject({ checked: true, value: "" });
        expect(JSON.stringify(read)).not.toContain("SVGs not supported");
      }
    } finally {
      await page.close();
    }
  });

  test("full text and link reads retain the tail of a long listing page", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<body>${"<p>Visible listing text</p>".repeat(3000)}${Array.from({ length: 405 }, (_, index) => `<a href="https://example.test/${index}">Link ${index}</a>`).join("")}<p>Last vacancy</p></body>`,
      );
      const mechanics = createPlaywrightApplyPageMechanics(page);
      expect(await mechanics.readText()).toContain("Last vacancy");
      const raw = await mechanics.readPage();
      expect(raw.links).toHaveLength(405);
      expect(raw.links.at(-1)?.href).toBe("https://example.test/404");
      expect(await mechanics.readLinkedText?.()).toContain(
        "Link 404 → https://example.test/404",
      );
    } finally {
      await page.close();
    }
  });

  test("keeps repeated labels, their URLs and adjacent status text inside separate page items", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<article><p>First employer</p><h2><a href="https://example.test/one">Engineer</a></h2><p>Closed</p></article><article><p>Second employer</p><h2><a href="https://example.test/two">Engineer</a></h2><p>Open</p></article><p hidden>Hidden employer</p><script>const secretText='Not page evidence';</script>`,
      );
      const text =
        await createPlaywrightApplyPageMechanics(page).readLinkedText?.();
      expect(text).toContain(
        "First employer\nEngineer → https://example.test/one\nClosed\n[End page item 1]",
      );
      expect(text).toContain(
        "[Page item 2]\nSecond employer\nEngineer → https://example.test/two\nOpen",
      );
      expect(text).not.toContain("Hidden employer");
      expect(text).not.toContain("Not page evidence");
    } finally {
      await page.close();
    }
  });

  test("keeps the outer step legend on a nested skills group", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <form><fieldset><legend>Step 3 of 6: Skills</legend>
          <label>Email <input type="email" name="email"></label>
          <fieldset><legend>Select your skills</legend>
            <label><input type="checkbox" name="skills" value="Analysis">Analysis</label>
            <label><input type="checkbox" name="skills" value="Coordination">Coordination</label>
          </fieldset>
        </fieldset></form>
      `);
      const observation = await readRawApplyPage(page);
      expect(
        observation.controls
          .filter((control) => control.name === "skills")
          .map((control) => control.groupLabel),
      ).toEqual([
        "Step 3 of 6: Skills — Select your skills",
        "Step 3 of 6: Skills — Select your skills",
      ]);
      expect(
        observation.controls.find((control) => control.name === "email")
          ?.groupLabel,
      ).toBe("Step 3 of 6: Skills");
    } finally {
      await page.close();
    }
  });

  test("reads the upload format and numeric/month constraints from the actual inputs", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<form><label>Resume<input type="file" accept=".txt,.pdf"></label><label>Experience<input type="number" min="0" max="50" step="1"></label><label>From<input type="month" min="2000-01" max="2026-10"></label></form>',
      );
      const raw = await readRawApplyPage(page);
      expect(raw.controls[0]).toMatchObject({ accept: ".txt,.pdf" });
      expect(raw.controls[1]).toMatchObject({
        inputType: "number",
        min: "0",
        max: "50",
        step: "1",
      });
      expect(raw.controls[2]).toMatchObject({
        inputType: "month",
        min: "2000-01",
        max: "2026-10",
      });
    } finally {
      await page.close();
    }
  });

  test("reads what each file field itself shows, not the help text or another field beside it", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<form>
        <label>Name <input name="name"></label>
        <div class="upload"><p>Resume</p><button type="button">Attach</button>
          <input id="resume" type="file" aria-describedby="resume-error" style="position:absolute;width:1px;height:1px;opacity:0">
          <span>Taylor-Resume.pdf</span></div>
        <p id="resume-error">Upload rejected by server</p>
        <p><label>Cover letter <input id="letter" type="file"></label></p>
        <p id="stale" hidden>Upload failed</p>
        <p>Trouble uploading? Upload error help</p>
      </form>`);
      const source = `(${collectApplyDocumentSnapshot.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(Object.values(APPLY_PAGE_SELECTORS).join(", "))})),${JSON.stringify(APPLY_PAGE_SELECTORS)},true)`;
      const native =
        await page.evaluate<ReturnType<typeof collectApplyDocumentSnapshot>>(
          source,
        );
      const automated = await readRawApplyPage(page);
      for (const controls of [native.controls, automated.controls]) {
        expect(
          controls.find((control) => control.id === "resume")?.upload,
        ).toEqual({
          ariaInvalid: false,
          described: "Upload rejected by server",
          nearby: "Resume\nAttach\nTaylor-Resume.pdf",
          shown: false,
        });
        expect(
          controls.find((control) => control.id === "letter")?.upload,
        ).toEqual({ described: "", nearby: "Cover letter", shown: true, ariaInvalid: false });
        expect(
          controls.find((control) => control.id === "")?.upload,
        ).toBeUndefined();
      }
    } finally {
      await page.close();
    }
  });

  test("a file on a disabled wizard step stays disabled even when the input has no disabled attribute", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<fieldset disabled hidden><input type="file" required></fieldset><button>Send application</button>',
      );
      const raw = await readRawApplyPage(page);
      expect(raw.controls[0]).toMatchObject({ disabled: true, visible: false });
    } finally {
      await page.close();
    }
  });

  afterAll(async () => {
    await browser?.close();
  });

  test("keeps nested choices and entered answers out of question labels in pages and frames", async () => {
    const page = await browser.newPage();
    const form = `
      <label><span>Preferred interview session</span>
        <select id="session" required><option value="">Choose a session</option><option>Thursday</option><option>Friday</option><option disabled>Unavailable</option><optgroup label="Past" disabled><option>Yesterday</option></optgroup></select>
      </label>
      <label id="note-label">Additional information <textarea id="note" aria-labelledby="note-label">A previous answer</textarea></label>
      <label><input id="updates" type="checkbox">Email me updates</label>
    `;
    await page.setContent(form + '<iframe id="embedded"></iframe>');
    const frame = page.locator("#embedded").contentFrame();
    await frame.locator("body").evaluate((body, html) => {
      body.innerHTML = html;
    }, form);

    const observation = await readRawApplyPage(page);
    const sessions = observation.controls.filter(
      (control) => control.id === "session",
    );
    expect(sessions).toHaveLength(2);
    for (const control of sessions) {
      expect(control.label).toBe("Preferred interview session");
      expect(control.options).toEqual(["Thursday", "Friday"]);
    }
    for (const control of observation.controls.filter(
      (item) => item.id === "note",
    )) {
      expect(control.label).toBe("Additional information");
      expect(control.value).toBe("A previous answer");
    }
    for (const control of observation.controls.filter(
      (item) => item.id === "updates",
    )) {
      expect(control.label).toBe("Email me updates");
    }
    await page.close();
  });

  test("GitHub replay: each field keeps the help text beside it, in pages and frames", async () => {
    const page = await browser.newPage();
    await page.setContent(
      `${githubReplay.linearPage}<iframe id="embedded"></iframe>`,
    );
    await page
      .locator("#embedded")
      .contentFrame()
      .locator("body")
      .evaluate((body, html) => {
        body.innerHTML = html;
      }, githubReplay.linearPage);
    const observation = await readRawApplyPage(page);
    const github = observation.controls.filter((item) => item.id === "gh");
    const linkedin = observation.controls.filter((item) => item.id === "li");
    expect(github).toHaveLength(2);
    expect(linkedin).toHaveLength(2);
    for (const control of github)
      expect(control.hint).toBe(githubReplay.fields[4]!.hint);
    for (const control of linkedin)
      expect(control.hint).toBe(
        "Please provide the link to your LinkedIn profile.",
      );
    await page.close();
  });

  test.each(menuReplay.cases)(
    "question-owned choices: $name",
    async (entry) => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<label for="country">Country of residence</label><input id="country" role="combobox" aria-expanded="false" aria-controls="shared" readonly>
      <label for="restrictions">${menuReplay.restrictionPrompt}</label><input id="restrictions" role="combobox" aria-expanded="false" aria-controls="shared" readonly>
      <label for="previous">${menuReplay.previousEmploymentPrompt}</label><input id="previous" role="combobox" aria-expanded="false" aria-controls="shared" readonly>
      <div id="shared" role="listbox" hidden></div><script>
      const data=${JSON.stringify({ entry, countries: menuReplay.countryOptions, restrictions: menuReplay.restrictionOptions, previous: menuReplay.previousEmploymentOptions })};
      const menu=document.getElementById('shared');
      for(const id of ['country','restrictions','previous']) { const input=document.getElementById(id);
        input.onclick=()=>{input.setAttribute('aria-controls','shared');input.setAttribute('aria-expanded','true');menu.hidden=false;
          if(id!=='country' && !data.entry.settles) return;
          setTimeout(()=>{menu.innerHTML=(id==='country'?data.countries:data[id]).map(x=>'<div role="option">'+x+'</div>').join('');},data.entry.delayMs);
        };
      }
      document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.querySelectorAll('input[aria-expanded=true]').forEach(x=>{x.setAttribute('aria-expanded','false');if(data.entry.releaseOwner)x.removeAttribute('aria-controls');});menu.hidden=true;}});
      </script>`);
        for (let read = 0; read < 2; read++) {
          const snapshot = await readRawApplyPage(page);
          expect(
            snapshot.controls.find((control) => control.id === "country")
              ?.options,
          ).toEqual(menuReplay.countryOptions);
          expect(
            snapshot.controls.find((control) => control.id === "restrictions")
              ?.options,
          ).toEqual(entry.settles ? menuReplay.restrictionOptions : []);
          expect(
            snapshot.controls.find((control) => control.id === "previous")
              ?.options,
          ).toEqual(entry.settles ? menuReplay.previousEmploymentOptions : []);
          expect(snapshot.controls.every((control) => !control.value)).toBe(
            true,
          );
        }
      } finally {
        await page.close();
      }
    },
  );

  test("two lists with the same question keep separate choices on another read", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<label for="one">Country</label><input id="one" role="combobox" aria-controls="one-list" aria-expanded="false" readonly>
        <label for="two">Country</label><input id="two" role="combobox" aria-controls="two-list" aria-expanded="false" readonly>
        <div id="one-list" role="listbox" hidden></div><div id="two-list" role="listbox" hidden></div>
        <script>
          const choices={one:['Germany','France'],two:['United Kingdom','Ireland']};
          for (const id of Object.keys(choices)) document.getElementById(id).onclick=()=>{
            document.getElementById(id).setAttribute('aria-expanded','true');
            const menu=document.getElementById(id+'-list');menu.hidden=false;
            menu.innerHTML=choices[id].map(label=>'<div role="option">'+label+'</div>').join('');
          };
          document.addEventListener('keydown',event=>{if(event.key==='Escape'){
            document.querySelectorAll('input').forEach(input=>input.setAttribute('aria-expanded','false'));
            document.querySelectorAll('[role="listbox"]').forEach(menu=>menu.hidden=true);
          }});
        </script>`);
      for (let read = 0; read < 2; read++) {
        const controls = (await readRawApplyPage(page)).controls;
        expect(
          controls.find((control) => control.id === "one")?.options,
        ).toEqual(["Germany", "France"]);
        expect(
          controls.find((control) => control.id === "two")?.options,
        ).toEqual(["United Kingdom", "Ireland"]);
      }
    } finally {
      await page.close();
    }
  });

  test("a form's long choice list is preserved in order", async () => {
    const page = await browser.newPage();
    const options = Array.from(
      { length: menuReplay.longListSize },
      (_, index) => `Option ${String(index + 1).padStart(3, "0")}`,
    );
    try {
      await page.setContent(`<label for="choices">Choose a region</label><input id="choices" role="combobox" aria-expanded="false" aria-controls="choice-list" readonly><div id="choice-list" role="listbox" hidden></div><script>
        const input=document.getElementById('choices'), list=document.getElementById('choice-list');
        input.onclick=()=>{input.setAttribute('aria-expanded','true');list.hidden=false;list.innerHTML=${JSON.stringify(options)}.map(x=>'<div role="option">'+x+'</div>').join('');};
        document.addEventListener('keydown',event=>{if(event.key==='Escape'){input.setAttribute('aria-expanded','false');list.hidden=true;}});
      </script>`);
      expect(
        (await readRawApplyPage(page)).controls.find(
          (control) => control.id === "choices",
        )?.options,
      ).toEqual(options);
    } finally {
      await page.close();
    }
  });

  test("a slow background click does not expire the menu observer before redraw", async () => {
    const page = await browser.newPage();
    const prototype = Object.getPrototypeOf(page.locator("input")) as Locator;
    // Called below with the locator that received the click.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = prototype.click;
    const click = vi
      .spyOn(prototype, "click")
      .mockImplementation(async function (this: Locator, options) {
        await new Promise((resolve) => setTimeout(resolve, 1450));
        await original.call(this, options);
      });
    try {
      await page.setContent(`<label for="one">First question</label><input id="one" role="combobox" aria-controls="shared" aria-expanded="false" readonly>
        <label for="two">Second question</label><input id="two" role="combobox" aria-controls="shared" aria-expanded="false" readonly>
        <div id="shared" role="listbox" hidden></div><script>
          for(const id of ['one','two']) document.getElementById(id).onclick=()=>{
            document.getElementById(id).setAttribute('aria-expanded','true');
            const menu=document.getElementById('shared');menu.hidden=false;
            setTimeout(()=>menu.innerHTML=(id==='one'?['First A','First B']:['Second A','Second B']).map(label=>'<div role="option">'+label+'</div>').join(''),80);
          };
          document.addEventListener('keydown',event=>{if(event.key==='Escape'){
            document.querySelectorAll('input').forEach(input=>input.setAttribute('aria-expanded','false'));
            document.getElementById('shared').hidden=true;
          }});
        </script>`);
      const controls = (await readRawApplyPage(page)).controls;
      expect(controls.find((control) => control.id === "one")?.options).toEqual(
        ["First A", "First B"],
      );
      expect(controls.find((control) => control.id === "two")?.options).toEqual(
        ["Second A", "Second B"],
      );
    } finally {
      click.mockRestore();
      await page.close();
    }
  }, 15_000);

  test("each control gets its own choices, and keeps them on a second read", async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);

    const first = await readRawApplyPage(page);
    const agreements = first.controls.find(
      (control) => control.id === "agreements",
    );
    const country = first.controls.find((control) => control.id === "country");

    expect(agreements?.options).toEqual(["Yes", "No"]);
    expect(country?.options).toEqual(["Afghanistan", "Albania", "Algeria"]);

    // A form is read again after every field is filled in; the same choices
    // come back without opening anything a second time.
    const second = await readRawApplyPage(page);
    expect(
      second.controls.find((control) => control.id === "agreements")?.options,
    ).toEqual(["Yes", "No"]);
    expect(
      second.controls.find((control) => control.id === "country")?.options,
    ).toEqual(["Afghanistan", "Albania", "Algeria"]);

    await page.close();
  }, 60_000);

  test("keeps person-completed fields when asked to navigate to the exact current URL", async () => {
    const page = await browser.newPage();
    await page.route("https://jobs.example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<input id="person-step" value=""><p>Application</p>',
      }),
    );
    await page.goto("https://jobs.example.test/apply/1?stage=review#human");
    await page.locator("#person-step").fill("completed by person");
    const goto = vi.spyOn(page, "goto");
    const mechanics = createPlaywrightApplyPageMechanics(page);

    await expect(
      mechanics.navigate(
        "https://jobs.example.test/apply/1?stage=review#human",
      ),
    ).resolves.toEqual({
      ok: true,
      url: "https://jobs.example.test/apply/1?stage=review#human",
    });
    expect(goto).not.toHaveBeenCalled();
    expect(await page.locator("#person-step").inputValue()).toBe(
      "completed by person",
    );

    await mechanics.navigate(
      "https://jobs.example.test/apply/1?stage=questions#agent",
    );
    expect(goto).toHaveBeenCalledTimes(1);
    await page.close();
  }, 60_000);

  test("reads a progress bar and notices a marker added after an earlier read", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent("<p>Application form</p>");
      expect((await readRawApplyPage(page)).stepLabel).toBeNull();
      await page.setContent('<div role="progressbar">Page 2 of 3</div>');
      expect((await readRawApplyPage(page)).stepLabel).toBe("Page 2 of 3");
    } finally {
      await page.close();
    }
  });

  test("reads the current step from an accessible step list", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <ol aria-label="Application steps">
        <li>My Information</li>
        <li>My Experience</li>
        <li>Application Questions</li>
        <li aria-current="step">Review</li>
      </ol>
      <button type="button">Save and continue</button>
      <button type="submit">Submit</button>
    `);

    const observation = await readRawApplyPage(page);

    expect(observation.stepLabel).toBe("Step 4 of 4: Review");
    await page.close();
  });

  test("keeps hidden future steps in the total when the marker is nested", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <ol aria-label="Application steps">
        <li>My Information</li>
        <li><a aria-current="step">My Experience</a></li>
        <li>Application Questions</li>
        <li hidden>Review</li>
      </ol>
      <button type="button">Save and continue</button>
      <button type="submit">Submit</button>
    `);

    const observation = await readRawApplyPage(page);

    expect(observation.stepLabel).toBe("Step 2 of 4: My Experience");
    await page.close();
  });

  test("does not treat a closed prepared page as reusable", async () => {
    const page = await browser.newPage();
    await page.goto("https://example.com/apply/closed");
    const mechanics = createPlaywrightApplyPageMechanics(page);
    await page.close();

    await expect(
      mechanics.navigate("https://example.com/apply/closed"),
    ).resolves.toEqual({
      ok: false,
      error:
        "The prepared application page was closed. Prepare it again before continuing.",
    });
  }, 60_000);

  test("one task sees and closes only popups opened by its own page", async () => {
    const context = await browser.newContext();
    const taskPage = await context.newPage();
    const unrelatedTaskPage = await context.newPage();
    await unrelatedTaskPage.setContent("<title>Other task</title>");
    await taskPage.setContent(`
      <title>Current task</title>
      <button id="open">Apply</button>
      <script>
        document.getElementById("open").addEventListener("click", () => {
          const popup = window.open("about:blank", "_blank");
          if (popup) popup.document.title = "Current task popup";
        });
      </script>
    `);

    await taskPage.click("#open");
    await expect.poll(() => context.pages().length).toBe(3);

    const observation = await readRawApplyPage(taskPage);
    expect(observation.openedTabs).toHaveLength(1);
    expect(observation.openedTabs[0]?.title).toBe("Current task popup");

    const mechanics = createPlaywrightApplyPageMechanics(taskPage);
    const adoption = await mechanics.adoptOpenedTab!(0);
    expect(adoption).toEqual({
      ok: false,
      error: "That tab never loaded a web page.",
    });
    expect(unrelatedTaskPage.isClosed()).toBe(false);
    expect(await unrelatedTaskPage.title()).toBe("Other task");

    await context.close();
  }, 60_000);

  test("presses keyboard-only controls on the requested field", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="city">City</label>
      <input id="city" />
      <p id="result">Waiting</p>
      <script>
        document.getElementById("city").addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            document.getElementById("result").textContent = "Accepted";
          }
        });
      </script>
    `);

    const mechanics = createPlaywrightApplyPageMechanics(page);
    expect(await mechanics.pressKey("c0", "Enter")).toEqual({
      ok: true,
      observedValue: "Enter",
    });
    expect(await page.locator("#result").innerText()).toBe("Accepted");

    await page.close();
  });

  test("reads a question wrapped around an otherwise unlabelled select", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <li>
        <div>
          Are you currently authorized to work in this country?
          <div><select required><option>Select...</option><option>Yes</option><option>No</option></select></div>
        </div>
      </li>
    `);

    const observation = await readRawApplyPage(page);
    expect(observation.controls[0]?.label).toBe(
      "Are you currently authorized to work in this country?",
    );

    await page.close();
  });

  test("does not report immediate success when a controlled input clears the value", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <label>Current location <input id="location" /></label>
      <script>
        document.getElementById("location").addEventListener("input", (event) => {
          event.target.value = "";
        });
      </script>
    `);

    const mechanics = createPlaywrightApplyPageMechanics(page);
    await expect(mechanics.fillText("c0", "Pristina")).resolves.toEqual({
      ok: false,
      error:
        "The field cleared the answer instead of keeping it. Leave it for the person or try a different control once.",
    });

    await page.close();
  });

  test("toggle labels cannot bypass the typed answer path through generic clicks", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="consent">I consent to a background check</label>
      <input id="consent" type="checkbox" />
    `);
    const mechanics = createPlaywrightApplyPageMechanics(page);
    const observation = await readRawApplyPage(page);
    const label = observation.clickables.find(
      (item) => item.tagName === "label",
    );
    if (!label) throw new Error("Expected a clickable checkbox label");
    for (const ref of [`e${label.index}`, "c0"]) {
      const outcome = await mechanics.clickElement(ref);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("A generic click changed the answer");
      expect(outcome.error).toContain("set_checkbox");
      expect(await page.locator("#consent").isChecked()).toBe(false);
    }
    await expect(mechanics.setToggle("c0", true)).resolves.toMatchObject({
      ok: true,
    });
    expect(await page.locator("#consent").isChecked()).toBe(true);
    await page.close();
  });

  test("an option-button press never touches the form's own Submit", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <form onsubmit="event.preventDefault(); window.sent = true">
          <label class="_required_x question-title">Are you in an European time zone?</label>
          <div><button aria-pressed="false" data-option="yes">Yes</button>
            <button aria-pressed="false" data-option="no">No</button></div>
          <button>Submit Application</button>
        </form>
        <script>
          for (const option of document.querySelectorAll("[aria-pressed]"))
            option.addEventListener("click", () => option.setAttribute("aria-pressed", "true"));
        </script>
      `);
      const mechanics = createPlaywrightApplyPageMechanics(page);
      const { actions } = await readRawApplyPage(page);
      const ref = (label: string) => {
        const action = actions.find((entry) => entry.label === label)!;
        return action.ref ?? `a${action.index}`;
      };
      // A ref that went stale and now names Submit is refused untouched.
      expect(
        await mechanics.setToggle(ref("Submit Application"), true),
      ).toMatchObject({ ok: false });
      expect(
        await page
          .locator("button", { hasText: "Submit" })
          .getAttribute("type"),
      ).toBeNull();
      expect(await mechanics.setToggle(ref("Yes"), true)).toMatchObject({
        ok: true,
      });
      expect(await page.evaluate("window.sent")).toBeUndefined();
    } finally {
      await page.close();
    }
  });

  test("a bare picker is required when only its question's title says so", async () => {
    const page = await browser.newPage();
    try {
      // Ashby's location field: no required attribute, no id for its label.
      await page.setContent(`
        <div class="field-entry"><label class="_required_f7cvd_91 ashby-application-form-question-title" for="_systemfield_location">What country are you based in?</label>
          <div><input role="combobox" aria-autocomplete="list" placeholder="Start typing..."></div></div>
        <div class="field-entry"><label class="ashby-application-form-question-title" for="x">Twitter/X</label>
          <div><input id="x" type="text"></div></div>
        <div class="field-entry"><label>Pronouns *</label><div><input type="text"></div></div>
      `);
      const { controls } = await readRawApplyPage(page);
      expect(controls.map((control) => control.required)).toEqual([
        true,
        false,
        true,
      ]);
    } finally {
      await page.close();
    }
  });

  test("native activation cannot accept a disabled or rejected toggle", async () => {
    const page = await browser.newPage();
    try {
      for (const html of [
        '<fieldset disabled><input type="checkbox"></fieldset>',
        '<input type="checkbox" onclick="event.preventDefault()">',
      ]) {
        await page.setContent(html);
        const input = page.locator("input");
        const fallback = vi
          .spyOn(input, "setChecked")
          .mockRejectedValue(new Error("Not accepted"));
        const mechanics = createPlaywrightApplyPageMechanics({
          locator: () => ({ nth: () => input }),
        } as unknown as Parameters<
          typeof createPlaywrightApplyPageMechanics
        >[0]);
        expect(await mechanics.setToggle("c0", true)).toMatchObject({
          ok: false,
        });
        expect(await input.isChecked()).toBe(false);
        expect(fallback).toHaveBeenCalledOnce();
      }
    } finally {
      await page.close();
    }
  });

  test("a native toggle uses its normal click and change events once", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <input type="checkbox" id="choice">
        <script>
          window.clicks = 0; window.changes = 0; window.trusted = [];
          const choice = document.getElementById("choice");
          choice.addEventListener("click", (event) => { window.clicks++; window.trusted.push(event.isTrusted); });
          choice.addEventListener("change", () => window.changes++);
        </script>
      `);
      const mechanics = createPlaywrightApplyPageMechanics(page);
      expect(await mechanics.setToggle("c0", true)).toMatchObject({ ok: true });
      expect(await mechanics.setToggle("c0", true)).toMatchObject({ ok: true });
      expect(await page.evaluate("[window.clicks, window.changes]")).toEqual([
        1, 1,
      ]);
      expect(await page.evaluate("window.trusted")).toEqual([true]);
      expect(await mechanics.setToggle("c0", false)).toMatchObject({
        ok: true,
      });
      expect(await page.locator("#choice").isChecked()).toBe(false);
      expect(await page.evaluate("[window.clicks, window.changes]")).toEqual([
        2, 2,
      ]);
    } finally {
      await page.close();
    }
  });

  test("checks an off-screen enabled radio even when another element covers its pointer target", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <fieldset style="margin-top:2000px">
        <legend>Are you authorized to work here?</legend>
        <label><input id="authorized" type="radio" name="authorized" required /> Yes</label>
        <label><input type="radio" name="authorized" /> No</label>
      </fieldset>
      <div style="position:fixed;inset:0;z-index:10"></div>
    `);

    const mechanics = createPlaywrightApplyPageMechanics(page);
    await expect(mechanics.setToggle("c0", true)).resolves.toEqual({
      ok: true,
      observedValue: "checked",
    });
    expect(await page.locator("#authorized").isChecked()).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await page.close();
  }, 15_000);

  test("keeps nearby actions reachable when scrolling an off-screen native toggle", async () => {
    const page = await browser.newPage({
      viewport: { width: 900, height: 640 },
    });
    try {
      await page.setContent(`
        <div style="height:1600px"></div>
        <label><input type="checkbox"> Confirm these synthetic answers</label>
        <button id="send" style="display:block;margin-top:20px">Send application</button>
        <div style="height:900px"></div>
        <aside style="position:fixed;bottom:0;left:0;right:0;height:180px;background:white">Page overlay</aside>
      `);
      await expect(
        createPlaywrightApplyPageMechanics(page).setToggle("c0", true),
      ).resolves.toMatchObject({ ok: true });
      expect(
        await page.evaluate(() => {
          const rect = document.getElementById("send")!.getBoundingClientRect();
          return document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          )?.id;
        }),
      ).toBe("send");
    } finally {
      await page.close();
    }
  });

  test("reads and operates accessible shadow-root and iframe forms", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <h1>Application</h1>
      <div id="shadow-host"></div>
      <div id="second-shadow-host"></div>
      <iframe id="embedded" srcdoc='<form>
        <label for="email">Email in frame</label>
        <input id="email" type="email" />
        <div id="frame-code" role="combobox" aria-label="Calling code" aria-valuetext="United Kingdom +44">+44</div>
        <input id="frame-phone" type="tel" aria-label="Phone" value="7700900123" />
        <button id="continue" type="button">Continue</button>
      </form>'></iframe>
      <script>
        const root = document.getElementById("shadow-host").attachShadow({ mode: "open" });
        root.innerHTML = '<label for="name">Name in component</label><input id="name" /><input id="first-radio" type="radio" name="authorized" />';
        const secondRoot = document.getElementById("second-shadow-host").attachShadow({ mode: "open" });
        secondRoot.innerHTML = '<input id="second-radio" type="radio" name="authorized" />';
      </script>
    `);
    await expect.poll(() => page.frames().length).toBe(2);
    const childFrame = page
      .frames()
      .find((frame) => frame !== page.mainFrame())!;
    await childFrame.evaluate(() => {
      document.getElementById("continue")?.addEventListener("click", () => {
        document.body.dataset.continued = "yes";
      });
    });

    const mechanics = createPlaywrightApplyPageMechanics(page);
    const observation = await mechanics.readPage();
    const shadowControl = observation.controls.find(
      (control) => control.id === "name",
    );
    const frameControl = observation.controls.find(
      (control) => control.id === "email",
    );
    const frameAction = observation.actions.find(
      (action) => action.label === "Continue",
    );

    const shadowRef = shadowControl?.ref ?? `c${shadowControl?.index}`;
    expect(shadowRef).toMatch(/^c\d+$/u);
    expect(frameControl?.ref).toMatch(/^f0c\d+$/u);
    expect(frameAction?.ref).toMatch(/^f0a\d+$/u);
    expect(frameAction?.submitsForm).toBe(false);
    expect(
      observation.controls.find((control) => control.id === "frame-code")
        ?.scopeKey,
    ).toBe(
      observation.controls.find((control) => control.id === "frame-phone")
        ?.scopeKey,
    );
    expect(
      observation.controls.find((control) => control.id === "first-radio")
        ?.scopeKey,
    ).not.toBe(
      observation.controls.find((control) => control.id === "second-radio")
        ?.scopeKey,
    );
    expect(observation.bodyText).toContain("Email in frame");

    expect(await mechanics.fillText(shadowRef, "Ada Lovelace")).toEqual({
      ok: true,
      observedValue: "Ada Lovelace",
    });
    expect(
      await mechanics.fillText(frameControl!.ref!, "ada@example.test"),
    ).toEqual({
      ok: true,
      observedValue: "ada@example.test",
    });
    expect(await mechanics.clickAction(frameAction!.ref!)).toEqual({
      ok: true,
      observedValue: "clicked",
    });
    expect(
      await childFrame.locator("body").getAttribute("data-continued"),
    ).toBe("yes");

    await page.close();
  });

  test("reports a covering dialog without pressing Send, then verifies the cleared button", async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button id="send">Send application</button>
        <aside role="dialog" style="position:fixed;inset:0;z-index:2">Cookie choices <button id="close">Reject optional</button></aside>
        <script>window.sends=0;document.getElementById('send').onclick=()=>window.sends++;document.getElementById('close').onclick=()=>document.querySelector('aside').remove();</script>
      `);
      const mechanics = createPlaywrightApplyPageMechanics(page);
      const blocked = await mechanics.checkAction!("a0");
      expect(blocked.ok).toBe(false);
      if (blocked.ok)
        throw new Error("An obstructed button was reported reachable");
      expect(blocked.error).toContain("Cookie choices");
      expect(await page.evaluate("window.sends")).toBe(0);
      await page.locator("#close").click();
      await expect(mechanics.checkAction!("a0")).resolves.toMatchObject({
        ok: true,
      });
      expect(await page.evaluate("window.sends")).toBe(0);
    } finally {
      await page.close();
    }
  });
});
