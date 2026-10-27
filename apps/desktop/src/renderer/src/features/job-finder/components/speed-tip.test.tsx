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
import { SpeedTip, isStrongComputer } from "./speed-tip";

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.hash}`}</p>;
}

function install(device: { memoryGb: number; cores: number }, speed?: string) {
  Object.assign(window, {
    nestor: {
      ping: () => Promise.resolve({ ok: true, platform: "win32", ...device }),
      jobs: {
        run: () => Promise.resolve(speed ? { speedLevel: speed } : {}),
      },
    },
  });
}

function renderTip() {
  render(
    <MemoryRouter initialEntries={["/job-finder/home"]}>
      <SpeedTip />
      <Routes>
        <Route element={<Where />} path="*" />
      </Routes>
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

test("dismissing the tip ends it for good", async () => {
  install({ memoryGb: 31.8, cores: 16 });
  renderTip();
  await waitForTip();
  fireEvent.click(
    screen.getByRole("button", { name: "Dismiss the Speed tip" }),
  );
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
