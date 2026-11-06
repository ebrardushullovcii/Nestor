import { chromium } from "playwright";
import { expect, test } from "vitest";
import {
  createPlaywrightApplyPageMechanics,
  readRawApplyPage,
} from "./apply-page-mechanics";
import { readPageLinkedText } from "./page-linked-text";
import { readRenderedPageHtml } from "./rendered-page-reader";

test("apply, search and text reads expose rendered frame facts without widget source or hidden text", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const source = "RAVEN_SOURCE_".repeat(60_000);
    const css = `/*${"YOUTUBE_CSS_".repeat(16_000)}*/`;
    const widget = `<body><p>Visible video caption</p><label for="name">Visible name<script type="application/json">${source}</script><style>${css}</style><input id="name"></label><noscript>Hidden noscript</noscript><template>Hidden template</template><div style="opacity:0">Hidden opacity</div><div style="display:none">Hidden display</div><div style="visibility:hidden">Hidden visibility</div><div style="content-visibility:hidden">Hidden content visibility</div></body>`;
    await page.context().route("https://video.example.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: route.request().url().endsWith("/hidden-body")
          ? `<body style="display:none"><script type="application/json">${source}</script>Hidden body</body>`
          : widget,
      }),
    );
    await page.setContent(
      `<body><h1>Visible job facts</h1><iframe src="https://video.example.test/video"></iframe><iframe src="https://video.example.test/hidden-body"></iframe><iframe style="display:none" src="https://video.example.test/hidden-frame"></iframe></body>`,
    );
    await Promise.all(page.frames().map((frame) => frame.waitForLoadState()));
    const raw = await readRawApplyPage(page);
    const fullText = await createPlaywrightApplyPageMechanics(page).readText();
    const searchText = await readPageLinkedText(page);
    await page
      .context()
      .route("https://jobs.example.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<h1>Visible job facts</h1><iframe src="https://video.example.test/video"></iframe><iframe src="https://video.example.test/hidden-body"></iframe>',
        }),
      );
    const rendered = await readRenderedPageHtml(
      page.context(),
      "https://jobs.example.test/job",
    );
    expect(JSON.stringify(raw)).not.toMatch(/RAVEN_SOURCE|YOUTUBE_CSS/u);
    for (const text of [
      raw.bodyText,
      fullText,
      searchText,
      rendered.visibleText,
    ]) {
      expect(text).toContain("Visible job facts");
      expect(text).toContain("Visible video caption");
      expect(text).not.toMatch(/RAVEN_SOURCE|YOUTUBE_CSS|Hidden/u);
      expect(text.length).toBeLessThan(150);
      expect(text.match(/Visible video caption/gu)).toHaveLength(1);
    }
    // innerText on this hidden root returns textContent, including source.
    expect(await page.frames()[2]!.locator("body").innerText()).toContain(
      "RAVEN_SOURCE",
    );
  } finally {
    await browser.close();
  }
}, 30_000);
