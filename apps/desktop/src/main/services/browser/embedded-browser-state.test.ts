import { app } from "electron";
import { describe, expect, test, vi } from "vitest";
import { browserUserAgent } from "./browser-navigation";
import { EmbeddedBrowser } from "./embedded-browser";
import type { Browser, Page } from "playwright";
import { createStubBrowserSessionRuntime } from "@nestor/browser-runtime";
import { withEmbeddedBrowserActivity } from "./embedded-browser-runtime";

const { openExternal, ELECTRON_UA, sessions, makeSession } = vi.hoisted(() => {
  const ELECTRON_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.76 Electron/44.2.0 Nestor/0.1.0 Safari/537.36";
  interface FakeSession {
    setUserAgent: ReturnType<typeof vi.fn<(ua: string) => void>>;
    getUserAgent(): string;
  }
  const sessions: FakeSession[] = [];
  // Like Electron's session: getUserAgent() falls back to the process
  // fallback, so reading it after the fallback changed is the wrong original.
  function makeSession(fallback: () => string): FakeSession {
    let own: string | null = null;
    const value = {
      setUserAgent: vi.fn<(ua: string) => void>((ua) => {
        own = ua;
      }),
      getUserAgent: () => own ?? fallback(),
      registerPreloadScript: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      on: vi.fn(),
    };
    sessions.push(value);
    return value;
  }
  return {
    openExternal: vi.fn(() => Promise.resolve()),
    ELECTRON_UA,
    sessions,
    makeSession,
  };
});

vi.mock("electron", () => {
  const app = {
    getAppMetrics: vi.fn(() => [{ pid: 100, memory: { workingSetSize: 0 } }]),
    getName: () => "Nestor",
    userAgentFallback: ELECTRON_UA,
  };
  return {
    app,
    BrowserWindow: class {},
    dialog: {},
    screen: {},
    session: {
      fromPartition: vi.fn(() => makeSession(() => app.userAgentFallback)),
    },
    shell: { openExternal },
    WebContentsView: class {},
  };
});

function makeBrowser() {
  const browser = new EmbeddedBrowser();
  const state = browser as unknown as {
    pageMap: Map<
      string,
      {
        id: string;
        openerId?: string;
        contents: ReturnType<typeof makeContents>;
      }
    >;
    activeTabId: string | null;
    parkedTabs: Map<string, null>;
    heldTabs: Map<string, string[]>;
    personTabs: Set<string>;
    personInputTabs: Set<string>;
    personInputAt: Map<string, number>;
    personSendPressedAt: Map<string, number>;
    sentTabs: Set<string>;
    lentTabs: Set<string>;
    ownedTabs: Map<string, Set<string>>;
    closeReleasedOwnedTabs(): void;
    originalUserAgent: string | null;
    passwordManager: unknown;
    operations: Map<AbortController, string>;
    operationClaims: Map<
      AbortController,
      { id: string; owner: null; tabs: Set<string> }
    >;
  };
  const ids = [
    "failed",
    "search",
    "prepared",
    "parked",
    "held",
    "person",
    "working",
  ];
  const pages = new Map(ids.map((id) => [id, makeContents(id)]));
  for (const [id, contents] of pages) state.pageMap.set(id, { id, contents });
  state.activeTabId = "failed";
  return { browser, state, pages };
}

function makeContents(id: string) {
  let closed = false;
  return {
    isDestroyed: () => closed,
    getOSProcessId: () => 100,
    debugger: {
      isAttached: () => true,
      sendCommand: vi.fn(() => Promise.resolve()),
    },
    getTitle: () => id,
    getURL: () => `https://jobs.example/${id}`,
    isLoading: () => false,
    setBackgroundThrottling: vi.fn(),
    setUserAgent: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    reload: vi.fn(),
    getBackgroundThrottling: () => true,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    mainFrame: {
      framesInSubtree: [
        {
          executeJavaScript: vi.fn<() => Promise<unknown>>(() =>
            Promise.resolve(),
          ),
        },
      ],
    },
    executeJavaScript: vi.fn(() =>
      Promise.resolve({ title: id, bodyText: "Application received" }),
    ),
    close: vi.fn(() => {
      closed = true;
    }),
  };
}

describe("embedded browser tab state", () => {
  test("an access handoff opens its own retained page without activating the app", () => {
    const { browser, state, pages } = makeBrowser();
    const focus = vi.fn();
    const show = vi.fn();
    Object.assign(browser, {
      window: {
        isDestroyed: () => false,
        isFocused: () => false,
        focus,
        show,
        getContentSize: () => [1200, 800],
        webContents: { getZoomFactor: () => 1, send: vi.fn(), focus },
      },
    });
    for (const page of state.pageMap.values())
      Object.assign(page, {
        view: {
          getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
          setBounds: vi.fn(),
          setVisible: vi.fn(),
        },
      });
    state.ownedTabs.set("application_1_attempt_1", new Set(["prepared"]));
    state.ownedTabs.set("application_2_attempt_1", new Set(["working"]));

    expect(
      browser.focusRetainedApplicationPage("application_1_attempt_1"),
    ).toBe(true);
    expect(browser.getState()).toMatchObject({
      presentation: "peek",
      activeTabId: "prepared",
    });
    expect(browser.focusRetainedApplicationPage("missing")).toBe(false);
    expect(browser.getState().activeTabId).toBe("prepared");
    expect(focus).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    for (const contents of pages.values()) {
      expect(contents.loadURL).not.toHaveBeenCalled();
      expect(contents.reload).not.toHaveBeenCalled();
      expect(contents.close).not.toHaveBeenCalled();
    }
  });

  test("opening outside exports only the displayed address and keeps the waiting tab intact", async () => {
    const { browser, state, pages } = makeBrowser();
    const page = pages.get("failed")!;
    page.getURL = () =>
      "https://jobs.example/failed?code=private&answer=prepared#token";
    state.parkedTabs.set("failed", null);
    await browser.command({ type: "open_in_browser" });
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://jobs.example/failed",
    );
    expect(state.parkedTabs.has("failed")).toBe(true);
    for (const contents of pages.values()) {
      expect(contents.loadURL).not.toHaveBeenCalled();
      expect(contents.reload).not.toHaveBeenCalled();
      expect(contents.setUserAgent).not.toHaveBeenCalled();
      expect(contents.close).not.toHaveBeenCalled();
    }
  });

  test.each(["about:blank", "file:///private", "javascript:alert(1)"])(
    "opening outside ignores a non-web address (%s)",
    async (url) => {
      const { browser, pages } = makeBrowser();
      pages.get("failed")!.getURL = () => url;
      openExternal.mockClear();
      await browser.command({ type: "open_in_browser" });
      expect(openExternal).not.toHaveBeenCalled();
    },
  );

  test("verification retry changes only the active tab and uses GET instead of replaying a form", async () => {
    const { browser, state, pages } = makeBrowser();
    state.originalUserAgent = "Chromium/152 Electron/44 Nestor/0.1";
    state.parkedTabs.set("failed", null);
    await browser.command({ type: "retry_verification" });
    expect(pages.get("failed")!.setUserAgent).toHaveBeenCalledExactlyOnceWith(
      state.originalUserAgent,
    );
    expect(pages.get("failed")!.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://jobs.example/failed",
    );
    expect(pages.get("failed")!.reload).not.toHaveBeenCalled();
    expect(state.parkedTabs.has("failed")).toBe(true);
    for (const [id, page] of pages) {
      if (id === "failed") continue;
      expect(page.setUserAgent).not.toHaveBeenCalled();
      expect(page.loadURL).not.toHaveBeenCalled();
      expect(page.close).not.toHaveBeenCalled();
    }
  });

  test.each(["completed", "failed", "aborted"])(
    "a %s discovery operation closes finished tabs after releasing its claim",
    async (outcome) => {
      const { browser, state, pages } = makeBrowser();
      Object.assign(browser, {
        presentation: "peek",
        viewport: { visible: true },
      });
      state.parkedTabs.set("parked", null);
      state.heldTabs.set("held", []);
      state.personTabs.add("person");
      const otherController = new AbortController();
      state.operationClaims.set(otherController, {
        id: "other",
        owner: null,
        tabs: new Set(["working"]),
      });
      const controller = new AbortController();
      const run = browser.runAutomation(
        "Searching source",
        controller.signal,
        () => {
          const ownClaim = [...state.operationClaims.entries()].find(
            ([key]) => key !== otherController,
          )?.[1];
          expect(ownClaim).toBeDefined();
          for (const id of [
            "search",
            "failed",
            "parked",
            "held",
            "person",
            "working",
          ])
            ownClaim!.tabs.add(id);
          if (outcome === "aborted") controller.abort();
          if (outcome !== "completed") throw new Error("Source stopped");
          return Promise.resolve("done");
        },
        { cleanupOnFinish: true },
      );
      if (outcome === "completed") await expect(run).resolves.toBe("done");
      else await expect(run).rejects.toThrow();
      expect(pages.get("search")?.close).toHaveBeenCalledOnce();
      for (const id of [
        "failed",
        "parked",
        "held",
        "person",
        "working",
        "prepared",
      ])
        expect(pages.get(id)?.close).not.toHaveBeenCalled();
      expect(state.operationClaims.size).toBe(1);
    },
  );

  test("releasing a finished owner closes its own tabs, never one the person has", () => {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("sent_result", new Set(["failed", "held", "parked"]));
    state.ownedTabs.set("waiting_result", new Set(["prepared"]));
    state.heldTabs.set("held", ["sent_result"]);
    state.parkedTabs.set("parked", null);
    browser.releaseOwnedTabs("sent_result");
    expect(pages.get("failed")?.close).toHaveBeenCalledOnce();
    expect(pages.get("held")?.close).not.toHaveBeenCalled();
    expect(pages.get("parked")?.close).not.toHaveBeenCalled();
    expect(pages.get("prepared")?.close).not.toHaveBeenCalled();
    expect(state.ownedTabs.has("sent_result")).toBe(false);
  });

  test("completed applications close their handed-off tabs and leave other owners alone", () => {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("sent_result", new Set(["prepared", "held", "parked"]));
    state.ownedTabs.set("other_result", new Set(["person"]));
    state.personTabs.add("prepared");
    state.personTabs.add("person");
    state.heldTabs.set("held", ["sent_result"]);
    state.parkedTabs.set("parked", null);
    browser.releaseOwnedTabs("sent_result", { finished: true });
    for (const id of ["prepared", "held", "parked"])
      expect(pages.get(id)?.close).toHaveBeenCalledOnce();
    expect(pages.get("person")?.close).not.toHaveBeenCalled();
    expect(state.personTabs.has("prepared")).toBe(false);
    expect(state.ownedTabs.has("sent_result")).toBe(false);
  });

  test("an owner release waits until the operation using its tab ends", () => {
    const { browser, state, pages } = makeBrowser();
    const controller = new AbortController();
    state.ownedTabs.set("result", new Set(["working"]));
    state.operationClaims.set(controller, {
      id: "active",
      owner: null,
      tabs: new Set(["working"]),
    });
    browser.releaseOwnedTabs("result");
    expect(pages.get("working")?.close).not.toHaveBeenCalled();
    state.operationClaims.delete(controller);
    state.closeReleasedOwnedTabs();
    expect(pages.get("working")?.close).toHaveBeenCalledOnce();
  });

  test("a retry transfers ownership so releasing the old result cannot close the form", () => {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("previous_result", new Set(["prepared"]));
    browser.transferOwnedTabs("previous_result", "retry_result");
    browser.releaseOwnedTabs("previous_result");
    expect(pages.get("prepared")?.close).not.toHaveBeenCalled();
    browser.releaseOwnedTabs("retry_result");
    expect(pages.get("prepared")?.close).toHaveBeenCalledOnce();
  });

  test("a retry reclaims its held page without reclaiming unrelated tabs", async () => {
    const { browser, state } = makeBrowser();
    state.ownedTabs.set("result", new Set(["held"]));
    state.heldTabs.set("held", ["result"]);
    state.heldTabs.set("prepared", ["other_result"]);
    state.personTabs.add("held");
    vi.spyOn(browser, "getOpenBrowser").mockResolvedValue(null);
    await browser.reclaimOwnedTabs("result");
    expect(state.heldTabs.has("held")).toBe(false);
    expect(state.personTabs.has("held")).toBe(false);
    expect(state.heldTabs.has("prepared")).toBe(true);
  });

  test("a failed transfer restores the exact person's page and leaves unrelated tabs alone", async () => {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("old", new Set(["held"]));
    state.heldTabs.set("held", ["old"]);
    state.parkedTabs.set("held", null);
    state.personTabs.add("held");
    state.personInputTabs.add("held");
    state.personInputAt.set("held", 123);
    state.heldTabs.set("prepared", ["unrelated"]);
    vi.spyOn(browser, "getOpenBrowser").mockResolvedValue(null);
    const restore = await browser.reclaimOwnedTabs("old");
    expect(state.personInputTabs.has("held")).toBe(true);
    restore();
    restore();
    expect(state.heldTabs.get("held")).toEqual(["old"]);
    expect(state.parkedTabs.has("held")).toBe(true);
    expect(state.personTabs.has("held")).toBe(true);
    expect(state.personInputTabs.has("held")).toBe(true);
    expect(state.personInputAt.get("held")).toBe(123);
    expect(state.heldTabs.get("prepared")).toEqual(["unrelated"]);
    expect(
      pages.get("held")!.mainFrame.framesInSubtree[0]!.executeJavaScript,
    ).toHaveBeenCalledTimes(2);
    for (const page of pages.values())
      expect(page.close).not.toHaveBeenCalled();
  });

  test("rollback cannot reclaim a tab whose ownership already moved to a new attempt", async () => {
    const { browser, state } = makeBrowser();
    state.ownedTabs.set("old", new Set(["held"]));
    state.personTabs.add("held");
    vi.spyOn(browser, "getOpenBrowser").mockResolvedValue(null);
    const restore = await browser.reclaimOwnedTabs("old");
    browser.transferOwnedTabs("old", "next");
    restore();
    expect(state.personTabs.has("held")).toBe(false);
    expect(state.ownedTabs.get("next")).toEqual(new Set(["held"]));
  });

  test("a failed native reclaim keeps the prior person handoff", async () => {
    const { browser, state } = makeBrowser();
    state.ownedTabs.set("old", new Set(["held"]));
    state.heldTabs.set("held", ["old"]);
    state.personTabs.add("held");
    vi.spyOn(browser, "getOpenBrowser").mockRejectedValue(
      new Error("Bridge unavailable"),
    );
    await expect(browser.reclaimOwnedTabs("old")).rejects.toThrow(
      "Bridge unavailable",
    );
    expect(state.heldTabs.get("held")).toEqual(["old"]);
    expect(state.personTabs.has("held")).toBe(true);
  });

  test("sign-in attention follows its tab instead of the active public listing", async () => {
    const { browser } = makeBrowser();
    browser.requestAttention(
      {
        kind: "sign_in",
        title: "Sign in to continue: Example Jobs",
        detail: "Sign in here.",
      },
      "failed",
    );
    expect(browser.getState().attention?.title).toContain("Example Jobs");
    await browser.command({ type: "select_tab", tabId: "person" });
    expect(browser.getState().attention).toBeNull();
    await browser.command({ type: "select_tab", tabId: "failed" });
    expect(browser.getState().attention?.kind).toBe("sign_in");
  });

  test("cleanup closes only finished tabs and preserves unsent forms and occupied tabs", async () => {
    const { browser, state, pages } = makeBrowser();
    state.parkedTabs.set("parked", null);
    state.heldTabs.set("held", []);
    state.personTabs.add("person");
    state.operationClaims.set(new AbortController(), {
      id: "active",
      owner: null,
      tabs: new Set(["working"]),
    });
    browser.markFinishedTabs([
      "failed",
      "search",
      "parked",
      "held",
      "person",
      "working",
    ]);
    await browser.command({ type: "close_finished_tabs" });
    expect(pages.get("failed")?.close).toHaveBeenCalledOnce();
    expect(pages.get("search")?.close).toHaveBeenCalledOnce();
    for (const id of ["prepared", "parked", "held", "person", "working"])
      expect(pages.get(id)?.close).not.toHaveBeenCalled();
  });
});

test("waiting forms release working capacity but a resumed form counts again", () => {
  const { browser, state } = makeBrowser();
  state.ownedTabs.set("prepared_result", new Set(["prepared"]));
  state.parkedTabs.set("parked", null);
  expect(browser.openTabCount()).toBe(7);
  expect(browser.workingTabCount()).toBe(5);
  state.operationClaims.set(new AbortController(), {
    id: "resuming",
    owner: null,
    tabs: new Set(["prepared"]),
  });
  expect(browser.workingTabCount()).toBe(6);
});

test("opening a new reading tab leaves the active application's operation running", async () => {
  const { browser, state } = makeBrowser();
  const controller = new AbortController();
  state.activeTabId = "working";
  state.operations.set(controller, "Preparing application");
  state.operationClaims.set(controller, {
    id: "application",
    owner: null,
    tabs: new Set(["working"]),
  });
  const open = vi
    .spyOn(
      browser as unknown as { openPersonTab(url: string): void },
      "openPersonTab",
    )
    .mockImplementation(() => undefined);
  await browser.command({ type: "new_tab" });
  expect(open).toHaveBeenCalledWith("about:blank");
  expect(controller.signal.aborted).toBe(false);
  expect(state.heldTabs.has("working")).toBe(false);
});

test("ten working tabs plus waiting forms leave room; sixteen working tabs use the measured concurrency ceiling", () => {
  const { browser, state } = makeBrowser();
  state.pageMap.clear();
  for (let i = 0; i < 26; i++) {
    const id = `tab_${i}`;
    state.pageMap.set(id, { id, contents: makeContents(id) });
    if (i < 10) state.ownedTabs.set(`waiting_${i}`, new Set([id]));
  }
  expect(browser.workingTabCount()).toBe(16);
  expect(
    (browser as unknown as { hasTabCapacity(): boolean }).hasTabCapacity(),
  ).toBe(false);
  for (let i = 20; i < 26; i++) state.pageMap.delete(`tab_${i}`);
  expect(browser.workingTabCount()).toBe(10);
  expect(
    (browser as unknown as { hasTabCapacity(): boolean }).hasTabCapacity(),
  ).toBe(true);
});

test.each(["pointer", "key"] as const)(
  "a person's own %s input unlocks an idle waiting form and its receipt read",
  async (kind) => {
    const { browser, state, pages } = makeBrowser();
    const native = browser as unknown as {
      handleUserInput(
        id: string,
        kind: "pointer" | "key",
        key?: { code: string; key: string },
      ): void;
      isPointerOverPage(): boolean;
    };
    vi.spyOn(native, "isPointerOverPage").mockReturnValue(true);
    state.ownedTabs.set("waiting_result", new Set(["prepared"]));
    native.handleUserInput("prepared", kind, { code: "Enter", key: "Enter" });
    expect(
      pages.get("prepared")?.mainFrame.framesInSubtree[0]?.executeJavaScript,
    ).toHaveBeenCalledWith(
      expect.stringContaining("finalActionAllowed = true"),
    );
    expect(
      await browser.readApplicationPageWithPerson("waiting_result"),
    ).toMatchObject({ bodyText: "Application received" });
    expect(
      await browser.readApplicationPageWithPerson("other_result"),
    ).toBeNull();
  },
);

test.each(["pointer", "key"] as const)(
  "automation %s input cannot unlock the person's send guard",
  async (kind) => {
    const { browser, state, pages } = makeBrowser();
    const native = browser as unknown as {
      handleUserInput(
        id: string,
        kind: "pointer" | "key",
        key?: { code: string; key: string },
      ): void;
      agentPresses: {
        notePress(id: string): void;
        noteKey(id: string, key: { code: string; key: string }): void;
      };
    };
    state.ownedTabs.set("waiting_result", new Set(["prepared"]));
    if (kind === "pointer") native.agentPresses.notePress("prepared");
    else
      native.agentPresses.noteKey("prepared", { code: "Enter", key: "Enter" });
    native.handleUserInput("prepared", kind, { code: "Enter", key: "Enter" });
    expect(
      pages.get("prepared")?.mainFrame.framesInSubtree[0]?.executeJavaScript,
    ).not.toHaveBeenCalled();
    expect(
      await browser.readApplicationPageWithPerson("waiting_result"),
    ).toBeNull();
  },
);

test("a finished search's leftover tabs close at once, except the one on screen and occupied tabs", () => {
  const { browser, state, pages } = makeBrowser();
  Object.assign(browser, { presentation: "peek", viewport: { visible: true } });
  state.parkedTabs.set("parked", null);
  state.heldTabs.set("held", []);
  state.personTabs.add("person");
  browser.markFinishedTabs(["failed", "search", "parked", "held", "person"]);
  expect(pages.get("search")?.close).toHaveBeenCalledOnce();
  // "failed" is displayed; watching it keeps it until the panel is hidden.
  for (const id of ["failed", "parked", "held", "person"])
    expect(pages.get(id)?.close).not.toHaveBeenCalled();
});

test("close finished tabs explains when there is nothing eligible", async () => {
  const { browser } = makeBrowser();
  await browser.command({ type: "close_finished_tabs" });
  expect(browser.getState().attention?.title).toBe("No finished tabs to close");
  expect(browser.getState().attention?.detail).toContain("Close a tab");
});

test("handing a native-owned form back closes its person guard before automation can use it", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("result", new Set(["prepared"]));
  const native = browser as unknown as {
    handleUserInput(
      id: string,
      kind: "key",
      key: { code: string; key: string },
    ): void;
  };
  native.handleUserInput("prepared", "key", { code: "Enter", key: "Enter" });
  vi.spyOn(browser, "getOpenBrowser").mockResolvedValue(null);
  await browser.reclaimOwnedTabs("result");
  expect(
    pages.get("prepared")?.mainFrame.framesInSubtree[0]?.executeJavaScript,
  ).toHaveBeenLastCalledWith(
    expect.stringContaining("finalActionAllowed = false"),
  );
  browser.completeOwnedTabReclaim("result");
  expect(await browser.readApplicationPageWithPerson("result")).toBeNull();
});

test("prepared tabs identify the job even when the site gives them identical titles", () => {
  const { browser, pages } = makeBrowser();
  browser.setApplicationTabLabel(
    "prepared",
    "Senior Learning Coordinator",
    "Clientnest Cobalt",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("Clientnest Cobalt · Senior Learning Coordinator");
  pages.get("prepared")!.getURL = () => "https://example.test/another-page";
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("prepared");
});

test.each(["record", "top_bar", "tab_picker"] as const)(
  "showing a prepared form through %s leaves it bound to its application until the person acts",
  async (entry) => {
    // Handing the page over on sight released it from its application, which
    // recorded the prepared form as closed ("Could not apply") and lost the
    // person's own send. The page is handed over on their first input instead.
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("ready_result", new Set(["prepared"]));
    state.activeTabId = "prepared";
    if (entry === "record") browser.showTab("prepared");
    else if (entry === "top_bar") await browser.command({ type: "open" });
    else {
      await browser.command({ type: "open" });
      await browser.command({ type: "select_tab", tabId: "prepared" });
    }
    expect(state.heldTabs.has("prepared")).toBe(false);
    expect(state.ownedTabs.get("ready_result")?.has("prepared")).toBe(true);
    expect(
      pages.get("prepared")?.mainFrame.framesInSubtree[0]?.executeJavaScript,
    ).not.toHaveBeenCalledWith(
      expect.stringContaining("finalActionAllowed = true"),
    );
  },
);

test("opening the browser to watch a working application does not open its Send guard", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("ready_result", new Set(["prepared"]));
  state.activeTabId = "prepared";
  const controller = new AbortController();
  state.operations.set(controller, "Preparing application");
  state.operationClaims.set(controller, {
    id: "prepare",
    owner: null,
    tabs: new Set(["prepared"]),
  });
  await browser.command({ type: "open" });
  expect(
    pages.get("prepared")?.mainFrame.framesInSubtree[0]?.executeJavaScript,
  ).not.toHaveBeenCalled();
  expect(controller.signal.aborted).toBe(false);
});

test("a prepared tab is ready without Resume when another tab was handed over", async () => {
  const { browser, state } = makeBrowser();
  state.heldTabs.set("held", ["old_result"]);
  state.ownedTabs.set("ready_result", new Set(["prepared"]));
  state.activeTabId = "prepared";
  await browser.command({ type: "open" });
  expect(browser.getState()).toMatchObject({
    phase: "ready",
    automationPaused: false,
    activeTabId: "prepared",
  });
  await browser.command({ type: "select_tab", tabId: "held" });
  expect(browser.getState()).toMatchObject({
    phase: "paused",
    automationPaused: true,
    activeTabId: "held",
  });
  state.heldTabs.set("held", []); // The person finished a prepared page; no task is interrupted.
  expect(browser.getState()).toMatchObject({
    phase: "ready",
    automationPaused: false,
  });
});

test("a background application does not label the selected prepared tab as working", async () => {
  const { browser, state } = makeBrowser();
  state.activeTabId = "prepared";
  const controller = new AbortController();
  state.operations.set(controller, "Preparing another application");
  state.operationClaims.set(controller, {
    id: "another",
    owner: null,
    tabs: new Set(["working"]),
  });
  await browser.command({ type: "open" });
  expect(browser.getState()).toMatchObject({ phase: "ready", activity: null });
  await browser.command({ type: "select_tab", tabId: "working" });
  expect(browser.getState()).toMatchObject({
    phase: "working",
    activity: "Preparing another application",
  });
});

test("tabs lead with the company and add the place, then a reference, only to tell twins apart", () => {
  const { browser } = makeBrowser();
  browser.setApplicationTabLabel(
    "prepared",
    "Engineer",
    "Synthetic",
    "London",
    "abc123",
  );
  browser.setApplicationTabLabel(
    "failed",
    "Engineer",
    "Synthetic",
    "Manchester",
    "def456",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("Synthetic · Engineer · London");
  browser.setApplicationTabLabel(
    "failed",
    "Engineer",
    "Synthetic",
    "London",
    "def456",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("Synthetic · Engineer · London · abc123");
  expect(
    browser.getState().tabs.find((tab) => tab.id === "failed")?.title,
  ).toBe("Synthetic · Engineer · London · def456");
  browser.setApplicationTabLabel(
    "failed",
    "Engineer",
    "Synthetic",
    "London",
    "abc123",
  );
  const titles = browser
    .getState()
    .tabs.filter((tab) => ["prepared", "failed"].includes(tab.id))
    .map((tab) => tab.title);
  expect(new Set(titles).size).toBe(2);
});

test("the person's own send in their window is kept by the app, so the page moving on cannot erase it", async () => {
  // Askable: the person pressed Apply; the page posted and moved on to
  // "Finish your application", a new document without the page guard.
  const { browser, state } = makeBrowser();
  const native = browser as unknown as {
    personInputTabs: Set<string>;
    personInputAt: Map<string, number>;
    noteBoundSend(id: string): void;
  };
  state.ownedTabs.set("result", new Set(["prepared"]));
  native.personInputTabs.add("prepared");
  // Without the person's own input just before, it is not their press.
  native.personInputAt.set("prepared", Date.now() - 5_000);
  native.noteBoundSend("prepared");
  expect(
    (await browser.readApplicationPageWithPerson("result"))?.sendPressedAt,
  ).toBeUndefined();
  native.personInputAt.set("prepared", Date.now());
  const before = Date.now();
  native.noteBoundSend("prepared");
  const pressed = (await browser.readApplicationPageWithPerson("result"))
    ?.sendPressedAt;
  expect(pressed).toBeDefined();
  expect(Date.parse(pressed!)).toBeGreaterThanOrEqual(before);
});

test("a general-browser send prompt requires recent person input and never claims a send", () => {
  const { browser, state: browserState } = makeBrowser();
  browserState.ownedTabs.set("result", new Set(["prepared"]));
  browser.setApplicationTabLabel("prepared", "Engineer", "Synthetic", "London");
  const state = browser as unknown as {
    personInputAt: Map<string, number>;
    noteUnboundSend(id: string): void;
  };
  state.noteUnboundSend("person");
  expect(browser.getState().unboundSendNotice).toBeNull();
  state.personInputAt.set("person", Date.now());
  state.noteUnboundSend("person");
  expect(browser.getState().unboundSendNotice?.tabId).toBe("person");
  const previous = browser.getState().unboundSendNotice?.id;
  state.personInputAt.set("prepared", Date.now());
  state.noteUnboundSend("prepared");
  expect(browser.getState().unboundSendNotice?.id).toBe(previous);
  browserState.ownedTabs.set("search", new Set(["person"]));
  state.personInputAt.set("person", Date.now());
  state.noteUnboundSend("person");
  expect(browser.getState().unboundSendNotice?.id).not.toBe(previous);
});

test("a raw page timestamp cannot invent the person's final press", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("result", new Set(["prepared"]));
  const native = browser as unknown as { personInputTabs: Set<string> };
  native.personInputTabs.add("prepared");
  const spoofed = {
    title: "Application",
    bodyText: "Application",
    sendPressedAt: new Date().toISOString(),
    sendConfirmationBefore: [],
    sendOrigin: "https://jobs.example",
  };
  pages.get("prepared")!.executeJavaScript.mockResolvedValue(spoofed);
  const raw = await browser.readApplicationPageWithPerson("result");
  expect(raw?.sendPressedAt).toBeUndefined();
  expect(raw?.sendConfirmationBefore).toBeUndefined();
});

test.each(["Still processing", "Your application has been received"])(
  "the sending iframe supplies the receipt, never a parent acknowledgement: %s",
  async (bodyText) => {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("result", new Set(["prepared"]));
    const native = browser as unknown as {
      personInputTabs: Set<string>;
      personInputAt: Map<string, number>;
      noteBoundSend(
        id: string,
        context: {
          confirmationBefore: string[];
          frameTreeNodeId: number;
          origin: string;
        },
      ): void;
    };
    native.personInputTabs.add("prepared");
    native.personInputAt.set("prepared", Date.now());
    const contents = pages.get("prepared")!;
    const frame = contents.mainFrame.framesInSubtree[0]!;
    Object.assign(frame, {
      frameTreeNodeId: 22,
      url: "https://frame.example/receipt",
    });
    frame.executeJavaScript.mockResolvedValue({ title: "Receipt", bodyText });
    native.noteBoundSend("prepared", {
      confirmationBefore: [],
      frameTreeNodeId: 22,
      origin: "https://frame.example",
    });
    const raw = await browser.readApplicationPageWithPerson("result");
    expect(raw?.bodyText).toBe(bodyText);
    expect(raw?.url).toBe("https://frame.example/receipt");
    expect(raw?.sendOrigin).toBe("https://frame.example");
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
  },
);

test("ending an application loan returns the person's own send control", async () => {
  const { browser, pages, state } = makeBrowser();
  state.personTabs.add("prepared");
  const execute =
    pages.get("prepared")!.mainFrame.framesInSubtree[0]!.executeJavaScript;
  await browser.lendTab("prepared");
  expect(execute).toHaveBeenLastCalledWith(
    expect.stringContaining("state.finalActionAllowed = false"),
  );
  browser.endLoan("prepared");
  expect(browser.isTabLent("prepared")).toBe(false);
  expect(execute).toHaveBeenLastCalledWith(
    expect.stringContaining("state.finalActionAllowed = true"),
  );
});

test("browser commands wake only their page without disabling window-wide throttling", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("result", new Set(["prepared"]));
  const controller = new AbortController();
  state.operations.set(controller, "search");
  state.operationClaims.set(controller, {
    id: "search",
    owner: null,
    tabs: new Set(["search"]),
  });
  const policy = browser as unknown as {
    isTabIdle(id: string): boolean;
    noteAutomationCommand(id: string, active: boolean): Promise<void>;
  };
  expect(policy.isTabIdle("prepared")).toBe(true);
  expect(policy.isTabIdle("search")).toBe(true);
  await policy.noteAutomationCommand("search", true);
  expect(policy.isTabIdle("search")).toBe(false);
  state.operationClaims.get(controller)!.tabs.add("prepared");
  await policy.noteAutomationCommand("prepared", true);
  expect(policy.isTabIdle("prepared")).toBe(false);
  for (const page of pages.values())
    expect(page.setBackgroundThrottling).not.toHaveBeenCalledWith(false);
});

test("waiting-form memory pressure triggers reclamation without blocking working slots", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("result", new Set(["prepared"]));
  const metrics = vi.spyOn(app, "getAppMetrics");
  metrics.mockReturnValue([
    { pid: 100, memory: { workingSetSize: 2200 * 1024 } },
  ] as ReturnType<typeof app.getAppMetrics>);
  expect(browser.hasAutomationTabCapacity()).toBe(true);
  const before = await browser.reduceWaitingFormMemory();
  expect(before.overBudget).toBe(true);
  expect(pages.get("prepared")!.debugger.sendCommand).toHaveBeenCalledWith(
    "HeapProfiler.collectGarbage",
  );
  expect(pages.get("prepared")!.close).not.toHaveBeenCalled();
  expect(pages.get("prepared")!.setBackgroundThrottling).not.toHaveBeenCalled();
  metrics.mockReturnValue([
    { pid: 100, memory: { workingSetSize: 50 * 1024 } },
  ] as ReturnType<typeof app.getAppMetrics>);
  expect(browser.hasAutomationTabCapacity()).toBe(true);
  expect(browser.getWaitingFormMemory().totalBytes).toBe(50 * 1024 * 1024);
  metrics.mockReturnValue([
    { pid: 100, memory: { workingSetSize: 0 } },
  ] as ReturnType<typeof app.getAppMetrics>);
});

test("search pages parked for the person do not use up the waiting-form budget", () => {
  const { browser, state } = makeBrowser();
  state.parkedTabs.set("parked", null);
  const metrics = vi.spyOn(app, "getAppMetrics");
  metrics.mockReturnValue([
    { pid: 100, memory: { workingSetSize: 1100 * 1024 } },
  ] as ReturnType<typeof app.getAppMetrics>);
  expect(browser.getWaitingFormMemory().totalBytes).toBe(0);
  expect(browser.hasAutomationTabCapacity()).toBe(true);
  metrics.mockReturnValue([
    { pid: 100, memory: { workingSetSize: 0 } },
  ] as ReturnType<typeof app.getAppMetrics>);
});

test("hidden work releases focus at command completion and preserves overlapping reads", async () => {
  vi.useFakeTimers();
  try {
    const { browser, state, pages } = makeBrowser();
    const controller = new AbortController();
    state.operations.set(controller, "Search");
    state.operationClaims.set(controller, {
      id: "search",
      owner: null,
      tabs: new Set(["search"]),
    });
    const policy = browser as unknown as {
      noteAutomationCommand(
        id: string,
        active: boolean,
        emulateFocus?: boolean,
      ): Promise<void>;
      isTabIdle(id: string): boolean;
    };
    await policy.noteAutomationCommand("search", true);
    await policy.noteAutomationCommand("search", true, false);
    await policy.noteAutomationCommand("search", false);
    expect(pages.get("search")?.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
    expect(policy.isTabIdle("search")).toBe(false);
    await policy.noteAutomationCommand("search", false, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(policy.isTabIdle("search")).toBe(true);
    expect(pages.get("search")?.close).not.toHaveBeenCalled();
    await policy.noteAutomationCommand("search", true);
    expect(pages.get("search")?.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: true },
    );
    expect(
      pages.get("search")?.setBackgroundThrottling,
    ).not.toHaveBeenCalledWith(false);
  } finally {
    vi.useRealTimers();
  }
});

test("a selected finished tab closes while the browser panel is hidden", () => {
  const { browser, pages } = makeBrowser();
  browser.markFinishedTabs(["failed"]);
  expect(pages.get("failed")?.close).toHaveBeenCalledOnce();
});

test("unfocused scripts still allow autosaves to settle; native probes do not cancel the window", async () => {
  vi.useFakeTimers();
  try {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("result", new Set(["prepared"]));
    const policy = browser as unknown as {
      noteAutomationCommand(
        id: string,
        active: boolean,
        focus: boolean,
        settle?: boolean,
      ): Promise<void>;
    };
    await policy.noteAutomationCommand("prepared", true, false, true);
    await policy.noteAutomationCommand("prepared", false, false, true);
    await vi.advanceTimersByTimeAsync(8_000);
    await policy.noteAutomationCommand("prepared", true, false);
    await policy.noteAutomationCommand("prepared", false, false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      pages.get("prepared")?.debugger.sendCommand,
    ).not.toHaveBeenCalledWith("Page.setWebLifecycleState", {
      state: "frozen",
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pages.get("prepared")?.debugger.sendCommand).toHaveBeenCalledWith(
      "Page.setWebLifecycleState",
      { state: "frozen" },
    );
  } finally {
    vi.useRealTimers();
  }
});

test("different places distinguish prepared tabs for the same company and role", () => {
  const { browser } = makeBrowser();
  browser.setApplicationTabLabel(
    "prepared",
    "Senior Accountant",
    "Synthetic Workshop",
    "London",
  );
  browser.setApplicationTabLabel(
    "failed",
    "Senior Accountant",
    "Synthetic Workshop",
    "Denver",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("Synthetic Workshop · Senior Accountant · London");
  expect(
    browser.getState().tabs.find((tab) => tab.id === "failed")?.title,
  ).toBe("Synthetic Workshop · Senior Accountant · Denver");
});

test("tabs without a place stay plain and add the short reference only when they match", () => {
  const { browser } = makeBrowser();
  browser.setApplicationTabLabel(
    "prepared",
    "Engineer",
    "Synthetic",
    "",
    "abc123",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("Synthetic · Engineer");
  browser.setApplicationTabLabel(
    "failed",
    "Engineer",
    "Synthetic",
    "",
    "def456",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("Synthetic · Engineer · abc123");
  expect(
    browser.getState().tabs.find((tab) => tab.id === "failed")?.title,
  ).toBe("Synthetic · Engineer · def456");
});

test("pressure reclaims the oldest eligible form and preserves a person's page", async () => {
  const { browser, state } = makeBrowser();
  state.ownedTabs.set("person-first", new Set(["person"]));
  state.ownedTabs.set("old-ready", new Set(["prepared"]));
  state.ownedTabs.set("new-ready", new Set(["failed"]));
  state.personTabs.add("person");
  browser.markPreparedForm("person-first");
  browser.markPreparedForm("old-ready");
  browser.markPreparedForm("new-ready");
  const originalMemory = browser.getWaitingFormMemory();
  let pressure = true;
  vi.spyOn(browser, "getWaitingFormMemory").mockImplementation(() => ({
    ...originalMemory,
    totalBytes: pressure ? 2 : originalMemory.totalBytes,
    budgetBytes: pressure ? 1 : originalMemory.budgetBytes,
  }));
  const reclaim = vi.fn((_owner: string, canDiscard: () => boolean) => {
    expect(canDiscard()).toBe(true);
    pressure = false;
    return Promise.resolve(true);
  });
  browser.setPreparedFormReclaimer(reclaim);
  await browser.reduceWaitingFormMemory();
  expect(reclaim).toHaveBeenCalledExactlyOnceWith(
    "old-ready",
    expect.any(Function),
  );
});

test("a fourth waiting form closes the oldest one; opening a form keeps it live", async () => {
  const run = async (open?: string) => {
    const { browser, state } = makeBrowser();
    const forms = [
      ["first", "search"],
      ["second", "prepared"],
      ["third", "working"],
      ["fourth", "parked"],
    ] as const;
    for (const [owner, tab] of forms)
      state.ownedTabs.set(owner, new Set([tab]));
    const reclaim = vi.fn<(owner: string) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    browser.setPreparedFormReclaimer(reclaim);
    for (const [owner] of forms.slice(0, 3)) {
      browser.markPreparedForm(owner);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    if (open) browser.showTab(open);
    await new Promise((resolve) => setTimeout(resolve, 2));
    browser.markPreparedForm("fourth");
    await browser.reduceWaitingFormMemory();
    return reclaim.mock.calls.map(([owner]) => owner);
  };
  expect(await run()).toEqual(["first"]);
  expect(await run("search")).toEqual(["second"]);
});

test("a waiting page that cannot close never makes a more recent one close", async () => {
  const { browser, state } = makeBrowser();
  const forms = [
    ["first", "search"],
    ["second", "prepared"],
    ["third", "working"],
    ["fourth", "parked"],
  ] as const;
  for (const [owner, tab] of forms) state.ownedTabs.set(owner, new Set([tab]));
  const reclaim = vi.fn<(owner: string) => Promise<boolean>>((owner) =>
    Promise.resolve(owner !== "first"),
  );
  browser.setPreparedFormReclaimer(reclaim);
  for (const [owner] of forms) {
    browser.markPreparedForm(owner);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await browser.reduceWaitingFormMemory();
  expect(reclaim.mock.calls.map(([owner]) => owner)).toEqual(["first"]);
});

test("a waiting page whose Send the person pressed never closes for the cap", async () => {
  const { browser, state } = makeBrowser();
  const forms = [
    ["sent", "search"],
    ["second", "prepared"],
    ["third", "working"],
    ["fourth", "parked"],
  ] as const;
  for (const [owner, tab] of forms) state.ownedTabs.set(owner, new Set([tab]));
  // The press outlives the page's own record once the page navigates.
  state.personSendPressedAt.set("search", Date.now());
  const reclaim = vi.fn<(owner: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  browser.setPreparedFormReclaimer(reclaim);
  for (const [owner] of forms) {
    browser.markPreparedForm(owner);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await browser.reduceWaitingFormMemory();
  expect(reclaim).not.toHaveBeenCalledWith("sent", expect.any(Function));
});

test("the Speed level's limit sets how many waiting pages stay live", async () => {
  const { browser, state } = makeBrowser();
  const forms = [
    ["first", "search"],
    ["second", "prepared"],
    ["third", "working"],
  ] as const;
  for (const [owner, tab] of forms) state.ownedTabs.set(owner, new Set([tab]));
  const reclaim = vi.fn<(owner: string) => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  browser.setPreparedFormReclaimer(reclaim);
  for (const [owner] of forms) {
    browser.markPreparedForm(owner);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(reclaim).not.toHaveBeenCalled();
  browser.setLiveWaitingPageLimit(1);
  await browser.reduceWaitingFormMemory();
  expect(reclaim.mock.calls.map(([owner]) => owner)).toEqual([
    "first",
    "second",
  ]);
});

test("only idle retained pages freeze; active source loading stays awake", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("result", new Set(["prepared"]));
  const policy = browser as unknown as {
    syncTabLifecycle(page: {
      id: string;
      contents: ReturnType<typeof makeContents>;
    }): void;
  };
  policy.syncTabLifecycle(state.pageMap.get("prepared")!);
  policy.syncTabLifecycle(state.pageMap.get("search")!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pages.get("prepared")!.debugger.sendCommand).toHaveBeenCalledWith(
    "Page.setWebLifecycleState",
    { state: "frozen" },
  );
  expect(pages.get("search")!.debugger.sendCommand).not.toHaveBeenCalledWith(
    "Page.setWebLifecycleState",
    { state: "frozen" },
  );
});

test("a page handed to the person never freezes in the background", async () => {
  const { browser, state, pages } = makeBrowser();
  state.ownedTabs.set("result", new Set(["prepared"]));
  state.personTabs.add("prepared");
  const policy = browser as unknown as {
    syncTabLifecycle(page: {
      id: string;
      contents: ReturnType<typeof makeContents>;
    }): void;
  };
  policy.syncTabLifecycle(state.pageMap.get("prepared")!);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pages.get("prepared")!.debugger.sendCommand).not.toHaveBeenCalledWith(
    "Page.setWebLifecycleState",
    { state: "frozen" },
  );
});

describe("process user-agent fallback for popups", () => {
  const CHROME = browserUserAgent(ELECTRON_UA, "Nestor");
  const ready = () => {
    const made = makeBrowser();
    // The password vault is not part of this check: every call is a no-op.
    made.state.passwordManager = new Proxy(
      {},
      {
        get: (target: Record<string | symbol, unknown>, key) =>
          key === "then" ? undefined : (target[key] ??= vi.fn()),
      },
    );
    return made;
  };

  test("getSession sets the process fallback and the session to the same Chrome identity, and keeps Electron's original", () => {
    expect(CHROME).not.toMatch(/Electron\/|Nestor\//);
    expect(CHROME).toContain("Chrome/152.0.7977.76");
    const first = ready();
    first.browser.getSession();
    expect(app.userAgentFallback).toBe(CHROME);
    expect(sessions.at(-1)!.setUserAgent).toHaveBeenCalledExactlyOnceWith(
      CHROME,
    );
    expect(first.state.originalUserAgent).toBe(ELECTRON_UA);
    // A later instance runs after the fallback changed and must still keep
    // Electron's original, not the session value that now falls back to Chrome.
    const second = ready();
    second.browser.getSession();
    expect(second.state.originalUserAgent).toBe(ELECTRON_UA);
    expect(app.userAgentFallback).toBe(CHROME);
    expect(sessions.at(-1)!.setUserAgent).toHaveBeenCalledExactlyOnceWith(
      CHROME,
    );
  });

  test("Retry gives only the selected tab Electron's original with a GET, and a popup from it gets no per-contents user agent", async () => {
    const { browser, state, pages } = ready();
    browser.getSession();
    await browser.command({ type: "retry_verification" });
    expect(pages.get("failed")!.setUserAgent).toHaveBeenCalledExactlyOnceWith(
      ELECTRON_UA,
    );
    expect(pages.get("failed")!.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://jobs.example/failed",
    );
    for (const [id, page] of pages)
      if (id !== "failed") expect(page.setUserAgent).not.toHaveBeenCalled();
    // The popup path Electron's createWindow takes sets no per-contents user
    // agent, so a popup presents the process fallback (Chrome) even when its
    // opener was retried. A per-contents override there would be switched off
    // and could flip identity mid-life on a later loadURL.
    const createPage = (
      EmbeddedBrowser.prototype as unknown as Record<string, () => void>
    ).createPage;
    expect(String(createPage)).not.toContain("setUserAgent");
    expect("applyPopupIdentity" in EmbeddedBrowser.prototype).toBe(false);
    expect(state.originalUserAgent).toBe(ELECTRON_UA);
  });
});

test.each(["held", "person", "parked"])(
  "native owner resolver refuses an unannounced %s tab immediately",
  async (kind) => {
    const { browser, state } = makeBrowser();
    state.ownedTabs.set("key", new Set(["prepared"]));
    if (kind === "held") state.heldTabs.set("prepared", ["key"]);
    if (kind === "person") state.personTabs.add("prepared");
    if (kind === "parked") state.parkedTabs.set("prepared", null);
    const connect = vi.spyOn(browser, "getOpenBrowser");
    await expect(browser.ownedApplicationPage("key")).resolves.toEqual({
      page: null,
    });
    expect(connect).not.toHaveBeenCalled();
  },
);

test("native owner resolver requires a unique root and ignores its owned popup", async () => {
  const { browser, state } = makeBrowser();
  state.ownedTabs.set("key", new Set(["prepared", "search"]));
  const page = { isClosed: () => false } as Page;
  const popup = { isClosed: () => false } as Page;
  const connect = vi.spyOn(browser, "getOpenBrowser").mockResolvedValue({
    contexts: () => [{ pages: () => [popup, page] }],
  } as unknown as Browser);
  const identify = vi
    .spyOn(browser, "identifyAutomationPage")
    .mockImplementation((candidate) =>
      Promise.resolve(candidate === page ? "prepared" : "search"),
    );
  await expect(browser.ownedApplicationPage("key")).resolves.toEqual({
    page: null,
  });
  expect(connect).not.toHaveBeenCalled();
  state.pageMap.get("search")!.openerId = "prepared";
  await expect(browser.ownedApplicationPage("key")).resolves.toEqual({ page });
  expect(identify).toHaveBeenCalledTimes(2);
});

test.each([100, 5_100])(
  "native owner resolver bounds Page arrival and caches older Page identities (arrival=%d)",
  async (delay) => {
    vi.useFakeTimers();
    try {
      const { browser, state } = makeBrowser();
      state.ownedTabs.set("key", new Set(["prepared"]));
      const old = { isClosed: () => false } as Page;
      const owned = { isClosed: () => false } as Page;
      const pages = [old];
      vi.spyOn(browser, "getOpenBrowser").mockResolvedValue({
        contexts: () => [{ pages: () => pages }],
      } as unknown as Browser);
      const identify = vi
        .spyOn(browser, "identifyAutomationPage")
        .mockImplementation((page) =>
          Promise.resolve(page === owned ? "prepared" : "unrelated"),
        );
      const timer = setTimeout(() => pages.push(owned), delay);
      const result = browser.ownedApplicationPage("key");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(result).resolves.toEqual({
        page: delay < 5_000 ? owned : null,
      });
      expect(identify.mock.calls.filter(([page]) => page === old)).toHaveLength(
        1,
      );
      clearTimeout(timer);
    } finally {
      vi.useRealTimers();
    }
  },
);

test.each(["connection", "guard"])(
  "native press arriving during %s reclaim survives and restores the handoff",
  async (phase) => {
    const { browser, state, pages } = makeBrowser();
    state.ownedTabs.set("old", new Set(["prepared"]));
    state.personTabs.add("prepared");
    state.personInputTabs.add("prepared");
    state.personInputAt.set("prepared", Date.now());
    const press = () => state.personSendPressedAt.set("prepared", Date.now());
    vi.spyOn(browser, "getOpenBrowser").mockImplementation(() => {
      if (phase === "connection") press();
      return Promise.resolve(null);
    });
    if (phase === "guard")
      pages
        .get("prepared")!
        .mainFrame.framesInSubtree[0]!.executeJavaScript.mockImplementation(
          () => {
            press();
            return Promise.resolve();
          },
        );
    await browser.reclaimOwnedTabs("old");
    expect(browser.ownerHasSendEvidence("old")).toBe(true);
    expect(state.personInputTabs.has("prepared")).toBe(true);
    expect(state.personTabs.has("prepared")).toBe(true);
  },
);

test("native-only owner transfer preserves the exact held tab's person and input flags", async () => {
  const { browser, state, pages } = makeBrowser();
  pages.get("prepared")!.executeJavaScript.mockImplementation(() =>
    Promise.resolve({
      title: "Application",
      bodyText: "Application received",
      controls: [],
    }),
  );
  state.ownedTabs.set("old", new Set(["prepared"]));
  state.heldTabs.set("prepared", ["old"]);
  state.parkedTabs.set("prepared", null);
  state.personTabs.add("prepared");
  state.personInputTabs.add("prepared");
  state.personInputAt.set("prepared", Date.now());
  const wrapped = withEmbeddedBrowserActivity(
    {
      ...createStubBrowserSessionRuntime({ sessions: [], catalog: [] }),
      renameApplicationPageBinding: vi.fn(async () => {}),
    },
    browser,
  );
  await expect(
    wrapped.adoptApplicationPageOwnership!("target_site", "old", "next"),
  ).resolves.toBe(true);
  expect(state.heldTabs.get("prepared")).toEqual(["old"]);
  expect(state.personTabs.has("prepared")).toBe(true);
  expect(state.parkedTabs.has("prepared")).toBe(true);
  await expect(
    wrapped.readApplicationPageWithPerson!("target_site", "next"),
  ).resolves.toMatchObject({ bodyText: "Application received" });
  expect(
    pages.get("prepared")!.mainFrame.framesInSubtree[0]!.executeJavaScript,
  ).not.toHaveBeenCalled();
});

test("a native send notification during the runtime rename keeps its original attribution and person handoff", async () => {
  const { browser, state } = makeBrowser();
  state.ownedTabs.set("old", new Set(["prepared"]));
  state.personTabs.add("prepared");
  state.personInputTabs.add("prepared");
  state.personInputAt.set("prepared", Date.now());
  vi.spyOn(browser, "getOpenBrowser").mockResolvedValue(null);
  const native = browser as unknown as { noteBoundSend(id: string): void };
  const rename = vi.fn(async () => {});
  const wrapped = withEmbeddedBrowserActivity(
    {
      ...createStubBrowserSessionRuntime({ sessions: [], catalog: [] }),
      transferApplicationPageBinding: () => {
        native.noteBoundSend("prepared");
        return Promise.resolve(true);
      },
      renameApplicationPageBinding: rename,
    },
    browser,
  );
  await expect(
    wrapped.transferApplicationPageBinding!("target_site", "old", "next"),
  ).resolves.toBe(false);
  expect(state.personSendPressedAt.has("prepared")).toBe(true);
  expect(state.personInputTabs.has("prepared")).toBe(true);
  expect(state.personTabs.has("prepared")).toBe(true);
  expect(state.ownedTabs.get("old")).toEqual(new Set(["prepared"]));
  expect(rename).toHaveBeenCalledExactlyOnceWith("target_site", "next", "old");
});
