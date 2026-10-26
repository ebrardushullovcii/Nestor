// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SettingsWorkspaceControls } from "./settings-workspace-controls";

describe("SettingsWorkspaceControls", () => {
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
    vi.clearAllMocks();
  });

  function renderControls(onResetWorkspace = vi.fn()) {
    container = document.createElement("div");
    container.id = "root";
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <SettingsWorkspaceControls
          isWorkspaceResetPending={false}
          onResetWorkspace={onResetWorkspace}
        />,
      );
    });

    return onResetWorkspace;
  }

  test("requires an explicit, clearly labeled confirmation before resetting", async () => {
    const onResetWorkspace = renderControls();
    const resetEntryButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Reset everything",
    );

    expect(resetEntryButton).toBeDefined();

    act(() => {
      resetEntryButton?.click();
    });

    const dialog = document.querySelector('[role="dialog"]');
    const confirmButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Reset workspace",
    );

    expect(dialog?.textContent).toContain("This cannot be undone.");
    const descriptionId = dialog?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "This permanently deletes your profile",
    );
    expect(confirmButton).toBeDefined();
    expect(onResetWorkspace).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
      confirmButton?.click();
    });

    expect(onResetWorkspace).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  test("keeps reset pending and reports a rejected reset inside the open dialog", async () => {
    let rejectReset: (error: Error) => void = () => {};
    renderControls(
      vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectReset = reject;
          }),
      ),
    );
    act(() => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Reset everything")
        ?.click();
    });
    await act(async () => {
      await Promise.resolve();
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "Reset workspace")
        ?.click();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Resetting workspace",
    );
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "app-managed exports",
    );
    await act(() =>
      Promise.resolve(
        rejectReset(
          new Error("clearStorageData failed for synthetic_session_42"),
        ),
      ),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector('[role="dialog"] [role="alert"]')?.textContent,
    ).toContain("Reset did not finish");
    const alert = document.querySelector('[role="dialog"] [role="alert"]');
    expect(alert?.querySelector("p")?.textContent).not.toContain(
      "synthetic_session_42",
    );
    expect(alert?.querySelector("details")?.textContent).toContain(
      "synthetic_session_42",
    );
    expect(alert?.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  test("cancels without invoking the destructive action", () => {
    const onResetWorkspace = renderControls();
    const resetEntryButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Reset everything",
    );

    act(() => {
      resetEntryButton?.click();
    });

    const cancelButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Cancel",
    );

    act(() => {
      cancelButton?.click();
    });

    expect(onResetWorkspace).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
