import { ToastProvider } from "@renderer/components/ui/toast";
// @vitest-environment jsdom

import {
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
    jobId: "saved",
    title: "Designer",
    company: "Example Studio",
    planName: "Design",
  };
  const queueJobForReview = vi.fn().mockResolvedValue(undefined);
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
      jobFinder: { queueJobForReview },
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
      expect(queueJobForReview).toHaveBeenCalledWith("saved"),
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
