import { expect, test } from "vitest";
import {
  measureWaitingFormMemory,
  waitingFormsHaveCapacity,
  WAITING_FORM_MEMORY_BUDGET,
} from "./waiting-form-memory";

const recordedAt = "2026-10-05T10:00:00Z";
test("records every retained tab's process memory in bytes and counts shared renderers once", () => {
  const memory = measureWaitingFormMemory({
    recordedAt,
    tabs: [
      { tabId: "one", processId: 1, backgroundThrottled: true },
      { tabId: "two", processId: 1, backgroundThrottled: true },
      { tabId: "three", processId: 2, backgroundThrottled: false },
    ],
    processes: [
      { pid: 1, memory: { workingSetSize: 100 * 1024 } },
      { pid: 2, memory: { workingSetSize: 50 * 1024 } },
      { pid: 3, memory: { workingSetSize: 999999 } },
    ],
  });
  expect(memory.tabs.map((tab) => tab.processBytes)).toEqual([
    100 * 1024 * 1024,
    100 * 1024 * 1024,
    50 * 1024 * 1024,
  ]);
  expect(memory.totalBytes).toBe(150 * 1024 * 1024);
  expect(memory.measurementComplete).toBe(true);
  expect(waitingFormsHaveCapacity(memory)).toBe(true);
});

test("unknown memory stays unmeasured, never a measured zero", () => {
  const memory = measureWaitingFormMemory({
    recordedAt,
    tabs: [{ tabId: "one", processId: 0, backgroundThrottled: true }],
    processes: [],
  });
  expect(memory.tabs[0]?.processBytes).toBeNull();
  expect(memory.measurementComplete).toBe(false);
  expect(waitingFormsHaveCapacity(memory)).toBe(false);
});

test("waiting forms over the budget have no capacity and are over budget", () => {
  const measure = (bytes: number) =>
    measureWaitingFormMemory({
      recordedAt,
      tabs: [{ tabId: "one", processId: 1, backgroundThrottled: true }],
      processes: [{ pid: 1, memory: { workingSetSize: bytes / 1024 } }],
    });
  expect(waitingFormsHaveCapacity(measure(WAITING_FORM_MEMORY_BUDGET))).toBe(
    true,
  );
  expect(
    waitingFormsHaveCapacity(measure(WAITING_FORM_MEMORY_BUDGET + 1024)),
  ).toBe(false);
  expect(measure(WAITING_FORM_MEMORY_BUDGET + 1024).overBudget).toBe(true);
});
