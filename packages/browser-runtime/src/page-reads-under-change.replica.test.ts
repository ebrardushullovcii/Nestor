import { chromium, type Browser, type Frame, type Page } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  createPlaywrightApplyPageMechanics,
  readRawApplyPage,
} from "./apply-page-mechanics";
import { screenshotPage } from "./page-image-input";
import { readPageLinkedText } from "./page-linked-text";
import { isVisibleFrame } from "./visible-page-text";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

const board = `<main><h1>Remote jobs</h1>
<article><a href="https://jobs.example.test/jobs/1">Senior Platform Engineer</a><p>Synthetic Employer, Europe</p></article>
<label for="q">Search</label><input id="q"><button>Search</button>
<div data-testid="card">Load more jobs</div></main>`;

/** A page whose frame list still holds an ad frame that has since detached. */
async function pageWithDetachedAdFrame(): Promise<{
  page: Page;
  view: Page;
  stale: Frame;
}> {
  const page = await browser.newPage();
  await page.route("https://ads.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<body><a href='https://ads.example.test/click'>Advert</a><input type='password'></body>",
    }),
  );
  await page.setContent(
    `${board}<iframe id="ad" src="https://ads.example.test/slot"></iframe>`,
  );
  const stale = page.frames().find((frame) => frame !== page.mainFrame())!;
  await stale.waitForLoadState();
  await page.evaluate(() => document.getElementById("ad")?.remove());
  // The read took its frame list before the ad slot was replaced.
  const view = new Proxy(page, {
    get(target, key) {
      if (key === "frames") return () => [target.mainFrame(), stale];
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return { page, view, stale };
}

test("a frame that detached mid-read is not drawn, and every page read still finishes", async () => {
  const { page, view, stale } = await pageWithDetachedAdFrame();
  try {
    expect(stale.isDetached()).toBe(true);
    await expect(isVisibleFrame(stale)).resolves.toBe(false);
    const raw = await readRawApplyPage(view);
    expect(raw.bodyText).toContain("Senior Platform Engineer");
    expect(raw.controls.length).toBeGreaterThan(0);
    await expect(readPageLinkedText(view)).resolves.toContain(
      "Senior Platform Engineer",
    );
    await expect(screenshotPage(view)).resolves.toBeTruthy();
  } finally {
    await page.close();
  }
}, 30_000);

test("an ad slot replaced while the page is read never fails the read", async () => {
  const page = await browser.newPage();
  try {
    await page.route("https://ads.example.test/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<p>Advert</p>" }),
    );
    // A rotating ad slot, replaced at the moment it is read. The reader
    // lists the page's frames, then looks at controls in closed shadow roots
    // and then at each frame. Here, looking at that control or at the ad's
    // own visibility removes the ad and puts a fresh one in its place, so
    // the read meets a frame that detached after it was listed. (A 2 ms
    // timer did this by chance, but on a slow runner it flooded Playwright's
    // event stream with about 230 cancelled requests a second, and reads
    // queued behind the backlog: that measured the runner, not the reader.)
    await page.setContent(
      `${board}<closed-widget></closed-widget><div id="slot"></div><script>
        window.rotations = 0;
        customElements.define('closed-widget', class extends HTMLElement {
          connectedCallback() {
            const root = this.attachShadow({ mode: 'closed' });
            root.innerHTML = '<button>Save search</button>';
            const button = root.querySelector('button');
            button.matches = function (...args) {
              window.rotations += 1;
              rotate();
              return Element.prototype.matches.apply(this, args);
            };
          }
        });
        const rotate = () => {
          const slot = document.getElementById('slot');
          const frame = document.createElement('iframe');
          frame.src = 'https://ads.example.test/slot?' + window.rotations;
          frame.checkVisibility = function (...args) {
            const shown = HTMLElement.prototype.checkVisibility.apply(this, args);
            window.rotations += 1;
            rotate();
            return shown;
          };
          slot.replaceChildren(frame);
        };
        rotate();
      </script>`,
    );
    await page.waitForLoadState();
    const rotations = () =>
      page.evaluate(
        () => (window as unknown as { rotations: number }).rotations,
      );
    const mechanics = createPlaywrightApplyPageMechanics(page);
    const before = await rotations();
    for (let read = 0; read < 15; read += 1) {
      const raw = await readRawApplyPage(page);
      expect(raw.bodyText).toContain("Senior Platform Engineer");
      await expect(readPageLinkedText(page)).resolves.toContain(
        "Senior Platform Engineer",
      );
      await expect(mechanics.readText()).resolves.toContain(
        "Senior Platform Engineer",
      );
    }
    // The slot really was replaced in the middle of these reads.
    expect((await rotations()) - before).toBeGreaterThanOrEqual(15);
  } finally {
    await page.close();
  }
}, 60_000);

// `document.host` is the page's own named element (or a collection, or a
// child window) when the page names something "host". Ancestor walks that
// climbed from <html> to document.host then called matches() on it.
for (const [shape, named] of [
  ["two images named host", '<img name="host" alt=""><img name="host" alt="">'],
  ["a frame named host", '<iframe name="host" srcdoc="<p>x</p>"></iframe>'],
  ["a form named host", '<form name="host"><input name="other"></form>'],
] as const)
  test(`ancestor walks reach the document safely when the page has ${shape}`, async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(`${board}${named}`);
      await Promise.all(page.frames().map((frame) => frame.waitForLoadState()));
      const raw = await readRawApplyPage(page);
      expect(raw.bodyText).toContain("Senior Platform Engineer");
      expect(raw.controls.some((control) => control.label === "Search")).toBe(
        true,
      );
      expect(raw.clickables.length).toBeGreaterThan(0);
      await expect(readPageLinkedText(page)).resolves.toContain(
        "Senior Platform Engineer",
      );
    } finally {
      await page.close();
    }
  }, 30_000);

test("a page that replaces Array.from, as Prototype.js does, still gives its text", async () => {
  const page = await browser.newPage();
  try {
    // Prototype.js 1.7.3 (bundled by WeWorkRemotely) sets Array.from = $A,
    // which copies an iterable and ignores the map function.
    await page.setContent(
      `<script>
        Array.from = function (iterable) {
          if (!iterable) return [];
          if ('toArray' in Object(iterable)) return iterable.toArray();
          var length = iterable.length || 0, results = new Array(length);
          while (length--) results[length] = iterable[length];
          return results;
        };
      </script>
      <header><nav>Remote jobs</nav></header>
      <main><h1>Don't see a role that fits?</h1>
      <h2>About the job</h2><p>Send us your profile and we will reach out.</p></main>`,
    );
    const raw = await readRawApplyPage(page);
    const linked = await readPageLinkedText(page);
    const text = await createPlaywrightApplyPageMechanics(page).readText();
    for (const read of [raw.bodyText, linked, text]) {
      expect(read).toContain("Send us your profile and we will reach out.");
      expect(read).not.toContain("[object");
    }
  } finally {
    await page.close();
  }
}, 30_000);
