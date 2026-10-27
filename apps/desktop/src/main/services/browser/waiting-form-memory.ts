import type { WaitingFormMemory } from "@nestor/contracts";

// Opening a closed waiting form refills it without sending, so only the most
// recently prepared or opened forms stay live; the rest close as soon as they
// settle. A real board's form uses about 200 MiB working set, so three fit
// the budget. Both are reclamation targets, not admission gates: waiting
// forms do not consume working slots.
export const MAX_LIVE_WAITING_FORMS = 3;
export const WAITING_FORM_MEMORY_BUDGET = 600 * 1024 * 1024;

export function measureWaitingFormMemory(input: {
  recordedAt: string;
  tabs: Array<{
    tabId: string;
    processId: number;
    backgroundThrottled: boolean;
  }>;
  processes: Array<{ pid: number; memory: { workingSetSize: number } }>;
}): WaitingFormMemory {
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
    budgetBytes: WAITING_FORM_MEMORY_BUDGET,
    totalBytes,
    measurementComplete: tabs.every((tab) => tab.processBytes !== null),
    overBudget: totalBytes > WAITING_FORM_MEMORY_BUDGET,
    tabs,
  };
}

export function waitingFormsHaveCapacity(memory: WaitingFormMemory): boolean {
  return memory.measurementComplete && memory.totalBytes <= memory.budgetBytes;
}
