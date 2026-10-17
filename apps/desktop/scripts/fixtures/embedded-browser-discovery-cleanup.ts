import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, webContents } from "electron";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";

async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT;
  if (!out) throw new Error("Missing isolated test output directory");
  app.setPath("userData", await mkdtemp(join(tmpdir(), "nestor-cleanup-")));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  const host = getEmbeddedBrowser();
  host.attachWindow(window);
  const result: { pass: boolean; cleanedTabs?: number; error?: string } = {
    pass: false,
  };
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<title>Local cleanup fixture</title><label>Unsent answer<input></label><button onclick=\"window.open('/popup','_blank')\">Open popup</button>",
    );
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    await host.command({ type: "open", url });
    const personTab = host.getState().tabs[0]!;
    let finishedSourceTabs: string[] = [];
    await host.runAutomation(
      "Synthetic discovery cleanup",
      undefined,
      async (_signal, _updateActivity, claimPage, claimedTabs) => {
        const browser = await host.connect();
        const context = browser.contexts()[0]!;
        const page = await context.newPage();
        await page.goto(`${url}/source`);
        claimPage(page);
        assert.equal((await claimedTabs()).length, 1);
        await page.getByLabel("Unsent answer").fill("Retained while idle");
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        const nativePage = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === `${url}/source`);
        assert.ok(nativePage);
        assert.equal(nativePage.getBackgroundThrottling(), true);
        assert.equal(
          await page.getByLabel("Unsent answer").inputValue(),
          "Retained while idle",
        );
        assert.equal(nativePage.getBackgroundThrottling(), false);
        const popupPromise = page.waitForEvent("popup", { timeout: 5000 });
        await page.getByRole("button", { name: "Open popup" }).click();
        await (await popupPromise).waitForLoadState();
        finishedSourceTabs = await claimedTabs();
        assert.equal(finishedSourceTabs.length, 2);
        await host.command({ type: "select_tab", tabId: personTab.id });
      },
      { cleanupOnFinish: true },
    );
    assert.ok(
      finishedSourceTabs.every(
        (id) => !host.getState().tabs.some((tab) => tab.id === id),
      ),
    );
    assert.deepEqual(
      host.getState().tabs.map((tab) => tab.id),
      [personTab.id],
    );
    result.cleanedTabs = finishedSourceTabs.length;
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

void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
