// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "@renderer/components/ui/toast";
import { SpeedTip, isStrongComputer } from "./speed-tip";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.hash}`}</p>;
}

let found = 12;
let notify: ((change: { stages: string[] }) => void) | null = null;

function install(device: { memoryGb: number; cores: number }, speed?: string) {
  Object.assign(window, {
    nestor: {
      ping: () => Promise.resolve({ ok: true, platform: "win32", ...device }),
      jobs: {
        run: (name: string) =>
          Promise.resolve(
            name === "stage_counts"
              ? { found, hidden: 0, shortlisted: 0, resume: 0, applied: 0 }
              : speed
                ? { speedLevel: speed }
                : {},
          ),
        onChange: (listener: (change: { stages: string[] }) => void) => {
          notify = listener;
          return () => {
            notify = null;
          };
        },
      },
    },
  });
}

function renderTip() {
  render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <ToastProvider>
        <SpeedTip />
        <Routes>
          <Route element={<Where />} path="*" />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function waitForTip() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  found = 12;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("a strong computer counts from 16 GB and 8 cores", () => {
  expect(isStrongComputer({ memoryGb: 15.8, cores: 8 })).toBe(true);
  expect(isStrongComputer({ memoryGb: 7.8, cores: 8 })).toBe(false);
  expect(isStrongComputer({ memoryGb: 31.8, cores: 4 })).toBe(false);
});

test("on a strong computer at Standard, the tip opens the Speed setting once", async () => {
  install({ memoryGb: 31.8, cores: 16 });
  renderTip();
  await waitForTip();
  fireEvent.click(screen.getByRole("button", { name: "Speed setting" }));
  expect(screen.getByTestId("where").textContent).toBe(
    "/job-finder/settings#settings-speed",
  );
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
  cleanup();
  renderTip();
  await waitForTip();
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
});

test("the tip goes twelve seconds after it shows, unless the person is on it", async () => {
  install({ memoryGb: 31.8, cores: 16 });
  renderTip();
  await waitForTip();
  const tip = () => screen.queryByText(/can run more at once/u);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(tip()).toBeTruthy();
  const aside = tip()!.closest("[data-toast]")!;
  fireEvent.mouseEnter(aside);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(tip()).toBeTruthy();
  fireEvent.mouseLeave(aside);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_000);
  });
  expect(tip()).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(tip()).toBeNull();
});

test("dismissing the tip ends it for good", async () => {
  install({ memoryGb: 31.8, cores: 16 });
  renderTip();
  await waitForTip();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  cleanup();
  renderTip();
  await waitForTip();
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
});

test("no tip on an 8 GB laptop or when a faster level is already on", async () => {
  install({ memoryGb: 7.8, cores: 8 });
  renderTip();
  await waitForTip();
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
  cleanup();
  install({ memoryGb: 31.8, cores: 16 }, "faster");
  renderTip();
  await waitForTip();
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
});

test("the tip is a quiet side note: no main button, gone by itself, and seen once shown", async () => {
  install({ memoryGb: 31.8, cores: 16 });
  renderTip();
  await waitForTip();
  expect(screen.getByText(/can run more at once/u)).toBeTruthy();
  // No claim about free memory, and no button that outranks the screen's own.
  expect(screen.queryByText(/plenty of memory/u)).toBeNull();
  expect(screen.queryByRole("button", { name: /Open Speed/u })).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(13_000);
  });
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
  cleanup();
  renderTip();
  await waitForTip();
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
});

test("waits for the first search: no tip over a first run's empty screens", async () => {
  found = 0;
  install({ memoryGb: 31.8, cores: 16 });
  renderTip();
  await waitForTip();
  expect(screen.queryByText(/can run more at once/u)).toBeNull();
  // The first search finds jobs; the tip follows a moment later.
  found = 9;
  act(() => notify?.({ stages: ["found"] }));
  await waitForTip();
  expect(screen.getByText(/can run more at once/u)).toBeTruthy();
});
