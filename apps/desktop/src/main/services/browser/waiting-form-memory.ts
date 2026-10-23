import type { WaitingFormMemory } from "@nestor/contracts";

// Ten replica forms used ~1.3 GiB working set (265 MiB private) on a 16 GiB
// PC; a real board reached 269 MiB working set. Keep room above ten ordinary
// forms and reserve 256 MiB for another. This is a reclamation target, not
// an admission gate: waiting forms do not consume working slots.
export const WAITING_FORM_MEMORY_BUDGET = 2 * 1024 * 1024 * 1024;
const NEXT_FORM_RESERVE = 256 * 1024 * 1024;

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
  return (
    memory.measurementComplete &&
    memory.totalBytes + NEXT_FORM_RESERVE <= memory.budgetBytes
  );
}
