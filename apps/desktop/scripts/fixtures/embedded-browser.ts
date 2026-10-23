import { app, BrowserWindow } from "electron";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createDesktopBrowserRuntime } from "../../src/main/services/job-finder/create-workspace-service";
import {
  importSignInsFromBrowser,
  listBrowserImportSources,
} from "../../src/main/services/browser/browser-profile-import";
import { DatabaseSync } from "node:sqlite";
import { createDeterministicJobFinderAiClient } from "@nestor/ai-providers";
import {
  ensurePrepareOnlyMutationGuard,
  getLatestBlockedPrepareOnlyAttempt,
  registerPrepareOnlyPreparedValue,
} from "../../../../packages/browser-runtime/src/playwright-application-flow";
async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT;
  if (!out) throw new Error("Missing isolated test output directory");
  const result: Record<string, unknown> = {};
  const writes: string[] = [];
  const host = getEmbeddedBrowser();
  let server: ReturnType<typeof createServer>;
  app.setPath(
    "userData",
    await mkdtemp(join(tmpdir(), "nestor-scoped-browser-")),
  );
  await app.whenReady();
  const mainWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    webPreferences: { sandbox: true },
  });
  host.attachWindow(mainWindow);
  try {
    result.versions = process.versions;
    server = createServer((req, res) => {
      if (req.method !== "GET") writes.push(req.url ?? "unknown");
      res.setHeader("Content-Type", "text/html");
      if (req.url === "/frame")
        return res.end("<label>Frame input<input></label>");
      if (req.url === "/popup")
        return res.end(
          '<title>Popup works</title><h1>Popup</h1><script>window.opener?.postMessage("popup-alive", "*")</script>',
        );
      if (req.url === "/guard")
        return res.end(
          '<title>Guard fixture</title><form action="/final-submit" method="POST" id="f"><label>Email<input name="email" id="email"></label><button>Submit application</button></form><script>document.getElementById("f").submit();document.getElementById("email").addEventListener("change",()=>fetch("/autosave",{method:"POST",body:"synthetic"}).catch(()=>{}));</script>',
        );
      res.end(
        '<title>Browser fixture</title><label>Name<input id="name"></label><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Apply locally</button><div id="result"></div><label>Resume<input type="file"></label><iframe src="/frame"></iframe><button onclick="window.open(\'/popup\',\'auth-fixture\')">Open popup</button><script>window.ticks=0;setInterval(()=>window.ticks++,100)</script>',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No port");
    const url = `http://127.0.0.1:${address.port}`;
    await host.command({ type: "open", url });
    host.setViewport({ x: 10, y: 70, width: 1100, height: 650, visible: true });
    await host.runAutomation("Synthetic browser check", undefined, async () => {
      const browser = await host.connect();
      const context = browser.contexts()[0]!;
      const page = context.pages()[0]!;
      page.setDefaultTimeout(5000);
      result.targets = context.pages().length;
      await page.getByLabel("Name", { exact: true }).fill("Visible");
      await page.getByRole("button", { name: "Apply locally" }).click();
      result.action = await page.locator("#result").innerText();
      await page
        .frameLocator("iframe")
        .getByLabel("Frame input")
        .fill("Synthetic");
      result.frame = true;
      await page.evaluate((frameUrl) => {
        const iframe = document.createElement("iframe");
        iframe.id = "cross-origin-frame";
        iframe.src = frameUrl;
        document.body.append(iframe);
      }, `http://localhost:${address.port}/frame`);
      await page
        .frameLocator("#cross-origin-frame")
        .getByLabel("Frame input")
        .fill("Cross-origin");
      result.crossOriginFrame = true;
      await page.getByLabel("Resume").setInputFiles({
        name: "synthetic.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Synthetic only"),
      });
      result.upload = true;
      await host.command({ type: "minimize" });
      await page.getByLabel("Name", { exact: true }).fill("Minimized");
      result.minimized = await page
        .getByLabel("Name", { exact: true })
        .inputValue();
      try {
        await page.screenshot({
          path: join(out, "scoped-hidden.png"),
          timeout: 5000,
        });
        result.screenshot = true;
      } catch (error) {
        result.screenshot = String(error);
      }
      const popupPromise = page.waitForEvent("popup", { timeout: 5000 });
      await page.getByRole("button", { name: "Open popup" }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      result.popup = await popup.title();
      result.opener = await popup.evaluate(() => !!window.opener);
      assert.equal(result.opener, true);
      const extra = await context.newPage();
      await extra.goto(url);
      result.newPage = await extra.title();
      await extra.close();
      await context.route("**/blocked", (route) => route.abort());
      result.route = await page.evaluate(async () => {
        try {
          await fetch("/blocked");
          return false;
        } catch {
          return true;
        }
      });
      result.isolation = await page.evaluate(() => ({
        require: typeof (globalThis as Record<string, unknown>).require,
        bridge: typeof (globalThis as Record<string, unknown>).nestor,
      }));
      const guarded = await context.newPage();
      guarded.setDefaultTimeout(5000);
      await ensurePrepareOnlyMutationGuard(guarded, false);
      await guarded.goto(url + "/guard");
      await registerPrepareOnlyPreparedValue(guarded, "synthetic@example.test");
      await guarded
        .getByLabel("Email", { exact: true })
        .fill("synthetic@example.test");
      await guarded.getByLabel("Email", { exact: true }).blur();
      result.guardVisibility = await guarded.evaluate(() => ({
        visibility: document.visibilityState,
        focus: document.hasFocus(),
      }));
      await guarded
        .getByRole("button", { name: "Submit application", exact: true })
        .click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      result.blockedMutation =
        await getLatestBlockedPrepareOnlyAttempt(guarded);
      result.externalWrites = writes;
      assert.deepEqual(writes, []);
      assert.ok(result.blockedMutation);
      await guarded.close();
      await host.getSession().cookies.set({
        url,
        name: "synthetic-session",
        value: "fixture",
        expirationDate: Date.now() / 1000 + 86400,
      });
    });
    await host.close(true);
    result.closed = host.getState();
    result.cookieRetained =
      (await host.getSession().cookies.get({ name: "synthetic-session" }))
        .length === 1;
    // A synthetic Firefox profile stands in for the user's real browsers.
    const home = await mkdtemp(join(tmpdir(), "nestor-import-home-"));
    const profile = join(
      home,
      "Library/Application Support/Firefox/Profiles/abc.synthetic",
    );
    await mkdir(profile, { recursive: true });
    await writeFile(
      join(home, "Library/Application Support/Firefox/profiles.ini"),
      "[Profile0]\nName=synthetic\nIsRelative=1\nPath=Profiles/abc.synthetic\n",
    );
    const db = new DatabaseSync(join(profile, "cookies.sqlite"));
    db.exec(
      "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)",
    );
    db.prepare(
      "INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
    ).run(
      "synthetic-import",
      "fixture-only",
      "127.0.0.1",
      "/",
      Math.floor(Date.now() / 1000) + 86400,
    );
    db.close();
    const importEnv = { platform: "darwin" as const, home };
    const sources = await listBrowserImportSources(importEnv);
    assert.equal(sources.sources.length, 1);
    assert.equal(sources.sources[0]?.browser, "firefox");
    const imported = await importSignInsFromBrowser(
      host,
      { sourceId: sources.sources[0]!.id },
      importEnv,
    );
    result.importMessage = imported.message;
    assert.equal(imported.status, "imported");
    assert.equal(imported.cookieCount, 1);
    assert.equal(
      (await host.getSession().cookies.get({ name: "synthetic-import" }))
        .length,
      1,
    );
    assert.equal(host.getState().automationPaused, true);
    result.cookieImport = imported.status;
    try {
      await host.connect();
      result.closedBlocksConnect = false;
    } catch {
      result.closedBlocksConnect = true;
    }
    await host.command({ type: "resume" });
    await host.command({ type: "open", url });
    result.reopen = host.getState().tabs.length;
    const runtime = createDesktopBrowserRuntime({
      env: { NESTOR_BROWSER_AGENT: "1" },
      desktopTestApiEnabled: false,
      aiClient: createDeterministicJobFinderAiClient(),
    });
    const opened = await runtime.openSession("target_site", {
      targetUrl: url,
      purpose: "automation",
    });
    assert.equal(opened.status, "ready");
    const snapshot = await runtime.captureVisualSnapshot!("target_site", {
      purpose: "debug_benchmark",
      mode: "viewport",
      label: "Synthetic embedded runtime",
      region: null,
      retention: {
        retention: "temporary",
        redactionLevel: "none",
        reason: "Synthetic local fixture",
        expiresAt: null,
      },
      reason: "Verify desktop runtime composition",
    });
    result.runtimeSnapshot = Boolean(snapshot);
    assert.ok(snapshot);
    await host.runAutomation("Reopened screenshot", undefined, async () => {
      const browser = await host.connect();
      const page = browser.contexts()[0]!.pages()[0]!;
      await page.getByLabel("Name", { exact: true }).fill("Reopened");
      await page.screenshot({
        path: join(out, "scoped-reopened.png"),
        timeout: 5000,
      });
      result.reopenedScreenshot = true;
    });
    let operation!: Promise<void>;
    host.setActivityHooks({
      pause: async () => {
        await Promise.allSettled([operation]);
        await host.releaseAutomationSession();
      },
      resume: () => Promise.resolve(),
    });
    operation = host
      .runAutomation(
        "Cancelable work",
        undefined,
        (signal) =>
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
      )
      .catch((error: unknown) => {
        assert.equal(error instanceof Error ? error.name : null, "AbortError");
      });
    await host.takeControl();
    result.handover = host.getState();
    assert.equal(result.handover && host.getState().tabs.length, 1);
    await host.close(true);
    result.closedDuringCleanup = host.getState().phase;
    assert.equal(result.closedDuringCleanup, "closed");
    assert.equal(result.screenshot, true);
    assert.equal(result.targets, 1);
    assert.equal(result.action, "Visible");
    assert.equal(result.minimized, "Minimized");
    assert.equal(result.popup, "Popup works");
    assert.equal(result.route, true);
    assert.deepEqual(result.isolation, {
      require: "undefined",
      bridge: "undefined",
    });
    assert.equal(result.cookieRetained, true);
    assert.equal(result.closedBlocksConnect, true);
    result.pass = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
  }
  await host.close(false);
  await writeFile(
    join(out, "scoped-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.error ? 1 : 0);
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
