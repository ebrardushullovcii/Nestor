// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildJobFinderShortcutHelp,
  eventMatchesJobFinderShortcut,
  formatJobFinderShortcutCombo,
  getJobFinderAriaKeyshortcuts,
  getJobFinderShortcutKeycaps,
  isEditableShortcutTarget,
  isImeComposingEvent,
  isInteractiveShortcutTarget,
  JOB_FINDER_SHORTCUTS,
} from "./job-finder-shortcuts";

function keyEvent(
  overrides: Partial<{
    altKey: boolean;
    ctrlKey: boolean;
    isComposing?: boolean;
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
  }> = {},
) {
  return {
    altKey: false,
    ctrlKey: false,
    key: "k",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("job finder shortcut registry", () => {
  it("matches modifier combos across platform modifiers without strays", () => {
    expect(
      eventMatchesJobFinderShortcut(keyEvent({ metaKey: true }), "mod+k"),
    ).toBe(true);
    expect(
      eventMatchesJobFinderShortcut(keyEvent({ ctrlKey: true }), "mod+k"),
    ).toBe(true);
    expect(
      eventMatchesJobFinderShortcut(
        keyEvent({ key: "K", metaKey: true }),
        "mod+k",
      ),
    ).toBe(true);
    expect(eventMatchesJobFinderShortcut(keyEvent(), "mod+k")).toBe(false);
    expect(
      eventMatchesJobFinderShortcut(
        keyEvent({ altKey: true, metaKey: true }),
        "mod+k",
      ),
    ).toBe(false);
    expect(
      eventMatchesJobFinderShortcut(keyEvent({ metaKey: true }), "mod+b"),
    ).toBe(false);
    expect(
      eventMatchesJobFinderShortcut(
        keyEvent({ shiftKey: true, metaKey: true }),
        "mod+k",
      ),
    ).toBe(false);
  });

  it("matches the slash alias only with no command modifiers", () => {
    expect(eventMatchesJobFinderShortcut(keyEvent({ key: "/" }), "/")).toBe(
      true,
    );
    expect(
      eventMatchesJobFinderShortcut(
        keyEvent({ key: "/", shiftKey: true }),
        "/",
      ),
    ).toBe(true);
    expect(
      eventMatchesJobFinderShortcut(keyEvent({ key: "/", ctrlKey: true }), "/"),
    ).toBe(false);
  });

  it("detects editable and interactive targets", () => {
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const contentEditable = document.createElement("div");
    contentEditable.setAttribute("contenteditable", "true");
    const button = document.createElement("button");

    for (const element of [input, textarea, select, contentEditable]) {
      expect(isEditableShortcutTarget(element)).toBe(true);
    }
    expect(isEditableShortcutTarget(button)).toBe(false);
    expect(isEditableShortcutTarget(null)).toBe(false);

    expect(isInteractiveShortcutTarget(button)).toBe(true);
    expect(isInteractiveShortcutTarget(document.createElement("div"))).toBe(
      false,
    );
  });

  it("flags IME composition through isComposing and keyCode 229", () => {
    expect(isImeComposingEvent({ isComposing: true })).toBe(true);
    expect(isImeComposingEvent({ keyCode: 229 })).toBe(true);
    expect(isImeComposingEvent({})).toBe(false);
  });

  it("formats combos and aria-keyshortcuts per platform", () => {
    expect(formatJobFinderShortcutCombo("mod+k", "darwin")).toBe("⌘K");
    expect(formatJobFinderShortcutCombo("mod+k", "win32")).toBe("Ctrl K");
    expect(formatJobFinderShortcutCombo("/", "darwin")).toBe("/");
    expect(formatJobFinderShortcutCombo("?", "win32")).toBe("?");
    expect(getJobFinderAriaKeyshortcuts("mod+b", "darwin")).toBe("Meta+b");
    expect(getJobFinderAriaKeyshortcuts("mod+b", "linux")).toBe("Control+b");
  });

  it("builds one help row per shortcut id and scope, never merging scopes", () => {
    // Grouping by id alone used to concatenate two different conditions into
    // one three-line grey paragraph beside a pair of keycaps that read as a
    // single broken token.
    expect(buildJobFinderShortcutHelp("darwin").slice(0, 5)).toEqual([
      {
        combos: [["⌘", "K"]],
        id: "open-global-search",
        rowId: "open-global-search::Anywhere in Job Finder",
        label: "Search your workspace",
        scope: "Anywhere in Job Finder",
      },
      {
        combos: [["/"]],
        id: "focus-list-search",
        rowId: "focus-list-search::Outside text fields, controls, and dialogs",
        label: "Search this list, or your workspace off a list",
        scope: "Outside text fields, controls, and dialogs",
      },
      {
        combos: [["⌘", "B"]],
        id: "toggle-sidebar",
        rowId:
          "toggle-sidebar::Wide layout only, outside overlays, search, and editable fields",
        label: "Show or hide the sidebar",
        scope:
          "Wide layout only, outside overlays, search, and editable fields",
      },
      {
        combos: [["⌘", "I"]],
        id: "toggle-assistant",
        rowId: "toggle-assistant::Anywhere in Job Finder",
        label: "Show or hide the assistant",
        scope: "Anywhere in Job Finder",
      },
      {
        combos: [["?"]],
        id: "open-shortcuts",
        rowId: "open-shortcuts::Outside text fields, controls, and dialogs",
        label: "Show keyboard shortcuts",
        scope: "Outside text fields, controls, and dialogs",
      },
    ]);
    // A modifier and its key are separate caps so the row reads as "hold
    // Ctrl, press K" instead of one "Ctrl K" token.
    expect(buildJobFinderShortcutHelp("win32")[0]?.combos).toEqual([
      ["Ctrl", "K"],
    ]);
    expect(getJobFinderShortcutKeycaps("mod+k", "darwin")).toEqual(["⌘", "K"]);
    expect(getJobFinderShortcutKeycaps("mod+b", "linux")).toEqual([
      "Ctrl",
      "B",
    ]);
    expect(getJobFinderShortcutKeycaps("?", "darwin")).toEqual(["?"]);
    for (const entry of buildJobFinderShortcutHelp("win32")) {
      expect(entry.scope).not.toContain(";");
    }
  });

  it("matches the literal ? combo without colliding with /", () => {
    expect(eventMatchesJobFinderShortcut(keyEvent({ key: "?" }), "?")).toBe(
      true,
    );
    expect(eventMatchesJobFinderShortcut(keyEvent({ key: "?" }), "/")).toBe(
      false,
    );
    expect(eventMatchesJobFinderShortcut(keyEvent({ key: "/" }), "?")).toBe(
      false,
    );
    expect(
      eventMatchesJobFinderShortcut(keyEvent({ key: "?", metaKey: true }), "?"),
    ).toBe(false);
  });

  it("states the Cmd+B scope truthfully for every platform", () => {
    const toggleSidebar = JOB_FINDER_SHORTCUTS.find(
      (shortcut) => shortcut.combo === "mod+b",
    );
    expect(toggleSidebar?.scope).toBe(
      "Wide layout only, outside overlays, search, and editable fields",
    );
    // The registry cannot drift back to an unconditional claim without this
    // failing: the hook gates the combo behind wide layout, overlays, search,
    // and editable targets.
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(buildJobFinderShortcutHelp(platform)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "toggle-sidebar",
            scope:
              "Wide layout only, outside overlays, search, and editable fields",
          }),
        ]),
      );
    }
  });
});

it.each(["darwin", "win32", "linux"] as const)(
  "lists standard zoom shortcuts on %s",
  (platform) => {
    const modifier = platform === "darwin" ? "⌘" : "Ctrl";
    expect(
      buildJobFinderShortcutHelp(platform)
        .slice(-3)
        .map(({ label, combos }) => ({ label, combos })),
    ).toEqual([
      { label: "Zoom In", combos: [[modifier, "="]] },
      { label: "Zoom Out", combos: [[modifier, "-"]] },
      { label: "Actual Size", combos: [[modifier, "0"]] },
    ]);
  },
);
