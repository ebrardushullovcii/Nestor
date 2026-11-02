// Loaded into the verified Electron main process with `-r`, before the app.
// 1. Focus: windows show without activating and never stay on top, so the owner's
//    front app stays in front.
// 2. Native pickers and links: answered from files in the state folder, logged to evidence.
// 3. Send guard: every Electron session refuses requests to anywhere but loopback
//    (NESTOR_VERIFY_NET=replica), or refuses only non-GET requests to non-loopback
//    hosts (NESTOR_VERIFY_NET=web), so nothing can be sent to a real employer.
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");

const stateDir = process.env.NESTOR_VERIFY_STATE;
const evidenceDir = process.env.NESTOR_VERIFY_EVIDENCE;
const netMode = process.env.NESTOR_VERIFY_NET === "web" ? "web" : "replica";
const log = (file, entry) =>
  fs.appendFileSync(
    path.join(evidenceDir, file),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
  );

// --- 1. Focus -------------------------------------------------------------
const { app, BrowserWindow, dialog, shell, session, Menu } = electron;
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
    const remote =
      /^(https?|wss?):$/.test(url.protocol) && !LOOPBACK.has(url.hostname);
    const blocked =
      remote && (netMode === "replica" || !READS.has(details.method));
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
};
