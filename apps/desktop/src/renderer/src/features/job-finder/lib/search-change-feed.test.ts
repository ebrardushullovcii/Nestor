import type { WorkspaceChanges } from "@nestor/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  SEARCH_PROGRESS_SYNC_INTERVAL_MS,
  SEARCH_SYNC_INTERVAL_MS,
  classifySearchChanges,
  createSearchChangeFeedFollower,
  isSearchViewRoute,
} from "./search-change-feed";

function batch(...tables: Array<[string, string?]>): WorkspaceChanges {
  return {
    changes: tables.map(([table, id = "x"], index) => ({
      revision: index + 1,
      table,
      id,
      operation: "upsert",
    })),
    revision: tables.length,
    hasMore: false,
    lists: [],
  };
}

function harness(route: string, running = true) {
  let now = 0;
  const timers: Array<{ at: number; run: () => void }> = [];
  const state = { route, running };
  const requestSync = vi.fn();
  const refreshCounts = vi.fn();
  const follower = createSearchChangeFeedFollower({
    isSearchRunning: () => state.running,
    currentRoute: () => state.route,
    requestSync,
    refreshCounts,
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      timers.splice(timers.indexOf(timer as (typeof timers)[number]), 1);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    for (const timer of [...timers].filter((entry) => entry.at <= now)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.run();
    }
  };
  return { follower, requestSync, refreshCounts, advance, state };
}

describe("search change feed", () => {
  it("knows which screens show a search", () => {
    expect(isSearchViewRoute("/job-finder/discovery")).toBe(true);
    expect(isSearchViewRoute("/job-finder/home")).toBe(true);
    expect(isSearchViewRoute("/job-finder/campaigns?edit=plan")).toBe(false);
    expect(isSearchViewRoute("/job-finder/profile?section=sources")).toBe(true);
    expect(isSearchViewRoute("/job-finder/review-queue")).toBe(false);
    expect(isSearchViewRoute("/job-finder/settings")).toBe(false);
  });

  it("tells job writes from run progress and from other work", () => {
    expect(classifySearchChanges(batch(["saved_jobs"]))).toEqual({
      jobs: true,
      run: false,
      other: false,
    });
    expect(classifySearchChanges(batch(["discovery_run_activity"]))).toEqual({
      jobs: false,
      run: true,
      other: false,
    });
    expect(classifySearchChanges(batch(["discovery_ledger"]))).toEqual({
      jobs: false,
      run: false,
      other: false,
    });
    expect(classifySearchChanges(batch(["resume_drafts"]))).toEqual({
      jobs: false,
      run: false,
      other: true,
    });
  });

  it("syncs a search screen at most once per interval, ending on the latest state", () => {
    const h = harness("/job-finder/home");
    h.follower.onChanges(batch(["saved_jobs"]));
    h.follower.onChanges(batch(["saved_jobs"]));
    h.follower.onChanges(batch(["discovery_runs"]));
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.advance(SEARCH_SYNC_INTERVAL_MS - 1);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.advance(1);
    expect(h.requestSync).toHaveBeenCalledTimes(2);
    h.advance(SEARCH_SYNC_INTERVAL_MS * 3);
    expect(h.requestSync).toHaveBeenCalledTimes(2);
  });

  it("only refreshes counts elsewhere, and catches up on a search screen", () => {
    const h = harness("/job-finder/review-queue");
    h.follower.onChanges(batch(["saved_jobs"]));
    h.follower.onChanges(batch(["discovery_run_activity"]));
    expect(h.requestSync).not.toHaveBeenCalled();
    expect(h.refreshCounts).toHaveBeenCalledTimes(1);
    h.state.route = "/job-finder/home";
    h.follower.onRouteChange();
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });

  it("leaves Find jobs' list to the feed and syncs it only for progress", () => {
    const h = harness("/job-finder/discovery");
    h.follower.onChanges(batch(["saved_jobs"]));
    expect(h.requestSync).not.toHaveBeenCalled();
    expect(h.refreshCounts).toHaveBeenCalledTimes(1);
    h.follower.onChanges(batch(["discovery_runs"]));
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.follower.onChanges(batch(["discovery_runs"]));
    h.advance(SEARCH_SYNC_INTERVAL_MS);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
    h.advance(SEARCH_PROGRESS_SYNC_INTERVAL_MS - SEARCH_SYNC_INTERVAL_MS);
    expect(h.requestSync).toHaveBeenCalledTimes(2);
  });

  it("follows other work on every screen, since main holds its notices", () => {
    const h = harness("/job-finder/review-queue");
    h.follower.onChanges(batch(["resume_drafts"]));
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });

  it("does nothing while no search runs", () => {
    const h = harness("/job-finder/discovery", false);
    h.follower.onChanges(batch(["saved_jobs"]));
    expect(h.requestSync).not.toHaveBeenCalled();
    expect(h.refreshCounts).not.toHaveBeenCalled();
  });

  it("stops its timers when disposed", () => {
    const h = harness("/job-finder/home");
    h.follower.onChanges(batch(["saved_jobs"]));
    h.follower.onChanges(batch(["saved_jobs"]));
    h.follower.dispose();
    h.advance(SEARCH_SYNC_INTERVAL_MS);
    expect(h.requestSync).toHaveBeenCalledTimes(1);
  });
});
