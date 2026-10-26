// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useKeptRouteHidden } from "@renderer/features/job-finder/lib/kept-route-visibility";
import { JobFinderKeptRoutesOutlet } from "./job-finder-kept-routes";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  renders.mockClear();
});

const renders = vi.fn<(name: string) => void>();

function Counter(props: { name: string }) {
  renders(props.name);
  const [count, setCount] = useState(0);
  const hidden = useKeptRouteHidden();
  const location = useLocation();
  return (
    <section>
      <h1>{props.name}</h1>
      <button onClick={() => setCount((value) => value + 1)} type="button">
        {`${props.name} count ${count}`}
      </button>
      <p>{`${props.name} hidden ${String(hidden)}`}</p>
      <output aria-label={`${props.name} navigation key`}>
        {location.key}
      </output>
    </section>
  );
}

function LocationKey() {
  const location = useLocation();
  return (
    <output aria-label="Shortlisted navigation key">{location.key}</output>
  );
}

function StaticPane() {
  renders("Shortlisted");
  return (
    <section>
      <LocationKey />
    </section>
  );
}

function Nav() {
  const navigate = useNavigate();
  return (
    <nav>
      <button
        onClick={() => void navigate("/job-finder/discovery?resumeMode=edit")}
        type="button"
      >
        request resume mode
      </button>
      <button
        onClick={() => void navigate("/job-finder/discovery")}
        type="button"
      >
        go find jobs
      </button>
      <button
        onClick={() => void navigate("/job-finder/review-queue")}
        type="button"
      >
        go shortlisted
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
          <Route element={<StaticPane />} path="review-queue" />
          <Route element={<Counter name="Home" />} path="home" />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("JobFinderKeptRoutesOutlet", () => {
  it("passes a new navigation key for a repeated explicit request with an identical URL", () => {
    renderApp();
    fireEvent.click(screen.getByText("request resume mode"));
    const before = screen.getByLabelText(
      "Find jobs navigation key",
    ).textContent;
    fireEvent.click(screen.getByText("request resume mode"));
    expect(
      screen.getByLabelText("Find jobs navigation key").textContent,
    ).not.toBe(before);
  });
  it("does not re-render the kept pane on an ordinary return to the same URL", () => {
    renderApp();
    const originalKey = screen.getByLabelText(
      "Find jobs navigation key",
    ).textContent;
    fireEvent.click(screen.getByText("go home"));
    // Count the cached pane separately from its location observer, which React
    // Router can notify on navigation even when the retained value is unchanged.
    const before = renders.mock.calls.filter(
      ([name]) => name === "Shortlisted",
    ).length;
    fireEvent.click(screen.getByText("go shortlisted"));
    const afterFirst = renders.mock.calls.filter(
      ([name]) => name === "Shortlisted",
    ).length;
    expect(afterFirst).toBeGreaterThan(before);
    const firstKey = screen.getByLabelText(
      "Shortlisted navigation key",
    ).textContent;
    fireEvent.click(screen.getByText("go home"));
    const beforeReturn = renders.mock.calls.filter(
      ([name]) => name === "Shortlisted",
    ).length;
    fireEvent.click(screen.getByText("go shortlisted"));
    expect(
      screen.getByLabelText("Shortlisted navigation key").textContent,
    ).toBe(firstKey);
    expect(
      renders.mock.calls.filter(([name]) => name === "Shortlisted"),
    ).toHaveLength(beforeReturn);
    fireEvent.click(screen.getByText("go find jobs"));
    expect(screen.getByLabelText("Find jobs navigation key").textContent).toBe(
      originalKey,
    );
  });
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
