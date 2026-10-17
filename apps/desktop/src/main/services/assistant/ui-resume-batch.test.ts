import type { AssistantResumeBatchState } from "@nestor/contracts";
import { beforeEach, expect, it } from "vitest";
import {
  clearUiResumeBatch,
  blockUiResumeBatch,
  invalidateUiResumeBatch,
  readUiResumeBatch,
  stopUiResumeBatch,
  syncUiResumeBatch,
} from "./ui-resume-batch";

const state: AssistantResumeBatchState = {
  id: "ui_batch",
  jobIds: ["one", "two", "three"],
  activeJobIds: ["one", "two"],
  completedJobIds: [],
  done: false,
  stopRequested: false,
};
beforeEach(clearUiResumeBatch);

it("stops a UI queue and fences later dispatch even before the renderer receives the stop event", () => {
  syncUiResumeBatch(state);
  expect(stopUiResumeBatch()).toMatchObject({
    stopRequested: true,
    activeJobIds: ["one", "two"],
  });
  expect(
    syncUiResumeBatch({ ...state, activeJobIds: ["three"] }).stopRequested,
  ).toBe(true);
  expect(readUiResumeBatch()?.stopRequested).toBe(true);
  syncUiResumeBatch({ ...state, activeJobIds: [], done: true });
  expect(readUiResumeBatch()).toBeNull();
  expect(syncUiResumeBatch({ ...state, id: "next_batch" }).stopRequested).toBe(
    false,
  );
});

it("does not expose mutable state or keep work after the renderer reloads", () => {
  syncUiResumeBatch(state);
  readUiResumeBatch()!.activeJobIds.length = 0;
  expect(readUiResumeBatch()?.activeJobIds).toEqual(["one", "two"]);
  clearUiResumeBatch();
  expect(readUiResumeBatch()).toBeNull();
});

it("an interrupted receipt does not keep the old UI scheduler locked", () => {
  syncUiResumeBatch({ ...state, running: false, activeJobIds: [] });
  expect(readUiResumeBatch()).toBeNull();
  expect(() =>
    syncUiResumeBatch({ ...state, id: "continued", running: true }),
  ).not.toThrow();
});

it("invalidation rejects late running and final syncs from the old queue while a new batch works", () => {
  const old = { ...state, id: "invalidated_reset_batch", running: true };
  syncUiResumeBatch(old);
  invalidateUiResumeBatch();
  expect(readUiResumeBatch()).toBeNull();
  expect(() => syncUiResumeBatch(old)).toThrow();
  expect(() =>
    syncUiResumeBatch({ ...old, activeJobIds: [], running: false, done: true }),
  ).toThrow();
  const next = { ...state, id: "new_batch_after_reset", running: true };
  expect(syncUiResumeBatch(next)).toMatchObject({
    id: next.id,
    stopRequested: false,
  });
  expect(() => syncUiResumeBatch(old)).toThrow();
  expect(readUiResumeBatch()?.id).toBe(next.id);
});

it("an ordinary clear does not erase an invalidated batch ID", () => {
  const old = { ...state, id: "invalidated_before_clear", running: true };
  syncUiResumeBatch(old);
  invalidateUiResumeBatch();
  clearUiResumeBatch();
  expect(() => syncUiResumeBatch(old)).toThrow();
  expect(() =>
    syncUiResumeBatch({ ...state, id: "new_after_clear", running: true }),
  ).not.toThrow();
});

it("a provider rejection sticks through stale syncs but cannot block the next batch", () => {
  const providerBlock = {
    reason: "funding" as const,
    message: "AI service unavailable: insufficient funds.",
  };
  syncUiResumeBatch(state);
  blockUiResumeBatch(state.id, providerBlock);
  providerBlock.message = "changed outside";
  expect(syncUiResumeBatch({ ...state })).toMatchObject({
    stopRequested: true,
    providerBlock: {
      reason: "funding",
      message: "AI service unavailable: insufficient funds.",
    },
  });
  syncUiResumeBatch({ ...state, activeJobIds: [], running: false });
  expect(
    syncUiResumeBatch({ ...state, id: "fresh" }).providerBlock,
  ).toBeUndefined();
  blockUiResumeBatch(state.id, providerBlock);
  expect(readUiResumeBatch()).toMatchObject({
    id: "fresh",
    stopRequested: false,
  });
});
