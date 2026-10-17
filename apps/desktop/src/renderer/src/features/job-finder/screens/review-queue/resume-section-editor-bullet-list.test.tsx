// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeDraftBullet, ResumeDraftSection } from "@nordri/contracts";
import type { createResumeDraftPatch } from "./resume-section-editor-helpers";
import { ResumeBulletListEditor } from "./resume-section-editor-bullet-list";
import { ResumeSectionEditor } from "./resume-section-editor";

function buildSection(
  bullets: readonly ResumeDraftBullet[],
  text: string | null = null,
): ResumeDraftSection {
  return {
    id: "section_summary",
    kind: "summary",
    label: "Summary",
    text,
    bullets: [...bullets],
    entries: [],
    origin: "ai_generated",
    locked: false,
    included: true,
    sortOrder: 0,
    entryOrderMode: "chronology",
    profileRecordId: null,
    sourceRefs: [],
    updatedAt: "2026-04-26T12:00:00.000Z",
  };
}

function bullet(
  index: number,
  overrides?: Partial<ResumeDraftBullet>,
): ResumeDraftBullet {
  return {
    id: `bullet_${index}`,
    text: `Bullet ${index} line`,
    origin: "user_edited",
    locked: false,
    included: true,
    sourceRefs: [],
    lastGeneratedContentHash: null,
    updatedAt: "2026-04-26T12:00:00.000Z",
    ...overrides,
  };
}

function renderList(input?: {
  bullets?: readonly ResumeDraftBullet[];
  onPatch?: (
    patch: ReturnType<typeof createResumeDraftPatch>,
    reason?: string | null,
  ) => void;
  showGeneratedMarkers?: boolean;
}) {
  const onPatch = input?.onPatch ?? vi.fn();
  const bullets = input?.bullets ?? [bullet(1), bullet(2), bullet(3)];
  return render(
    <ResumeBulletListEditor
      bulletRows={bullets}
      controlIdPrefix="ctrl"
      disabled={false}
      section={buildSection(bullets)}
      showGeneratedMarkers={input?.showGeneratedMarkers ?? false}
      onChange={vi.fn()}
      onPatch={onPatch}
    />,
  );
}

describe("ResumeBulletListEditor", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("replaces repeated visible labels with exact per-bullet aria labels", () => {
    renderList();

    expect(screen.queryByText("Bullet text")).toBeNull();
    const textareas = screen.getAllByRole("textbox");
    expect(
      textareas.map((textarea) => textarea.getAttribute("aria-label")),
    ).toEqual(["Section bullet 1", "Section bullet 2", "Section bullet 3"]);
  });

  it("keeps lock state and move order reachable with exact accessible names", () => {
    renderList();

    const lockButtons = screen.getAllByRole("button", { name: "Lock" });
    expect(lockButtons).toHaveLength(3);
    for (const lock of lockButtons) {
      expect(lock.getAttribute("aria-pressed")).toBe("false");
    }

    expect(
      screen.getByRole("button", { name: "Move bullet 1 up" }),
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", { name: "Move bullet 3 down" }),
    ).toHaveProperty("disabled", true);
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("data-size")).toBe("icon-sm");
      expect(button.getAttribute("data-variant")).toBe("ghost");
      expect(button.className).toContain("size-8");
      expect(button.getAttribute("title")).toBeTruthy();
      expect(button.textContent?.trim()).toBe("");
    }
    expect(
      screen
        .getByRole("button", { name: "Hide bullet 1" })
        .getAttribute("title"),
    ).toBe("Hide bullet 1");
    expect(lockButtons[0]?.getAttribute("title")).toBe("Lock bullet 1");
  });

  it("keeps every bullet action in one 32px row", () => {
    const { container } = renderList({ bullets: [bullet(1)] });
    const row = container.querySelector("textarea")?.previousElementSibling;
    expect(row?.className).toContain("h-8");
    expect(row?.querySelectorAll("button")).toHaveLength(4);
  });

  it("sends typed patches with exact ids when toggling visibility", () => {
    const onPatch = vi.fn();
    renderList({ onPatch });

    fireEvent.click(screen.getByRole("button", { name: "Hide bullet 2" }));

    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch.mock.calls[0]?.[0]).toMatchObject({
      operation: "toggle_include",
      targetBulletId: "bullet_2",
      targetSectionId: "section_summary",
      newIncluded: false,
    });
    expect(onPatch.mock.calls[0]?.[1]).toBe("Hidden bullet");
  });

  it("marks generated lines only when markers are requested", () => {
    const { container } = renderList({
      bullets: [bullet(1), bullet(2, { origin: "ai_generated" })],
    });
    expect(container.textContent).not.toContain("AI-generated");

    const marked = renderList({
      bullets: [
        bullet(1),
        bullet(2, { origin: "ai_generated" }),
        bullet(3, { origin: "assistant_edited" }),
      ],
      showGeneratedMarkers: true,
    });

    expect(marked.container.textContent).toContain("AI-generated");
    expect(
      Array.from(marked.container.querySelectorAll('[data-size="icon-sm"]'))
        .length,
    ).toBeGreaterThan(0);
  });

  it("keeps content-sizing textareas with a two-line floor class", () => {
    const { container } = renderList({ bullets: [bullet(1)] });
    const textarea = container.querySelector("textarea")!;
    expect(textarea.className).toContain("[field-sizing:content]");
    expect(textarea.className).toContain("min-h-[3.9rem]");
    expect(textarea.getAttribute("rows")).toBe("2");
  });

  it("renders a skills section one row per skill instead of a prose block per word", () => {
    const skills = [
      bullet(1, { text: "SQL Server" }),
      bullet(2, { text: "REST APIs" }),
    ];
    const { container } = render(
      <ResumeSectionEditor
        disabled={false}
        isExpanded
        isSelected={false}
        onToggleExpanded={vi.fn()}
        onChange={vi.fn()}
        onPatch={vi.fn()}
        onSelectEntry={vi.fn()}
        onSelectSection={vi.fn()}
        section={{
          ...buildSection(skills),
          id: "section_skills",
          kind: "skills",
          label: "Skills",
        }}
        selectedEntryId={null}
        selectedTargetId={null}
        showGeneratedMarkers={false}
        workHistoryReviewSuggestions={[]}
      />,
    );

    const rows = Array.from(
      container.querySelectorAll("[data-resume-bullet-row-density]"),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getAttribute("data-resume-bullet-row-density")).toBe(
        "compact",
      );
      // Actions sit beside the field instead of stacking above it.
      expect(row.className).toContain("flex");
      expect(row.className).not.toContain("grid");
    }

    for (const row of rows) {
      const textarea = row.querySelector("textarea")!;
      expect(textarea.getAttribute("rows")).toBe("1");
      expect(textarea.className).toContain("min-h-8");
      expect(textarea.className).not.toContain("min-h-[3.9rem]");
    }

    // Every control inside a compact bullet row is icon-only, so each one
    // keeps its exact accessible name. The section title beside them is a
    // labelled disclosure button and is deliberately not icon-only.
    for (const row of rows) {
      for (const button of row.querySelectorAll("button")) {
        expect(button.getAttribute("aria-label") ?? "").not.toBe("");
        expect(button.getAttribute("title")).toBeTruthy();
      }
    }
  });

  it("keeps prose sections on the comfortable row density", () => {
    const { container } = renderList();

    for (const row of container.querySelectorAll(
      "[data-resume-bullet-row-density]",
    )) {
      expect(row.getAttribute("data-resume-bullet-row-density")).toBe(
        "comfortable",
      );
    }
  });

  it("does not show an empty bullets state when Summary already has text", () => {
    const summaryText =
      "Product designer who turns complex workflows into clear, usable systems.";
    const section = buildSection([], summaryText);

    render(
      <ResumeSectionEditor
        disabled={false}
        isExpanded
        isSelected={false}
        onToggleExpanded={vi.fn()}
        onChange={vi.fn()}
        onPatch={vi.fn()}
        onSelectEntry={vi.fn()}
        onSelectSection={vi.fn()}
        section={section}
        selectedEntryId={null}
        selectedTargetId={null}
        showGeneratedMarkers={false}
        workHistoryReviewSuggestions={[]}
      />,
    );

    expect(screen.getByDisplayValue(summaryText)).toBeTruthy();
    expect(screen.queryByText("No bullets yet")).toBeNull();
  });
});
