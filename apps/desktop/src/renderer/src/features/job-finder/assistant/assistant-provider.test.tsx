// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";

import { AssistantProvider, useAssistant } from "./assistant-provider";

let assistant: ReturnType<typeof useAssistant> = null;
function Probe() {
  assistant = useAssistant();
  return null;
}

afterEach(() => {
  cleanup();
  assistant = null;
  delete document.documentElement.dataset.assistantSidebar;
});

describe("assistant context capture in the provider", () => {
  it("captures text selected inside a text field, such as the resume summary", async () => {
    render(
      <MemoryRouter initialEntries={["/job-finder/review-queue/job_1/resume"]}>
        <AssistantProvider>
          <Probe />
          <textarea
            aria-label="Section text"
            defaultValue="Builds calm tools. Leads design systems work."
          />
        </AssistantProvider>
      </MemoryRouter>,
    );
    const field = screen.getByLabelText<HTMLTextAreaElement>("Section text");
    field.focus();
    field.setSelectionRange(19, 45);
    act(() => {
      field.dispatchEvent(new Event("select", { bubbles: true }));
    });
    let captured: Awaited<
      ReturnType<NonNullable<typeof assistant>["captureContext"]>
    > | null = null;
    await act(async () => {
      captured =
        (await assistant?.captureContext({ mentions: [], attachments: [] })) ??
        null;
    });
    expect(captured!.selectedText).toBe("Leads design systems work.");
  });

  it("keeps the selection when focus moves to the composer before sending", async () => {
    // The docked sidebar marks <html> with the same attribute as the panel;
    // a page field must still count as the page.
    document.documentElement.dataset.assistantSidebar = "docked";
    render(
      <MemoryRouter initialEntries={["/job-finder/review-queue/job_1/resume"]}>
        <AssistantProvider>
          <Probe />
          <textarea
            aria-label="Section text"
            defaultValue="Builds calm tools. Leads design systems work."
          />
          <aside data-assistant-sidebar>
            <textarea aria-label="Message the assistant" />
          </aside>
        </AssistantProvider>
      </MemoryRouter>,
    );
    const field = screen.getByLabelText<HTMLTextAreaElement>("Section text");
    field.focus();
    field.setSelectionRange(19, 45);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    // Clicking the composer: focus passes through the page body first,
    // where the document selection is empty.
    field.blur();
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    screen.getByLabelText<HTMLTextAreaElement>("Message the assistant").focus();
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    let captured: Awaited<
      ReturnType<NonNullable<typeof assistant>["captureContext"]>
    > | null = null;
    await act(async () => {
      captured =
        (await assistant?.captureContext({ mentions: [], attachments: [] })) ??
        null;
    });
    expect(captured!.selectedText).toBe("Leads design systems work.");
  });

  it("lets a higher-priority source replace the screen's list", async () => {
    function Sources() {
      const value = useAssistant();
      value?.registerContext("screen", () => ({
        list: {
          listKind: "jobs",
          selectedIds: [],
          displayedIds: ["a"],
          filteredIds: ["a"],
          totalFilteredCount: 1,
          filterSummary: null,
          campaignId: null,
        },
      }));
      value?.registerContext(
        "panel",
        () => ({
          list: {
            listKind: "jobs",
            selectedIds: ["a"],
            displayedIds: ["a"],
            filteredIds: ["a"],
            totalFilteredCount: 1,
            filterSummary: null,
            campaignId: null,
          },
        }),
        1,
      );
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <AssistantProvider>
          <Probe />
          <Sources />
        </AssistantProvider>
      </MemoryRouter>,
    );
    let captured: Awaited<
      ReturnType<NonNullable<typeof assistant>["captureContext"]>
    > | null = null;
    await act(async () => {
      captured =
        (await assistant?.captureContext({ mentions: [], attachments: [] })) ??
        null;
    });
    expect(captured!.list?.selectedIds).toEqual(["a"]);
  });

  it("peeks the record the screen would send as this, for the header", () => {
    function Sources() {
      const value = useAssistant();
      value?.registerContext("screen", () => ({
        focus: { kind: "job", id: "job_1", label: "Designer at Acme" },
      }));
      value?.registerContext("panel", () => ({ focus: null }), 1);
      return null;
    }
    render(
      <MemoryRouter initialEntries={["/job-finder/discovery"]}>
        <AssistantProvider>
          <Probe />
          <Sources />
        </AssistantProvider>
      </MemoryRouter>,
    );
    expect(assistant?.peekFocus()?.label).toBe("Designer at Acme");
  });
});
