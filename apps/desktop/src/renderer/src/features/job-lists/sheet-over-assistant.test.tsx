// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ListDetailLayout } from "./index";

const html = document.documentElement;

afterEach(() => {
  cleanup();
  html.removeAttribute("data-assistant-sidebar");
  html.removeAttribute("data-reading-over-assistant");
});

function layout(open: boolean) {
  return (
    <ListDetailLayout
      detail={<p>Resume</p>}
      list={<p>Rows</p>}
      sheet={{ open }}
      sheetAlways
      sheetOverAssistant
    />
  );
}

const panel = () =>
  document.querySelector<HTMLElement>("[data-detail-sheet-panel]");

it("spans the docked chat's width while the reading sheet is open, and gives the chat back on Back", () => {
  html.setAttribute("data-assistant-sidebar", "docked");
  const view = render(layout(true));
  expect(panel()?.style.position).toBe("fixed");
  // jsdom is 1024 wide and lays nothing out: the box reaches the gutter.
  expect(panel()?.style.width).toBe("1008px");
  expect(html.hasAttribute("data-reading-over-assistant")).toBe(true);
  view.rerender(layout(false));
  expect(html.hasAttribute("data-reading-over-assistant")).toBe(false);
  expect(panel()?.style.position).toBe("");
});

it("leaves the chat alone when the assistant is not docked", () => {
  render(layout(true));
  expect(panel()?.style.position).toBe("");
  expect(html.hasAttribute("data-reading-over-assistant")).toBe(false);
});

it("goes back to the main column when the person reopens or closes the assistant while reading", async () => {
  html.setAttribute("data-assistant-sidebar", "docked");
  render(layout(true));
  expect(html.hasAttribute("data-reading-over-assistant")).toBe(true);
  await act(async () => {
    html.setAttribute("data-assistant-sidebar", "closed");
    await Promise.resolve();
  });
  expect(html.hasAttribute("data-reading-over-assistant")).toBe(false);
  expect(panel()?.style.position).toBe("");
});
