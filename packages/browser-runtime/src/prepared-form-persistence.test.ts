import { expect, test, vi } from "vitest";
import type { PreparedApplicationForm } from "@nestor/contracts";
import { createBrowserAgentRuntime } from "./playwright-browser-runtime";

test("cold availability hydrates durable snapshots without connecting, preparing or sending", async () => {
  const saved: PreparedApplicationForm = {
    id: "result",
    label: "Synthetic",
    savedAt: "2026-10-23T10:00:00Z",
    reason: null,
    attachments: [],
    snapshot: {
      url: "https://jobs.example/apply",
      structure: "a".repeat(64),
      fields: [
        {
          type: "text",
          value: "Synthetic answer",
          checked: false,
          selected: [],
          files: [],
          disabled: false,
          readOnly: false,
        },
      ],
    },
  };
  const connect = vi.fn().mockRejectedValue(new Error("offline"));
  const loadAttachment = vi.fn();
  const remove = vi.fn();
  const runtime = createBrowserAgentRuntime({
    userDataDir: "/unused",
    browserHost: {
      connect,
      getOpenBrowser: vi.fn(),
      close: vi.fn(),
      assertAutomationSafe: vi.fn(),
    },
    preparedFormStore: {
      get: vi.fn((key) => Promise.resolve(key === saved.id ? saved : null)),
      save: vi.fn(),
      delete: remove,
      loadAttachment,
    },
  });
  expect(
    await runtime.hasApplicationPageBinding!("target_site", "result"),
  ).toBe(true);
  expect(
    await runtime.getApplicationPageState!("target_site", "result"),
  ).toEqual({ resultId: "result", state: "reopenable", reason: null });
  expect(
    await runtime.hasApplicationPageBinding!("target_site", "legacy"),
  ).toBe(false);
  expect(
    await runtime.getApplicationPageState!("target_site", "legacy"),
  ).toEqual({
    resultId: "legacy",
    state: "needs_preparing",
    reason: "no_snapshot",
  });
  const progress = vi.fn();
  expect(
    await runtime.reopenApplicationPage!("target_site", "result", progress),
  ).toEqual({
    resultId: "result",
    state: "reopenable",
    reason: "reopen_failed",
  });
  expect(progress).toHaveBeenLastCalledWith({
    resultId: "result",
    phase: "failed",
  });
  expect(
    await runtime.hasApplicationPageBinding!("target_site", "result"),
  ).toBe(true);
  await runtime.releaseApplicationPageBinding!("target_site", "result");
  expect(remove).toHaveBeenCalledWith("result");
  expect(connect).toHaveBeenCalledOnce();
  expect(loadAttachment).not.toHaveBeenCalled();
});
