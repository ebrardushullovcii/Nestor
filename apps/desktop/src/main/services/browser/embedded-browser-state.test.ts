import { app } from "electron";
import { describe, expect, test, vi } from "vitest";
import { EmbeddedBrowser } from "./embedded-browser";

vi.mock("electron", () => ({
  app: {
    getAppMetrics: vi.fn(() => [{ pid: 100, memory: { workingSetSize: 0 } }]),
  },
  BrowserWindow: class {},
  dialog: {},
  screen: {},
  session: {},
  WebContentsView: class {},
}));

function makeBrowser() {
  const browser = new EmbeddedBrowser();
  const state = browser as unknown as {
    pageMap: Map<
      string,
      { id: string; contents: ReturnType<typeof makeContents> }
    >;
    activeTabId: string | null;
    parkedTabs: Map<string, null>;
    heldTabs: Map<string, string[]>;
    personTabs: Set<string>;
    personSendPressedAt: Map<string, number>;
    ownedTabs: Map<string, Set<string>>;
    closeReleasedOwnedTabs(): void;
    originalUserAgent: string | null;
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
      framesInSubtree: [{ executeJavaScript: vi.fn(() => Promise.resolve()) }],
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
  ).toBe("Senior Learning Coordinator · Clientnest Cobalt");
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

test("same-title tabs include place and distinguish the same place by reference", () => {
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
  ).toBe("London · Engineer · Synthetic");
  browser.setApplicationTabLabel(
    "failed",
    "Engineer",
    "Synthetic",
    "London",
    "def456",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("abc123 · London · Engineer · Synthetic");
  expect(
    browser.getState().tabs.find((tab) => tab.id === "failed")?.title,
  ).toBe("def456 · London · Engineer · Synthetic");
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

test("different places distinguish prepared tabs before a long job and employer name", () => {
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
  ).toBe("London · Senior Accountant · Synthetic Workshop");
  expect(
    browser.getState().tabs.find((tab) => tab.id === "failed")?.title,
  ).toBe("Denver · Senior Accountant · Synthetic Workshop");
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
  ).toBe("Engineer · Synthetic");
  browser.setApplicationTabLabel(
    "failed",
    "Engineer",
    "Synthetic",
    "",
    "def456",
  );
  expect(
    browser.getState().tabs.find((tab) => tab.id === "prepared")?.title,
  ).toBe("abc123 · Engineer · Synthetic");
  expect(
    browser.getState().tabs.find((tab) => tab.id === "failed")?.title,
  ).toBe("def456 · Engineer · Synthetic");
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
