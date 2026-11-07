import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { getEmbeddedBrowser } from "../../src/main/services/browser/embedded-browser";
import { createPlaywrightApplyPageSession } from "@nestor/browser-runtime/apply-page";
import { createApplyPageHands } from "../../../../packages/browser-agent/src/apply/page-hands";
import { createPageTools } from "../../../../packages/browser-agent/src/page-tools";
import { withVerificationPrivacy, traceEvent } from "@nestor/core/run-trace";
import { handleVerificationReplica } from "../../test-fixtures/job-sites/verification-replica.mjs";

async function main() {
  const out = process.env.EMBEDDED_BROWSER_TEST_OUTPUT!;
  assert.ok(out);
  process.env.NESTOR_RUN_TRACE_DIR = out;
  app.setPath(
    "userData",
    await mkdtemp(join(tmpdir(), "nestor-native-verification-")),
  );
  process.env.NESTOR_USER_DATA_DIR = app.getPath("userData");
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    paintWhenInitiallyHidden: true,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  let shown = false,
    focused = false;
  window.on("show", () => {
    shown = true;
  });
  window.on("focus", () => {
    focused = true;
  });
  const host = getEmbeddedBrowser();
  host.attachWindow(window);
  const checks: string[] = [];
  let failure: string | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const send = (status: number, body: string, type = "text/html") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    };
    try {
      if (
        !(await handleVerificationReplica(req, res, url, {
          send,
          logPost: () => {},
          readPost: async () => {
            let body = "";
            for await (const chunk of req) body += String(chunk);
            return Object.fromEntries(new URLSearchParams(body));
          },
        }))
      )
        send(404, "Not found");
    } catch {
      send(500, "Replica error");
    }
  });
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    await host.runAutomation(
      "Native verification replica",
      undefined,
      async (_signal, _activity, claim, claimed) => {
        const browser = await host.connect();
        const page = await browser.contexts()[0]!.newPage();
        claim(page);
        await claimed();
        const session = createPlaywrightApplyPageSession({
          page,
          onPage: async (child) => {
            claim(child);
            await claimed();
          },
        });
        const tab = () =>
          host
            .getState()
            .tabs.find(
              (tab) =>
                tab.url.split(/[?#]/u)[0] === page.url().split(/[?#]/u)[0],
            )!;
        const target = async (ref: string) => {
          const control = (await session.readPage()).controls.find(
            (c) => c.ref === ref,
          )!;
          return {
            controlIndex: control.index,
            id: control.id,
            name: control.name,
            ...(control.frame ? { frame: control.frame } : {}),
          };
        };
        const hands = createApplyPageHands({
          ...session,
          generateAccountCredential: async ({ username, passwordRefs }) =>
            host.generateAccountCredential(
              tab().id,
              username,
              await Promise.all(passwordRefs.map(target)),
            ),
          listSavedCredentials: async () => host.listAgentCredentials(tab().id),
          fillSavedCredential: async (ref, id) =>
            host.fillAgentCredential(tab().id, id, await target(ref)),
        });
        const tools = createPageTools(hands);
        const call = async (name: string, args: Record<string, unknown>) => {
          console.log(`Verification tool: ${name}`);
          const tool = tools.tools.find(
            (tool) => tool.definition.function.name === name,
          )!;
          const result = await tool.execute(JSON.stringify(args), { step: 1 });
          assert.equal(result.kind, "ok");
          if (result.kind === "ok")
            assert.notEqual(result.status, "failed", name);
          return result;
        };
        const refs = async () => {
          const raw = await tools.observe();
          return {
            control: (label: string) =>
              raw.controls.find((c) => c.label === label)!.ref,
            action: (label: string) =>
              raw.actions.find((c) => c.label === label)!.ref,
          };
        };
        await page.goto(`${base}/verification-replica/register/native`);
        let r = await refs();
        await call("type", {
          ref: r.control("Email"),
          text: "synthetic@example.test",
        });
        await call("generate_account_login", {
          username: "synthetic@example.test",
          passwordRefs: [r.control("Password"), r.control("Confirm password")],
        });
        r = await refs();
        await call("click", { ref: r.action("Create Account") });
        assert.match(await hands.readText(), /Your account was created/u);
        const saved = host.passwords().vault().list(base)[0]!;
        assert.ok(saved);
        checks.push(
          "The real encrypted vault and sandboxed preload generated, saved and filled both new-account fields; the replica accepted the account.",
        );
        await page.goto(`${base}/verification-replica/logout/native`);
        await page.goto(`${base}/verification-replica/login/native`);
        r = await refs();
        await call("type", { ref: r.control("Email"), text: saved.username });
        await call("fill_saved_login", {
          ref: r.control("Password"),
          credentialId: saved.id,
        });
        r = await refs();
        await call("click", { ref: r.action("Sign in") });
        assert.match(await hands.readText(), /You are signed in/u);
        checks.push(
          "A later sign-in used the generated saved login through the real private password IPC.",
        );

        await withVerificationPrivacy(async () => {
          await page.goto(`${base}/verification-replica/apply/native`);
          r = await refs();
          await call("type", {
            ref: r.control("Name"),
            text: "Alex Synthetic",
          });
          const terms = (await tools.observe()).controls.find(
            (c) => c.kind === "checkbox",
          )!;
          await call("set_checkbox", { ref: terms.ref, checked: true });
          r = await refs();
          await call("click", { ref: r.action("Send application") });
          const formUrl = page.url();
          await call("open_tab", {
            url: `${base}/verification-replica/inbox/native`,
          });
          const inbox = await hands.readText();
          const code = /verification code is\s+([a-f0-9]+)/u.exec(inbox)?.[1];
          assert.ok(code);
          assert.equal(page.url(), formUrl);
          assert.equal(
            await page.locator('[autocomplete="one-time-code"]').count(),
            1,
          );
          traceEvent("model_turn", {
            request: { messages: [{ content: inbox }] },
            response: { content: code },
          });
          await call("switch_tab", { tabId: "form" });
          r = await refs();
          await call("type", {
            ref: r.control("Verification code"),
            text: code,
          });
          await call("click", { ref: r.action("Verify email") });
          assert.match(
            await hands.readText(),
            /Your application has been received/u,
          );
          await call("close_tab", { tabId: "tab1" });
          const stats = await page
            .context()
            .request.get(`${base}/verification-replica/stats/native`)
            .then((response) => response.json());
          assert.deepEqual(stats, { sends: 1, verifications: 1, accepted: 1 });
          const password = host.passwords().vault().read(saved.id)!.password;
          for (const file of (await readdir(out)).filter((file) =>
            file.endsWith(".jsonl"),
          )) {
            const text = await readFile(join(out, file), "utf8");
            assert.equal(text.includes(code), false);
            assert.equal(text.includes(password), false);
          }
        });
        checks.push(
          "An auxiliary tab shared the embedded session, read the replica inbox and returned to the unchanged bound form; code entry completed exactly one application.",
        );
        checks.push(
          "Native trace/model records contain neither the generated password nor the emailed code.",
        );
        await page.close();
      },
    );
    assert.equal(shown, false);
    assert.equal(focused, false);
    checks.push(
      "The isolated app stayed hidden and never focused the owner's desktop.",
    );
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
  } finally {
    await host.close(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const result = {
    pass: !failure,
    checks,
    ...(failure ? { error: failure } : {}),
  };
  await writeFile(
    join(out, "verification-result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  app.exit(failure ? 1 : 0);
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
