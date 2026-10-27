import type { TriageStage } from "@nestor/contracts";

export interface TriageAction {
  to: TriageStage;
  label: string;
  /** The key that does it. */
  key: string;
  /** What the toast says after, e.g. "Shortlisted 3 jobs". */
  done: string;
  /** The bulk button with the ticked count, e.g. "Hide 6,418". */
  bulk: (count: string) => string;
}

const SHORTLIST: TriageAction = {
  to: "shortlisted",
  label: "Shortlist",
  key: "s",
  done: "Shortlisted",
  bulk: (count) => `Shortlist ${count}`,
};
const HIDE: TriageAction = {
  to: "hidden",
  label: "Hide",
  key: "h",
  done: "Hid",
  bulk: (count) => `Hide ${count}`,
};
const BACK: TriageAction = {
  to: "found",
  label: "Move back to Find jobs",
  key: "r",
  done: "Moved back",
  bulk: (count) => `Move ${count} back`,
};

const SHOW_AGAIN: TriageAction = {
  to: "found",
  label: "Show again",
  key: "r",
  done: "Showing again",
  bulk: (count) => `Show ${count} again`,
};

/** The moves each tab offers, main one first. */
export const TRIAGE_ACTIONS: Record<TriageStage, readonly TriageAction[]> = {
  found: [SHORTLIST, HIDE],
  shortlisted: [BACK, HIDE],
  hidden: [SHOW_AGAIN, SHORTLIST],
};
