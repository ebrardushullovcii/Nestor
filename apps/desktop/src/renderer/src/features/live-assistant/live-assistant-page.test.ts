import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  formatRetainedCueCardCount,
  getInterviewDocumentTitle,
  getInterviewModeLabel,
  getLastJobFinderRoute,
  inferInterviewRendererPlatform,
  installJobFinderRouteRecorder,
  recordLastJobFinderRoute,
  shouldApplyInterviewWorkspaceSnapshot,
} from "./live-assistant-page";

describe("Live Assistant navigation labels", () => {
  it("describes the current section when no interview is live", () => {
    expect(getInterviewModeLabel("setup", false)).toBe("Setup mode");
    expect(getInterviewModeLabel("assist", false)).toBe("Assist mode");
    expect(getInterviewModeLabel("review", false)).toBe("Review mode");
    expect(getInterviewModeLabel("settings", false)).toBe("Settings mode");
  });

  it("keeps live-session and current-section context in labels and titles", () => {
    expect(getInterviewModeLabel("assist", true)).toBe("Live session");
    expect(getInterviewModeLabel("review", true)).toBe("Live session · Review");
    expect(getInterviewDocumentTitle("review", false)).toBe(
      "Review mode | Live Assistant | Nestor",
    );
    expect(getInterviewDocumentTitle("settings", true)).toBe(
      "Live session · Settings | Live Assistant | Nestor",
    );
  });

  it("identifies the renderer platform before the async desktop bridge replies", () => {
    expect(inferInterviewRendererPlatform("MacIntel")).toBe("darwin");
    expect(inferInterviewRendererPlatform("Linux x86_64")).toBe("linux");
    expect(inferInterviewRendererPlatform("Win32")).toBe("win32");
    expect(inferInterviewRendererPlatform("")).toBe("win32");
  });

  it("uses grammatical retained cue-card counts", () => {
    expect(formatRetainedCueCardCount(0)).toBe("0 cue cards retained");
    expect(formatRetainedCueCardCount(1)).toBe("1 cue card retained");
    expect(formatRetainedCueCardCount(2)).toBe("2 cue cards retained");
  });
});

describe("Live Assistant workspace snapshot ordering", () => {
  it("rejects an older asynchronous workspace snapshot", () => {
    expect(
      shouldApplyInterviewWorkspaceSnapshot(
        "2026-07-14T12:00:01.000Z",
        "2026-07-14T12:00:00.000Z",
      ),
    ).toBe(false);
  });

  it("accepts newer and equal workspace snapshots", () => {
    expect(
      shouldApplyInterviewWorkspaceSnapshot(
        "2026-07-14T12:00:00.000Z",
        "2026-07-14T12:00:01.000Z",
      ),
    ).toBe(true);
    expect(
      shouldApplyInterviewWorkspaceSnapshot(
        "2026-07-14T12:00:00.000Z",
        "2026-07-14T12:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("fails open when a snapshot timestamp cannot be parsed", () => {
    expect(
      shouldApplyInterviewWorkspaceSnapshot("invalid", "also-invalid"),
    ).toBe(true);
  });
});

function createMemoryStorage(
  initialValues: Record<string, string> = {},
): Storage {
  const values = new Map<string, string>(Object.entries(initialValues));
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

type RouteRecordingHistoryStub = {
  pushState: (
    data: Parameters<History["pushState"]>[0],
    unused: string,
    url?: string | URL | null,
  ) => void;
  replaceState: (
    data: Parameters<History["replaceState"]>[0],
    unused: string,
    url?: string | URL | null,
  ) => void;
};

function createHistoryStub() {
  const forwardedUrls: Array<string | URL | null | undefined> = [];
  const history: RouteRecordingHistoryStub = {
    pushState: (_data, _unused, url) => {
      forwardedUrls.push(url);
    },
    replaceState: (_data, _unused, url) => {
      forwardedUrls.push(url);
    },
  };
  return { forwardedUrls, history };
}

describe("Job Finder return-route resolution", () => {
  it("falls back to the Job Finder root when nothing was recorded yet", () => {
    expect(getLastJobFinderRoute(createMemoryStorage())).toBe("/job-finder");
  });

  it("falls back to the Job Finder root for stored non-Job-Finder routes", () => {
    const storage = createMemoryStorage({
      "nestor.live-assistant.last-job-finder-route":
        "/live-assistant/overlay/answer",
    });

    expect(getLastJobFinderRoute(storage)).toBe("/job-finder");
  });

  it("returns the last recorded Job Finder route including nested paths", () => {
    const storage = createMemoryStorage();
    recordLastJobFinderRoute(
      storage,
      "#/job-finder/applications?view=pipeline",
    );

    expect(getLastJobFinderRoute(storage)).toBe(
      "/job-finder/applications?view=pipeline",
    );
  });

  it("ignores empty and non-Job-Finder navigation targets", () => {
    const storage = createMemoryStorage();
    recordLastJobFinderRoute(storage, "#/job-finder/review-queue");
    recordLastJobFinderRoute(storage, null);
    recordLastJobFinderRoute(storage, undefined);
    recordLastJobFinderRoute(storage, "#/live-assistant/overlay/answer");
    recordLastJobFinderRoute(storage, "#/");
    recordLastJobFinderRoute(storage, "#/job-finderish/not-a-route");

    expect(getLastJobFinderRoute(storage)).toBe("/job-finder/review-queue");
  });
});

describe("Job Finder route recorder installation", () => {
  it("records Job Finder hash navigations from history writes and forwards them", () => {
    const { forwardedUrls, history } = createHistoryStub();
    const storage = createMemoryStorage();
    installJobFinderRouteRecorder(history, storage);

    history.pushState({}, "", "#/live-assistant");
    history.pushState({}, "", "#/job-finder/profile");
    history.replaceState({}, "", "#/job-finder/settings?section=audio");

    expect(forwardedUrls).toEqual([
      "#/live-assistant",
      "#/job-finder/profile",
      "#/job-finder/settings?section=audio",
    ]);
    expect(getLastJobFinderRoute(storage)).toBe(
      "/job-finder/settings?section=audio",
    );
  });

  it("installs at most one recorder per history instance", () => {
    const { forwardedUrls, history } = createHistoryStub();
    const firstStorage = createMemoryStorage();
    const secondStorage = createMemoryStorage();

    installJobFinderRouteRecorder(history, firstStorage);
    installJobFinderRouteRecorder(history, secondStorage);

    history.pushState({}, "", "#/job-finder/companies/acme");

    expect(getLastJobFinderRoute(firstStorage)).toBe(
      "/job-finder/companies/acme",
    );
    expect(
      secondStorage.getItem("nestor.live-assistant.last-job-finder-route"),
    ).toBeNull();
    expect(forwardedUrls).toEqual(["#/job-finder/companies/acme"]);
  });
});

describe("Live Assistant brand lockup token classes", () => {
  /**
   * Tailwind v4's custom-property shorthand takes the token name directly.
   * `text-(var(--x))` compiles to nothing, so the uppercase "Live Assistant"
   * subtitle silently lost its letter-spacing and small-screen size. Pin the
   * token form at the source, since a dropped class leaves no rendered trace.
   */
  const source = readFileSync(
    new URL("./live-assistant-page.tsx", import.meta.url),
    "utf8",
  );

  it("styles the wordmark with defined design tokens", () => {
    expect(source).toContain("text-(--headline-primary)");
  });

  it("names the module through the shared module switch, not a caption", () => {
    // The uppercase caption under the wordmark was replaced by the shared
    // two-option switch, which owns its own tokens; the header must not grow
    // a second, hand-styled copy of the module name.
    expect(source).toContain(
      'import { ModuleSwitch } from "@renderer/components/module-switch"',
    );
    expect(source).toContain('activeModule="live-assistant"');
    expect(source).not.toContain("formatModuleLabel");
  });

  it("names this module in full and leaves the other one to the menu", () => {
    // The header hosts the same control as the Job Finder rail, so it follows
    // the same rule: the caption prints the active module's whole name and the
    // other module waits in the switch's menu, with no truncation utility
    // anywhere near "Live Assistant". It takes the default caption variant —
    // `rail` is the 4rem collapsed rail's shape and would drop the name to an
    // icon, which this 2.5rem caption row has the width to avoid.
    const start = source.indexOf("<ModuleSwitch");
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf("/>", start) + 2);

    expect(call).toContain('activeModule="live-assistant"');
    expect(call).not.toContain('variant="rail"');
    expect(call).not.toContain("truncate");
    expect(call).not.toContain("line-clamp");
    expect(call).not.toContain("text-ellipsis");
    expect(call).toContain("sm:inline-flex");
  });

  it("wraps no custom property in var() inside a Tailwind class", () => {
    expect(source).not.toMatch(/-\((?:[A-Za-z-]+:)?var\(--/);
  });
});
