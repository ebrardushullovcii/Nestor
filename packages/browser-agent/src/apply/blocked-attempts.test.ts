import type { ApplyBlockedAttempt } from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import { attemptKey, judgeBlockedAttempt } from "./blocked-attempts";

/**
 * What the guard stops, and which of those stops matter.
 *
 * The rule is about consequence: before Job Finder has touched the page,
 * nothing the page does can be a result of this run. Afterwards, anything
 * carrying an answer is a possible save and ends the run.
 */

function attempt(
  overrides: Partial<ApplyBlockedAttempt> = {},
): ApplyBlockedAttempt {
  return {
    kind: "fetch",
    method: "POST",
    url: "https://apply.example.test/save",
    at: "2026-09-14T10:00:00.000Z",
    ...overrides,
  };
}

const PAGE_URL = "https://apply.example.test/form";

describe("blocked attempts", () => {
  test("nothing blocked is nothing to say", () => {
    const judgement = judgeBlockedAttempt({
      attempt: null,
      acknowledged: new Set(),
      hasWritten: false,
      pageUrl: PAGE_URL,
      lastFieldLabel: null,
    });
    expect(judgement).toEqual({ stop: false, tolerated: false, note: null });
  });

  test("the page's own background traffic before any fill is tolerated", () => {
    const judgement = judgeBlockedAttempt({
      attempt: attempt(),
      acknowledged: new Set(),
      hasWritten: false,
      pageUrl: PAGE_URL,
      lastFieldLabel: null,
    });
    expect(judgement).toEqual({
      stop: false,
      tolerated: true,
      note: "The page made a request of its own before anything was filled in. It was blocked and nothing was sent.",
    });
  });

  test("a same-site save while filling is blocked, noted, and not fatal", () => {
    const judgement = judgeBlockedAttempt({
      attempt: attempt(),
      acknowledged: new Set(),
      hasWritten: true,
      pageUrl: PAGE_URL,
      lastFieldLabel: "Email",
    });
    // Nothing left the page, and a form that saves as you type is ordinary.
    expect(judgement.stop).toBe(false);
    if (!judgement.stop) {
      expect(judgement.tolerated).toBe(true);
      expect(judgement.note).toContain("Blocked a background save");
      expect(judgement.note).toContain("Email");
      expect(judgement.savesAsYouGo?.host).toBe("apply.example.test");
    }
  });

  test("a request to another site carrying none of the answers is tolerated", () => {
    const judgement = judgeBlockedAttempt({
      attempt: attempt({
        url: "https://analytics.example-other.test/beacon",
        carriedPreparedValue: false,
      }),
      acknowledged: new Set(),
      hasWritten: true,
      pageUrl: PAGE_URL,
      lastFieldLabel: "Email",
    });
    expect(judgement.stop).toBe(false);
  });

  test("a request to another site that did carry an answer is blocked and named", () => {
    const judgement = judgeBlockedAttempt({
      attempt: attempt({
        url: "https://collector.example-other.test/ingest",
        carriedPreparedValue: true,
      }),
      acknowledged: new Set(),
      hasWritten: true,
      pageUrl: PAGE_URL,
      lastFieldLabel: "Email",
    });
    expect(judgement.stop).toBe(false);
    if (!judgement.stop) {
      expect(judgement.savesAsYouGo?.host).toBe("collector.example-other.test");
    }
  });

  test("the page trying to send the form always stops the run", () => {
    for (const kind of [
      "dom_submit",
      "form_submit",
      "form_request_submit",
    ] as const) {
      const judgement = judgeBlockedAttempt({
        attempt: attempt({ kind }),
        acknowledged: new Set(),
        hasWritten: false,
        pageUrl: PAGE_URL,
        lastFieldLabel: null,
      });
      expect(judgement.stop).toBe(true);
      if (judgement.stop) {
        expect(judgement.summary).toContain("send the application");
      }
    }
  });

  test("a download always stops the run", () => {
    const judgement = judgeBlockedAttempt({
      attempt: attempt({ kind: "download" }),
      acknowledged: new Set(),
      hasWritten: false,
      pageUrl: PAGE_URL,
      lastFieldLabel: null,
    });
    expect(judgement.stop).toBe(true);
  });

  test("a popup or a new window hands back where it was going instead of stopping", () => {
    for (const kind of ["popup_open", "window_open"] as const) {
      const judgement = judgeBlockedAttempt({
        attempt: attempt({ kind, url: "https://jobs.employer.test/apply/123" }),
        acknowledged: new Set(),
        hasWritten: false,
        pageUrl: PAGE_URL,
        lastFieldLabel: null,
      });
      expect(judgement.stop).toBe(false);
      if (!judgement.stop) {
        expect(judgement.tolerated).toBe(true);
        expect(judgement.openedWindow).toEqual({
          url: "https://jobs.employer.test/apply/123",
        });
        expect(judgement.note).toContain("jobs.employer.test");
      }
    }
  });

  test("something already forgiven is not raised twice", () => {
    const blocked = attempt();
    const judgement = judgeBlockedAttempt({
      attempt: blocked,
      acknowledged: new Set([attemptKey(blocked)]),
      hasWritten: true,
      pageUrl: PAGE_URL,
      lastFieldLabel: "Email",
    });
    expect(judgement).toEqual({ stop: false, tolerated: false, note: null });
  });
});
