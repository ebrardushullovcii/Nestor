import { ToastProvider } from "@renderer/components/ui/toast";
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

test("offers a workspace export before deletion and retains data if export fails", async () => {
  const exportPersonalWorkspace = vi
    .fn()
    .mockRejectedValue(new Error("disk full"));
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: { jobFinder: { exportPersonalWorkspace } },
  });
  const onResetWorkspace = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SettingsWorkspaceControls
        isWorkspaceResetPending={false}
        onResetWorkspace={onResetWorkspace}
      />,
    );
  });
  act(() => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Reset everything"))
      ?.click();
  });
  await act(async () => {
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Export first"))
      ?.click();
    await Promise.resolve();
  });
  expect(exportPersonalWorkspace).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Nothing was deleted");
  expect(onResetWorkspace).not.toHaveBeenCalled();
  act(() => root.unmount());
  document.body.replaceChildren();
});

test("personal export toast names the saved path and explains included chats", async () => {
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobFinder: {
        exportPersonalWorkspace: vi.fn().mockResolvedValue({
          status: "saved",
          filePath: "/chosen/synthetic-workspace.json",
          exportedCount: 3,
        }),
      },
    },
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() =>
    Promise.resolve(
      root.render(
        <ToastProvider>
          <SettingsWorkspaceControls
            isWorkspaceResetPending={false}
            onResetWorkspace={vi.fn()}
          />
        </ToastProvider>,
      ),
    ),
  );
  await act(async () => {
    await Promise.resolve();
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Export personal workspace")
      ?.click();
  });
  expect(document.body.textContent).toContain(
    "Saved to /chosen/synthetic-workspace.json",
  );
  expect(container.textContent).toContain("answers and chats");
  act(() => root.unmount());
  document.body.replaceChildren();
});

test("restore previews all workspace contents and requires confirmation", async () => {
  const { render, fireEvent, cleanup } = await import("@testing-library/react");
  const previewPersonalWorkspaceRestore = vi.fn().mockResolvedValue({
    token: "00000000-0000-4000-8000-000000000001",
    profileName: "Synthetic Example",
    exportedAt: "2026-10-05T10:00:00.000Z",
    jobs: 3,
    applications: 2,
    answers: 4,
    documents: 5,
    chats: 1,
  });
  const confirmPersonalWorkspaceRestore = vi
    .fn()
    .mockResolvedValue({ safetyExportPath: "/synthetic/safety.json" });
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      jobFinder: {
        previewPersonalWorkspaceRestore,
        confirmPersonalWorkspaceRestore,
      },
    },
  });
  const view = render(
    <ToastProvider>
      <SettingsWorkspaceControls
        isWorkspaceResetPending={false}
        onResetWorkspace={vi.fn()}
      />
    </ToastProvider>,
  );
  fireEvent.click(view.getByRole("button", { name: "Restore from an export" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(view.getByRole("dialog").textContent).toContain(
    "3 jobs, 2 applications, 4 answers, 5 documents and 1 chat",
  );
  expect(view.getByRole("dialog").textContent).toContain("safety export");
  expect(confirmPersonalWorkspaceRestore).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole("button", { name: "Restore workspace" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(confirmPersonalWorkspaceRestore).toHaveBeenCalledWith({
    token: "00000000-0000-4000-8000-000000000001",
  });
  expect(view.queryByRole("dialog")).toBeNull();
  cleanup();
});
