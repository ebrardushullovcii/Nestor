// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProfileSaveFooter } from "./profile-save-footer";

function renderFooter(overrides?: {
  actionMessage?: string | null;
  hasUnsavedChanges?: boolean;
  isSavePending?: boolean;
  onSave?: () => void;
  validationMessage?: string | null;
}) {
  return render(
    <ProfileSaveFooter
      actionMessage={overrides?.actionMessage ?? null}
      hasUnsavedChanges={overrides?.hasUnsavedChanges ?? false}
      isSavePending={overrides?.isSavePending ?? false}
      onSave={overrides?.onSave ?? vi.fn()}
      validationMessage={overrides?.validationMessage ?? null}
    />,
  );
}

describe("ProfileSaveFooter", () => {
  afterEach(() => {
    cleanup();
  });

  it("does not accuse the person of unsaved work when only an import filled the page", () => {
    render(
      <ProfileSaveFooter
        actionMessage={null}
        hasUnsavedChanges
        hasUserEdits={false}
        isSavePending={false}
        onSave={vi.fn()}
        validationMessage={null}
      />,
    );

    expect(
      screen.getByText("Imported details on this page are not saved yet."),
    ).toBeTruthy();
    expect(screen.queryByText("Unsaved changes on this page.")).toBeNull();
  });

  it("saves on Ctrl+S only when there is something to save", () => {
    const onSave = vi.fn();
    const { unmount } = renderFooter({ onSave });
    const clean = fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    // The browser's own "Save page" never opens, even with nothing to save.
    expect(clean).toBe(false);
    expect(onSave).not.toHaveBeenCalled();
    unmount();

    renderFooter({ onSave, hasUnsavedChanges: true });
    fireEvent.keyDown(window, { key: "s" });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "S", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("button", { name: "Save changes" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Control+s");
  });

  it("keeps Save changes disabled until the form is dirty", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <ProfileSaveFooter
        actionMessage={null}
        hasUnsavedChanges={false}
        isSavePending={false}
        onSave={onSave}
        validationMessage={null}
      />,
    );

    const button = screen.getByRole("button", { name: "Save changes" });
    // A clean form keeps native disabled semantics.
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-disabled")).toBeNull();

    rerender(
      <ProfileSaveFooter
        actionMessage={null}
        hasUnsavedChanges
        isSavePending={false}
        onSave={onSave}
        validationMessage={null}
      />,
    );

    expect(
      screen
        .getByRole("button", { name: "Save changes" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("retains focus on Save changes while the save is pending and blocks activation", () => {
    const onSave = vi.fn();
    const view = renderFooter({ hasUnsavedChanges: true, onSave });

    const button = screen.getByRole("button", { name: "Save changes" });
    button.focus();
    expect(document.activeElement).toBe(button);

    view.rerender(
      <ProfileSaveFooter
        actionMessage={null}
        hasUnsavedChanges
        isSavePending
        onSave={onSave}
        validationMessage={null}
      />,
    );

    // Pending keeps the control exposed but inert without dropping focus.
    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: " " });
    fireEvent.click(screen.getByText(/Unsaved changes on this page/));
    expect(onSave).not.toHaveBeenCalled();

    view.rerender(
      <ProfileSaveFooter
        actionMessage={null}
        hasUnsavedChanges
        isSavePending={false}
        onSave={onSave}
        validationMessage={null}
      />,
    );

    // Pending -> ready restores activation under the retained focus.
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-busy")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("describes the disabled save with its reason and never with a live region", () => {
    renderFooter({
      actionMessage: "Profile saved.",
      hasUnsavedChanges: false,
      validationMessage: "Add an email address before saving.",
    });

    const button = screen.getByRole("button", { name: "Save changes" });
    const statuses = screen.getAllByRole("status");
    expect(statuses.map((status) => status.textContent)).toEqual([
      "Add an email address before saving.",
      "Profile saved.",
    ]);

    // The validation and last-action messages already live in role="status"
    // regions; pointing the button at either would announce it twice. The
    // save-state line is not a live region, so a greyed Save can carry it as
    // a visible, announced reason instead of being unexplained.
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(
      statuses.some((status) => status.getAttribute("id") === describedBy),
    ).toBe(false);
    const reason = document.getElementById(describedBy ?? "");
    expect(reason?.textContent).toBe("No unsaved changes.");
    expect(reason?.getAttribute("data-profile-save-state")).toBe("clean");
  });

  it("turns Save off when the page is clean and on when it is dirty", () => {
    const { rerender } = renderFooter({ hasUnsavedChanges: false });

    const cleanButton = screen.getByRole("button", { name: "Save changes" });
    expect((cleanButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      document
        .querySelector("[data-profile-save-state]")
        ?.getAttribute("data-profile-save-state"),
    ).toBe("clean");

    rerender(
      <ProfileSaveFooter
        actionMessage={null}
        hasUnsavedChanges
        isSavePending={false}
        onSave={() => {}}
        validationMessage={null}
      />,
    );

    const dirtyButton = screen.getByRole("button", { name: "Save changes" });
    expect((dirtyButton as HTMLButtonElement).disabled).toBe(false);
    expect(dirtyButton.getAttribute("aria-describedby")).toBeNull();
    const dirtyState = document.querySelector("[data-profile-save-state]");
    expect(dirtyState?.getAttribute("data-profile-save-state")).toBe("dirty");
    expect(dirtyState?.textContent).toBe("Unsaved changes on this page.");
  });

  it("offers the Assistant launcher slot as a sibling of Save", () => {
    // Pinned by attribute name on purpose. `ProfileCopilotRail` resolves this
    // slot first and falls back to `[data-profile-workspace-actions]` (the
    // footer root) for guided-setup footers, which have no slot. That fallback
    // is deliberate — and it is exactly why a rename here would otherwise be
    // silent: the launcher would quietly go back to rendering below the Save
    // row instead of beside it.
    renderFooter({ hasUnsavedChanges: true });

    const slot = document.querySelector<HTMLElement>(
      "[data-profile-assistant-launcher-slot]",
    );
    const save = screen.getByRole("button", { name: "Save changes" });

    expect(slot).not.toBeNull();
    expect(slot?.parentElement).toBe(save.parentElement);
    // `display: contents` so the docked launcher lays out as Save's sibling
    // rather than inside a wrapper box of its own.
    expect(slot?.className).toContain("contents");
  });
});
