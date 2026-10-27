// @vitest-environment jsdom

import type { JobSitePage } from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createKeptRouteVisibility,
  KeptRouteVisibilityContext,
} from "@renderer/features/job-finder/lib/kept-route-visibility";

import { SitePicker } from "./site-picker";

afterEach(cleanup);

function Destination() {
  return <p>Profile opened at {useLocation().search}</p>;
}

beforeEach(() => {
  const empty: JobSitePage = {
    rows: [],
    total: 0,
    enabledTotal: 0,
    selected: 0,
    nextCursor: null,
    counts: { all: 0, enabled: 0, disabled: 0, needs_attention: 0 },
  };
  Object.assign(window, {
    nestor: {
      jobs: {
        run: vi.fn(() => Promise.resolve(empty)),
        onChange: () => () => undefined,
      },
    },
  });
});

it("closes the kept site's picker when opening Profile's Job sources", async () => {
  render(
    <MemoryRouter initialEntries={["/job-finder/discovery"]}>
      <SitePicker
        value={{ all: true, except: [] }}
        onChange={() => undefined}
      />
      <Routes>
        <Route path="/job-finder/discovery" element={null} />
        <Route path="/job-finder/profile" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "No sites yet" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Add sites in Profile" }),
  );
  expect(
    await screen.findByText(
      "Profile opened at ?section=sources&focus=job-sources",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Sites to search" })).toBeNull();
});

it("closes on any route hide and stays closed when Find jobs is shown again", async () => {
  const visibility = createKeptRouteVisibility(false);
  render(
    <MemoryRouter>
      <KeptRouteVisibilityContext.Provider value={visibility}>
        <SitePicker
          value={{ all: true, except: [] }}
          onChange={() => undefined}
        />
      </KeptRouteVisibilityContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "No sites yet" }));
  expect(screen.getByRole("dialog", { name: "Sites to search" })).toBeTruthy();
  act(() => visibility.setHidden(true));
  expect(screen.queryByRole("dialog", { name: "Sites to search" })).toBeNull();
  act(() => visibility.setHidden(false));
  expect(screen.queryByRole("dialog", { name: "Sites to search" })).toBeNull();
  expect(
    (await screen.findByRole("button", { name: "No sites yet" })).getAttribute(
      "aria-expanded",
    ),
  ).toBe("false");
});
