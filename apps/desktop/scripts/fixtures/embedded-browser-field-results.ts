import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime/apply-page";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";
import {
  fieldResultsForm,
  acceptFieldResultsSubmission,
} from "../../test-fixtures/job-finder/field-results";

async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT;
  assert.ok(out);
  app.setPath(
    "userData",
    await mkdtemp(join(tmpdir(), "nestor-field-results-")),
  );
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.setPosition(-6000, 0);
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  const host = getEmbeddedBrowser();
  host.attachWindow(window);
  let accepted = 0;
  const result: {
    pass: boolean;
    checks: string[];
    facts: unknown[];
    error?: string;
  } = {
    pass: false,
    checks: [],
    facts: [],
  };
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/send" && req.method === "POST") {
      acceptFieldResultsSubmission(req, res, () => accepted++);
    } else if (req.url === "/board")
      res.end('<a href="/apply" target="_blank">Apply on company website</a>');
    else res.end(fieldResultsForm);
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    await host.command({ type: "open", url: `${origin}/board` });
    await host.runAutomation("Field mechanics replica", undefined, async () => {
      const browser = await host.connect();
      const page = browser.contexts()[0]!.pages()[0]!;
      const hands = createPlaywrightApplyPageMechanics(page);
      for (const send of [false, true]) {
        accepted = 0;
        await hands.navigate(`${origin}/board`);
        const listing = await hands.readPage();
        assert.equal((await hands.followLink(listing.links[0]!.ref!)).ok, true);
        const form = await hands.readPage();
        const field = (label: string) =>
          form.controls.find((control) => control.label === label)!.ref!;
        assert.equal(
          (await hands.fillText(field("Email"), "test@example.test")).ok,
          true,
        );
        assert.equal(
          (await hands.setToggle(field("Terms"), true)).controlState?.checked,
          true,
        );
        const radio = form.clickables.find((entry) => entry.label === "N/A")!;
        assert.equal(
          (await hands.clickElement(radio.ref!)).controlState?.checked,
          true,
        );
        await hands.clickElement(field("Calling code"));
        const selection = await hands.chooseOption(
          field("Calling code"),
          "Kosovo",
        );
        result.facts.push({
          selection,
          picker: await page.getByRole("combobox").evaluate((element) => ({
            expanded: element.getAttribute("aria-expanded"),
            list: document.getElementById(
              element.getAttribute("aria-controls")!,
            )?.innerHTML,
          })),
        });
        assert.equal(selection.ok, true);
        assert.equal(selection.optionList?.open, false);
        assert.ok(selection.optionList?.options.includes("Kosovo"));
        assert.equal(
          (await hands.fillText(field("Phone"), "+383 44 000 000")).ok,
          true,
        );
        if (send) {
          const fresh = await hands.readPage();
          assert.equal(
            (
              await hands.clickElement(
                fresh.actions.find(
                  (action) => action.label === "Send application",
                )!.ref!,
              )
            ).ok,
            true,
          );
          assert.match(
            (await hands.readPage()).bodyText,
            /Application received/,
          );
        }
        assert.equal(accepted, send ? 1 : 0);
        result.checks.push(
          `${send ? "Send accepted once" : "Fill accepted zero"}; Kosovo, email, terms and N/A states observed`,
        );
      }
      await hands.navigate(`${origin}/board`);
      const listing = await hands.readPage();
      await page.locator("a").evaluate((node) => node.remove());
      assert.equal((await hands.followLink(listing.links[0]!.ref!)).ok, false);
      await hands.navigate(`${origin}/apply`);
      const form = await hands.readPage();
      const email = form.controls.find((control) => control.label === "Email")!;
      await page
        .getByLabel("Email", { exact: true })
        .evaluate((node) => node.remove());
      assert.equal(
        (await hands.fillText(email.ref!, "test@example.test")).ok,
        false,
      );
      result.checks.push(
        "Replaced link and email return stale without selector auto-wait",
      );
      assert.equal(window.isFocused(), false);
      assert.equal(window.getOpacity(), 0);
      result.checks.push(
        "Isolated native host stayed unfocused, transparent and off screen",
      );
    });
    result.pass = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    await host.close(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    window.destroy();
  }
  await writeFile(
    join(out, "field-results.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
  app.exit(result.pass ? 0 : 1);
}
void main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
