// @vitest-environment jsdom

import type { JobSitePage } from "@nestor/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

import { SitePicker } from "./site-picker";

afterEach(cleanup);

function Destination() {
  return <p>Profile opened at {useLocation().search}</p>;
}

it("takes someone without enabled sites straight to Profile's Job sources", async () => {
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
  render(
    <MemoryRouter initialEntries={["/job-finder/discovery"]}>
      <Routes>
        <Route
          path="/job-finder/discovery"
          element={
            <SitePicker
              value={{ all: true, except: [] }}
              onChange={() => undefined}
            />
          }
        />
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
});
