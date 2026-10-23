// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  focusVisibleListSearch,
  handleListSearchEscape,
} from "./list-search-focus";
import {
  historyStepForKey,
  historyStepForMouseButton,
} from "./use-history-navigation-shortcuts";

function field(parent: HTMLElement, value = ""): HTMLInputElement {
  const input = document.createElement("input");
  input.setAttribute("data-list-search", "");
  input.value = value;
  // jsdom has no layout; a visible field has at least one box.
  input.getClientRects = () =>
    [{ height: 32, width: 200 }] as unknown as DOMRectList;
  parent.append(input);
  return input;
}

describe("focusVisibleListSearch", () => {
  it("focuses the shown list's search and skips one kept behind another screen", () => {
    const root = document.createElement("div");
    const hidden = document.createElement("section");
    hidden.setAttribute("data-kept-route", "hidden");
    const shown = document.createElement("section");
    shown.setAttribute("data-kept-route", "shown");
    root.append(hidden, shown);
    document.body.append(root);
    field(hidden, "old");
    const target = field(shown, "react");

    expect(focusVisibleListSearch(root)).toBe(true);
    expect(document.activeElement).toBe(target);
    expect(target.selectionStart).toBe(0);
    expect(target.selectionEnd).toBe(5);
    root.remove();
  });

  it("reports false when the screen has no list search", () => {
    const root = document.createElement("div");
    expect(focusVisibleListSearch(root)).toBe(false);
  });
});

describe("handleListSearchEscape", () => {
  const escape = (input: HTMLInputElement) => ({
    currentTarget: input,
    key: "Escape",
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });

  it("clears the text first, then leaves the field", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const onQueryChange = vi.fn();

    handleListSearchEscape(escape(input), "react", onQueryChange);
    expect(onQueryChange).toHaveBeenCalledWith("");
    expect(document.activeElement).toBe(input);

    handleListSearchEscape(escape(input), "", onQueryChange);
    expect(onQueryChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input);
    input.remove();
  });
});

describe("history steps", () => {
  const key = (
    k: string,
    mods: Partial<
      Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey", boolean>
    >,
  ) => ({
    altKey: false,
    ctrlKey: false,
    key: k,
    metaKey: false,
    shiftKey: false,
    ...mods,
  });

  it("maps Alt+Left/Right and the mouse side buttons only", () => {
    expect(historyStepForKey(key("ArrowLeft", { altKey: true }))).toBe(-1);
    expect(historyStepForKey(key("ArrowRight", { altKey: true }))).toBe(1);
    expect(historyStepForKey(key("ArrowLeft", {}))).toBeNull();
    expect(
      historyStepForKey(key("ArrowLeft", { altKey: true, shiftKey: true })),
    ).toBeNull();
    expect(historyStepForMouseButton(3)).toBe(-1);
    expect(historyStepForMouseButton(4)).toBe(1);
    expect(historyStepForMouseButton(0)).toBeNull();
  });
});
