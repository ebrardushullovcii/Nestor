// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const feed = vi.fn();
const unsubscribe = vi.fn();

/** A fresh copy of the hook's module state for each test. */
async function load() {
  vi.resetModules();
  const hook = await import("./use-activity-feed");
  function Feed() {
    const { feed: value } = hook.useActivityFeed();
    return <p data-testid="feed">{value ? JSON.stringify(value) : "none"}</p>;
  }
  return { ...hook, Feed };
}

const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(10);
  });

beforeEach(() => {
  vi.useFakeTimers();
  feed.mockReset().mockResolvedValue({ rows: [] });
  unsubscribe.mockReset();
  Object.assign(window, {
    nestor: {
      activity: { feed },
      jobs: { onChange: () => unsubscribe, onSearchStatus: () => unsubscribe },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test("a refresh due after the last user unmounts never reads", async () => {
  const { Feed, refreshActivityFeed } = await load();
  render(<Feed />);
  await settle();
  expect(feed).toHaveBeenCalledTimes(1);
  refreshActivityFeed();
  cleanup();
  expect(unsubscribe).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(feed).toHaveBeenCalledTimes(1);
  // With nobody using it, a refresh schedules nothing either.
  refreshActivityFeed();
  expect(vi.getTimerCount()).toBe(0);
});

test("a read still on its way when the last user unmounts is dropped", async () => {
  const { Feed } = await load();
  let answer!: (value: unknown) => void;
  feed.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
  render(<Feed />);
  await settle();
  cleanup();
  answer({ rows: ["late"] });
  await vi.advanceTimersByTimeAsync(0);
  // Mounted again, it shows its own fresh read, never the dropped one.
  feed.mockReturnValueOnce(new Promise(() => undefined));
  render(<Feed />);
  await settle();
  expect(screen.getByTestId("feed").textContent).toBe("none");
  expect(feed).toHaveBeenCalledTimes(2);
});
