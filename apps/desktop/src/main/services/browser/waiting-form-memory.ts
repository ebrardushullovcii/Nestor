import type { WaitingFormMemory } from "@nestor/contracts";

// Opening a closed waiting page refills it without sending, so only the most
// recently prepared or opened pages waiting on the person (Ready or Needs
// you) stay live; the rest close as soon as they settle. The Speed setting
// sets how many. A real board's form uses about 200 MiB working set, so the
// budget is that much per live page. Both are reclamation targets, not
// admission gates: waiting pages do not consume working slots.
export const MAX_LIVE_WAITING_FORMS = 3;
export const WAITING_FORM_BUDGET_PER_PAGE = 200 * 1024 * 1024;
export const WAITING_FORM_MEMORY_BUDGET =
  MAX_LIVE_WAITING_FORMS * WAITING_FORM_BUDGET_PER_PAGE;

export function measureWaitingFormMemory(input: {
  recordedAt: string;
  tabs: Array<{
    tabId: string;
    processId: number;
    backgroundThrottled: boolean;
  }>;
  processes: Array<{ pid: number; memory: { workingSetSize: number } }>;
  budgetBytes?: number;
}): WaitingFormMemory {
  const budgetBytes = input.budgetBytes ?? WAITING_FORM_MEMORY_BUDGET;
  const bytesByPid = new Map(
    input.processes.map(({ pid, memory }) => [
      pid,
      Math.round(memory.workingSetSize * 1024),
    ]),
  );
  const tabs = input.tabs.map((tab) => ({
    ...tab,
    processBytes: bytesByPid.get(tab.processId) ?? null,
  }));
  const pids = new Set(tabs.map((tab) => tab.processId));
  const totalBytes = [...pids].reduce(
    (sum, pid) => sum + (bytesByPid.get(pid) ?? 0),
    0,
  );
  return {
    recordedAt: input.recordedAt,
    budgetBytes,
    totalBytes,
    measurementComplete: tabs.every((tab) => tab.processBytes !== null),
    overBudget: totalBytes > budgetBytes,
    tabs,
  };
}

export function waitingFormsHaveCapacity(memory: WaitingFormMemory): boolean {
  return memory.measurementComplete && memory.totalBytes <= memory.budgetBytes;
}
