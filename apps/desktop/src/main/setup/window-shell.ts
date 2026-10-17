import {
  app,
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  dialog,
  type Event as ElectronEvent,
  type Rectangle,
  screen,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopWindowControlsStateSchema } from "@nestor/contracts";
import {
  bindMainWindowStatePersistence,
  loadMainWindowState,
  restoreMainWindowBounds,
  type RestoredMainWindowBounds,
} from "./window-state";
import {
  applyMainWindowZoomCommand,
  bindMainWindowZoomShortcuts,
} from "./window-zoom";
import {
  bindMainWindowLifecycle,
  type MainWindowFailure,
  type MainWindowRecoveryChoice,
} from "./main-window-lifecycle";
import { resolveBrandIconPaths } from "./brand-icons";
import { getMainWindowCloseGuard } from "./main-window-close-guard";

const defaultMainWindowBounds = {
  width: 1440,
  height: 920,
} as const;

const startupWindowWidthEnvName = "NESTOR_STARTUP_WINDOW_WIDTH";
const startupWindowHeightEnvName = "NESTOR_STARTUP_WINDOW_HEIGHT";
const startupZoomFactorEnvName = "NESTOR_STARTUP_ZOOM_FACTOR";
const testerSessionGeometryEnvName = "NESTOR_TESTER_SESSION_GEOMETRY";

export const STARTUP_WINDOW_MIN_DIMENSION_PX = 400;
export const STARTUP_ZOOM_MIN_FACTOR = 1;
export const STARTUP_ZOOM_MAX_FACTOR = 5;

/**
 * Optional manifest-driven tester window request parsed from the process
 * environment. Absent keys keep the existing window behavior untouched;
 * present-but-invalid values fail closed instead of being ignored.
 */
export interface StartupWindowGeometryRequest {
  height?: number;
  width?: number;
  zoomFactor?: number;
}

export interface StartupWindowSize {
  height: number;
  width: number;
}

function invalidStartupInteger(name: string, rawValue: string): Error {
  return new Error(
    `Invalid ${name}: expected a positive integer, received ${JSON.stringify(rawValue)}.`,
  );
}

function readStartupDimensionEnv(
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined {
  const rawValue = env[name];
  if (rawValue === undefined) {
    return undefined;
  }

  // Canonical decimal digits only: signs, decimals, whitespace padding,
  // scientific notation, and empty values all fail closed instead of being
  // coerced into a different geometry than the one that was requested.
  if (!/^\d+$/u.test(rawValue)) {
    throw invalidStartupInteger(name, rawValue);
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw invalidStartupInteger(name, rawValue);
  }
  return parsed;
}

function readStartupZoomFactorEnv(env: NodeJS.ProcessEnv): number | undefined {
  const rawValue = env[startupZoomFactorEnvName];
  if (rawValue === undefined) {
    return undefined;
  }

  const rangeError = () =>
    new Error(
      `Invalid ${startupZoomFactorEnvName}: expected a finite number between ${STARTUP_ZOOM_MIN_FACTOR} and ${STARTUP_ZOOM_MAX_FACTOR}, received ${JSON.stringify(rawValue)}.`,
    );
  if (!/^\d+(?:\.\d+)?$/u.test(rawValue)) {
    throw rangeError();
  }
  const parsed = Number(rawValue);
  if (
    !Number.isFinite(parsed) ||
    parsed < STARTUP_ZOOM_MIN_FACTOR ||
    parsed > STARTUP_ZOOM_MAX_FACTOR
  ) {
    throw rangeError();
  }
  return parsed;
}

export function parseStartupWindowGeometryRequest(
  env: NodeJS.ProcessEnv,
): StartupWindowGeometryRequest | null {
  // The strict startup-geometry surface belongs to launcher-driven tester
  // sessions only. Without the explicit tester marker, ambient
  // NESTOR_STARTUP_* variables (for example from a developer's shell or a
  // .env file) are ignored entirely so normal startup behavior never changes.
  const marker = env[testerSessionGeometryEnvName];
  if (marker === undefined) {
    return null;
  }
  if (marker !== "1") {
    throw new Error(
      `Invalid ${testerSessionGeometryEnvName}: expected "1", received ${JSON.stringify(marker)}.`,
    );
  }
  const width = readStartupDimensionEnv(env, startupWindowWidthEnvName);
  const height = readStartupDimensionEnv(env, startupWindowHeightEnvName);
  const zoomFactor = readStartupZoomFactorEnv(env);
  if (width === undefined && height === undefined && zoomFactor === undefined) {
    throw new Error(
      `${testerSessionGeometryEnvName} is present but no startup geometry was requested; set ${startupWindowWidthEnvName} and ${startupWindowHeightEnvName} and/or ${startupZoomFactorEnvName}.`,
    );
  }
  if ((width === undefined) !== (height === undefined)) {
    throw new Error(
      `${startupWindowWidthEnvName} and ${startupWindowHeightEnvName} must be provided together.`,
    );
  }
  return {
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(zoomFactor === undefined ? {} : { zoomFactor }),
  };
}

/**
 * A tester session with an explicit geometry request forces normal display
 * mode: restored maximize/fullscreen would override the requested window size,
 * while normal launches keep their restore behavior untouched.
 */
export function suppressRestoredDisplayMode(
  request: StartupWindowGeometryRequest | null,
): boolean {
  return request !== null;
}

export function clampStartupWindowSize(
  requested: StartupWindowSize,
  workArea: Pick<Rectangle, "height" | "width">,
): StartupWindowSize {
  const clampDimension = (value: number, areaSize: number) =>
    Math.min(Math.max(value, STARTUP_WINDOW_MIN_DIMENSION_PX), areaSize);
  return {
    height: clampDimension(requested.height, workArea.height),
    width: clampDimension(requested.width, workArea.width),
  };
}

export function resolveStartupWindowSize(
  request: StartupWindowGeometryRequest | null,
  fallbackBounds: RestoredMainWindowBounds,
  workArea: Pick<Rectangle, "height" | "width">,
): RestoredMainWindowBounds {
  if (!request || request.width === undefined || request.height === undefined) {
    return fallbackBounds;
  }
  return clampStartupWindowSize(
    { height: request.height, width: request.width },
    workArea,
  );
}

interface StartupZoomWindowTarget {
  isDestroyed(): boolean;
  on(eventName: string, listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    on(eventName: string, listener: () => void): unknown;
    setZoomFactor(factor: number): void;
  };
}

/**
 * Enforces the requested startup zoom natively via webContents.setZoomFactor
 * (never CSS transforms or device-scale overrides) after the document is
 * ready. Chromium applies per-origin zoom at navigation commit time, so the
 * factor is asserted on first paint and re-asserted after every completed
 * main-frame load (bounded recovery reloads included). The zoom-shortcut
 * binder adopts this same requested factor as its owned value, so both
 * binders agree on did-finish-load and persisted host zoom from a reused
 * user-data root can never override the request.
 */
export function bindStartupWindowZoom(
  window: StartupZoomWindowTarget,
  zoomFactor: number,
): void {
  const applyStartupZoom = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.setZoomFactor(zoomFactor);
    }
  };

  window.on("ready-to-show", applyStartupZoom);
  window.webContents.on("did-finish-load", applyStartupZoom);
}

export const MAIN_WINDOW_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "frame-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "connect-src 'self' http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:* wss://localhost:* wss://127.0.0.1:* wss://[::1]:*",
].join("; ");

type RendererLoadTarget =
  | {
      kind: "dev";
      url: string;
      origin: string;
    }
  | {
      kind: "file";
      filePath: string;
      url: string;
    };

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (normalizedHostname === "localhost" || normalizedHostname === "::1") {
    return true;
  }

  const octets = normalizedHostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => {
      if (!/^\d+$/.test(octet)) {
        return false;
      }

      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

export function resolveTrustedRendererDevUrl(
  value: string | undefined,
): URL | null {
  const trimmedValue = value?.trim();
  if (!trimmedValue) {
    return null;
  }

  try {
    const url = new URL(trimmedValue);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !isLoopbackHostname(url.hostname) ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export function resolveRendererLoadTarget(
  currentDir: string,
  rendererUrl: string | undefined,
  isPackaged: boolean,
): RendererLoadTarget {
  const filePath = path.join(currentDir, "../renderer/index.html");
  const trustedRendererUrl = isPackaged
    ? null
    : resolveTrustedRendererDevUrl(rendererUrl);

  if (trustedRendererUrl) {
    return {
      kind: "dev",
      url: trustedRendererUrl.toString(),
      origin: trustedRendererUrl.origin,
    };
  }

  return {
    kind: "file",
    filePath,
    url: pathToFileURL(filePath).toString(),
  };
}

export function isAllowedRendererNavigation(
  url: string,
  target: RendererLoadTarget,
): boolean {
  try {
    const candidate = new URL(url);
    if (candidate.username || candidate.password) {
      return false;
    }

    if (target.kind === "dev") {
      return candidate.origin === target.origin;
    }

    const entry = new URL(target.url);
    return (
      candidate.protocol === "file:" &&
      candidate.pathname === entry.pathname &&
      candidate.search === ""
    );
  } catch {
    return false;
  }
}

export function bindMainWindowNavigationGuards(
  window: Pick<BrowserWindow, "webContents">,
  target: RendererLoadTarget,
) {
  const denyUnexpectedNavigation = (event: ElectronEvent<{ url: string }>) => {
    if (!isAllowedRendererNavigation(event.url, target)) {
      event.preventDefault();
    }
  };

  window.webContents.on("will-navigate", denyUnexpectedNavigation);
  window.webContents.on("will-redirect", denyUnexpectedNavigation);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function getWindowControlsState(window: BrowserWindow) {
  return DesktopWindowControlsStateSchema.parse({
    isFullScreen: window.isFullScreen(),
    isMaximized: window.isMaximized() || window.isFullScreen(),
    isMinimizable: window.isMinimizable(),
    isClosable: window.isClosable(),
  });
}

export function sendWindowControlsState(window: BrowserWindow) {
  if (window.isDestroyed()) {
    return;
  }

  window.webContents.send(
    "window:controls-state-changed",
    getWindowControlsState(window),
  );
}

function bindWindowControlsState(window: BrowserWindow) {
  const emitControlsState = () => sendWindowControlsState(window);

  window.on("maximize", emitControlsState);
  window.on("unmaximize", emitControlsState);
  window.on("enter-full-screen", emitControlsState);
  window.on("leave-full-screen", emitControlsState);
}

function getMainWindowFailureTitle(failure: MainWindowFailure): string {
  switch (failure.reason) {
    case "renderer-unresponsive":
      return "Nestor stopped responding";
    case "renderer-crashed":
      return "Nestor encountered a window error";
    case "startup-load-timeout":
      return "Nestor is taking too long to start";
    case "renderer-recovery-failed":
      return "Nestor could not recover the window";
    case "renderer-load-failed":
      return "Nestor could not load the window";
  }
}

async function showMainWindowRecoveryDialog(
  window: BrowserWindow,
  failure: MainWindowFailure,
  canRetry: boolean,
): Promise<MainWindowRecoveryChoice> {
  if (window.isDestroyed()) {
    return "quit";
  }

  const buttons = canRetry ? ["Retry window", "Quit"] : ["Quit"];
  const response = await dialog.showMessageBox(window, {
    type: "error",
    title: getMainWindowFailureTitle(failure),
    message: failure.detail,
    detail: canRetry
      ? "Retry reloads the main window once and may discard unsaved in-memory edits. Already-saved workspace data is kept. Choose Quit to close the app and start again later."
      : "No bounded recovery retry remains. Quit and start the app again to avoid an endless restart loop.",
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });

  return canRetry && response.response === 0 ? "retry" : "quit";
}

function recoverMainWindow(window: BrowserWindow, failure: MainWindowFailure) {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }

  if (failure.reason === "renderer-unresponsive") {
    try {
      window.webContents.forcefullyCrashRenderer();
    } catch {
      // A renderer that has already exited cannot be forcefully crashed again.
    }
  }

  window.webContents.reload();
}

export function buildMainWindowMenuTemplate(
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  return [
    ...(platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "editMenu" },
    {
      label: "View",
      // The keys themselves are handled by bindMainWindowZoomShortcuts; the
      // menu shows them and routes clicks through the same zoom steps.
      submenu: (
        [
          ["Zoom In", "CommandOrControl+=", "in"],
          ["Zoom Out", "CommandOrControl+-", "out"],
          ["Actual Size", "CommandOrControl+0", "reset"],
        ] as const
      ).map(([label, accelerator, command]) => ({
        label,
        accelerator,
        registerAccelerator: false,
        click: (_item, window) => {
          if (window instanceof BrowserWindow) {
            applyMainWindowZoomCommand(window.webContents, command);
          }
        },
      })),
    },
  ];
}

export function createMainWindow(currentDir: string) {
  // Fail closed before any window exists when the optional tester geometry
  // environment is invalid: createMainWindowSafely logs the error and quits
  // instead of launching with unpredictable window/zoom test conditions.
  const startupGeometry = parseStartupWindowGeometryRequest(process.env);
  const rendererTarget = resolveRendererLoadTarget(
    currentDir,
    process.env.ELECTRON_RENDERER_URL,
    app.isPackaged,
  );
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const savedState = loadMainWindowState();
  const restoredBounds = restoreMainWindowBounds(
    defaultMainWindowBounds,
    savedState,
  );
  const brandIcons = !isMac ? resolveBrandIconPaths(app.getAppPath()) : null;
  const mainWindow = new BrowserWindow({
    // Only an explicit geometry request consults the primary display work
    // area; without one, the existing bounds path is preserved untouched.
    ...(startupGeometry
      ? resolveStartupWindowSize(
          startupGeometry,
          restoredBounds,
          screen.getPrimaryDisplay().workArea,
        )
      : restoredBounds),
    minWidth: 1024,
    minHeight: 720,
    show: true,
    title: "Nestor",
    ...(brandIcons ? { icon: brandIcons.appIcon } : {}),
    backgroundColor: "#0e1726",
    autoHideMenuBar: true,
    frame: !(isMac || isWindows),
    ...(isMac ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: {
      preload: path.join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  bindWindowControlsState(mainWindow);
  if (startupGeometry?.zoomFactor !== undefined) {
    bindStartupWindowZoom(mainWindow, startupGeometry.zoomFactor);
  }
  bindMainWindowStatePersistence(mainWindow);
  // The shortcuts binder owns the window zoom factor for the whole session.
  // An explicit tester startup request is adopted as that owned factor so its
  // post-load reassertion (which beats persisted Chromium host zoom restored
  // at commit time on reused user-data roots) agrees with the startup binder
  // instead of clobbering the requested value on did-finish-load.
  bindMainWindowZoomShortcuts(mainWindow.webContents, process.platform, {
    initialZoomFactor:
      startupGeometry?.zoomFactor ?? savedState?.zoomFactor ?? 1,
  });
  bindMainWindowNavigationGuards(mainWindow, rendererTarget);
  const lifecycle = bindMainWindowLifecycle(mainWindow, {
    showRecoveryDialog: (failure, canRetry) =>
      showMainWindowRecoveryDialog(mainWindow, failure, canRetry),
    recover: (failure) => recoverMainWindow(mainWindow, failure),
    requestQuit: () => app.quit(),
    onFailure: (failure) => {
      console.warn("[Desktop] Main window lifecycle failure.", failure);
    },
  });
  mainWindow.on("closed", () => lifecycle.dispose());

  // App-owned close protection: while the renderer mirrors unsaved
  // Profile/setup/Resume Studio work, the native close is paused once and the
  // renderer's branded dialog decides between staying open and discarding.
  const closeGuard = getMainWindowCloseGuard();
  // Capture the exact webContents: outbound close requests must reach this
  // window's renderer only, never window-enumeration order.
  closeGuard.attachMainWindow(mainWindow.webContents);
  mainWindow.on("close", (event) => {
    closeGuard.handleWindowClose(event);
  });
  mainWindow.webContents.on("render-process-gone", () => {
    closeGuard.markRendererUnavailable();
  });
  // Any document (re)load — bounded recovery reloads and dev reloads
  // included — replaces the renderer context that granted a discard
  // approval, so an unconsumed approval must die before fresh dirty state.
  mainWindow.webContents.on("did-start-loading", () => {
    closeGuard.invalidateCloseApproval();
  });
  mainWindow.on("closed", () => {
    // The process-wide guard survives window recreation (macOS activate);
    // dropping renderer availability here only clears cached protection.
    closeGuard.markRendererUnavailable();
  });

  mainWindow.on("ready-to-show", () => {
    if (suppressRestoredDisplayMode(startupGeometry)) {
      // Tester determinism: restored maximize/fullscreen would override the
      // manifest-driven window size, so this launch stays in normal mode.
    } else if (
      savedState?.displayMode === "maximized" ||
      savedState?.displayMode === "fullscreen"
    ) {
      // A saved full-screen mode comes back as a maximized window, never as
      // native full screen. This fires on first paint, which in development
      // can be seconds after the window is already usable, so restoring full
      // screen here looked like a button click had taken over the screen.
      // Full screen is only ever entered by the user's own control.
      mainWindow.maximize();
    }

    mainWindow.show();
    sendWindowControlsState(mainWindow);
  });

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildMainWindowMenuTemplate()),
  );

  if (rendererTarget.kind === "dev") {
    void mainWindow.loadURL(rendererTarget.url).catch((error: unknown) => {
      lifecycle.reportLoadPromiseFailure(error);
    });
  } else {
    void mainWindow
      .loadFile(rendererTarget.filePath)
      .catch((error: unknown) => {
        lifecycle.reportLoadPromiseFailure(error);
      });
  }

  return mainWindow;
}
