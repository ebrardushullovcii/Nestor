// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { JobFinderDiagnosticExportResult } from "@nestor/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsSupportControls } from "./settings-support-controls";

describe("SettingsSupportControls", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    document.body.replaceChildren();
    container = null;
    root = null;
    vi.restoreAllMocks();
  });

  function renderControls(
    exportDiagnostics: () => Promise<JobFinderDiagnosticExportResult>,
  ) {
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: {
        jobFinder: {
          exportDiagnostics,
        },
      },
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<SettingsSupportControls />);
    });

    const button = [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === "Export diagnostics",
    );

    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.getAttribute("type")).toBe("button");
    button?.focus();
    expect(document.activeElement).toBe(button);

    return button as HTMLButtonElement;
  }

  test("uses the typed preload bridge and reports a saved local export without exposing a path", async () => {
    const exportDiagnostics = vi
      .fn()
      .mockResolvedValue({ status: "saved" } as const);
    const button = renderControls(exportDiagnostics);

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Diagnostic report saved on this device.",
    );
    expect(document.body.textContent).not.toMatch(/[A-Z]:\\|file:\/\//i);
  });

  test("keeps the button pending and prevents duplicate export requests", async () => {
    let resolveExport:
      | ((result: JobFinderDiagnosticExportResult) => void)
      | undefined;
    const exportDiagnostics = vi.fn(
      () =>
        new Promise<JobFinderDiagnosticExportResult>((resolve) => {
          resolveExport = resolve;
        }),
    );
    const button = renderControls(exportDiagnostics);

    act(() => {
      button.click();
    });

    const pendingButton = document.querySelector("button");
    expect(pendingButton?.hasAttribute("disabled")).toBe(false);
    expect(pendingButton?.getAttribute("aria-disabled")).toBe("true");
    expect(pendingButton?.getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Preparing a local diagnostic report…",
    );

    act(() => {
      pendingButton?.click();
    });
    expect(exportDiagnostics).toHaveBeenCalledOnce();

    await act(async () => {
      resolveExport?.({ status: "cancelled" });
      await Promise.resolve();
    });
  });

  test("reports cancellation truthfully", async () => {
    const button = renderControls(
      vi.fn().mockResolvedValue({ status: "cancelled" } as const),
    );

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Export cancelled. No diagnostic report was saved.",
    );
  });

  test("reports a failed save without exposing exception details", async () => {
    const button = renderControls(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "C:\\Users\\private\\diagnostics.json could not be written",
          ),
        ),
    );

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Could not export the diagnostic report. Try again.",
    );
    expect(document.body.textContent).not.toContain("C:\\Users\\private");
  });
});
