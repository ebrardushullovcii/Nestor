import type { BrowserSessionRuntime } from "@nestor/browser-runtime";

export function toDiscoverySessionState(
  session: Awaited<ReturnType<BrowserSessionRuntime["getSessionState"]>>,
) {
  return {
    adapterKind: session.source,
    status: session.status,
    driver: session.driver,
    label: session.label,
    detail: session.detail,
    lastCheckedAt: session.lastCheckedAt,
  };
}

export function formatFoundSuffix(jobsFound: number): string {
  return jobsFound > 0 ? ` (${jobsFound} found so far)` : "";
}
