// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useKeptRouteHidden } from "@renderer/features/job-finder/lib/kept-route-visibility";
import { JobFinderKeptRoutesOutlet } from "./job-finder-kept-routes";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(cleanup);

function Counter(props: { name: string }) {
  const [count, setCount] = useState(0);
  const hidden = useKeptRouteHidden();
  return (
    <section>
      <h1>{props.name}</h1>
      <button onClick={() => setCount((value) => value + 1)} type="button">
        {`${props.name} count ${count}`}
      </button>
      <p>{`${props.name} hidden ${String(hidden)}`}</p>
    </section>
  );
}

function Nav() {
  const navigate = useNavigate();
  return (
    <nav>
      <button
        onClick={() => void navigate("/job-finder/discovery")}
        type="button"
      >
        go find jobs
      </button>
      <button onClick={() => void navigate("/job-finder/home")} type="button">
        go home
      </button>
    </nav>
  );
}

function renderApp() {
  render(
    <MemoryRouter initialEntries={["/job-finder/discovery"]}>
      <Routes>
        <Route
          element={
            <>
              <Nav />
              <JobFinderKeptRoutesOutlet
                context={null}
                fallback={<p>Opening</p>}
                readyMarker={null}
              />
            </>
          }
          path="/job-finder"
        >
          <Route element={<Counter name="Find jobs" />} path="discovery" />
          <Route element={<Counter name="Home" />} path="home" />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("JobFinderKeptRoutesOutlet", () => {
  it("keeps Find jobs mounted and marked hidden while Home shows", () => {
    renderApp();
    fireEvent.click(screen.getByText("Find jobs count 0"));
    expect(screen.getByText("Find jobs count 1")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByText("go home"));
    });
    expect(screen.getByText("Find jobs hidden true")).toBeTruthy();
    const frame = screen
      .getByText("Find jobs count 1")
      .closest("[data-kept-route]");
    expect(frame?.getAttribute("data-kept-route")).toBe("hidden");
    expect(frame?.hasAttribute("inert")).toBe(true);
    fireEvent.click(screen.getByText("Home count 0"));
    expect(screen.getByText("Home count 1")).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByText("go find jobs"));
    });
    // Its state is still there; Home, not kept, is gone.
    expect(screen.getByText("Find jobs count 1")).toBeTruthy();
    expect(screen.getByText("Find jobs hidden false")).toBeTruthy();
    expect(screen.queryByText(/^Home count/)).toBeNull();

    act(() => {
      fireEvent.click(screen.getByText("go home"));
    });
    // Home mounts fresh per visit.
    expect(screen.getByText("Home count 0")).toBeTruthy();
  });
});
