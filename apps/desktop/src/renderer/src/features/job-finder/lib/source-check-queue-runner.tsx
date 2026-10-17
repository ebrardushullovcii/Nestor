import type { SourceDebugRunRecord } from "@nestor/contracts";
import { useSourceCheckQueueRunner } from "./source-check-queue";

/**
 * Mounted once at the Job Finder page level so "Check these N sources" keeps
 * advancing on every screen, not only while Profile is open.
 */
export function SourceCheckQueueRunner(props: {
  isSourceDebugPending: (targetId: string) => boolean;
  recentSourceDebugRuns: readonly SourceDebugRunRecord[];
  onRunSourceDebug: (targetId: string) => void;
}): null {
  useSourceCheckQueueRunner(props);
  return null;
}
