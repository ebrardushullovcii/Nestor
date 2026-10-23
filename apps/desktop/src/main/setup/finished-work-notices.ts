/**
 * Long work (a search, a resume batch, an Apply queue) shows on the taskbar
 * button while it runs, and says once that it finished when the person is
 * not looking at the window (ADR 0051: finished work only; a pause, a stop
 * or a failure stays on the app's own screens).
 */

export type LongWorkKind = "search" | "resumes" | "apply";

export interface FinishedWorkNotice {
  title: string;
  body: string;
  /** The screen the notice opens when clicked. */
  route: string;
}

export interface FinishedWorkWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  /** Electron's setProgressBar: -1 clears, 0..1 fills, above 1 is busy. */
  setProgressBar(
    progress: number,
    options?: { mode: "normal" | "indeterminate" },
  ): void;
  openRoute(route: string): void;
}

export interface FinishedWorkNotifierDeps {
  getWindow(): FinishedWorkWindow | null;
  /** Shows one system notification; `onClick` runs when it is clicked. */
  showNotification(notice: FinishedWorkNotice, onClick: () => void): void;
}

export interface FinishedWorkNotifier {
  /** Work started or moved on; `fraction` is 0..1, or null when unknown. */
  progress(kind: LongWorkKind, fraction: number | null): void;
  /**
   * Work ended. With a notice it finished and may say so; without one it
   * stopped, paused or failed and only leaves the taskbar.
   */
  end(kind: LongWorkKind, notice: FinishedWorkNotice | null): void;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function searchFinishedNotice(newJobs: number): FinishedWorkNotice {
  return {
    title: "Search finished",
    body:
      newJobs > 0
        ? `${plural(newJobs, "new job", "new jobs")} to look at`
        : "Nothing new this time",
    route: "/job-finder/discovery",
  };
}

export function resumesFinishedNotice(written: number): FinishedWorkNotice {
  return {
    title: "Resumes ready",
    body: `Finished ${plural(written, "resume", "resumes")}`,
    route: "/job-finder/review-queue",
  };
}

export function applyQueueFinishedNotice(
  jobs: number,
  sends: boolean,
): FinishedWorkNotice {
  return {
    title: "Applications finished",
    // The words Home uses for a finished queue.
    body: `${sends ? "Applied to" : "Filled in applications for"} ${plural(jobs, "job", "jobs")}`,
    route: "/job-finder/applications",
  };
}

export function createFinishedWorkNotifier(
  deps: FinishedWorkNotifierDeps,
): FinishedWorkNotifier {
  const running = new Map<LongWorkKind, number | null>();

  const paintTaskbar = () => {
    const window = deps.getWindow();
    if (!window || window.isDestroyed()) return;
    if (running.size === 0) {
      window.setProgressBar(-1);
      return;
    }
    const known = [...running.values()].filter(
      (value): value is number => value !== null,
    );
    // Two kinds at once: the bar shows the one furthest behind.
    if (known.length === running.size) {
      window.setProgressBar(Math.min(...known), { mode: "normal" });
      return;
    }
    window.setProgressBar(2, { mode: "indeterminate" });
  };

  return {
    progress(kind, fraction) {
      running.set(
        kind,
        fraction === null || !Number.isFinite(fraction)
          ? null
          : Math.min(1, Math.max(0, fraction)),
      );
      paintTaskbar();
    },
    end(kind, notice) {
      const wasRunning = running.delete(kind);
      paintTaskbar();
      if (!notice || !wasRunning) return;
      const window = deps.getWindow();
      if (!window || window.isDestroyed() || window.isFocused()) return;
      deps.showNotification(notice, () => {
        const target = deps.getWindow();
        if (!target || target.isDestroyed()) return;
        if (target.isMinimized()) target.restore();
        target.focus();
        target.openRoute(notice.route);
      });
    },
  };
}
