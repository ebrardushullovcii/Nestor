// Loaded into the verified Electron main process with `-r`, before the app.
// 1. Focus: windows show without activating and never stay on top, so the owner's
//    front app stays in front.
// 2. Native pickers and links: answered from files in the state folder, logged to evidence.
// 3. Send guard: every Electron session refuses requests to anywhere but loopback
//    (NESTOR_VERIFY_NET=replica), or refuses only non-GET requests to non-loopback
//    hosts (NESTOR_VERIFY_NET=web). Explicitly authorized live mode allows writes;
//    the app's own permissions and Send rules still apply.
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");

const stateDir = process.env.NESTOR_VERIFY_STATE;
const evidenceDir = process.env.NESTOR_VERIFY_EVIDENCE;
const netMode = ["web", "live"].includes(process.env.NESTOR_VERIFY_NET)
  ? process.env.NESTOR_VERIFY_NET
  : "replica";
if (netMode === "live" && process.env.NESTOR_LIVE_APPLY_AUTHORIZED !== "1")
  throw new Error("Live network requires NESTOR_LIVE_APPLY_AUTHORIZED=1.");
const log = (file, entry) =>
  fs.appendFileSync(
    path.join(evidenceDir, file),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
  );

// --- 1. Focus -------------------------------------------------------------
const { app, BrowserWindow, dialog, shell, session, Menu, ipcMain } = electron;
// Permanent provenance: every mutating test API marks this data folder synthetic.
// Reading test metadata does not. The marker is written before invoking the seed.
const provenancePath = path.join(
  process.env.NESTOR_USER_DATA_DIR,
  "nestor-profile-provenance.json",
);
const readProvenance = () => {
  try {
    return JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  } catch {
    return { version: 1, kind: "unknown" };
  }
};
const assertLiveProfile = () => {
  if (netMode === "live" && readProvenance().kind === "synthetic")
    throw new Error(
      "Live network refused: profile was seeded through a synthetic/test API.",
    );
};
assertLiveProfile();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  handle(channel, async (...args) => {
    if (
      channel.startsWith("job-finder:test-") &&
      !channel.startsWith("job-finder:test-get-")
    ) {
      fs.writeFileSync(
        provenancePath,
        JSON.stringify(
          {
            ...readProvenance(),
            kind: "synthetic",
            seededAt: new Date().toISOString(),
            seedChannel: channel,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      assertLiveProfile();
    }
    return listener(...args);
  });
const {
  loadProviderFixture,
  installProviderTransport,
} = require("./provider-fixture.cjs");
const providerFixture = loadProviderFixture(
  process.env.NESTOR_VERIFY_PROVIDER_FIXTURE,
  {
    label: path.basename(stateDir),
    userDataDir: process.env.NESTOR_USER_DATA_DIR ?? "",
    testApi: process.env.NESTOR_ENABLE_TEST_API === "1",
    net: netMode,
  },
);
const providerSessions = new WeakSet();
let providerArmed = false;
installProviderTransport(providerFixture, () => providerArmed);

// Scoreboard setup stops its automatic search before measuring a fresh one.
// Hold only this instance's replica GETs until that setup is complete. Aborted
// reads are rejected immediately; no job rows are removed to reset the test.
const scoreboardReadsReleased = path.join(
  stateDir,
  "scoreboard-reads-released",
);
if (
  process.env.NESTOR_SCOREBOARD_HOLD_SETUP_READS === "1" &&
  !fs.existsSync(scoreboardReadsReleased)
) {
  const state = JSON.parse(
    fs.readFileSync(path.join(stateDir, "state.json"), "utf8"),
  );
  const fixtureOrigin = new URL(state.sitesUrl).origin;
  if (
    !["127.0.0.1", "localhost"].includes(new URL(fixtureOrigin).hostname) ||
    netMode !== "replica"
  )
    throw new Error(
      "Scoreboard read hold requires this instance's loopback replicas.",
    );
  const fetchPage = globalThis.fetch;
  const waiting = new Set();
  let held = true;
  globalThis.__nestorReleaseScoreboardReads = () => {
    fs.writeFileSync(scoreboardReadsReleased, "released\n", { mode: 0o600 });
    held = false;
    for (const release of [...waiting]) release();
  };
  globalThis.fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method =
      options?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      held &&
      url.origin === fixtureOrigin &&
      method.toUpperCase() === "GET"
    ) {
      const signal =
        options?.signal ??
        (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      await new Promise((resolve, reject) => {
        const detach = () => {
          waiting.delete(release);
          signal?.removeEventListener("abort", abort);
        };
        const release = () => {
          detach();
          resolve();
        };
        const abort = () => {
          detach();
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Stopped"),
          );
        };
        waiting.add(release);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    return fetchPage(input, options);
  };
}
// Unseen windows: macOS draws an accessory app's windows on the active Space,
// even over a full-screen app, so every window is fully transparent and
// click-through. Screenshots read the page with capturePage and Playwright
// input goes through CDP, so neither needs the window to be seen.
// NESTOR_VERIFY_WINDOWS=visible shows them again (still never focused).
const unseen = process.env.NESTOR_VERIFY_WINDOWS !== "visible";
const setOpacity = BrowserWindow.prototype.setOpacity;
const setIgnoreMouseEvents = BrowserWindow.prototype.setIgnoreMouseEvents;
const hideFromScreen = (win) => {
  if (!unseen) return;
  setOpacity.call(win, 0);
  setIgnoreMouseEvents.call(win, true);
};
// Electron recognises its windows by `constructor.name === "BrowserWindow"`, so the name stays.
const QuietWindow = class BrowserWindow extends electron.BrowserWindow {
  constructor(options = {}) {
    const wantsShow = options.show !== false;
    // No always-on-top: Live Assistant popups would otherwise float over the owner's apps.
    super({ ...options, show: false, alwaysOnTop: false });
    hideFromScreen(this);
    if (wantsShow) this.showInactive();
  }
};
BrowserWindow.prototype.show = function show() {
  hideFromScreen(this);
  this.showInactive();
};
if (unseen) {
  // The app may fade or un-ignore its own windows; keep them unseen.
  BrowserWindow.prototype.setOpacity = function () {};
  BrowserWindow.prototype.setIgnoreMouseEvents = function () {};
}
// Native menus, system notifications and menu-bar icons would appear on the
// owner's screen; log them instead.
Menu.prototype.popup = function popup() {
  log("opened.jsonl", { kind: "menu.popup" });
};
class QuietNotification {
  constructor(options = {}) {
    this.options = options;
  }
  static isSupported() {
    return true;
  }
  show() {
    log("opened.jsonl", {
      kind: "notification",
      title: this.options.title ?? null,
    });
  }
  close() {}
  on() {
    return this;
  }
  once() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
}
class QuietTray {
  constructor() {
    log("opened.jsonl", { kind: "tray" });
  }
  setToolTip() {}
  setContextMenu() {}
  setImage() {}
  setTitle() {}
  on() {
    return this;
  }
  destroy() {}
  isDestroyed() {
    return false;
  }
}
BrowserWindow.prototype.focus = function focus() {};
BrowserWindow.prototype.moveTop = function moveTop() {};
BrowserWindow.prototype.setAlwaysOnTop = function setAlwaysOnTop() {};
app.focus = () => {};
if (app.dock) {
  app.dock.show = async () => {};
  app.dock.bounce = () => 0;
}
const quietPolicy = () =>
  process.platform === "darwin" && app.setActivationPolicy("accessory");
app.on("will-finish-launching", quietPolicy);
app.on("ready", quietPolicy);
// `import { BrowserWindow } from "electron"` resolves through require; hand out the quiet class.
const patched = new Proxy(electron, {
  get: (target, key) =>
    key === "BrowserWindow"
      ? QuietWindow
      : key === "Notification"
        ? QuietNotification
        : key === "Tray"
          ? QuietTray
          : Reflect.get(target, key),
});
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === "electron") return patched;
  return originalLoad.call(this, request, ...rest);
};

// --- 2. Pickers and links -------------------------------------------------
const nextOpen = () => {
  const file = path.join(stateDir, "next-open.txt");
  const paths = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  fs.rmSync(file, { force: true });
  return paths;
};
dialog.showOpenDialog = async (...args) => {
  const filePaths = nextOpen();
  const options =
    args.find(
      (a) => a && typeof a === "object" && !(a instanceof BrowserWindow),
    ) ?? {};
  log("dialogs.jsonl", {
    kind: "open",
    title: options.title ?? null,
    returned: filePaths,
  });
  return { canceled: filePaths.length === 0, filePaths };
};
dialog.showOpenDialogSync = () => {
  const filePaths = nextOpen();
  log("dialogs.jsonl", { kind: "open-sync", returned: filePaths });
  return filePaths.length ? filePaths : undefined;
};
const exportsDir = path.join(evidenceDir, "exports");
const savePath = (options) => {
  fs.mkdirSync(exportsDir, { recursive: true });
  return path.join(
    exportsDir,
    path.basename((options && options.defaultPath) || `export-${Date.now()}`),
  );
};
dialog.showSaveDialog = async (...args) => {
  const options =
    args.find(
      (a) => a && typeof a === "object" && !(a instanceof BrowserWindow),
    ) ?? {};
  const filePath = savePath(options);
  log("dialogs.jsonl", { kind: "save", returned: filePath });
  return { canceled: false, filePath };
};
dialog.showSaveDialogSync = (...args) =>
  savePath(
    args.find(
      (a) => a && typeof a === "object" && !(a instanceof BrowserWindow),
    ),
  );
dialog.showMessageBox = async (...args) => {
  const options =
    args.find(
      (a) => a && typeof a === "object" && !(a instanceof BrowserWindow),
    ) ?? {};
  const response = options.defaultId ?? 0;
  log("dialogs.jsonl", {
    kind: "message",
    message: options.message,
    buttons: options.buttons,
    response,
  });
  return { response, checkboxChecked: false };
};
shell.openExternal = async (url) =>
  log("opened.jsonl", { kind: "openExternal", url });
shell.openPath = async (target) => (
  log("opened.jsonl", { kind: "openPath", target }),
  ""
);
shell.showItemInFolder = (target) =>
  log("opened.jsonl", { kind: "showItemInFolder", target });

// --- 3. Send guard --------------------------------------------------------
const LOOPBACK = new Set([
  "localhost",
  "[::1]",
  "::1",
  ...Array.from({ length: 12 }, (_, index) => `127.0.0.${index + 1}`),
]);
const READS = new Set(["GET", "HEAD", "OPTIONS"]);
const guarded = new WeakSet();
function guard(ses) {
  if (!ses || guarded.has(ses)) return;
  guarded.add(ses);
  ses.webRequest.onBeforeRequest((details, callback) => {
    let url;
    try {
      url = new URL(details.url);
    } catch {
      return callback({});
    }
    const provider =
      providerFixture && url.origin === "https://" + providerFixture.host;
    const probe =
      provider &&
      details.method === "GET" &&
      url.pathname === "/__nestor_probe/" + providerFixture.nonce;
    const synthetic = provider && (probe || providerSessions.has(ses));
    const remote =
      /^(https?|wss?):$/.test(url.protocol) && !LOOPBACK.has(url.hostname);
    const syntheticLive =
      netMode === "live" && readProvenance().kind === "synthetic";
    const blocked =
      (remote && syntheticLive && !READS.has(details.method)) ||
      (remote &&
        !synthetic &&
        netMode !== "live" &&
        (netMode === "replica" || !READS.has(details.method)));
    if (blocked)
      log("blocked-requests.jsonl", {
        method: details.method,
        origin: url.origin,
        path: url.pathname,
        type: details.resourceType,
        mode: netMode,
      });
    callback(blocked ? { cancel: true } : {});
  });
}
app.on("session-created", guard);
app.on("ready", () => {
  guard(session.defaultSession);
  guard(session.fromPartition("persist:nestor-browser"));
});
globalThis.__nestorVerify = {
  netMode,
  guardInstalled: (ses) => guarded.has(ses),
  armProviderFixture: async (id, nonce) => {
    if (!providerFixture || nonce !== providerFixture.nonce)
      throw new Error("Synthetic provider arm refused.");
    const contents = electron.webContents.fromId(id);
    if (
      !contents ||
      contents.isDestroyed() ||
      contents.session !== session.fromPartition("persist:nestor-browser") ||
      contents.getURL() !==
        "https://" + providerFixture.host + "/__nestor_probe/" + nonce
    )
      throw new Error(
        "Synthetic provider probe is not in this run browser session.",
      );
    const actual = await contents.executeJavaScript(
      "document.body.textContent.trim()",
    );
    if (actual !== nonce)
      throw new Error("Synthetic provider mapping nonce did not match.");
    providerSessions.add(contents.session);
    providerArmed = true;
    log("provider-mapping.jsonl", {
      host: providerFixture.host,
      port: providerFixture.port,
      spki: providerFixture.spki,
      webContentsId: id,
      nonceVerified: true,
    });
    return { host: providerFixture.host, nonceVerified: true };
  },
};
