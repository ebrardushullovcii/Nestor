// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ResumeDraftRevisionSchema,
  ResumeDraftSchema,
  type ResumeDraftRevision,
} from "@nestor/contracts";
import { ResumeVersionHistoryPanel } from "./resume-version-history-panel";

function createDraft(updatedAt = "2026-07-30T12:00:00.000Z") {
  return ResumeDraftSchema.parse({
    id: "draft_1",
    jobId: "job_1",
    status: "needs_review",
    templateId: "classic_ats",
    identity: null,
    sections: [],
    targetPageCount: 2,
    generationMethod: "ai",
    approvedAt: null,
    approvedExportId: null,
    staleReason: null,
    createdAt: "2026-07-30T10:00:00.000Z",
    updatedAt,
  });
}

function createRevision(
  index: number,
  overrides: Partial<ResumeDraftRevision> = {},
): ResumeDraftRevision {
  const snapshotDraft = createDraft(`2026-07-30T10:0${index}:00.000Z`);
  return ResumeDraftRevisionSchema.parse({
    id: `revision_${index}`,
    draftId: snapshotDraft.id,
    parentRevisionId: index > 1 ? `revision_${index - 1}` : null,
    actor: "user",
    mutationKind: "manual_save",
    snapshotDraft,
    snapshotIdentity: snapshotDraft.identity,
    snapshotSections: snapshotDraft.sections,
    beforeHash: `before_${index}`,
    afterHash: `after_${index}`,
    diff: {
      templateChanged: false,
      identityChanged: false,
      sectionOrderChanged: false,
      addedSectionIds: [],
      removedSectionIds: [],
      changedSectionIds: [`section_${index}`],
    },
    restoredFromRevisionId: null,
    createdAt: `2026-07-30T10:0${index}:00.000Z`,
    reason: `Saved change ${index}`,
    ...overrides,
  });
}

describe("ResumeVersionHistoryPanel", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  function renderPanel(input?: {
    isPending?: boolean;
    onRestore?: (revisionId: string) => void;
    revisions?: readonly ResumeDraftRevision[];
  }) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ResumeVersionHistoryPanel
          currentDraft={createDraft()}
          isPending={input?.isPending ?? false}
          onRestore={input?.onRestore ?? vi.fn()}
          revisions={input?.revisions ?? []}
        />,
      );
    });
  }

  it("shows the newest five revisions and pages through older history without growing the DOM", () => {
    const revisions = [1, 2, 3, 4, 5, 6, 7].map((index) =>
      createRevision(index),
    );
    renderPanel({ revisions });

    const visibleRows = () =>
      container?.querySelectorAll("[data-resume-revision-row]") ?? [];

    expect(visibleRows()).toHaveLength(5);
    expect(visibleRows()[0]?.textContent).toContain("Saved change 7");
    expect(visibleRows()[4]?.textContent).toContain("Saved change 3");
    expect(container?.textContent).toContain("1–5 of 7");

    const olderButton = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Older changes"),
    );
    act(() => olderButton?.click());

    expect(visibleRows()).toHaveLength(2);
    expect(visibleRows()[0]?.textContent).toContain("Saved change 2");
    expect(visibleRows()[1]?.textContent).toContain("Saved change 1");
    expect(container?.textContent).toContain("6–7 of 7");

    const newerButton = [...(container?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Newer changes"),
    );
    act(() => newerButton?.click());

    expect(visibleRows()).toHaveLength(5);
    expect(visibleRows()[0]?.textContent).toContain("Saved change 7");
  });

  it("shows actor, mutation, reason, timestamp, and a bounded diff summary", () => {
    renderPanel({
      revisions: [
        createRevision(5, {
          actor: "assistant",
          mutationKind: "assistant_patch",
          reason: "Tightened the summary",
          diff: {
            templateChanged: true,
            identityChanged: true,
            sectionOrderChanged: true,
            addedSectionIds: ["added"],
            removedSectionIds: ["removed"],
            changedSectionIds: ["changed"],
          },
        }),
      ],
    });

    const row = container?.querySelector("[data-resume-revision-row]");
    expect(row?.textContent).toContain("Assistant");
    expect(row?.textContent).toContain("Assistant edit");
    expect(row?.textContent).toContain("Tightened the summary");
    expect(row?.textContent).toContain("Template changed");
    expect(row?.textContent).toContain("Identity changed");
    expect(row?.textContent).toContain("Section order changed");
    expect(row?.textContent).toContain("+3 more changes");
    expect(row?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-07-30T10:05:00.000Z",
    );
  });

  it("labels legacy rows as non-restorable and only invokes restore for full snapshots", () => {
    const onRestore = vi.fn();
    const restorable = createRevision(2);
    const legacy = createRevision(1, {
      snapshotDraft: null,
      beforeHash: null,
      afterHash: null,
      diff: null,
    });
    renderPanel({ onRestore, revisions: [legacy, restorable] });

    const rows = [
      ...(container?.querySelectorAll<HTMLElement>(
        "[data-resume-revision-row]",
      ) ?? []),
    ];
    const legacyRow = rows.find((row) =>
      row.textContent?.includes("Saved change 1"),
    );
    const restorableRow = rows.find((row) =>
      row.textContent?.includes("Saved change 2"),
    );

    expect(legacyRow?.textContent).toContain("Legacy snapshot");
    expect(legacyRow?.textContent).toContain("cannot be restored");
    expect(legacyRow?.querySelector("button")).toBeNull();

    const restoreButton = restorableRow?.querySelector("button");
    expect(restoreButton?.textContent).toContain("Restore");
    act(() => restoreButton?.click());
    expect(onRestore).toHaveBeenCalledWith(restorable.id);
  });

  it("styles revision articles as read-only wells instead of editable field surfaces", () => {
    renderPanel({ revisions: [createRevision(1)] });

    const row = container?.querySelector<HTMLElement>(
      "[data-resume-revision-row]",
    );
    expect(row?.className).toContain("bg-(--surface-well)");
    expect(row?.className).toContain("border-(--surface-well-border)");
    expect(row?.className).not.toContain("--field");
  });

  it("disables restore and history paging while a revision action is pending", () => {
    renderPanel({
      isPending: true,
      revisions: [1, 2, 3, 4, 5, 6].map((index) => createRevision(index)),
    });

    const buttons = [...(container?.querySelectorAll("button") ?? [])];
    expect(
      buttons.filter((button) => button.textContent?.includes("Restore")),
    ).toHaveLength(5);
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });

  it("searches saved versions without changing the underlying revision set", () => {
    renderPanel({
      revisions: [
        createRevision(1, { reason: "Updated skills" }),
        createRevision(2, { reason: "Tightened summary" }),
      ],
    });

    const search = container?.querySelector<HTMLInputElement>(
      'input[type="search"]',
    );
    expect(search).toBeTruthy();
    act(() => {
      if (!search) return;
      fireEvent.change(search, { target: { value: "skills" } });
    });

    const rows = container?.querySelectorAll("[data-resume-revision-row]");
    expect(rows).toHaveLength(1);
    expect(rows?.[0]?.textContent).toContain("Updated skills");
    expect(container?.textContent).toContain("1 of 2 results");
  });
});
