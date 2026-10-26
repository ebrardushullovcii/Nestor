import { chromium } from "playwright";
import { expect, test } from "vitest";
import { installMutationResponseBodyObserver } from "./mutation-response-body";

test("a clone with no reader stays unreadable rather than publishing an empty success", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route("http://fixture.example.test/**", (route) =>
      route.fulfill({
        status: 200,
        contentType:
          route.request().method() === "POST"
            ? "application/json"
            : "text/html",
        body:
          route.request().method() === "POST"
            ? '{"uploadId":"synthetic-file-1"}'
            : "<p>Fixture</p>",
      }),
    );
    await page.goto("http://fixture.example.test/form");
    await page.evaluate(() => {
      const clone: unknown = Reflect.get(
        globalThis.Response.prototype,
        "clone",
      );
      if (typeof clone !== "function")
        throw new Error("Missing response clone");
      globalThis.Response.prototype.clone = function (
        this: globalThis.Response,
      ) {
        const copy = Reflect.apply(clone, this, []) as globalThis.Response;
        Object.defineProperty(copy, "body", { value: null });
        return copy;
      };
    });
    await page.evaluate(installMutationResponseBodyObserver);
    const text = await page.evaluate(async () => {
      await (
        await fetch("/upload", { method: "POST", body: "synthetic-file" })
      ).text();
      const entries = (window as unknown as Record<string, unknown>)
        .__nestorMutationResponses as { text: string | null }[];
      return entries.at(-1)?.text;
    });
    expect(text).toBeNull();
  } finally {
    await browser.close();
  }
});
