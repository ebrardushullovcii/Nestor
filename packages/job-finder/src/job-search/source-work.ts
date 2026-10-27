import type { JobDiscoveryTarget, JobSearchSourceRow } from "@nestor/contracts";

export interface SourceWork {
  target: JobDiscoveryTarget;
  row: JobSearchSourceRow;
  urls: Set<string>;
  processed: number;
  screened: number;
  unrelatedRun: number;
  quickStopReason?: string;
  collected: boolean;
  accessBlocked: boolean;
  counted: boolean;
  notes: string[];
}
export function sourceWork(target: JobDiscoveryTarget): SourceWork {
  return {
    target,
    urls: new Set(),
    processed: 0,
    screened: 0,
    unrelatedRun: 0,
    collected: false,
    accessBlocked: false,
    counted: false,
    notes: [],
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
