import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";

async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT;
  assert.ok(out, "Missing isolated test output directory");
  app.setPath("userData", await mkdtemp(join(tmpdir(), "nestor-page-api-")));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.setPosition(-6000, 0);
  const host = getEmbeddedBrowser();
  host.attachWindow(window);
  const hits: Array<{ method: string; url: string; cookie: string }> = [];
  const result: { pass: boolean; checks: string[]; error?: string } = {
    pass: false,
    checks: [],
  };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    hits.push({
      method: request.method ?? "",
      url,
      cookie: request.headers.cookie ?? "",
    });
    if (url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.setHeader(
        "Set-Cookie",
        "page-session=synthetic; HttpOnly; Path=/api",
      );
      response.end(
        '<title>Local page API fixture</title><a href="/api/jobs">Jobs JSON</a>',
      );
      return;
    }
    if (!["/api/jobs", "/api/redirect", "/api/followed"].includes(url)) {
      response.writeHead(404).end();
      return;
    }
    assert.equal(request.method, "GET");
    assert.equal(
      request.headers.accept,
      "application/json, text/plain, text/html;q=0.8",
    );
    if (url === "/api/redirect") {
      response.writeHead(302, {
        Location: "/api/followed",
        "Set-Cookie": "redirect-session=synthetic; HttpOnly; Path=/api",
      });
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.setHeader(
      "Set-Cookie",
      "api-session=synthetic; HttpOnly; Path=/api",
    );
    response.end(JSON.stringify({ jobs: [{ id: "synthetic-job" }] }));
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    // Even at the same origin, the app renderer's default session is separate.
    await session.defaultSession.cookies.set({
      url: origin,
      name: "app-only",
      value: "synthetic",
    });
    await host.runAutomation(
      "Synthetic page API check",
      undefined,
      async () => {
        const browser = await host.connect();
        const page = await browser.contexts()[0]!.newPage();
        assert.equal(
          host.openTabCount(),
          1,
          "The replaced automation placeholder must close",
        );
        await page.goto(origin);
        await host.getSession().cookies.set({
          url: `http://localhost:${address.port}`,
          name: "other-origin",
          value: "synthetic",
        });
        const options = {
          headers: { accept: "application/json, text/plain, text/html;q=0.8" },
          maxRedirects: 0,
          timeout: 30_000,
        };
        const response = await page
          .context()
          .request.get(`${origin}/api/jobs`, options);
        assert.equal(response.status(), 200);
        assert.equal(
          await response.text(),
          JSON.stringify({ jobs: [{ id: "synthetic-job" }] }),
        );
        assert.equal(
          hits.find((hit) => hit.url === "/api/jobs")?.cookie,
          "page-session=synthetic",
        );
        result.checks.push(
          "JSON GET carries only the page session's matching HttpOnly cookie",
        );
        assert.equal(
          (await host.getSession().cookies.get({ name: "api-session" })).length,
          1,
        );
        assert.equal(
          (await session.defaultSession.cookies.get({ name: "api-session" }))
            .length,
          0,
        );
        result.checks.push(
          "response cookies return to the embedded partition only",
        );

        const redirect = await page
          .context()
          .request.get(`${origin}/api/redirect`, options);
        assert.equal(redirect.status(), 302);
        assert.equal(redirect.headers().location, "/api/followed");
        assert.equal(
          hits.filter((hit) => hit.url === "/api/followed").length,
          0,
        );
        result.checks.push(
          "maxRedirects: 0 returns the redirect without visiting its destination",
        );
        const followed = await page
          .context()
          .request.get(
            new URL(redirect.headers().location!, origin).href,
            options,
          );
        assert.equal(followed.status(), 200);
        assert.ok(
          hits
            .find((hit) => hit.url === "/api/followed")
            ?.cookie.includes("redirect-session=synthetic"),
        );
        result.checks.push(
          "an explicit follow-up GET carries the redirect response's cookie",
        );
        assert.ok(hits.every((hit) => hit.method === "GET"));
        await page.close();
      },
    );
    result.pass = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    await host.close(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await writeFile(
    join(out, "scoped-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  app.exit(result.pass ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
