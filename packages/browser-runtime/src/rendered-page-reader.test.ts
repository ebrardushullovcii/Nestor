import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { readRenderedPageHtml } from "./rendered-page-reader";
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : chromium.executablePath());
it.skipIf(!existsSync(executablePath))(
  "reads script-rendered listing text and closes only its own tab",
  async () => {
    const html = await readFile(
      new URL("./fixtures/script-rendered-listing.html", import.meta.url),
      "utf8",
    );
    const server = createServer((request, response) => {
      const errorStatus = /\/status\/(\d{3})/u.exec(request.url ?? "");
      if (errorStatus) response.statusCode = Number(errorStatus[1]);
      response.setHeader("Content-Type", "text/html");
      response.end(html);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const browser = await chromium.launch({ headless: true, executablePath });
    try {
      const context = await browser.newContext();
      const personPage = await context.newPage();
      const result = await readRenderedPageHtml(
        context,
        `http://127.0.0.1:${address.port}/job`,
      );
      expect(result.html).toContain(
        '<main id="listing"><h1>Product designer</h1>',
      );
      expect(result.html).toContain("Hours vary from 20 to 30");
      expect(context.pages()).toEqual([personPage]);
      for (const status of [401, 403, 404, 410, 500]) {
        await expect(
          readRenderedPageHtml(
            context,
            `http://127.0.0.1:${address.port}/status/${status}`,
          ),
        ).rejects.toMatchObject({ status });
        expect(context.pages()).toEqual([personPage]);
      }
      await expect(
        readRenderedPageHtml(context, "file:///private/tmp/a"),
      ).rejects.toThrow("website");
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30_000,
);
