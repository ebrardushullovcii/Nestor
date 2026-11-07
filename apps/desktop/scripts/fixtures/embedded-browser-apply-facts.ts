import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { createPlaywrightApplyPageMechanics } from "@nestor/browser-runtime/apply-page";
import {
  executeExactlyOneFinalAction,
  observeApplicationForm,
} from "@nestor/browser-runtime";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";
import {
  refusalText,
  startApplyFactsReplica,
} from "../../test-fixtures/job-finder/apply-facts";

async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT;
  assert.ok(out);
  app.setPath("userData", await mkdtemp(join(tmpdir(), "nestor-apply-facts-")));
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  window.setPosition(-6000, 0);
  window.setOpacity(0);
  window.setIgnoreMouseEvents(true);
  const host = getEmbeddedBrowser();
  host.attachWindow(window);
  const replica = await startApplyFactsReplica();
  const result: {
    pass: boolean;
    checks: string[];
    facts: unknown[];
    error?: string;
  } = { pass: false, checks: [], facts: [] };
  try {
    await host.command({ type: "open", url: replica.url });
    await host.runAutomation("Apply facts replica", undefined, async () => {
      const browser = await host.connect();
      const page = browser.contexts()[0]!.pages()[0]!;
      const mechanics = createPlaywrightApplyPageMechanics(page);
      const fill = async () => {
        const form = await mechanics.readPage();
        const field = (label: string) =>
          form.controls.find((control) => control.label === label)!.ref!;
        assert.equal(
          (await mechanics.fillText(field("Name"), "Alex Synthetic")).ok,
          true,
        );
        assert.equal(
          (await mechanics.fillText(field("Phone"), "2025550123")).ok,
          true,
        );
        assert.equal(
          (
            await mechanics.uploadFile(field("Resume"), {
              name: "synthetic.txt",
              mimeType: "text/plain",
              bytes: new TextEncoder().encode("Synthetic resume bytes"),
            })
          ).ok,
          true,
        );
      };
      await fill();
      assert.deepEqual(replica.state, { posts: 0, accepted: 0 });
      result.checks.push("Fill sends and accepts zero applications");
      const form = await mechanics.readPage();
      const send = form.actions.find(
        (action) => action.label === "Send application",
      )!;
      const observed = await observeApplicationForm(page, {
        finalActionTargets: [{ ref: send.ref!, label: send.label }],
      });
      const input = {
        expectedObservation: observed.identity,
        expectedControl: observed.controls[0]!.identity,
        expectedPageOrigin: replica.url,
        allowedOrigins: [replica.url],
        veto: () => true,
        callId: "refused_send",
      };
      const refused = await executeExactlyOneFinalAction(page, input);
      result.facts.push(refused.facts);
      const request = refused.facts.requestsAfterClick.find(
        (request) => request.path === "/candidates",
      );
      assert.equal(request?.status, 422);
      assert.equal(request.responseText, refusalText);
      const after = await mechanics.readPage();
      assert.notEqual(
        after.controls.find((control) => control.label === "Resume")?.upload
          ?.network,
        "rejected",
      );
      result.checks.push(
        "Native Recruitee-shaped 422 response text retained as form facts, not an attachment rejection",
      );
      await executeExactlyOneFinalAction(page, input);
      assert.equal(replica.state.posts, 1);
      await mechanics.fillText(
        after.controls.find((control) => control.label === "Phone")!.ref!,
        "+12025550123",
      );
      const next = await observeApplicationForm(page);
      const sent = await executeExactlyOneFinalAction(page, {
        ...input,
        expectedObservation: next.identity,
        expectedControl: next.controls[0]!.identity,
        callId: "new_send_decision",
      });
      result.facts.push(sent.facts);
      await executeExactlyOneFinalAction(page, {
        ...input,
        expectedObservation: next.identity,
        expectedControl: next.controls[0]!.identity,
        callId: "new_send_decision",
      });
      assert.deepEqual(replica.state, { posts: 2, accepted: 1 });
      assert.match(
        (await mechanics.readPage()).bodyText,
        /Application received/,
      );
      result.checks.push(
        "New Send decision accepted once; neither consumed call replays",
      );
      assert.equal(window.isFocused(), false);
      assert.equal(window.getOpacity(), 0);
      result.checks.push(
        "Isolated native host stayed hidden, unfocused and off screen",
      );
    });
    result.pass = true;
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    await host.close(false);
    await replica.close();
    window.destroy();
  }
  await writeFile(
    join(out, "apply-facts.json"),
    JSON.stringify(result, null, 2),
  );
  app.exit(result.pass ? 0 : 1);
}
void main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
