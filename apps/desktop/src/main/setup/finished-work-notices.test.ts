import { describe, expect, it, vi } from "vitest";
import {
  applyQueueFinishedNotice,
  createFinishedWorkNotifier,
  resumesFinishedNotice,
  searchFinishedNotice,
  type FinishedWorkNotice,
  type FinishedWorkWindow,
} from "./finished-work-notices";

function fakeWindow(focused: boolean) {
  const window = {
    isDestroyed: () => false,
    isFocused: vi.fn(() => focused),
    isMinimized: () => true,
    restore: vi.fn(),
    focus: vi.fn(),
    setProgressBar: vi.fn(),
    openRoute: vi.fn(),
  } satisfies FinishedWorkWindow;
  return window;
}

describe("finished work notices", () => {
  it("fills the taskbar while work runs and clears it when nothing runs", () => {
    const window = fakeWindow(true);
    const notifier = createFinishedWorkNotifier({
      getWindow: () => window,
      showNotification: vi.fn(),
    });

    notifier.progress("resumes", 0.25);
    expect(window.setProgressBar).toHaveBeenLastCalledWith(0.25, {
      mode: "normal",
    });
    notifier.progress("search", null);
    expect(window.setProgressBar).toHaveBeenLastCalledWith(2, {
      mode: "indeterminate",
    });
    notifier.end("search", null);
    notifier.progress("apply", 0.1);
    expect(window.setProgressBar).toHaveBeenLastCalledWith(0.1, {
      mode: "normal",
    });
    notifier.end("apply", null);
    notifier.end("resumes", null);
    expect(window.setProgressBar).toHaveBeenLastCalledWith(-1);
  });

  it("says a job finished once, only while the window is not focused", () => {
    const unfocused = fakeWindow(false);
    const showNotification =
      vi.fn<(notice: FinishedWorkNotice, onClick: () => void) => void>();
    const notifier = createFinishedWorkNotifier({
      getWindow: () => unfocused,
      showNotification,
    });

    notifier.progress("search", null);
    notifier.end("search", searchFinishedNotice(34));
    // A second end for the same work is not a second finished job.
    notifier.end("search", searchFinishedNotice(34));
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(showNotification.mock.calls[0]?.[0]).toEqual({
      title: "Search finished",
      body: "34 new jobs to look at",
      route: "/job-finder/discovery",
    });

    // The click brings the window back on the screen the notice is about.
    showNotification.mock.calls[0]?.[1]();
    expect(unfocused.restore).toHaveBeenCalled();
    expect(unfocused.focus).toHaveBeenCalled();
    expect(unfocused.openRoute).toHaveBeenCalledWith("/job-finder/discovery");

    const focused = fakeWindow(true);
    const quiet = vi.fn();
    const watching = createFinishedWorkNotifier({
      getWindow: () => focused,
      showNotification: quiet,
    });
    watching.progress("resumes", 0.5);
    watching.end("resumes", resumesFinishedNotice(10));
    expect(quiet).not.toHaveBeenCalled();
  });

  it("stays quiet for work that paused, stopped or failed", () => {
    const window = fakeWindow(false);
    const showNotification = vi.fn();
    const notifier = createFinishedWorkNotifier({
      getWindow: () => window,
      showNotification,
    });
    notifier.progress("apply", 0.5);
    notifier.end("apply", null);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("words each finished job plainly", () => {
    expect(searchFinishedNotice(0).body).toBe("Nothing new this time");
    expect(searchFinishedNotice(1).body).toBe("1 new job to look at");
    expect(resumesFinishedNotice(12)).toMatchObject({
      title: "Resumes ready",
      body: "Finished 12 resumes",
      route: "/job-finder/review-queue",
    });
    expect(applyQueueFinishedNotice(10, false).body).toBe(
      "Filled in applications for 10 jobs",
    );
    expect(applyQueueFinishedNotice(1, true).body).toBe("Applied to 1 job");
  });
});
