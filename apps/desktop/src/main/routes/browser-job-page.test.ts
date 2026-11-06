import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { BROWSER_JOB_PAGE_HTML } from "./browser-job-page";

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? chromium.executablePath();

it.skipIf(!existsSync(executablePath))(
  "reads a rendered listing in visible frames without changing the open page or making requests",
  async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      response.setHeader("Content-Type", "text/html");
      const pages: Record<string, string> = {
        "/": `<title>Company careers</title><main>Company branding</main>
          <script>window.widgetConstructions = 0;
            customElements.define('site-widget', class extends HTMLElement {
              constructor() { super(); window.widgetConstructions++; }
            });
          </script><site-widget>Careers widget</site-widget>
          <iframe src="/listing/page"></iframe>
          <iframe style="display:none" src="/hidden"></iframe>
          <iframe style="visibility:hidden" src="/hidden"></iframe>
          <iframe style="width:1px;height:1px;border:0" src="/hidden"></iframe>
          <iframe src="http://localhost:PORT/foreign"></iframe>`,
        "/listing/page": `<base href="/positions/42/"><h1>Software Engineer</h1>
          <script>document.body.insertAdjacentHTML('beforeend', '<p>Build accessible software.</p>')</script>
          <a href="apply">Apply for this job online</a>
          <iframe src="/details"></iframe>`,
        "/details": "<p>TypeScript experience required.</p>",
        "/hidden": "<p>Hidden tracking content</p>",
        "/foreign": "<p>Cross-origin content</p>",
      };
      response.end(
        (pages[request.url ?? ""] ?? "").replace("PORT", String(port)),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const port = address.port;
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const page = await browser.newPage();
      const pageUrl = `http://127.0.0.1:${port}/`;
      await page.goto(pageUrl, { waitUntil: "networkidle" });
      const original = await page.content();
      expect(await page.evaluate("window.widgetConstructions")).toBe(1);
      const beforeRequests = requests;
      const html = await page.evaluate<string>(BROWSER_JOB_PAGE_HTML);
      const snapshot = await page.evaluate((markup) => {
        const parsed = new DOMParser().parseFromString(markup, "text/html");
        return {
          text: parsed.body.textContent,
          links: [...parsed.querySelectorAll("a[href]")].map((link) => ({
            label: link.textContent,
            url: link.getAttribute("href"),
          })),
        };
      }, html);
      expect(snapshot.text).toContain("Software Engineer");
      expect(snapshot.text).toContain("Build accessible software.");
      expect(snapshot.text).toContain("TypeScript experience required.");
      expect(snapshot.text).not.toContain("Hidden tracking content");
      expect(snapshot.text).not.toContain("Cross-origin content");
      expect(snapshot.links).toContainEqual({
        label: "Apply for this job online",
        url: `${pageUrl}positions/42/apply`,
      });
      expect(await page.content()).toBe(original);
      expect(await page.evaluate("window.widgetConstructions")).toBe(1);
      expect(page.frames()).toHaveLength(7);
      expect(requests).toBe(beforeRequests);

      await page.setContent(
        Array.from(
          { length: 13 },
          (_, index) => `<iframe srcdoc="<p>Embedded ${index}</p>"></iframe>`,
        ).join(""),
      );
      const bounded = await page.evaluate<string>(BROWSER_JOB_PAGE_HTML);
      expect(bounded).toContain("Embedded 11</p>");
      expect(bounded).not.toContain("Embedded 12</p>");
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
