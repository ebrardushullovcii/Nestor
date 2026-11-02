// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import { installScrollActivity } from "./scroll-activity";

/** jsdom has no layout: give an element a scrolling box by hand. */
function scrollable(element: HTMLElement) {
  element.style.overflowY = "auto";
  Object.defineProperty(element, "scrollHeight", { value: 1000 });
  Object.defineProperty(element, "clientHeight", { value: 100 });
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("scroll activity marks", () => {
  it("shows the thumb only on the innermost scroll area under the pointer", () => {
    const page = scrollable(document.createElement("main"));
    const list = scrollable(document.createElement("div"));
    const row = document.createElement("button");
    list.append(row);
    page.append(list);
    document.body.append(page);
    const uninstall = installScrollActivity();

    row.dispatchEvent(new Event("pointerover", { bubbles: true }));
    // A bare :hover also matched the page column around the list.
    expect(list.hasAttribute("data-scroll-hover")).toBe(true);
    expect(page.hasAttribute("data-scroll-hover")).toBe(false);

    page.dispatchEvent(new Event("pointerover", { bubbles: true }));
    expect(list.hasAttribute("data-scroll-hover")).toBe(false);
    expect(page.hasAttribute("data-scroll-hover")).toBe(true);
    uninstall();
  });

  it("marks the scroll area that holds keyboard focus", () => {
    const pane = scrollable(document.createElement("section"));
    const field = document.createElement("input");
    pane.append(field);
    document.body.append(pane);
    const uninstall = installScrollActivity();

    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(pane.hasAttribute("data-scroll-focus")).toBe(true);
    field.dispatchEvent(
      new FocusEvent("focusout", { bubbles: true, relatedTarget: null }),
    );
    expect(pane.hasAttribute("data-scroll-focus")).toBe(false);
    uninstall();
  });
});
