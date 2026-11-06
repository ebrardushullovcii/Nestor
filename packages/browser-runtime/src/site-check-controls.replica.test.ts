import { createServer, type Server } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApplyPageHands } from "@nestor/browser-agent";
import {
  createPlaywrightApplyPageMechanics,
  createPlaywrightApplyPageSession,
} from "./apply-page-mechanics";

let browser: Browser;
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/frame") {
      response.end(`<!doctype html><body><div id="challenge"></div><script>
        const root=document.querySelector('#challenge').attachShadow({mode:'closed'});
        root.innerHTML='<p>Complete this site check to enable Submit</p><label><input type="checkbox">Verify you are human</label><input type="hidden" name="cf-turnstile-response" value="synthetic-token-not-for-model">';
        root.querySelector('input').addEventListener('click',event=>{
          if(event.isTrusted) parent.postMessage({passed:true},'*');
        });
      </script>`);
      return;
    }
    response.end(`<!doctype html><body><h1>Local application</h1><div id="host"></div>
      <button id="submit" disabled>Submit Application</button><script>
      const root=document.querySelector('#host').attachShadow({mode:'closed'});
      root.innerHTML='<iframe style="width:400px;height:150px;border:7px solid black" src="http://localhost:${(server.address() as { port: number }).port}/frame"></iframe>';
      addEventListener('message',event=>{if(event.data.passed){document.querySelector('#submit').disabled=false; document.body.dataset.passed='true'}});
      </script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

test.each(["click", "set_checkbox"] as const)(
  "%s on a closed-root checkbox in a cross-origin iframe is trusted and enables Submit",
  async (tool) => {
    const page = await browser.newPage();
    try {
      const frameLoaded = page.waitForEvent("framenavigated", {
        predicate: (frame) => frame.url().endsWith("/frame"),
      });
      await page.goto(origin);
      const frame = await frameLoaded;
      await frame.waitForLoadState();
      const hands = createApplyPageHands(
        createPlaywrightApplyPageMechanics(page),
      );
      const before = await hands.observe();
      expect(JSON.stringify(before)).not.toContain(
        "synthetic-token-not-for-model",
      );
      expect(before.bodyTextExcerpt).toContain(
        "Complete this site check to enable Submit",
      );
      const checkbox = before.clickables.find(
        (control) => control.role === "checkbox",
      );
      expect(checkbox).toMatchObject({
        label: "Verify you are human",
        visible: true,
        disabled: false,
      });
      expect(checkbox?.frame?.origin).toContain("localhost");
      const submit = before.actions.find(
        (action) => action.label === "Submit Application",
      )!;
      const disabled = await hands.clickElement(submit.ref);
      expect(disabled.ok).toBe(false);
      if (!disabled.ok) expect(disabled.error).toMatch(/disabled/iu);
      expect(
        await (tool === "click"
          ? hands.clickElement(checkbox!.ref)
          : hands.setToggle(checkbox!.ref, true)),
      ).toMatchObject({ ok: true });
      await page.waitForFunction(() => document.body.dataset.passed === "true");
      const after = await hands.observe();
      expect(
        after.actions.find((action) => action.ref === submit.ref)?.disabled,
      ).toBe(false);
      await page.goto(origin);
      const stale = await hands.clickElement(checkbox!.ref);
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error).toMatch(/stale/iu);
    } finally {
      await page.close();
    }
  },
);

test("refs follow DOM identity across label, value, URL and ordinal changes", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin + "/plain");
    await page.setContent(
      `<label>Name<input></label><button id="target" onclick="this.dataset.clicked='true'">Apply</button>`,
    );
    const hands = createPlaywrightApplyPageSession({ page });
    const first = await hands.readPage();
    const ref = first.actions[0]!.ref!;
    const field = first.controls[0]!.ref!;
    await page.evaluate(() => {
      const target = document.querySelector("#target")!;
      target.textContent = "Continue";
      target.before(document.createElement("button"));
      history.replaceState(null, "", "/changed");
      document.querySelector("input")!.id = "new-id";
    });
    const changed = await hands.readPage();
    expect(
      changed.actions.find((action) => action.label === "Continue")?.ref,
    ).toBe(ref);
    expect(changed.actions[0]?.ref).not.toBe(ref);
    expect(
      await hands.clickBoundAction!({
        ref,
        label: "Apply",
        url: origin + "/plain",
        stepLabel: null,
        frame: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await hands.clickWithoutWrites!({
        ref,
        label: "Apply",
        url: origin + "/plain",
        stepLabel: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await hands.clickElement(ref)).toMatchObject({ ok: true });
    expect(await page.locator("#target").getAttribute("data-clicked")).toBe(
      "true",
    );
    expect(await hands.fillText(field, "Synthetic applicant")).toMatchObject({
      ok: true,
    });
    await page.locator("#target").evaluate((element) => {
      element.removeAttribute("data-clicked");
      element.replaceWith(element.cloneNode(true));
    });
    const removed = await hands.clickElement(ref);
    expect(removed.ok).toBe(false);
    if (!removed.ok) expect(removed.error).toMatch(/stale/iu);
    expect(
      await page.locator("button").first().getAttribute("data-clicked"),
    ).toBeNull();
  } finally {
    await page.close();
  }
});

test("observation includes every child frame, long site error and full review text", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const longError = `Site validation: ${"Please complete the human check. ".repeat(30)}`;
    const review = `<dl>${Array.from({ length: 205 }, (_, index) => `<dt>Answer ${index}</dt><dd>Recorded ${index}</dd>`).join("")}</dl>`;
    const frames = Array.from(
      { length: 18 },
      (_, index) =>
        `<iframe srcdoc="<button>Frame ${index}</button>${index === 17 ? "Long document ".repeat(2500) + "FULL_FRAME_TAIL" : ""}"></iframe>`,
    ).join("");
    await page.setContent(
      `<div role="alert">${longError}</div>${review}${frames}`,
    );
    const observation =
      await createPlaywrightApplyPageMechanics(page).readPage();
    expect(
      observation.actions.some((action) => action.label === "Frame 17"),
    ).toBe(true);
    expect(observation.bodyText).toContain("FULL_FRAME_TAIL");
    expect(observation.validationErrors).toContain(longError.trim());
    expect(observation.summaryRows).toHaveLength(205);
  } finally {
    await page.close();
  }
}, 30_000);

test("a list read uses the observed node when another field is inserted during observation", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    await page.setContent(`<label>Country<input id="country" role="combobox" aria-controls="choices" aria-expanded="false" readonly></label><div id="choices" role="listbox" hidden></div><script>
      const country=document.querySelector('#country');
      country.onclick=()=>{document.querySelector('#choices').hidden=false;document.querySelector('#choices').innerHTML='<div role="option">Alpha</div><div role="option">Beta</div>';country.setAttribute('aria-expanded','true')};
      const observer=new MutationObserver(()=>{if(country.hasAttribute('data-nestor-control-ref')){observer.disconnect();const input=document.createElement('input');input.onclick=()=>document.body.dataset.wrongClick='true';country.parentElement.before(input)}});
      observer.observe(country,{attributes:true,attributeFilter:['data-nestor-control-ref']});
    </script>`);
    const mechanics = createPlaywrightApplyPageMechanics(page);
    const observation = await mechanics.readPage();
    const field = observation.controls.find(
      (control) => control.id === "country",
    )!;
    expect(field.options).toEqual([]);
    await mechanics.clickElement(field.ref!);
    expect(
      (await mechanics.readPage()).controls.find(
        (control) => control.id === "country",
      )?.options,
    ).toEqual(["Alpha", "Beta"]);
    expect(
      await page.locator("body").getAttribute("data-wrong-click"),
    ).toBeNull();
  } finally {
    await page.close();
  }
});
