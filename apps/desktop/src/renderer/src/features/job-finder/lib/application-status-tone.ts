import type { ApplicationWorkState } from "@nestor/contracts";

import type { BadgeTone } from "./job-finder-types";

/**
 * One colour per application state, on every screen that shows one
 * (Shortlisted, Applications, Activity, the board): a sent application is
 * "Applied" and neutral everywhere (as the Applications stage is), blue is
 * Apply at work, amber is the person's turn (an answer, a Send, a check),
 * red is a failure, grey is waiting or set aside. "Ready to send" was green
 * on Shortlisted and grey on Applications, and "Filled in" shared the green
 * of "Sent" in Activity.
 */
export const APPLICATION_WORK_TONE: Record<ApplicationWorkState, BadgeTone> = {
  queued: "muted",
  running: "active",
  submitting: "active",
  needs_you: "warning",
  ready: "warning",
  uncertain: "warning",
  blocked: "warning",
  submitted: "neutral",
  failed: "critical",
  closed: "muted",
  stopped: "muted",
  skipped: "muted",
};
