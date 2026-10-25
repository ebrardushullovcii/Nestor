import type { TriageStage } from "@nestor/contracts";

export interface TriageAction {
  to: TriageStage;
  label: string;
  /** The key that does it. */
  key: string;
  /** What the toast says after, e.g. "Shortlisted 3 jobs". */
  done: string;
}

const SHORTLIST: TriageAction = {
  to: "shortlisted",
  label: "Shortlist",
  key: "s",
  done: "Shortlisted",
};
const HIDE: TriageAction = {
  to: "hidden",
  label: "Hide",
  key: "h",
  done: "Hid",
};
const BACK: TriageAction = {
  to: "found",
  label: "Move back to Find jobs",
  key: "r",
  done: "Moved back",
};

const SHOW_AGAIN: TriageAction = {
  to: "found",
  label: "Show again",
  key: "r",
  done: "Showing again",
};

/** The moves each tab offers, main one first. */
export const TRIAGE_ACTIONS: Record<TriageStage, readonly TriageAction[]> = {
  found: [SHORTLIST, HIDE],
  shortlisted: [BACK, HIDE],
  hidden: [SHOW_AGAIN, SHORTLIST],
};
