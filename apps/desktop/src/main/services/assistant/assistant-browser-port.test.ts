import { beforeEach, describe, expect, it, vi } from "vitest";

const mechanics = vi.hoisted(() => ({
  readPage: vi.fn(() =>
    Promise.resolve({
      controls: [
        {
          ref: "cover_letter",
          label: "Phone *",
          value: "Sam",
          files: ["synthetic.pdf"],
        },
      ],
    }),
  ),
  navigate: vi.fn(() =>
    Promise.resolve({ ok: true, url: "https://example.test" }),
  ),
  clickElement: vi.fn(() => Promise.resolve({ ok: true })),
  clickAction: vi.fn(() => Promise.resolve({ ok: true })),
  followLink: vi.fn(() => Promise.resolve({ ok: true })),
  pressKey: vi.fn(() => Promise.resolve({ ok: true })),
  uploadFile: vi.fn(() => Promise.resolve({ ok: true })),
  chooseOption: vi.fn(() => Promise.resolve({ ok: true })),
  setToggle: vi.fn(() => Promise.resolve({ ok: true })),
  goBack: vi.fn(() => Promise.resolve({ ok: true })),
  fillText: vi.fn(() => Promise.resolve({ ok: true })),
}));
vi.mock("@nestor/browser-runtime", () => ({
  createPlaywrightApplyPageMechanics: () => mechanics,
}));

import {
  ApplicationRecordSchema,
  type JobFinderWorkspaceSnapshot,
} from "@nestor/contracts";

import type { EmbeddedBrowser } from "../browser/embedded-browser";
import { createAssistantBrowserPort } from "./assistant-browser-port";

function world(bound = false) {
  const loan = new AbortController();
  const original = {
    url: () => "http://127.0.0.1:47950/spruce/apply/1",
    goto: vi.fn(),
    evaluate: vi.fn(() => Promise.resolve(bound ? "prepared_result" : null)),
    screenshot: vi.fn(() => Promise.resolve(Buffer.from("synthetic"))),
  };
  const owned = {
    ...original,
    url: () => "http://127.0.0.1:47950/brindle/jobs/50",
    goto: vi.fn(() => Promise.resolve()),
  };
  const context = {
    pages: () => [original, owned],
    newPage: vi.fn(() => Promise.resolve(owned)),
  };
  const lendTab = vi.fn(() => Promise.resolve());
  const showTab = vi.fn();
  const getApplicationTabIds = vi.fn(() => ["original"]);
  const endLoan = vi.fn();
  const browser = {
    getState: () => ({
      phase: "needs_you",
      presentation: "expanded",
      activeTabId: "original",
      tabs: [{ id: "original", url: original.url(), title: "Spruce" }],
    }),
    getApplicationTabIds,
    lendTab,
    showTab,
    endLoan,
    identifyAutomationPage: (page: unknown) =>
      Promise.resolve(page === original ? "original" : "owned"),
    connect: () => Promise.resolve({ contexts: () => [context] }),
    runAutomation: vi.fn(
      (
        _label: string,
        _unused: unknown,
        work: (
          signal: AbortSignal,
          update: () => void,
          claim: (page: unknown) => void,
        ) => Promise<unknown>,
      ) => work(loan.signal, () => undefined, vi.fn()),
    ),
  } as unknown as EmbeddedBrowser;
  const snapshot = {
    applicationRecords: [],
    applyJobResults: [],
    userActionRequests: [],
  } as unknown as JobFinderWorkspaceSnapshot;
  const readWorkspace = vi.fn(() => Promise.resolve(snapshot));
  return {
    port: createAssistantBrowserPort(browser, readWorkspace),
    snapshot,
    readWorkspace,
    browser,
    getApplicationTabIds,
    endLoan,
    lendTab,
    showTab,
    original,
    owned,
    context,
    loan,
  };
}

async function lend(
  ctx: ReturnType<typeof world>,
  tabId: string | null,
  signal?: AbortSignal,
) {
  return ctx.port.lease({
    tabId,
    conversationId: "conversation",
    turnId: "turn",
    openUrl: tabId ? null : "http://127.0.0.1:47950/brindle/jobs/50",
    ...(signal ? { signal } : {}),
  });
}

describe("assistant browser tab safety", () => {
  beforeEach(() => vi.clearAllMocks());
  it("R3-007 opens unrelated work separately and leaves the original form untouched", async () => {
    const ctx = world();
    const lease = await lend(ctx, null);
    expect(ctx.context.newPage).toHaveBeenCalledOnce();
    expect(ctx.original.goto).not.toHaveBeenCalled();
    expect(ctx.lendTab).not.toHaveBeenCalled();
    expect(lease.tabId).toBe("owned");
    expect(lease.borrowed).toBe(false);
    await lease.release("finished");
    expect(() => lease.hands.readPage()).toThrow("released");
  });

  it("R3-016 lends and shows the exact filled tab without navigating it", async () => {
    const ctx = world(true);
    const lease = await lend(ctx, "original");
    expect(ctx.lendTab).toHaveBeenCalledWith("original");
    expect(ctx.showTab).toHaveBeenCalledWith("original");
    expect(ctx.context.newPage).not.toHaveBeenCalled();
    expect(ctx.original.goto).not.toHaveBeenCalled();
    expect(await lease.hands.readPage()).toMatchObject({
      controls: [
        {
          ref: "cover_letter",
          label: "Phone *",
          value: "Sam",
          files: ["synthetic.pdf"],
        },
      ],
    });
    expect(lease.borrowed).toBe(true);
    for (const action of [
      () => lease.hands.followLink("link"),
      () => lease.hands.navigate("https://example.test"),
      () => lease.hands.clickAction("send"),
      () => lease.hands.pressKey(undefined, "Control+Enter"),
      () => lease.hands.fillText("name", "late"),
      () => lease.hands.clickElement("expand"),
      () => lease.hands.chooseOption("option", "Synthetic"),
      () => lease.hands.setToggle("consent", true),
      () =>
        lease.hands.uploadFile("file", {
          name: "synthetic.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array(),
        }),
      () => lease.hands.goBack(),
    ])
      await expect(action()).rejects.toThrow(
        "This tab holds a prepared application",
      );
    await lease.release("finished");
  });

  it("ordinary lent tabs allow click, type, upload and navigation", async () => {
    const ctx = world();
    const lease = await lend(ctx, "original");
    expect(lease.borrowed).toBe(true);
    expect(await lease.isApplicationBound()).toBe(false);
    await lease.hands.clickElement("expand");
    await lease.hands.fillText("name", "Synthetic");
    await lease.hands.uploadFile("file", {
      name: "synthetic.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(),
    });
    await lease.hands.navigate("https://example.test");
    expect(mechanics.clickElement).toHaveBeenCalledWith("expand");
    expect(mechanics.fillText).toHaveBeenCalledWith("name", "Synthetic");
    expect(mechanics.uploadFile).toHaveBeenCalledOnce();
    expect(mechanics.navigate).toHaveBeenCalledWith("https://example.test");
    await lease.release("finished");
  });

  it("rechecks a newly bound form before the next mutation", async () => {
    const ctx = world();
    const lease = await lend(ctx, "original");
    await lease.hands.fillText("name", "Synthetic");
    ctx.original.evaluate.mockResolvedValue("prepared_result");
    await expect(lease.hands.fillText("name", "late")).rejects.toThrow(
      "This tab holds a prepared application",
    );
    expect(mechanics.fillText).toHaveBeenCalledOnce();
    await lease.release("finished");
  });

  it.each([false, true])(
    "an unreadable binding only allows tabs with no saved application pointing there (record: %s)",
    async (referenced) => {
      const ctx = world();
      ctx.original.evaluate.mockRejectedValue(new Error("cannot read mark"));
      ctx.snapshot.applicationRecords = [
        ApplicationRecordSchema.parse({
          id: "record",
          jobId: "job",
          title: "Synthetic",
          company: "Synthetic",
          status: "ready_for_review",
          lastAttemptState: "ready",
          lastActionLabel: "Prepared",
          nextActionLabel: "Review",
          lastUpdatedAt: "2026-10-04T12:00:00.000Z",
          replaySummary: {
            lastUrl: referenced
              ? ctx.original.url()
              : "https://elsewhere.test/apply",
          },
        }),
      ];

      const lease = await lend(ctx, "original");
      if (referenced)
        await expect(
          lease.hands.navigate("https://example.test"),
        ).rejects.toThrow("This tab holds a prepared application");
      else await lease.hands.navigate("https://example.test");
      expect(mechanics.navigate).toHaveBeenCalledTimes(referenced ? 0 : 1);
      await lease.release("finished");
    },
  );

  it("fences mechanics after Stop or the person's takeover", async () => {
    const ctx = world();
    const turn = new AbortController();
    const lease = await lend(ctx, "original", turn.signal);
    const before = mechanics.fillText.mock.calls.length;
    turn.abort();
    await expect(lease.hands.fillText("field", "late write")).rejects.toThrow();
    expect(mechanics.fillText.mock.calls).toHaveLength(before);
    await lease.release("stopped");
    const next = world();
    const loan = await lend(next, "original");
    next.loan.abort();
    await expect(loan.hands.fillText("field", "late write")).rejects.toThrow();
    await loan.release("taken back");
  });
});

it("shows a focused retained tab through the browser open command", async () => {
  const command = vi.fn().mockResolvedValue(undefined);
  const browser = { command } as unknown as EmbeddedBrowser;
  const readWorkspace = vi.fn();
  await createAssistantBrowserPort(browser, readWorkspace).show?.();
  expect(command).toHaveBeenCalledWith({ type: "open" });
  expect(readWorkspace).not.toHaveBeenCalled();
});

it("lends the exact waiting application for fields only, records edits, and fences late writes", async () => {
  const ctx = world(true);
  ctx.snapshot.applyJobResults = [
    {
      id: "prepared_result",
      applicationRecordId: "record",
      state: "awaiting_review",
      privacyReceipt: null,
    },
  ] as unknown as JobFinderWorkspaceSnapshot["applyJobResults"];
  ctx.browser.readTab = vi.fn(() =>
    Promise.resolve({ url: ctx.original.url(), value: "prepared_result" }),
  ) as EmbeddedBrowser["readTab"];
  const onApplicationChange = vi.fn(() => Promise.resolve());
  const turn = new AbortController();
  const lease = await ctx.port.lease({
    tabId: null,
    applicationResultId: "prepared_result",
    conversationId: "conversation",
    turnId: "turn",
    signal: turn.signal,
    onApplicationChange,
  });
  expect(ctx.getApplicationTabIds).toHaveBeenCalledWith("prepared_result");
  expect(ctx.context.newPage).not.toHaveBeenCalled();
  expect(ctx.lendTab).toHaveBeenCalledWith("original");
  expect(lease.applicationResultId).toBe("prepared_result");
  await lease.hands.fillText("cover_letter", "Synthetic letter");
  expect(onApplicationChange).toHaveBeenCalledWith("record", "Phone");
  await expect(lease.hands.clickAction("send")).rejects.toThrow("fields only");
  await expect(lease.hands.navigate("https://example.test")).rejects.toThrow(
    "fields only",
  );
  ctx.original.evaluate.mockResolvedValue("different_result");
  await expect(
    lease.hands.fillText("cover_letter", "Wrong tab"),
  ).rejects.toThrow("changed or closed");
  ctx.original.evaluate.mockResolvedValue("prepared_result");
  turn.abort();
  await expect(
    lease.hands.uploadFile("resume", {
      name: "synthetic.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(),
    }),
  ).rejects.toThrow();
  await lease.release("ended");
  expect(ctx.endLoan).toHaveBeenCalledWith("original");
  await expect(lease.hands.fillText("cover_letter", "Late")).rejects.toThrow();
});

it("refuses missing or ambiguous retained application tabs without opening a copy", async () => {
  const ctx = world(true);
  ctx.snapshot.applyJobResults = [
    {
      id: "prepared_result",
      applicationRecordId: "record",
      state: "awaiting_review",
    },
  ] as unknown as JobFinderWorkspaceSnapshot["applyJobResults"];
  ctx.browser.readTab = vi.fn(() =>
    Promise.resolve(null),
  ) as EmbeddedBrowser["readTab"];
  await expect(
    ctx.port.lease({
      tabId: null,
      applicationResultId: "prepared_result",
      conversationId: "conversation",
      turnId: "turn",
    }),
  ).rejects.toThrow("exact prepared application tab");
  expect(ctx.getApplicationTabIds).toHaveBeenCalledWith("prepared_result");
  expect(ctx.context.newPage).not.toHaveBeenCalled();
  expect(ctx.lendTab).not.toHaveBeenCalled();
  const readTab = vi.fn(() =>
    Promise.resolve({ url: ctx.original.url(), value: "prepared_result" }),
  );
  ctx.browser.readTab = readTab as EmbeddedBrowser["readTab"];
  ctx.getApplicationTabIds.mockReturnValue([]);
  await expect(
    ctx.port.lease({
      tabId: null,
      applicationResultId: "prepared_result",
      conversationId: "conversation",
      turnId: "turn",
    }),
  ).rejects.toThrow("exact prepared application tab");
  expect(readTab).not.toHaveBeenCalled();
  ctx.getApplicationTabIds.mockReturnValue(["original", "owned"]);
  await expect(
    ctx.port.lease({
      tabId: null,
      applicationResultId: "prepared_result",
      conversationId: "conversation",
      turnId: "turn",
    }),
  ).rejects.toThrow("exact prepared application tab");
  expect(ctx.lendTab).not.toHaveBeenCalled();
});
