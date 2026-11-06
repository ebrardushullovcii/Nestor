import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, webContents } from "electron";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime";
import { createApplyPageHands } from "../../../../packages/browser-agent/src/apply/page-hands";
import { createPageTools } from "../../../../packages/browser-agent/src/page-tools";

// https://developers.cloudflare.com/turnstile/troubleshooting/testing/
const keys = {
  interactive: "3x00000000000000000000FF",
  pass: "1x00000000000000000000AA",
  block: "2x00000000000000000000AB",
};

async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT;
  assert.ok(out);
  app.setPath("userData", await mkdtemp(join(tmpdir(), "nestor-site-checks-")));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    paintWhenInitiallyHidden: true,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  let shown = false;
  let focused = false;
  window.on("show", () => {
    shown = true;
  });
  window.on("focus", () => {
    focused = true;
  });
  const host = getEmbeddedBrowser();
  host.attachWindow(window);
  const scenarios: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    const url = new URL(request.url!, "http://localhost");
    const key =
      keys[url.searchParams.get("key") as keyof typeof keys] ??
      keys.interactive;
    const nested = url.searchParams.has("nested");
    const frame = url.pathname === "/frame";
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    response.end(`<!doctype html><title>Local site check</title>
      ${frame ? "" : "<h1>Local application</h1><button disabled>Submit Application</button>"}
      <div id="widget"></div><p id="status">Waiting for site check</p>
      <script>
      window.widgetEvents=[];
      const passed=()=>{document.querySelector('button').disabled=false;document.querySelector('#status').textContent='Site check passed';widgetEvents.push('success')};
      addEventListener('message',event=>{if(event.data.siteCheckPassed)passed()});
      ${
        nested
          ? `document.querySelector('#widget').attachShadow({mode:'closed'}).innerHTML='<iframe style="width:440px;height:200px;border:9px solid gray" src="http://localhost:${address.port}/frame?key=${url.searchParams.get("key")}"></iframe>';`
          : `window.ready=()=>turnstile.render('#widget',{
        sitekey:'${key}', retry:'never',
        callback:()=>{${frame ? "parent.postMessage({siteCheckPassed:true},'*')" : "passed()"}},
        'before-interactive-callback':()=>widgetEvents.push('interactive'),
        'error-callback':code=>{widgetEvents.push('error:'+code);document.querySelector('#status').textContent='Site check refused'}
      });`
      }
      </script>${nested ? "" : '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready&render=explicit" async defer></script>'}`);
  });
  let failure: string | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await host.runAutomation("Local site checks", undefined, async () => {
      const browser = await host.connect();
      for (const scenario of [
        { key: "interactive", nested: false },
        { key: "interactive", nested: true },
        { key: "pass", nested: false },
        { key: "block", nested: false },
      ]) {
        const page = await browser.contexts()[0]!.newPage();
        const url = `http://127.0.0.1:${address.port}/?key=${scenario.key}${scenario.nested ? "&nested=1" : ""}`;
        await page.goto(url);
        const contents = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)!;
        assert.ok(contents);
        const hands = createApplyPageHands(
          createPlaywrightApplyPageMechanics(page),
        );
        const tools = createPageTools(hands);
        let checkboxRef: string | undefined;
        let disabledResult: unknown;
        if (scenario.key === "interactive") {
          await page.waitForTimeout(5000);
          const observation = await tools.observe();
          const checkbox = observation.clickables.find(
            (control) => control.role === "checkbox" && control.visible,
          );
          assert.ok(
            checkbox?.ref,
            "The real Turnstile checkbox must reach model observation",
          );
          checkboxRef = checkbox.ref;
          const submit = observation.actions.find(
            (action) => action.label === "Submit Application",
          )!;
          disabledResult = await hands.clickElement(submit.ref);
          assert.match(JSON.stringify(disabledResult), /disabled/iu);
          const clickResult = await tools.tools
            .find((tool) => tool.definition.function.name === "click")!
            .execute(JSON.stringify({ ref: checkbox.ref }), { step: 1 });
          assert.match(JSON.stringify(clickResult), /Pressed/iu);
          await page.waitForFunction(
            () =>
              !(document.querySelector("button") as HTMLButtonElement).disabled,
            undefined,
            { timeout: 15000 },
          );
        } else if (scenario.key === "pass") {
          await page.waitForFunction(
            () =>
              !(document.querySelector("button") as HTMLButtonElement).disabled,
          );
        } else {
          await page.waitForFunction(
            () =>
              document.querySelector("#status")?.textContent ===
              "Site check refused",
          );
          assert.equal(await page.getByRole("button").isDisabled(), true);
        }
        const tokenFrame = scenario.nested
          ? page
              .frames()
              .find((frame) =>
                frame
                  .url()
                  .startsWith(`http://localhost:${address.port}/frame`),
              )!
          : page.mainFrame();
        const tokenPresent = await tokenFrame.evaluate(
          () =>
            !!(
              document.querySelector(
                'input[name="cf-turnstile-response"]',
              ) as HTMLInputElement | null
            )?.value,
        );
        if (scenario.key === "interactive" || scenario.key === "pass")
          assert.equal(tokenPresent, true);
        assert.equal(window.isVisible(), false);
        assert.equal(window.isFocused(), false);
        assert.equal(shown, false);
        assert.equal(focused, false);
        const result = {
          ...scenario,
          checkboxRef,
          disabledResult,
          passed: scenario.key !== "block",
          tokenPresent,
          backgroundThrottling: contents.getBackgroundThrottling(),
          windowHidden: true,
          windowFocused: false,
        };
        scenarios.push(result);
        console.log(JSON.stringify(result));
        await page.screenshot({
          path: join(
            out,
            `site-check-${scenario.key}-${scenario.nested ? "nested" : "direct"}.png`,
          ),
        });
        await page.close();
      }
    });
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
  } finally {
    await host.close(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const result = {
    pass: !failure,
    scenarios,
    ...(failure ? { error: failure } : {}),
  };
  await writeFile(
    join(out, "scoped-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  app.exit(failure ? 1 : 0);
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
