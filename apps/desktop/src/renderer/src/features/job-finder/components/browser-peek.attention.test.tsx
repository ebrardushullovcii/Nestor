import { ToastProvider } from "@renderer/components/ui/toast";
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  DesktopBrowserBridge,
  DesktopBrowserState,
} from "@nestor/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserPeek } from "./browser-peek";
import { workThrough } from "../../needs-you/work-through";

const staleAttentionState: DesktopBrowserState = {
  revision: 4,
  phase: "needs_you",
  presentation: "minimized",
  tabs: [],
  activeTabId: null,
  activity: null,
  attention: {
    kind: "user_action",
    title: "This page needs a human",
    detail: "A handoff was waiting.",
  },
  automationPaused: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BrowserPeek handoff attention", () => {
  it("clears the derived browser chip when the workspace has no unresolved handoff", async () => {
    const previousBridge = window.nestor;
    const browser: DesktopBrowserBridge = {
      passwords: {
        list: vi.fn(),
        save: vi.fn(),
        dismiss: vi.fn(),
        autofill: vi.fn(),
        delete: vi.fn(),
        importCsv: vi.fn(),
        importFromBrowser: vi.fn(),
      },
      addCurrentJob: vi.fn(),
      getState: vi.fn().mockResolvedValue(staleAttentionState),
      command: vi.fn().mockResolvedValue(staleAttentionState),
      setViewport: vi.fn().mockResolvedValue(undefined),
      captureActivePage: vi.fn().mockResolvedValue({ dataUrl: null }),
      listImportSources: vi.fn().mockResolvedValue({ sources: [], note: null }),
      importFromBrowser: vi.fn().mockResolvedValue({
        status: "cancelled",
        cookieCount: 0,
        siteCount: 0,
        message: "Cancelled.",
      }),
      onStateChanged: vi.fn().mockReturnValue(() => undefined),
      onFocusAddress: vi.fn().mockReturnValue(() => undefined),
    };
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { browser },
    });

    const view = render(<BrowserPeek hasUnresolvedAttention />);
    expect(
      await screen.findByRole("button", {
        name: /This page needs a human/,
      }),
    ).toBeTruthy();

    view.rerender(<BrowserPeek hasUnresolvedAttention={false} />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Job Finder browser.*Ready/i }),
      ).toBeTruthy(),
    );
    expect(screen.queryByLabelText(/This page needs a human/)).toBeNull();

    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: previousBridge,
    });
  });
});

it("saves the exact current tab from the visible Add this job action", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const previous = window.nestor;
  let finishAdd!: (value: {
    jobId: string;
    title: string;
    company: string;
    planName: string;
  }) => void;
  const addCurrentJob = vi.fn(
    () =>
      new Promise((resolve) => {
        finishAdd = resolve;
      }),
  );
  const saved = {
    jobId: "17",
    title: "Designer",
    company: "Example Studio",
    planName: "Design",
  };
  const runJobs = vi.fn().mockResolvedValue({ moved: 1, moveId: 3 });
  const state: DesktopBrowserState = {
    ...staleAttentionState,
    phase: "ready",
    attention: null,
    presentation: "peek",
    activeTabId: "chosen",
    tabs: [
      {
        id: "chosen",
        title: "Designer",
        url: "https://jobs.example.test/one",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  };
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobs: { run: runJobs },
      browser: {
        addCurrentJob,
        getState: vi.fn().mockResolvedValue(state),
        command: vi.fn().mockResolvedValue(state),
        setViewport: vi.fn().mockResolvedValue(undefined),
        captureActivePage: vi.fn().mockResolvedValue({ dataUrl: null }),
        onStateChanged: () => () => undefined,
        onFocusAddress: () => () => undefined,
      },
    },
  });
  try {
    render(<BrowserPeek />);
    fireEvent.click(
      await screen.findByRole("button", { name: "More browser actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Add this job" }));
    await waitFor(() =>
      expect(addCurrentJob).toHaveBeenCalledExactlyOnceWith({
        tabId: "chosen",
      }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Adding this job…",
    );
    finishAdd(saved);
    await screen.findByText("Saved Designer at Example Studio.");
    expect(screen.getByRole("status").textContent).toContain("Shortlist");
    fireEvent.click(screen.getByRole("button", { name: "Shortlist" }));
    await waitFor(() =>
      expect(runJobs).toHaveBeenCalledWith("move_jobs", {
        selection: { ids: [17] },
        to: "shortlisted",
      }),
    );
    await screen.findByText("Designer at Example Studio added to Shortlisted.");
    addCurrentJob.mockImplementationOnce(() =>
      Promise.reject(
        new Error(
          "No job listing was found on this page. Open the job's own listing and try again.",
        ),
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "More browser actions" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Add this job" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "No job listing",
      ),
    );
  } finally {
    cleanup();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: previous,
    });
    vi.unstubAllGlobals();
  }
});

it("shows a dismissible recording prompt for an unbound send without blocking browser input", async () => {
  const previous = window.nestor;
  const onRecordSend = vi.fn();
  const command = vi.fn().mockResolvedValue(staleAttentionState);
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      browser: {
        getState: vi.fn().mockResolvedValue({
          ...staleAttentionState,
          attention: null,
          unboundSendNotice: { id: "send_notice", tabId: "general" },
        }),
        command,
        setViewport: vi.fn().mockResolvedValue(undefined),
        onStateChanged: vi.fn().mockReturnValue(() => undefined),
        onFocusAddress: vi.fn().mockReturnValue(() => undefined),
      },
    },
  });
  try {
    render(
      <ToastProvider>
        <BrowserPeek onRecordSend={onRecordSend} />
      </ToastProvider>,
    );
    expect(
      await screen.findByText("This page is not linked to an application"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Record it in Applications" }),
    );
    expect(onRecordSend).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith({ type: "minimize" });
    expect(command).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "stop" }),
    );
  } finally {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: previous,
    });
  }
});

function peekBridge(state: DesktopBrowserState) {
  let listener: ((next: DesktopBrowserState) => void) | null = null;
  const command = vi.fn().mockResolvedValue(state);
  return {
    command,
    emit: (next: DesktopBrowserState) => listener?.(next),
    browser: {
      getState: vi.fn().mockResolvedValue(state),
      command,
      setViewport: vi.fn().mockResolvedValue(undefined),
      captureActivePage: vi.fn().mockResolvedValue({ dataUrl: null }),
      listImportSources: vi.fn().mockResolvedValue({ sources: [], note: null }),
      onStateChanged: (next: (value: DesktopBrowserState) => void) => {
        listener = next;
        return () => undefined;
      },
      onFocusAddress: () => () => undefined,
    },
  };
}

const openPage: DesktopBrowserState = {
  ...staleAttentionState,
  phase: "ready",
  attention: null,
  presentation: "peek",
  activeTabId: "form",
  tabs: [
    {
      id: "form",
      title: "Apply · Lantern Services",
      url: "http://127.0.0.1:47950/lever/apply/7",
      loading: false,
      canGoBack: false,
      canGoForward: false,
    },
  ],
};

it("offers a manual browser fallback without retrying or resuming verification", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const previous = window.nestor;
  const peek = peekBridge(openPage);
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { browser: peek.browser },
  });
  try {
    render(<BrowserPeek />);
    fireEvent.click(
      await screen.findByRole("button", { name: "More browser actions" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Open in my browser" }),
    );
    await screen.findByText(
      /Nestor cannot observe or continue work in that browser/,
    );
    expect(peek.command).toHaveBeenCalledExactlyOnceWith({
      type: "open_in_browser",
    });
  } finally {
    cleanup();
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: previous,
    });
    vi.unstubAllGlobals();
  }
});

describe("BrowserPeek after the person's own Send", () => {
  it("says the application was sent and links to it, without an empty browser grabbing focus", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const previous = window.nestor;
    const peek = peekBridge(openPage);
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { browser: peek.browser },
    });
    const onOpenApplication = vi.fn();
    try {
      render(
        <ToastProvider>
          <BrowserPeek onOpenApplication={onOpenApplication} />
        </ToastProvider>,
      );
      await screen.findByRole("dialog");
      // The sent form's tab closes while the peek is still open: the page
      // goes blank, and the address bar must not take focus by itself.
      act(() =>
        peek.emit({
          ...openPage,
          revision: 6,
          tabs: [],
          activeTabId: null,
          sentNotice: {
            id: "sent_1",
            applicationId: 3,
            jobId: 42,
            company: "Lantern Services",
            title: "Backend Engineer",
          },
        }),
      );
      expect(
        await screen.findByText("Sent: Backend Engineer at Lantern Services"),
      ).toBeTruthy();
      expect(screen.getByText("Moved to Applied.")).toBeTruthy();
      expect(document.activeElement).not.toBe(
        screen.getByRole("textbox", { name: "Website address" }),
      );
      // One Escape hides the empty browser.
      fireEvent.keyDown(
        screen.getByRole("textbox", { name: "Website address" }),
        { key: "Escape" },
      );
      expect(peek.command).toHaveBeenCalledWith({ type: "minimize" });
      peek.command.mockClear();
      fireEvent.click(
        screen.getByRole("button", { name: "Open in Applications" }),
      );
      expect(onOpenApplication).toHaveBeenCalledWith(42);
      expect(peek.command).toHaveBeenCalledWith({ type: "minimize" });
    } finally {
      cleanup();
      Object.defineProperty(window, "nestor", {
        configurable: true,
        value: previous,
      });
      vi.unstubAllGlobals();
    }
  });

  it("focuses the address bar when the person opens an empty browser, and one Escape hides it", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const previous = window.nestor;
    const peek = peekBridge({ ...openPage, tabs: [], activeTabId: null });
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { browser: peek.browser },
    });
    try {
      render(<BrowserPeek />);
      const address = await screen.findByRole("textbox", {
        name: "Website address",
      });
      await waitFor(() => expect(document.activeElement).toBe(address));
      fireEvent.keyDown(address, { key: "Escape" });
      expect(peek.command).toHaveBeenCalledExactlyOnceWith({
        type: "minimize",
      });
    } finally {
      cleanup();
      Object.defineProperty(window, "nestor", {
        configurable: true,
        value: previous,
      });
      vi.unstubAllGlobals();
    }
  });
});

describe("BrowserPeek during a walk through sign-ins", () => {
  afterEach(() => workThrough.reset());

  it("shows where the walk is, checks a site on Done and pauses when hidden", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const previous = window.nestor;
    const peek = peekBridge(openPage);
    const needsYou = vi.fn().mockResolvedValue(true);
    const jobs = vi.fn((name: string) =>
      Promise.resolve(
        name === "retry_source"
          ? { search: { id: "search_1", state: "running" }, sources: [] }
          : { rows: [], nextCursor: null, total: 0 },
      ),
    );
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        browser: peek.browser,
        needsYou: { run: needsYou },
        jobs: { run: jobs, onSearchStatus: () => () => undefined },
      },
    });
    const site = (id: number, label: string) => ({
      id,
      kind: "site" as const,
      label,
      taskIds: [id],
      sources: [{ id: id * 10, url: `https://${label}.example.test/jobs` }],
    });
    try {
      render(<BrowserPeek />);
      // Needs you's sign-in tab carries its own "then Retry" banner.
      act(() =>
        peek.emit({
          ...openPage,
          revision: 5,
          phase: "needs_you",
          attention: {
            kind: "sign_in",
            title: "Sign in to continue: scale-853",
            detail:
              "Finish sign-in or verification here, then Retry in Needs you.",
          },
        }),
      );
      act(() => workThrough.start([site(1, "scale-853"), site(2, "orbit")]));
      expect(needsYou).toHaveBeenCalledWith("open_need", { id: 1 });
      const bar = () =>
        document.querySelector("[data-browser-walk]")?.textContent ?? "";
      await waitFor(() => expect(bar()).toContain("scale-853 · 1 of 2"));
      // The walk's bar replaces it rather than contradicting Done.
      expect(screen.queryByText(/then Retry in Needs you/)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Done, next site" }));
      await waitFor(() =>
        expect(jobs).toHaveBeenCalledWith("retry_source", { id: 10 }),
      );
      expect(needsYou).toHaveBeenCalledWith("open_need", { id: 2 });
      expect(bar()).toContain("orbit · 2 of 2");
      act(() =>
        peek.emit({ ...openPage, revision: 9, presentation: "minimized" }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      // Hiding the browser paused the walk: reopened, it waits for Continue.
      act(() => peek.emit({ ...openPage, revision: 10 }));
      await screen.findByRole("dialog");
      expect(bar()).toBe("");
      act(() => workThrough.resume());
      expect(bar()).toContain("orbit · 2 of 2");
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      expect(bar()).toBe("");
      expect(peek.command).toHaveBeenCalledWith({ type: "minimize" });
    } finally {
      cleanup();
      Object.defineProperty(window, "nestor", {
        configurable: true,
        value: previous,
      });
      vi.unstubAllGlobals();
    }
  });
});
