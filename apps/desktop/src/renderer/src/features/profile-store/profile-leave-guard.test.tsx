// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { getJobFinderWindowCloseConfirmation } from "@renderer/pages/job-finder-window-close-guard";
import { ProfileLeaveGuard } from "./profile-leave-guard";

// The data router builds a fetch Request for each navigation, and jsdom's
// AbortSignal fails Node's brand check inside it; React Router reads only
// the url, method and signal.
class NavigationRequestStub {
  method: string;
  signal: unknown;
  url: string;
  constructor(
    input: string | URL,
    init?: { method?: string; signal?: unknown },
  ) {
    this.url = String(input);
    this.method = (init?.method ?? "GET").toUpperCase();
    this.signal = init?.signal ?? null;
  }
}
beforeAll(() => vi.stubGlobal("Request", NavigationRequestStub));
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

function renderGuard(dirty: boolean) {
  Object.assign(window, {
    nestor: { window: { setCloseGuardState: vi.fn(() => Promise.resolve()) } },
  });
  const router = createMemoryRouter(
    [
      {
        path: "/job-finder/profile",
        element: <ProfileLeaveGuard dirty={dirty} saving={null} />,
      },
      { path: "*", element: <p>Elsewhere</p> },
    ],
    { initialEntries: ["/job-finder/profile?section=basics"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

test("unsaved edits ask before leaving, and Stay keeps the screen", async () => {
  const router = renderGuard(true);
  expect(getJobFinderWindowCloseConfirmation()?.reasons).toEqual([
    "Unsaved profile or setup changes",
  ]);
  await act(() => router.navigate("/job-finder/home"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Stay/u }));
  expect(router.state.location.pathname).toBe("/job-finder/profile");
});

test("Leave without saving goes on; a tab change never asks", async () => {
  const router = renderGuard(true);
  await act(() => router.navigate("/job-finder/profile?section=experience"));
  expect(screen.queryByRole("dialog")).toBeNull();
  await act(() => router.navigate("/job-finder/home"));
  fireEvent.click(
    screen.getByRole("button", { name: /Leave without saving/u }),
  );
  expect(await screen.findByText("Elsewhere")).toBeTruthy();
  expect(getJobFinderWindowCloseConfirmation()).toBeNull();
});

test("nothing unsaved never asks", async () => {
  const router = renderGuard(false);
  await act(() => router.navigate("/job-finder/home"));
  expect(screen.getByText("Elsewhere")).toBeTruthy();
});
