// A deliberately small backend for verify-nestor, not ElectronApplication.
// Main-process inspection and the UI bridge never attach to embedded pages.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { descendants, startTime, stillOurs } from "./common.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function validateLaunchMode(mode, { video = false } = {}) {
  if (!["playwright", "native"].includes(mode))
    throw new Error("--launch is playwright or native");
  if (mode === "native" && video)
    throw new Error(
      "Native launch does not support --video. Use capturePage shots.",
    );
}

export function nativeArgs(launch, patchPath) {
  return ["--inspect=127.0.0.1:0", "-r", patchPath, launch.appDir];
}

/** Compile only the existing bridge, outside out/. No desktop build is run. */
export async function prepareNativeBridge({
  checkout,
  stateDir,
  requireDesktop,
}) {
  const { build } = await import(
    pathToFileURL(requireDesktop.resolve("vite")).href
  );
  const wsPath = requireDesktop.resolve("ws");
  const output = path.join(stateDir, "native-helper");
  await build({
    configFile: false,
    root: checkout,
    logLevel: "warn",
    plugins: [
      {
        name: "verify-native-external-ws",
        enforce: "pre",
        resolveId: (source) =>
          source === "ws" ? { id: wsPath, external: true } : null,
      },
    ],
    build: {
      ssr: path.join(
        checkout,
        "apps/desktop/src/main/services/browser/browser-cdp-bridge.ts",
      ),
      outDir: output,
      emptyOutDir: true,
      rollupOptions: {
        external: (id) => isBuiltin(id) || id === wsPath || id === "electron",
        output: {
          format: "cjs",
          entryFileNames: "ui-bridge.cjs",
          dynamicImportInCjs: false,
          // ws has inherited enumerable properties; match the native fixture.
          externalLiveBindings: false,
        },
      },
    },
  });
  const bridgePath = path.join(output, "ui-bridge.cjs");
  return {
    bridgePath,
    bridgeSha256: createHash("sha256")
      .update(readFileSync(bridgePath))
      .digest("hex"),
  };
}

/** This function is serialized into the owned main process. Keep it closure-free. */
export async function installUiBridge(electron, input, Bridge) {
  const { BrowserWindow, app } = electron;
  const BridgeClass = Bridge ?? require(input.bridgePath).BrowserCdpBridge;
  const isUi = (contents) => {
    if (contents.isDestroyed()) return false;
    try {
      const url = new URL(contents.getURL());
      url.hash = "";
      return url.href === input.rendererUrl;
    } catch {
      return false;
    }
  };
  const page = (contents) => ({ id: String(contents.id), contents });
  const uiPages = () =>
    BrowserWindow.getAllWindows()
      .filter((win) => !win.isDestroyed() && isUi(win.webContents))
      .map((win) => page(win.webContents));
  // The main window is created before this runs, so its creation event is
  // already past; wait until it has loaded the exact renderer URL.
  const deadline = Date.now() + (input.readyMs ?? 45_000);
  while (!uiPages().length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!uiPages().length)
    return {
      // URL classes only: never a page URL or title.
      error: "no-ui-window",
      windows: BrowserWindow.getAllWindows().map((win) => {
        const url = win.isDestroyed() ? "" : win.webContents.getURL();
        if (!url) return "empty";
        if (!url.startsWith("file:")) return "non-file";
        return url.split("#")[0] === input.rendererUrl
          ? "ui-unmatched"
          : "file-other";
      }),
    };
  const forbidden = () => {
    throw new Error("Native verification exposes only the existing main UI.");
  };
  const focused = new Map();
  const bridge = new BridgeClass({
    pages: uiPages,
    createPage: forbidden,
    closePage: forbidden,
    selectPage: () => {}, // Never activate a native window.
    userAgent: () => uiPages()[0]?.contents.getUserAgent() ?? "",
    emulateFocus: (id) => (focused.get(id) ?? 0) > 0,
    onAutomationCommand: async (id, active, needsFocus) => {
      // CDP focus is scoped to this UI command, never native OS focus.
      if (needsFocus) {
        focused.set(
          id,
          Math.max(0, (focused.get(id) ?? 0) + (active ? 1 : -1)),
        );
        await bridge.syncFocusEmulation();
      }
    },
    onPageCreated: (listener) => {
      const pending = new Map();
      const created = (_event, contents) => {
        const loaded = () => {
          if (isUi(contents)) listener(page(contents));
        };
        pending.set(contents, loaded);
        contents.on("did-finish-load", loaded);
      };
      app.on("web-contents-created", created);
      return () => {
        app.off("web-contents-created", created);
        for (const [contents, loaded] of pending)
          contents.off("did-finish-load", loaded);
        pending.clear();
      };
    },
  });
  // The driver quits via main, never Browser.close through a browser-wide port.
  globalThis.__nestorVerifyUiBridge = bridge;
  return bridge.start();
}

/** Minimal JSON request/reply transport; no handles or Electron automation API. */
export function inspectorClient(socket, timeoutMs = 15_000) {
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const fail = () => {
    closed = true;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error("Owned native inspector disconnected."));
    }
    pending.clear();
  };
  socket.on("close", fail);
  socket.on("error", fail);
  socket.on("message", (bytes) => {
    let message;
    try {
      message = JSON.parse(String(bytes));
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    // Do not echo evaluated expressions, page contents or protocol error data.
    if (message.error)
      request.reject(new Error("Owned native inspector request failed."));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      if (closed)
        return Promise.reject(
          new Error("Owned native inspector disconnected."),
        );
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Native inspector ${method} timed out.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error("Native inspector send failed."));
        }
      });
    },
    close() {
      fail();
      socket.terminate();
    },
  };
}

export async function evaluateMain(client, fn, arg) {
  const expression = `(${fn.toString()})(require('electron'), ${JSON.stringify(arg) ?? "undefined"})`;
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true,
  });
  if (response.exceptionDetails)
    throw new Error(
      "Native main evaluation failed; inspect the owned app log.",
    );
  return response.result?.value;
}

/**
 * Only recorded identities may be terminated, even if a PID was recycled.
 * With a graceful `quit`, wait for the app to exit on its own (as the
 * Playwright path's 20 s close does) so cookies and SQLite flush before any
 * signal; `quit` only queues app.quit(), so its resolving is not an exit.
 */
export async function stopNativeChild(
  child,
  rootStart,
  quit,
  graceMs = 20_000,
) {
  const owned = new Map();
  if (stillOurs(child.pid, rootStart))
    for (const pid of descendants(child.pid)) owned.set(pid, startTime(pid));
  const alive = () =>
    [...owned]
      .filter(([pid, start]) => stillOurs(pid, start))
      .map(([pid]) => pid);
  if (quit) {
    await Promise.race([quit().catch(() => {}), sleep(1500)]);
    const deadline = Date.now() + graceMs;
    while (alive().length && Date.now() < deadline) await sleep(100);
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of alive()) {
      try {
        process.kill(pid, signal);
      } catch {}
    }
    for (let i = 0; i < 20 && alive().length; i++) await sleep(50);
  }
  return alive();
}

export async function startNativeApp(
  launch,
  env,
  patchPath,
  { requireDesktop, cwd, onSpawn, log },
) {
  validateLaunchMode("native", launch);
  const { chromium } = requireDesktop("playwright");
  const WebSocket = requireDesktop("ws");
  const child = spawn(launch.electronPath, nativeArgs(launch, patchPath), {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rootStart = startTime(child.pid);
  if (child.pid) onSpawn(child, rootStart);
  let inspector;
  let ui;
  let closing;
  let stderr = "";
  const close = () =>
    (closing ??= (async () => {
      const survivors = await stopNativeChild(child, rootStart, async () => {
        if (inspector) {
          // Queue quit, then disconnect so Node cannot wait for the debugger.
          await evaluateMain(inspector, ({ app }) => {
            setImmediate(() => app.quit());
            return true;
          });
          inspector.close();
        }
      });
      inspector?.close();
      await ui?.close().catch(() => {});
      if (survivors.length) {
        const error = new Error(
          `Native app survivors: ${survivors.join(", ")}`,
        );
        error.survivors = survivors;
        throw error;
      }
      return survivors;
    })());
  try {
    if (child.pid && !rootStart) {
      child.kill(); // Our just-created handle; never search for an Electron PID.
      throw new Error(
        "Refusing: could not record native Electron start identity.",
      );
    }
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Owned native inspector did not start.")),
        15_000,
      );
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off("error", failed);
        child.off("exit", exited);
        error ? reject(error) : resolve(value);
      };
      const failed = () => finish(new Error("Native Electron spawn failed."));
      const exited = () =>
        finish(new Error("Native Electron exited before inspector readiness."));
      child.once("error", failed);
      child.once("exit", exited);
      child.stdout.on("data", log);
      child.stderr.on("data", (chunk) => {
        // Bound the readiness buffer; never put the inspector URL in evidence.
        stderr = (stderr + String(chunk)).slice(-16_384);
        log(
          String(chunk).replace(
            /ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/g,
            "[owned-inspector]",
          ),
        );
        const match =
          /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9-]+)/.exec(
            stderr,
          );
        if (match) finish(null, match[1]);
      });
    });
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("Native inspector connect timed out."));
      }, 10_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Native inspector connection failed."));
      });
    });
    inspector = inspectorClient(socket);
    const evaluate = (fn, arg) => evaluateMain(inspector, fn, arg);
    // The inspector starts before -r preloads and the app module. Its socket
    // being open does not establish that Electron's main API is ready yet.
    let mainAvailable = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await inspector.send("Runtime.evaluate", {
        expression:
          "(() => { try { return typeof require('electron').app?.whenReady === 'function'; } catch { return false; } })()",
        returnByValue: true,
        includeCommandLineAPI: true,
      });
      if (ready.result?.value === true) {
        mainAvailable = true;
        break;
      }
      await sleep(50);
    }
    if (!mainAvailable)
      throw new Error("Native main module did not become ready.");
    await evaluate(async ({ app }) => {
      await app.whenReady();
      return true;
    });
    const actual = await evaluate(({ app }) => app.getPath("userData"));
    if (path.resolve(actual) !== path.resolve(launch.userDataDir))
      throw new Error(
        "Refusing: native app userData differs from the private instance.",
      );
    // Wait for product readiness before exposing only its exact renderer target.
    const transport = await evaluate(installUiBridge, {
      bridgePath: launch.bridgePath,
      rendererUrl: pathToFileURL(
        path.join(launch.appDir, "out/renderer/index.html"),
      ).href,
    });
    if (transport?.error)
      throw new Error(
        `Native main UI window did not load (${transport.error}; windows: ${transport.windows.join(",") || "none"}).`,
      );
    ui = await chromium.connectOverCDP(transport.endpoint, {
      headers: transport.headers,
      noDefaults: true,
      timeout: 15_000,
    });
    const context = ui.contexts()[0];
    if (!context) throw new Error("Native UI bridge returned no context.");
    const unsupported = () => {
      throw new Error(
        "Native verification supports JSON main evaluate, UI pages and capturePage only; Electron handles/video are unavailable.",
      );
    };
    return {
      process: () => child,
      windows: () => context.pages(),
      context: () => context,
      evaluate,
      close,
      browserWindow: unsupported,
      evaluateHandle: unsupported,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      const failure = new AggregateError(
        [error, cleanup],
        "Native startup and owned cleanup failed.",
      );
      failure.survivors = cleanup.survivors ?? [];
      throw failure;
    }
    throw error;
  }
}

export function assertNativeIdentity(samples) {
  if (!samples.length)
    throw new Error(
      "Refusing: no embedded page for native identity precondition.",
    );
  for (const sample of samples) {
    if (
      sample.webdriver !== false ||
      sample.webdriverDescriptor?.own !== false ||
      sample.webdriverDescriptor?.getter !== true ||
      !sample.chromeShape ||
      !sample.userAgent.includes(`Chrome/${sample.chromeVersion}`) ||
      /Electron\/|Nestor\//i.test(sample.userAgent) ||
      (sample.brands &&
        !sample.brands.some((item) => item.brand === "Google Chrome"))
    )
      throw new Error(
        "Refusing: native embedded identity/webdriver precondition failed.",
      );
  }
  return samples;
}

/** Read-only on existing embedded pages; the driver creates a replica probe at start. */
export async function readNativeIdentity(app) {
  const samples = await app.evaluate(async ({ webContents, session }) => {
    const partition = session.fromPartition("persist:nestor-browser");
    const pages = webContents
      .getAllWebContents()
      .filter(
        (contents) =>
          !contents.isDestroyed() &&
          contents.session === partition &&
          /^https?:/.test(contents.getURL()),
      );
    return Promise.all(
      pages.map(async (contents) => ({
        contentsId: contents.id,
        chromeVersion: process.versions.chrome,
        ...(await contents.executeJavaScript(`(() => {
        const descriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
        return {
          webdriver: navigator.webdriver,
          userAgent: navigator.userAgent,
          brands: navigator.userAgentData?.brands ?? null,
          chromeShape: !!window.chrome && typeof window.chrome.app === 'object' &&
            typeof window.chrome.runtime === 'object' && typeof window.chrome.csi === 'function',
          webdriverDescriptor: { own: Object.hasOwn(navigator, 'webdriver'),
            getter: typeof descriptor?.get === 'function', configurable: descriptor?.configurable ?? null }
        };
      })()`)),
      })),
    );
  });
  return assertNativeIdentity(samples);
}
