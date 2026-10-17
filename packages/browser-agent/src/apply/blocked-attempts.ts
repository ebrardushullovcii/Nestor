import type { ApplyBlockedAttempt } from "@nestor/contracts";

/**
 * Deciding whether something the guard blocked is worth stopping for.
 *
 * A page makes requests of its own all day: analytics, fonts, a widget posting
 * its own form. Blocking those is the containment working, not a reason to
 * stop an application. What does matter is the site trying to save an answer
 * Job Finder just typed, or trying to send the form, or trying to open a
 * window or start a download. Those stop the run and are said plainly.
 */

export function attemptKey(attempt: ApplyBlockedAttempt): string {
  return `${attempt.kind}|${attempt.method}|${attempt.url ?? ""}|${attempt.at}`;
}

function isContainmentAttempt(attempt: ApplyBlockedAttempt): boolean {
  return (
    attempt.kind === "popup_open" ||
    attempt.kind === "download" ||
    attempt.kind === "window_open"
  );
}

function isPageOwnBackgroundTraffic(attempt: ApplyBlockedAttempt): boolean {
  return !attempt.kind.includes("submit") && !isContainmentAttempt(attempt);
}

function isCrossOrigin(
  attempt: ApplyBlockedAttempt,
  pageUrl: string | null,
): boolean {
  if (!attempt.url || !pageUrl) {
    return false;
  }
  try {
    return new URL(attempt.url).origin !== new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

export type BlockedAttemptJudgement =
  | {
      stop: false;
      tolerated: boolean;
      note: string | null;
      /**
       * Set when the page tried to open another tab. Job Finder works in one
       * tab, so the popup was closed; this is where it was going, so the run
       * can open it here instead. Null when the address was not readable.
       */
      openedWindow?: { url: string | null };
      /**
       * Set when the blocked request was the site saving an answer as it was
       * typed. Nothing left the page and the run carries on; it only matters
       * later, if the form will not move on without that save.
       */
      savesAsYouGo?: { host: string | null };
    }
  | { stop: true; summary: string };

/** The site a blocked request was heading for, in the person's words. */
export function attemptHost(attempt: ApplyBlockedAttempt): string | null {
  if (!attempt.url) return null;
  try {
    return new URL(attempt.url).hostname.replace(/^www\./iu, "");
  } catch {
    return null;
  }
}

/**
 * What to do about the most recent blocked attempt.
 *
 * `hasWritten` is whether Job Finder has touched the page yet. Before it has,
 * nothing the page does can be a consequence of this run, so ordinary
 * background traffic is noted and tolerated. Once it has, every same-origin
 * write is a possible save of an answer and stops the run.
 */
export function judgeBlockedAttempt(input: {
  attempt: ApplyBlockedAttempt | null;
  acknowledged: ReadonlySet<string>;
  hasWritten: boolean;
  pageUrl: string | null;
  lastFieldLabel: string | null;
}): BlockedAttemptJudgement {
  const { attempt } = input;
  if (!attempt) {
    return { stop: false, tolerated: false, note: null };
  }
  if (input.acknowledged.has(attemptKey(attempt))) {
    return { stop: false, tolerated: false, note: null };
  }

  if (attempt.kind === "download") {
    return {
      stop: true,
      summary:
        "The site tried to download a file on its own, so Job Finder stopped and left the form as it was.",
    };
  }

  // A new tab is not an attack; it is how most job boards hand you to the
  // employer's own site. The popup is closed because the run lives in one
  // tab, and the address it was going to is handed back so the run can go
  // there itself.
  if (isContainmentAttempt(attempt)) {
    const host = attemptHost(attempt);
    return {
      stop: false,
      tolerated: true,
      note: host
        ? `The page tried to open ${host} in a new tab. Job Finder keeps to one tab, so it opened the address here instead.`
        : "The page tried to open a new tab, which Job Finder closed; it works in one tab.",
      openedWindow: { url: attempt.url },
    };
  }

  if (!input.hasWritten && isPageOwnBackgroundTraffic(attempt)) {
    return {
      stop: false,
      tolerated: true,
      note: "The page made a request of its own before anything was filled in. It was blocked and nothing was sent.",
    };
  }

  // The guard could see the form when it blocked this. A request to another
  // site carrying none of the answers cannot have saved one.
  if (
    attempt.carriedPreparedValue === false &&
    isCrossOrigin(attempt, input.pageUrl) &&
    (!input.hasWritten || isPageOwnBackgroundTraffic(attempt))
  ) {
    return {
      stop: false,
      tolerated: true,
      note: "The page made a request to another site carrying none of your answers. It was blocked and nothing was sent.",
    };
  }

  if (attempt.kind.includes("submit")) {
    return {
      stop: true,
      summary:
        "The page tried to send the application on its own. Job Finder blocked it and stopped, so nothing was sent.",
    };
  }

  // A form that saves each answer as it is typed is ordinary. The guard
  // refuses the save, so nothing leaves the page, and the run keeps filling:
  // stopping here left the person with a dead end and a Try again that did
  // the same thing. It matters only if the form then will not move on.
  const host = attemptHost(attempt);
  const where = host ?? "the site";
  return {
    stop: false,
    tolerated: true,
    note: input.lastFieldLabel
      ? `Blocked a background save to ${where} while filling ${input.lastFieldLabel}.`
      : `Blocked a background save to ${where} while the form was being filled in.`,
    savesAsYouGo: { host },
  };
}
