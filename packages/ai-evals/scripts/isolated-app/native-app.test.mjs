import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { startTime, stillOurs } from "./common.mjs";
import {
  assertNativeIdentity,
  evaluateMain,
  inspectorClient,
  installUiBridge,
  nativeArgs,
  stopNativeChild,
  validateLaunchMode,
} from "./native-app.mjs";

test("plain launch has only a main inspector and preserves patch/app arguments", () => {
  assert.deepEqual(
    nativeArgs({ appDir: "/private/instance/app" }, "/helper/patch.cjs"),
    [
      "--inspect=127.0.0.1:0",
      "-r",
      "/helper/patch.cjs",
      "/private/instance/app",
    ],
  );
  validateLaunchMode("playwright", { video: true });
  validateLaunchMode("native");
  assert.throws(
    () => validateLaunchMode("native", { video: true }),
    /does not support/,
  );
  assert.throws(() => validateLaunchMode("unknown"), /playwright or native/);
});

test("UI host excludes embedded, overlay, same-path remote and other copied builds", async () => {
  const app = new EventEmitter();
  const contents = (id, url) =>
    Object.assign(new EventEmitter(), {
      id,
      getURL: () => url,
      isDestroyed: () => false,
      getUserAgent: () => "Chrome/1",
    });
  const main = contents(
    1,
    "file:///private/instance/out/renderer/index.html#profile",
  );
  const pages = [
    main,
    contents(2, "https://example.test/apply"),
    contents(
      3,
      "file:///private/instance/out/renderer/live-assistant/overlay/index.html",
    ),
    contents(4, "file:///another/out/renderer/index.html"),
    contents(
      5,
      "https://example.test/private/instance/out/renderer/index.html",
    ),
  ];
  let host;
  let syncs = 0;
  class Bridge {
    constructor(value) {
      host = value;
    }
    start() {
      return { endpoint: "ws://127.0.0.1:1/browser" };
    }
    syncFocusEmulation() {
      syncs++;
    }
  }
  await installUiBridge(
    {
      app,
      BrowserWindow: {
        getAllWindows: () =>
          pages.map((webContents) => ({
            webContents,
            isDestroyed: () => false,
          })),
      },
    },
    { rendererUrl: "file:///private/instance/out/renderer/index.html" },
    Bridge,
  );
  assert.deepEqual(
    host.pages().map((p) => p.id),
    ["1"],
  );
  assert.throws(
    () => host.createPage("https://example.test"),
    /existing main UI/,
  );
  assert.throws(() => host.closePage("1"), /existing main UI/);
  host.selectPage("1"); // It must not call native focus.
  await host.onAutomationCommand("1", true, true);
  await host.onAutomationCommand("1", true, true);
  await host.onAutomationCommand("1", false, true);
  assert.equal(host.emulateFocus("1"), true);
  await host.onAutomationCommand("1", false, true);
  assert.equal(host.emulateFocus("1"), false);
  assert.equal(syncs, 4);
  const announced = [];
  const dispose = host.onPageCreated((page) => announced.push(page.id));
  const popup = contents(6, "https://accounts.google.com/");
  app.emit("web-contents-created", {}, popup);
  popup.emit("did-finish-load");
  const replacement = contents(
    7,
    "file:///private/instance/out/renderer/index.html",
  );
  app.emit("web-contents-created", {}, replacement);
  replacement.emit("did-finish-load");
  assert.deepEqual(announced, ["7"]);
  dispose();
  assert.equal(app.listenerCount("web-contents-created"), 0);
  assert.equal(replacement.listenerCount("did-finish-load"), 0);
  delete globalThis.__nestorVerifyUiBridge;
});

test("UI bridge waits for the already-created main window to load, else reports URL classes only", async () => {
  const rendererUrl = "file:///private/instance/out/renderer/index.html";
  let url = "";
  const win = {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      id: 1,
      getURL: () => url,
      isDestroyed: () => false,
      getUserAgent: () => "Chrome/1",
    }),
  };
  const electron = {
    app: new EventEmitter(),
    BrowserWindow: { getAllWindows: () => [win] },
  };
  let started = 0;
  class Bridge {
    start() {
      started++;
      return { endpoint: "ws://127.0.0.1:1/browser" };
    }
  }
  setTimeout(() => (url = `${rendererUrl}#home`), 150);
  assert.deepEqual(
    await installUiBridge(electron, { rendererUrl, readyMs: 2000 }, Bridge),
    { endpoint: "ws://127.0.0.1:1/browser" },
  );
  url = "https://private.example/path?token=x";
  assert.deepEqual(
    await installUiBridge(electron, { rendererUrl, readyMs: 150 }, Bridge),
    { error: "no-ui-window", windows: ["non-file"] },
  );
  assert.equal(started, 1);
  delete globalThis.__nestorVerifyUiBridge;
});

class Socket extends EventEmitter {
  sent = [];
  send(text) {
    this.sent.push(JSON.parse(text));
  }
  terminate() {
    this.emit("close");
  }
}

test("main inspector correlates out-of-order JSON replies and rejects pending on disconnect", async () => {
  const socket = new Socket();
  const client = inspectorClient(socket, 1000);
  const a = client.send("Runtime.enable");
  const b = client.send("Runtime.evaluate");
  socket.emit(
    "message",
    JSON.stringify({ id: socket.sent[1].id, result: { result: { value: 2 } } }),
  );
  socket.emit(
    "message",
    JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }),
  );
  socket.emit("message", JSON.stringify({ id: socket.sent[0].id, result: {} }));
  assert.deepEqual(await a, {});
  assert.deepEqual(await b, { result: { value: 2 } });
  const pending = client.send("Runtime.evaluate");
  const rejection = assert.rejects(pending, /disconnected/);
  client.close();
  await rejection;
});

test("main evaluation requests JSON only and does not expose exception payloads", async () => {
  let request;
  const client = {
    send: async (method, params) => {
      request = { method, params };
      return { result: { value: { ready: true } } };
    },
  };
  assert.deepEqual(
    await evaluateMain(client, (_electron, arg) => arg, { ready: true }),
    { ready: true },
  );
  assert.equal(request.params.awaitPromise, true);
  assert.equal(request.params.returnByValue, true);
  assert.equal(request.params.includeCommandLineAPI, true);
  await assert.rejects(
    evaluateMain(
      { send: async () => ({ exceptionDetails: { text: "private text" } }) },
      () => null,
    ),
    (error) => !error.message.includes("private text"),
  );
});

test("natural identity fails closed on missing page, webdriver, overridden getter or wrong brand", () => {
  const sample = {
    webdriver: false,
    chromeShape: true,
    chromeVersion: "149.0.1.0",
    userAgent: "Mozilla/5.0 Chrome/149.0.1.0 Safari/537.36",
    brands: [{ brand: "Google Chrome", version: "149" }],
    webdriverDescriptor: { own: false, getter: true },
  };
  assert.deepEqual(assertNativeIdentity([sample]), [sample]);
  assert.throws(() => assertNativeIdentity([]), /no embedded page/);
  for (const patch of [
    { webdriver: true },
    { chromeShape: false },
    { webdriverDescriptor: { own: true, getter: true } },
    { userAgent: sample.userAgent + " Electron/44" },
    { brands: [{ brand: "Chromium" }] },
  ])
    assert.throws(
      () => assertNativeIdentity([{ ...sample, ...patch }]),
      /precondition failed/,
    );
});

test("native cleanup stops its own Node child and leaves a separately owned sentinel alive", async (t) => {
  const args = ["-e", "setInterval(() => {}, 1000)"];
  const child = spawn(process.execPath, args, { stdio: "ignore" });
  const sentinel = spawn(process.execPath, args, { stdio: "ignore" });
  t.after(() => {
    child.kill();
    sentinel.kill();
  });
  const childStart = startTime(child.pid);
  const sentinelStart = startTime(sentinel.pid);
  assert.ok(childStart && sentinelStart);
  assert.deepEqual(await stopNativeChild(child, childStart), []);
  assert.equal(stillOurs(sentinel.pid, sentinelStart), true);
  assert.equal(stillOurs(child.pid, childStart), false);
});

test("graceful native quit waits for the app's own exit before any signal", async (t) => {
  // Exits cleanly 400 ms after quit is queued; a signal would give 143.
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.exit(143)); process.stdin.once('data', () => setTimeout(() => process.exit(0), 400)); setInterval(() => {}, 1000)",
    ],
    { stdio: ["pipe", "ignore", "ignore"] },
  );
  t.after(() => child.kill());
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const started = startTime(child.pid);
  assert.ok(started);
  let quits = 0;
  assert.deepEqual(
    await stopNativeChild(
      child,
      started,
      async () => {
        quits++;
        child.stdin.write("quit\n");
      },
      5000,
    ),
    [],
  );
  assert.equal(quits, 1);
  assert.equal(await exited, 0);
});

function patchedGuard(mode, authorized, profileKind = "unknown") {
  let provenance = { kind: profileKind };
  const handlers = new Map();
  const events = new Map();
  const logs = [];
  class Window {
    setOpacity() {}
    setIgnoreMouseEvents() {}
    showInactive() {}
  }
  class Menu {
    popup() {}
  }
  const makeSession = () => ({
    webRequest: {
      onBeforeRequest(fn) {
        this.listener = fn;
      },
    },
  });
  const embedded = makeSession();
  const defaultSession = makeSession();
  const electron = {
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    BrowserWindow: Window,
    Menu,
    dialog: {},
    shell: {},
    app: { on: (event, fn) => events.set(event, fn) },
    session: { defaultSession, fromPartition: () => embedded },
  };
  const fs = {
    appendFileSync: (_file, text) => logs.push(JSON.parse(text)),
    readFileSync: () => JSON.stringify(provenance),
    writeFileSync: (_file, text) => {
      provenance = JSON.parse(text);
    },
  };
  vm.runInNewContext(
    readFileSync(new URL("./instance-patch.cjs", import.meta.url), "utf8"),
    {
      require: (id) =>
        ({
          "node:module": { _load() {} },
          "node:fs": fs,
          "node:path": {
            join: (...parts) => parts.join("/"),
            basename: (value) => value.split("/").at(-1),
          },
          electron,
          "./provider-fixture.cjs": {
            loadProviderFixture: () => null,
            installProviderTransport() {},
          },
        })[id],
      process: {
        env: {
          NESTOR_VERIFY_STATE: "/state",
          NESTOR_VERIFY_EVIDENCE: "/evidence",
          NESTOR_VERIFY_NET: mode,
          NESTOR_LIVE_APPLY_AUTHORIZED: authorized,
        },
        platform: "linux",
      },
      URL,
    },
  );
  events.get("ready")();
  const popup = makeSession();
  events.get("session-created")(popup);
  const request = (session, url, method) => {
    let result;
    session.webRequest.listener(
      { url, method, resourceType: "xhr" },
      (value) => (result = value),
    );
    return result.cancel === true;
  };
  return {
    sessions: [defaultSession, embedded, popup],
    request,
    logs,
    register: electron.ipcMain.handle,
    invoke: (channel) => handlers.get(channel)(),
    provenance: () => provenance,
  };
}

test("unchanged guards cover all sessions: external writes/redirect targets blocked, replica POST allowed", () => {
  for (const mode of ["replica", "web"]) {
    const guard = patchedGuard(mode);
    for (const session of guard.sessions) {
      for (const url of [
        "https://employer.example/autosave?token=secret",
        "https://employer.example/submit",
        "https://challenges.cloudflare.com/wrong-path",
        "https://wrong.example/cdn-cgi/challenge-platform/x",
      ]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"])
          assert.equal(guard.request(session, url, method), true);
      }
      assert.equal(
        guard.request(session, "http://127.0.0.1:1234/submit", "POST"),
        false,
      );
      assert.equal(
        guard.request(session, "https://employer.example/redirected", "POST"),
        true,
      );
      assert.equal(
        guard.request(session, "https://example.test/read", "GET"),
        mode === "replica",
      );
    }
    assert.ok(guard.logs.length);
    assert.equal(JSON.stringify(guard.logs).includes("secret"), false);
  }
});

test("live requires the exact authorization flag and allows real-site requests in every session", () => {
  for (const authorization of [undefined, "", "0", "true"])
    assert.throws(
      () => patchedGuard("live", authorization),
      /NESTOR_LIVE_APPLY_AUTHORIZED=1/,
    );
  const guard = patchedGuard("live", "1");
  for (const session of guard.sessions)
    for (const method of [
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ])
      assert.equal(
        guard.request(session, "https://employer.example/apply", method),
        false,
      );
  assert.equal(guard.logs.length, 0);
});

test("CLI refuses live mode without authorization before starting an instance", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./cli.mjs", import.meta.url)),
      "up",
      "--net",
      "live",
    ],
    {
      env: { ...process.env, NESTOR_LIVE_APPLY_AUTHORIZED: "0" },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /--net live requires NESTOR_LIVE_APPLY_AUTHORIZED=1/,
  );
});

test("test API seeding is durably synthetic and live startup refuses it; app setup remains accepted", async () => {
  const replica = patchedGuard("replica", undefined, "app_setup");
  let seeded = false;
  replica.register("job-finder:test-load-applications-store-demo", () => {
    seeded = true;
  });
  await replica.invoke("job-finder:test-load-applications-store-demo");
  assert.equal(seeded, true);
  assert.equal(replica.provenance().kind, "synthetic");
  assert.throws(() => patchedGuard("live", "1", "synthetic"), /seeded/);
  assert.doesNotThrow(() => patchedGuard("live", "1", "app_setup"));
});
