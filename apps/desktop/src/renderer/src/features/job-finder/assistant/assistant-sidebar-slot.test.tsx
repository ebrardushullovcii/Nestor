// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantSidebarSlot } from "./assistant-sidebar-slot";
let open = true;
const mounts = vi.fn();
vi.mock("./assistant-provider", () => ({ useAssistant: () => ({ open }) }));
// The first screen never shows, so only the open sidebar loads the chunk.
vi.mock("../lib/after-first-screen", () => ({ afterFirstScreen: () => {} }));
vi.mock("./assistant-sidebar", async () => {
  const { useEffect } = await import("react");
  return {
    AssistantSidebar: () => {
      useEffect(() => {
        mounts();
      }, []);
      return <aside>assistant</aside>;
    },
  };
});
afterEach(() => {
  cleanup();
  open = true;
  mounts.mockClear();
});
it("keeps the sidebar mounted when it is closed before the first screen shows", async () => {
  const { rerender } = render(<AssistantSidebarSlot />);
  await screen.findByText("assistant");
  open = false;
  rerender(<AssistantSidebarSlot />);
  open = true;
  rerender(<AssistantSidebarSlot />);
  expect(screen.getByText("assistant")).toBeTruthy();
  expect(mounts).toHaveBeenCalledTimes(1);
});
it("loads nothing while closed and before the first screen shows", () => {
  open = false;
  const { container } = render(<AssistantSidebarSlot />);
  expect(container.innerHTML).toBe("");
});
