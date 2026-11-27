import type {
  IndexPageLog,
  JobDiscoveryTarget,
  JobSearchSettings,
  JobSearchSourceRow,
  SourceNavigationProgress,
} from "@nestor/contracts";

export interface SourceWork {
  target: JobDiscoveryTarget;
  /** Read the whole site even in a Quick search (the person chose Keep reading). */
  full: boolean;
  row: JobSearchSourceRow;
  urls: Set<string>;
  /** Index page addresses this run has read on the site, requested and landed. */
  indexPages: Set<string>;
  /** Index pages this search finished on the site, kept across restarts. */
  pageLog?: IndexPageLog;
  /** Where browser collections of the site had got to, kept across restarts. */
  navigation?: {
    read(startUrl: string): SourceNavigationProgress | null;
    save(startUrl: string, progress: SourceNavigationProgress): void;
  };
  processed: number;
  /** Listings the site answered as removed; recorded closed, never read. */
  removed: number;
  screened: number;
  collected: boolean;
  accessBlocked: boolean;
  counted: boolean;
  notes: string[];
  /** The notes come from an attempt that read listings or finished. */
  notesRead: boolean;
  readFailures: string[];
  /** Why this run's last attempt on the site failed; a resume tries it again. */
  failure: string | null;
  /** Why the attempt before this run failed, kept for the site's message. */
  earlierFailure: string | null;
  completeAccess?: () => void;
}
/** Keep reading reads the whole site, as a Thorough search does. */
export function sourceSettings(
  settings: JobSearchSettings,
  source: SourceWork,
): JobSearchSettings {
  return source.full ? { ...settings, depth: "thorough" } : settings;
}

/** A site's outcome is settled: later work on it must not mark it searching or done. */
export function settledState(state: JobSearchSourceRow["state"]): boolean {
  return (
    state === "needs_you" ||
    state === "failed" ||
    state === "stopped" ||
    state === "partial"
  );
}

export function sourceWork(
  target: JobDiscoveryTarget,
  full = false,
): SourceWork {
  return {
    target,
    full,
    urls: new Set(),
    indexPages: new Set(),
    processed: 0,
    removed: 0,
    screened: 0,
    collected: false,
    accessBlocked: false,
    counted: false,
    notes: [],
    notesRead: false,
    readFailures: [],
    failure: null,
    earlierFailure: null,
    row: {
      sourceId: target.id,
      label: target.label,
      url: target.startingUrl,
      state: "waiting",
      lane: null,
      phase: "http",
      cards: 0,
      related: 0,
      unrelated: 0,
      seen: 0,
      failedReads: 0,
      found: 0,
      added: 0,
      hidden: 0,
      message: null,
    },
  };
}
