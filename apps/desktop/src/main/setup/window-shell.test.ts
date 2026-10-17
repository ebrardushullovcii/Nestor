import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  MAIN_WINDOW_CONTENT_SECURITY_POLICY,
  buildMainWindowMenuTemplate,
  STARTUP_ZOOM_MAX_FACTOR,
  STARTUP_ZOOM_MIN_FACTOR,
  STARTUP_WINDOW_MIN_DIMENSION_PX,
  bindMainWindowNavigationGuards,
  bindStartupWindowZoom,
  clampStartupWindowSize,
  createMainWindow,
  getWindowControlsState,
  isAllowedRendererNavigation,
  parseStartupWindowGeometryRequest,
  resolveRendererLoadTarget,
  resolveStartupWindowSize,
  resolveTrustedRendererDevUrl,
  suppressRestoredDisplayMode,
} from "./window-shell";

function createControlsWindow(input: {
  isFullScreen: boolean;
  isMaximized: boolean;
}): Parameters<typeof getWindowControlsState>[0] {
  return {
    isClosable: () => true,
    isFullScreen: () => input.isFullScreen,
    isMaximized: () => input.isMaximized,
    isMinimizable: () => true,
  } as unknown as Parameters<typeof getWindowControlsState>[0];
}

describe("desktop window controls state", () => {
  test("distinguishes native fullscreen from a maximized window", () => {
    expect(
      getWindowControlsState(
        createControlsWindow({ isFullScreen: false, isMaximized: true }),
      ),
    ).toEqual({
      isClosable: true,
      isFullScreen: false,
      isMaximized: true,
      isMinimizable: true,
    });

    expect(
      getWindowControlsState(
        createControlsWindow({ isFullScreen: true, isMaximized: false }),
      ),
    ).toEqual({
      isClosable: true,
      isFullScreen: true,
      isMaximized: true,
      isMinimizable: true,
    });
  });
});

// Recording electron mock so the REAL createMainWindow wiring can be exercised:
// every window/webContents listener registration is captured in call order, so
// a reorder of the zoom binders inside createMainWindow fails these tests.
interface RecordedMainWindow {
  currentZoomFactor(): number;
  emitWebContents(eventName: string, ...args: unknown[]): void;
  emitWindow(eventName: string, ...args: unknown[]): void;
  loadedFiles: string[];
  simulateCommitTimeHostZoom(factor: number): void;
  webContentsEventListeners: Map<string, Array<(...args: unknown[]) => void>>;
  zoomWrites: number[];
}

const electronMock = vi.hoisted(() => {
  interface FakeRegistration {
    event: string;
    listener: (...args: unknown[]) => void;
    target: "window" | "webContents";
  }

  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1080 },
  };

  const controller = {
    instances: [] as RecordedMainWindow[],
    registrations: [] as FakeRegistration[],
    reset(): void {
      this.instances = [];
      this.registrations = [];
    },
  };

  function registerListener(
    instanceListeners: Map<string, Array<(...args: unknown[]) => void>>,
    target: "window" | "webContents",
    eventName: string,
    listener: (...args: unknown[]) => void,
  ): void {
    const registered = instanceListeners.get(eventName) ?? [];
    registered.push(listener);
    instanceListeners.set(eventName, registered);
    controller.registrations.push({ event: eventName, listener, target });
  }

  function createWindow(options: unknown): Record<string, unknown> {
    void options;
    const windowEventListeners = new Map<
      string,
      Array<(...args: unknown[]) => void>
    >();
    const webContentsEventListeners = new Map<
      string,
      Array<(...args: unknown[]) => void>
    >();
    let zoomFactor = 1;
    const zoomWrites: number[] = [];
    const instance: RecordedMainWindow = {
      currentZoomFactor: () => zoomFactor,
      emitWebContents(eventName: string, ...args: unknown[]) {
        for (const listener of [
          ...(webContentsEventListeners.get(eventName) ?? []),
        ]) {
          listener(...args);
        }
      },
      emitWindow(eventName: string, ...args: unknown[]) {
        for (const listener of [
          ...(windowEventListeners.get(eventName) ?? []),
        ]) {
          listener(...args);
        }
      },
      loadedFiles: [],
      simulateCommitTimeHostZoom(factor: number): void {
        // Chromium restores persisted per-origin zoom at navigation-commit
        // time; nothing in the app caused this write and nothing records it.
        zoomFactor = factor;
      },
      webContentsEventListeners,
      zoomWrites,
    };
    controller.instances.push(instance);

    const webContents = {
      getZoomFactor: () => zoomFactor,
      id: 4242,
      isDestroyed: () => false,
      on: (eventName: string, listener: (...args: unknown[]) => void) =>
        registerListener(
          webContentsEventListeners,
          "webContents",
          eventName,
          listener,
        ),
      removeListener: (
        eventName: string,
        listener: (...args: unknown[]) => void,
      ) => {
        const registered = webContentsEventListeners.get(eventName) ?? [];
        const index = registered.indexOf(listener);
        if (index >= 0) registered.splice(index, 1);
      },
      send: (channel: string, payload?: unknown) => {
        void channel;
        void payload;
      },
      setWindowOpenHandler: () => ({ action: "deny" as const }),
      setZoomFactor: (factor: number) => {
        zoomFactor = factor;
        zoomWrites.push(factor);
      },
    };

    return {
      getBounds: () => ({ x: 10, y: 20, height: 920, width: 1440 }),
      isClosable: () => true,
      isMinimizable: () => true,
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMaximized: () => false,
      loadFile: (filePath: string) => {
        instance.loadedFiles.push(filePath);
        return Promise.resolve();
      },
      loadURL: (url: string) => {
        void url;
        return Promise.resolve();
      },
      on: (eventName: string, listener: (...args: unknown[]) => void) =>
        registerListener(windowEventListeners, "window", eventName, listener),
      removeMenu: () => {},
      show: () => {},
      webContents,
    };
  }

  return { controller, createWindow, display };
});

vi.mock("electron", () => ({
  BrowserWindow: function FakeBrowserWindow(options: unknown) {
    return electronMock.createWindow(options);
  },
  app: {
    getPath: () => "/fake-nestor-user-data",
    getAppPath: () => "/fake-nestor-app",
    isPackaged: false,
  },
  dialog: {},
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
  },
  screen: {
    getAllDisplays: () => [electronMock.display],
    getPrimaryDisplay: () => electronMock.display,
  },
}));

describe("main renderer security policy", () => {
  test.each([
    "http://localhost:5173",
    "https://localhost:5173/app",
    "http://127.0.0.1:4173",
    "http://127.0.0.42:4173",
    "http://[::1]:5173",
  ])("accepts loopback dev URL %s", (value) => {
    expect(resolveTrustedRendererDevUrl(value)?.toString()).toBe(
      new URL(value).toString(),
    );
  });

  test.each([
    undefined,
    "",
    "javascript:alert(document.domain)",
    "file:///tmp/renderer/index.html",
    "https://renderer.example.test",
    "http://localhost.evil.test:5173",
    "http://user:password@127.0.0.1:5173",
    "not a URL",
  ])("rejects an untrusted dev URL %s", (value) => {
    expect(resolveTrustedRendererDevUrl(value)).toBeNull();
  });

  test("uses the packaged file entry even when a dev URL is present", () => {
    expect(
      resolveRendererLoadTarget(
        "D:/app/out/main",
        "http://127.0.0.1:5173",
        true,
      ),
    ).toMatchObject({
      kind: "file",
      filePath: path.join("D:/app/out/main", "../renderer/index.html"),
    });
  });

  test("uses a trusted loopback URL during local development", () => {
    expect(
      resolveRendererLoadTarget(
        "D:/app/out/main",
        "http://127.0.0.1:5173",
        false,
      ),
    ).toEqual({
      kind: "dev",
      url: "http://127.0.0.1:5173/",
      origin: "http://127.0.0.1:5173",
    });
  });

  test("allows only the trusted dev origin and the packaged file entry", () => {
    const devTarget = resolveRendererLoadTarget(
      "D:/app/out/main",
      "http://127.0.0.1:5173",
      false,
    );
    expect(
      isAllowedRendererNavigation(
        "http://127.0.0.1:5173/#/job-finder/profile",
        devTarget,
      ),
    ).toBe(true);
    expect(
      isAllowedRendererNavigation("https://example.test/phishing", devTarget),
    ).toBe(false);
    expect(
      isAllowedRendererNavigation(
        'javascript:window.location="https://example.test"',
        devTarget,
      ),
    ).toBe(false);

    const fileTarget = resolveRendererLoadTarget(
      "D:/app/out/main",
      undefined,
      true,
    );
    expect(
      isAllowedRendererNavigation(
        `${fileTarget.url}#/job-finder/profile`,
        fileTarget,
      ),
    ).toBe(true);
    expect(
      isAllowedRendererNavigation("file:///D:/other/index.html", fileTarget),
    ).toBe(false);
  });

  test("prevents external redirects and all new windows", () => {
    const listeners = new Map<
      string,
      (event: { url: string; preventDefault: () => void }) => void
    >();
    const setWindowOpenHandler = vi.fn();
    const webContents = {
      on: vi.fn(
        (
          eventName: string,
          listener: (event: {
            url: string;
            preventDefault: () => void;
          }) => void,
        ) => {
          listeners.set(eventName, listener);
        },
      ),
      setWindowOpenHandler,
    };
    const target = resolveRendererLoadTarget(
      "D:/app/out/main",
      "http://127.0.0.1:5173",
      false,
    );

    bindMainWindowNavigationGuards({ webContents } as never, target);

    expect(webContents.on).toHaveBeenCalledWith(
      "will-navigate",
      expect.any(Function),
    );
    expect(webContents.on).toHaveBeenCalledWith(
      "will-redirect",
      expect.any(Function),
    );
    expect(setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));

    const preventDefault = vi.fn();
    listeners.get("will-navigate")?.({
      url: "https://example.test/phishing",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledTimes(1);

    const allowPreventDefault = vi.fn();
    listeners.get("will-redirect")?.({
      url: "http://127.0.0.1:5173/#/job-finder/profile",
      preventDefault: allowPreventDefault,
    });
    expect(allowPreventDefault).not.toHaveBeenCalled();

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0] as () => {
      action: string;
    };
    expect(openHandler()).toEqual({ action: "deny" });
  });

  test("keeps scripts and fonts same-origin while allowing dev HMR hosts", () => {
    expect(MAIN_WINDOW_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(MAIN_WINDOW_CONTENT_SECURITY_POLICY).not.toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(MAIN_WINDOW_CONTENT_SECURITY_POLICY).toContain("font-src 'self'");
    expect(MAIN_WINDOW_CONTENT_SECURITY_POLICY).not.toContain(
      "fonts.googleapis.com",
    );
    expect(MAIN_WINDOW_CONTENT_SECURITY_POLICY).not.toContain(
      "fonts.gstatic.com",
    );
    expect(MAIN_WINDOW_CONTENT_SECURITY_POLICY).toContain("ws://localhost:*");
  });

  test("declares the CSP in the renderer entry document", () => {
    const rendererHtml = readFileSync(
      new URL("../../renderer/index.html", import.meta.url),
      "utf8",
    );

    expect(rendererHtml).toMatch(
      /<meta\s+http-equiv="Content-Security-Policy"/,
    );
    expect(rendererHtml).toContain("script-src 'self'");
    expect(rendererHtml).toContain("object-src 'none'");
    expect(rendererHtml).toContain("font-src 'self'");
    expect(rendererHtml).not.toContain("fonts.googleapis.com");
    expect(rendererHtml).not.toContain("fonts.gstatic.com");
  });
});

describe("startup window geometry", () => {
  const widthEnvName = "NESTOR_STARTUP_WINDOW_WIDTH";
  const heightEnvName = "NESTOR_STARTUP_WINDOW_HEIGHT";
  const zoomEnvName = "NESTOR_STARTUP_ZOOM_FACTOR";
  const markerEnvName = "NESTOR_TESTER_SESSION_GEOMETRY";

  function createStartupZoomHarness() {
    const windowListeners = new Map<string, Array<() => void>>();
    const webContentsListeners = new Map<string, Array<() => void>>();
    let windowDestroyed = false;
    let webContentsDestroyed = false;
    const setZoomFactor = vi.fn();
    const window = {
      isDestroyed: () => windowDestroyed,
      on: vi.fn((eventName: string, listener: () => void) => {
        const listeners = windowListeners.get(eventName) ?? [];
        listeners.push(listener);
        windowListeners.set(eventName, listeners);
      }),
      webContents: {
        isDestroyed: () => webContentsDestroyed,
        on: vi.fn((eventName: string, listener: () => void) => {
          const listeners = webContentsListeners.get(eventName) ?? [];
          listeners.push(listener);
          webContentsListeners.set(eventName, listeners);
        }),
        setZoomFactor,
      },
    };
    return {
      destroyWebContents() {
        webContentsDestroyed = true;
      },
      destroyWindow() {
        windowDestroyed = true;
      },
      emit(eventName: string) {
        for (const listener of windowListeners.get(eventName) ?? []) {
          listener();
        }
      },
      setZoomFactor,
      webContentsEmit(eventName: string) {
        for (const listener of webContentsListeners.get(eventName) ?? []) {
          listener();
        }
      },
      window,
    };
  }

  test("requests nothing when the startup environment is absent", () => {
    expect(parseStartupWindowGeometryRequest({})).toBeNull();
    expect(
      parseStartupWindowGeometryRequest({ NESTOR_USER_DATA_DIR: "/x" }),
    ).toBeNull();
  });

  test("ignores stray ambient startup variables without the tester marker", () => {
    // Normal .env/default startup behavior must be unaffected by ambient
    // NESTOR_STARTUP_* values that leak from a developer shell.
    expect(
      parseStartupWindowGeometryRequest({
        [heightEnvName]: "800",
        [widthEnvName]: "1280",
        [zoomEnvName]: "2",
      }),
    ).toBeNull();
    expect(
      parseStartupWindowGeometryRequest({
        [heightEnvName]: "not-a-number",
        [widthEnvName]: "-1",
      }),
    ).toBeNull();
  });

  test("parses an explicit complete request under the tester marker", () => {
    expect(
      parseStartupWindowGeometryRequest({
        [markerEnvName]: "1",
        [heightEnvName]: "800",
        [widthEnvName]: "1280",
        [zoomEnvName]: "2.5",
      }),
    ).toEqual({ height: 800, width: 1280, zoomFactor: 2.5 });
    expect(STARTUP_WINDOW_MIN_DIMENSION_PX).toBe(400);
    expect(STARTUP_ZOOM_MIN_FACTOR).toBe(1);
    expect(STARTUP_ZOOM_MAX_FACTOR).toBe(5);
  });

  test("fails clearly on a bad or geometry-less tester marker", () => {
    expect(() =>
      parseStartupWindowGeometryRequest({ [markerEnvName]: "true" }),
    ).toThrow(new RegExp(`Invalid ${markerEnvName}`, "u"));
    expect(() =>
      parseStartupWindowGeometryRequest({ [markerEnvName]: "" }),
    ).toThrow(new RegExp(`Invalid ${markerEnvName}`, "u"));
    expect(() =>
      parseStartupWindowGeometryRequest({ [markerEnvName]: "1" }),
    ).toThrow(new RegExp(`${markerEnvName}.*no startup geometry`, "u"));
  });

  test.each([
    "",
    "0",
    "-1280",
    "+1280",
    "12.5",
    "1280px",
    " 1280",
    "1280 ",
    "0x500",
    "1e3",
    "999999999999999999999",
  ])("fails closed on invalid window dimension %j", (value) => {
    expect(() =>
      parseStartupWindowGeometryRequest({
        [markerEnvName]: "1",
        [widthEnvName]: value,
      }),
    ).toThrow(new RegExp(`Invalid ${widthEnvName}`, "u"));
    expect(() =>
      parseStartupWindowGeometryRequest({
        [markerEnvName]: "1",
        [heightEnvName]: value,
      }),
    ).toThrow(new RegExp(`Invalid ${heightEnvName}`, "u"));
  });

  test("requires window width and height to be provided together", () => {
    expect(() =>
      parseStartupWindowGeometryRequest({
        [markerEnvName]: "1",
        [widthEnvName]: "1280",
      }),
    ).toThrow(/must be provided together/u);
    expect(() =>
      parseStartupWindowGeometryRequest({
        [markerEnvName]: "1",
        [heightEnvName]: "800",
      }),
    ).toThrow(/must be provided together/u);
  });

  test.each(["1", "2", "5", "2.5"])(
    "accepts in-range zoom factor %s",
    (value) => {
      expect(
        parseStartupWindowGeometryRequest({
          [markerEnvName]: "1",
          [zoomEnvName]: value,
        })?.zoomFactor,
      ).toBe(Number(value));
    },
  );

  test.each([
    "",
    "0",
    "0.99",
    "5.01",
    "-2",
    "abc",
    " 2",
    "2 ",
    "1e1",
    "Infinity",
    "NaN",
  ])("fails closed on invalid zoom factor %j", (value) => {
    expect(() =>
      parseStartupWindowGeometryRequest({
        [markerEnvName]: "1",
        [zoomEnvName]: value,
      }),
    ).toThrow(new RegExp(`Invalid ${zoomEnvName}`, "u"));
  });

  test("clamps requested size to at least 400px and the work area", () => {
    expect(
      clampStartupWindowSize(
        { height: 200, width: 300 },
        {
          height: 1080,
          width: 1920,
        },
      ),
    ).toEqual({ height: STARTUP_WINDOW_MIN_DIMENSION_PX, width: 400 });
    expect(
      clampStartupWindowSize(
        { height: 1500, width: 5000 },
        {
          height: 1080,
          width: 1920,
        },
      ),
    ).toEqual({ height: 1080, width: 1920 });
    expect(
      clampStartupWindowSize(
        { height: 800, width: 1280 },
        {
          height: 1080,
          width: 1920,
        },
      ),
    ).toEqual({ height: 800, width: 1280 });
  });

  test("keeps restored bounds untouched when no geometry was requested", () => {
    const fallback = { x: 12, y: 34, width: 1000, height: 700 };
    expect(
      resolveStartupWindowSize(null, fallback, {
        height: 1080,
        width: 1920,
      }),
    ).toEqual(fallback);
    expect(
      resolveStartupWindowSize({}, fallback, { height: 1080, width: 1920 }),
    ).toEqual(fallback);
  });

  test("replaces restored bounds with clamped geometry when requested", () => {
    expect(
      resolveStartupWindowSize(
        { height: 9000, width: 640 },
        { x: 12, y: 34, width: 1440, height: 920 },
        { height: 1000, width: 1500 },
      ),
    ).toEqual({ height: 1000, width: 640 });
  });

  test("applies native zoom only after ready and completed main-frame loads", () => {
    const harness = createStartupZoomHarness();

    bindStartupWindowZoom(harness.window as never, 2);
    expect(harness.setZoomFactor).not.toHaveBeenCalled();
    expect(harness.window.on).toHaveBeenCalledWith(
      "ready-to-show",
      expect.any(Function),
    );
    expect(harness.window.webContents.on).toHaveBeenCalledWith(
      "did-finish-load",
      expect.any(Function),
    );

    harness.emit("ready-to-show");
    expect(harness.setZoomFactor).toHaveBeenCalledTimes(1);
    expect(harness.setZoomFactor).toHaveBeenNthCalledWith(1, 2);

    harness.webContentsEmit("did-finish-load");
    expect(harness.setZoomFactor).toHaveBeenNthCalledWith(2, 2);
  });

  test("skips native zoom application once Electron destroyed the target", () => {
    const destroyedWindowHarness = createStartupZoomHarness();
    bindStartupWindowZoom(destroyedWindowHarness.window as never, 2);
    destroyedWindowHarness.destroyWindow();
    destroyedWindowHarness.emit("ready-to-show");
    expect(destroyedWindowHarness.setZoomFactor).not.toHaveBeenCalled();

    const destroyedContentsHarness = createStartupZoomHarness();
    bindStartupWindowZoom(destroyedContentsHarness.window as never, 2);
    destroyedContentsHarness.destroyWebContents();
    destroyedContentsHarness.webContentsEmit("did-finish-load");
    expect(destroyedContentsHarness.setZoomFactor).not.toHaveBeenCalled();
  });

  test("suppresses restored display mode only under an explicit request", () => {
    expect(suppressRestoredDisplayMode(null)).toBe(false);
    expect(suppressRestoredDisplayMode({ zoomFactor: 2 })).toBe(true);
    expect(suppressRestoredDisplayMode({ height: 800, width: 1280 })).toBe(
      true,
    );
  });

  test("keeps restored bounds for a zoom-only tester request", () => {
    const fallback = { x: 40, y: 50, width: 1440, height: 920 };
    expect(
      resolveStartupWindowSize(
        parseStartupWindowGeometryRequest({
          [markerEnvName]: "1",
          [zoomEnvName]: "2",
        }),
        fallback,
        { height: 1080, width: 1920 },
      ),
    ).toEqual(fallback);
  });
});

describe("createMainWindow zoom wiring order", () => {
  const geometryEnvironmentNames = [
    "ELECTRON_RENDERER_URL",
    "NESTOR_STARTUP_WINDOW_HEIGHT",
    "NESTOR_STARTUP_WINDOW_WIDTH",
    "NESTOR_STARTUP_ZOOM_FACTOR",
    "NESTOR_TESTER_SESSION_GEOMETRY",
    "NESTOR_USER_DATA_DIR",
  ];
  let savedEnvironment: Array<[string, string | undefined]>;

  beforeEach(() => {
    electronMock.controller.reset();
    savedEnvironment = geometryEnvironmentNames.map((name) => [
      name,
      process.env[name],
    ]);
    for (const name of geometryEnvironmentNames) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of savedEnvironment) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    // Settle lifecycle timers exactly like an app quit would.
    for (const instance of electronMock.controller.instances) {
      instance.emitWindow("closed");
    }
  });

  function createWiredMainWindow(): RecordedMainWindow {
    createMainWindow("/fake-app-main");
    const instance = electronMock.controller.instances.at(-1);
    if (!instance) {
      throw new Error("createMainWindow did not construct a BrowserWindow.");
    }
    return instance;
  }

  function registeredWebContentsListeners(
    eventName: string,
  ): Array<(...args: unknown[]) => void> {
    return electronMock.controller.registrations
      .filter(
        (registration) =>
          registration.target === "webContents" &&
          registration.event === eventName,
      )
      .map((registration) => registration.listener);
  }

  function dispatchZoomIn(instance: RecordedMainWindow): void {
    // createMainWindow passes process.platform, so the accelerator is Command
    // on macOS and Control everywhere else; sending the wrong one makes the
    // binder ignore the key and the zoom never moves. The shortcut binder
    // prevents default Chromium handling either way.
    const usesCommand = process.platform === "darwin";
    instance.emitWebContents(
      "before-input-event",
      { preventDefault: () => {} },
      {
        alt: false,
        code: "Equal",
        control: !usesCommand,
        isComposing: false,
        key: "=",
        meta: usesCommand,
        type: "keyDown",
      },
    );
  }

  test("pins registration order: startup request writer first, owned-session writer last", () => {
    process.env.NESTOR_TESTER_SESSION_GEOMETRY = "1";
    process.env.NESTOR_STARTUP_ZOOM_FACTOR = "1.25";
    const instance = createWiredMainWindow();

    // Real wiring adopted the parsed request as the owned factor and wrote it
    // pre-load through bindMainWindowZoomShortcuts.
    expect(instance.zoomWrites).toEqual([1.25]);

    // Three did-finish-load writers register in creation order: the startup
    // zoom binder, the zoom-shortcut binder, then lifecycle bookkeeping.
    const finishLoadListeners =
      registeredWebContentsListeners("did-finish-load");
    expect(finishLoadListeners).toHaveLength(3);

    const readyToShowListeners = electronMock.controller.registrations
      .filter(
        (registration) =>
          registration.target === "window" &&
          registration.event === "ready-to-show",
      )
      .map((registration) => registration.listener);
    expect(readyToShowListeners).toHaveLength(2);

    // First paint and first load land on native 1.25 with no other writes.
    readyToShowListeners[0]?.();
    expect(instance.currentZoomFactor()).toBe(1.25);
    for (const listener of finishLoadListeners) listener();
    expect(instance.zoomWrites).toEqual([1.25, 1.25, 1.25]);

    // The user zooms with the keyboard mid-session: the owned session factor
    // becomes theirs from now on.
    dispatchZoomIn(instance);
    expect(instance.currentZoomFactor()).toBe(1.35);

    // Role-pin every did-finish-load listener in REGISTRATION order against a
    // simulated commit-time host-zoom restore. Swapping the two binder calls
    // inside createMainWindow swaps these roles and fails this test.
    const observedAfterStaleRestore: number[] = [];
    for (const listener of finishLoadListeners) {
      instance.simulateCommitTimeHostZoom(2);
      listener();
      observedAfterStaleRestore.push(instance.currentZoomFactor());
    }
    expect(observedAfterStaleRestore).toEqual([
      1.25, // first registered: unconditional startup-request writer
      1.35, // second: shortcut binder re-asserting the user-owned factor
      2, // third: lifecycle bookkeeping never touches zoom
    ]);

    // Full reload end to end: stale host zoom restores at commit time, then
    // BOTH zoom handlers run in registration order and the user-owned session
    // factor wins the window.
    instance.simulateCommitTimeHostZoom(1.1);
    for (const listener of finishLoadListeners) listener();
    expect(instance.currentZoomFactor()).toBe(1.35);
  });

  test("without an explicit request no startup binder is wired and the default wins reloads", () => {
    const instance = createWiredMainWindow();

    // Only the zoom-shortcut binder plus lifecycle bookkeeping register here;
    // bindStartupWindowZoom must stay conditional on an explicit request.
    const finishLoadListeners =
      registeredWebContentsListeners("did-finish-load");
    expect(finishLoadListeners).toHaveLength(2);

    instance.simulateCommitTimeHostZoom(1.25);
    for (const listener of finishLoadListeners) listener();
    expect(instance.currentZoomFactor()).toBe(1);
  });
});

test("View lists the zoom shortcuts the window already handles", () => {
  const view = buildMainWindowMenuTemplate("darwin").find(
    (item) => item.label === "View",
  );
  const submenu = Array.isArray(view?.submenu) ? view.submenu : [];
  expect(
    submenu.map(({ label, accelerator, registerAccelerator }) => ({
      label,
      accelerator,
      registerAccelerator,
    })),
  ).toEqual([
    {
      label: "Zoom In",
      accelerator: "CommandOrControl+=",
      registerAccelerator: false,
    },
    {
      label: "Zoom Out",
      accelerator: "CommandOrControl+-",
      registerAccelerator: false,
    },
    {
      label: "Actual Size",
      accelerator: "CommandOrControl+0",
      registerAccelerator: false,
    },
  ]);
  expect(
    buildMainWindowMenuTemplate("darwin").some(
      (item) => item.role === "windowMenu",
    ),
  ).toBe(false);
});
