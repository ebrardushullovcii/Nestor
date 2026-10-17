// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeDraftSectionSchema } from "@nestor/contracts";
import { ResumeSectionEditor } from "./resume-section-editor";

function renderEditor() {
  const onSelectSection = vi.fn();
  const onPatch = vi.fn();
  render(
    <ResumeSectionEditor
      section={ResumeDraftSectionSchema.parse({
        id: "summary",
        kind: "summary",
        label: "Summary",
        text: "Builds accessible workflows.",
        origin: "imported",
        sortOrder: 0,
        updatedAt: "2026-09-26T12:00:00.000Z",
      })}
      disabled={false}
      isExpanded
      isSelected
      selectedEntryId={null}
      selectedTargetId={null}
      showGeneratedMarkers={false}
      onChange={vi.fn()}
      onSelectEntry={vi.fn()}
      onSelectSection={onSelectSection}
      onToggleExpanded={vi.fn()}
      onPatch={onPatch}
      workHistoryReviewSuggestions={[]}
    />,
  );
  return { onSelectSection, onPatch };
}

afterEach(cleanup);

describe("resume section control selection", () => {
  it.each(["Lock section", "Hide section"])(
    "does not scroll the section between pressing and releasing %s",
    (name) => {
      const { onSelectSection, onPatch } = renderEditor();
      const button = screen.getByRole("button", { name });
      fireEvent.mouseDown(button);
      fireEvent.focus(button);
      // Reselecting the section increments its scroll key. In Electron it
      // moves this button out from under the pointer before mouseup.
      expect(onSelectSection).not.toHaveBeenCalled();
      fireEvent.mouseUp(button);
      fireEvent.click(button);
      expect(onPatch).toHaveBeenCalledOnce();
    },
  );

  it("still selects the section when its wording receives focus", () => {
    const { onSelectSection } = renderEditor();
    fireEvent.focus(screen.getByRole("textbox", { name: "Section text" }));
    expect(onSelectSection).toHaveBeenCalledWith("summary");
  });
});
