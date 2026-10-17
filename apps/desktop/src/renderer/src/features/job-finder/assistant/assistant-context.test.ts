import { describe, expect, it } from "vitest";
import {
  AssistantEventSchema,
  AssistantMessageSchema,
  AssistantTurnSchema,
} from "@nestor/contracts";

import {
  buildListContext,
  composeContextReference,
  flattenDirtyFields,
  focusFromLocation,
  profileFieldForEditorPath,
  screenForPathname,
} from "./assistant-context-capture";
import {
  applyAssistantEvent,
  type AssistantConversationState,
} from "./use-assistant-conversation";

const NOW = "2026-09-27T10:00:00.000Z";

describe("assistant context capture", () => {
  it("names the screen from the route", () => {
    expect(screenForPathname("/job-finder")).toBe("home");
    expect(screenForPathname("/job-finder/discovery")).toBe("discovery");
    expect(screenForPathname("/job-finder/review-queue/job_1/resume")).toBe(
      "resume_studio",
    );
    expect(screenForPathname("/job-finder/profile/setup")).toBe("setup");
    expect(screenForPathname("/job-finder/applications")).toBe("applications");
  });

  it("reads the focused record from the app's own link shapes", () => {
    expect(focusFromLocation("/job-finder/discovery", "?jobId=job_9")).toEqual({
      kind: "job",
      id: "job_9",
      label: null,
    });
    expect(
      focusFromLocation(
        "/job-finder/applications",
        "?applicationRecordId=app_1",
      ),
    ).toMatchObject({ kind: "application", id: "app_1" });
    expect(
      focusFromLocation("/job-finder/review-queue/job_2/resume", ""),
    ).toMatchObject({
      kind: "job",
      id: "job_2",
    });
  });

  it("maps dirty form paths to profile field names", () => {
    const paths = flattenDirtyFields({
      identity: { headline: true, summary: true },
      profileSkills: [true, { name: true }],
      minimumSalaryUsd: true,
    });
    expect(paths).toEqual([
      "identity.headline",
      "identity.summary",
      "profileSkills.0",
      "profileSkills.1.name",
      "minimumSalaryUsd",
    ]);
    expect([...new Set(paths.map(profileFieldForEditorPath))]).toEqual([
      "headline",
      "summary",
      "skills",
      "compensation",
    ]);
  });

  it("merges screen patches without letting an empty value erase the URL focus", () => {
    const reference = composeContextReference({
      pathname: "/job-finder/discovery",
      search: "?jobId=job_1",
      patches: [
        {
          focus: null,
          list: {
            listKind: "jobs",
            selectedIds: [],
            displayedIds: ["job_1", "job_2"],
            filteredIds: ["job_1", "job_2", "job_3"],
            totalFilteredCount: 3,
            filterSummary: null,
            campaignId: null,
          },
        },
      ],
      browser: null,
      selectedText: "Senior engineer",
      mentions: [],
      attachments: [],
      now: NOW,
    });
    expect(reference.focus).toMatchObject({ kind: "job", id: "job_1" });
    expect(reference.list?.filteredIds).toHaveLength(3);
    expect(reference.selectedText).toBe("Senior engineer");
  });

  it("makes the browser the screen only while it is visible", () => {
    const reference = composeContextReference({
      pathname: "/job-finder/discovery",
      search: "",
      patches: [],
      browser: {
        tabId: "tab_1",
        url: "http://127.0.0.1:47950/",
        title: null,
        visible: true,
      },
      selectedText: null,
      mentions: [],
      attachments: [],
      now: NOW,
    });
    expect(reference.screen).toBe("browser");
  });
});

describe("resume editor selection", () => {
  it("puts selected text into the resume editor's selection", () => {
    const reference = composeContextReference({
      pathname: "/job-finder/review-queue/job_1/resume",
      search: "",
      patches: [
        {
          editor: {
            editor: "resume",
            jobId: "job_1",
            draftId: "draft_1",
            savedRevision: null,
            draftVersion: 0,
            hasUnsavedEdits: false,
            mode: "editable",
            selection: null,
          },
        },
      ],
      browser: null,
      selectedText: "Leads design systems work.",
      mentions: [],
      attachments: [],
      now: NOW,
    });
    expect(
      reference.editor?.editor === "resume"
        ? reference.editor.selection?.text
        : null,
    ).toBe("Leads design systems work.");
  });
});

describe("buildListContext", () => {
  it("uses only ticked rows as the selection and keeps ticked rows a filter hid", () => {
    const list = buildListContext({
      listKind: "applications",
      checkedIds: ["app_3", "app_9"],
      displayedIds: ["app_1", "app_2", "app_3"],
      filteredIds: ["app_1", "app_2", "app_3"],
    });
    expect(list.selectedIds).toEqual(["app_3", "app_9"]);
    expect(list.totalFilteredCount).toBe(3);
    expect(
      buildListContext({
        listKind: "jobs",
        checkedIds: [],
        displayedIds: ["job_1"],
        filteredIds: ["job_1"],
      }).selectedIds,
    ).toEqual([]);
  });
});

describe("applyAssistantEvent", () => {
  const base: AssistantConversationState = {
    status: null,
    conversations: [],
    conversationId: "conv_1",
    messages: [],
    hasOlder: false,
    activeTurn: null,
    activity: null,
    draftText: null,
    progress: [],
    stall: null,
    plans: [],
    pendingMessageIds: ["msg_user"],
    error: null,
    loading: false,
  };
  const event = (payload: unknown, conversationId = "conv_1") =>
    AssistantEventSchema.parse({
      conversationId,
      sequence: 1,
      at: NOW,
      payload,
    });
  const turn = (status: string) =>
    AssistantTurnSchema.parse({
      id: "turn_1",
      conversationId: "conv_1",
      trigger: "message",
      status,
      generation: 1,
      startedAt: NOW,
    });

  it("clears the selected chat and transient state when its store is reset", () => {
    const state = applyAssistantEvent(
      {
        ...base,
        hasOlder: true,
        progress: ["Preparing"],
        stall: "Waiting",
        error: "Try again",
      },
      event({ type: "conversation_deleted" }),
    );
    expect(state).toMatchObject({
      conversationId: null,
      messages: [],
      hasOlder: false,
      activeTurn: null,
      activity: null,
      draftText: null,
      progress: [],
      stall: null,
      plans: [],
      pendingMessageIds: [],
      error: null,
    });
  });

  it("replaces the streamed draft with each attempt's whole text", () => {
    let state = applyAssistantEvent(
      base,
      event({ type: "turn_updated", turn: turn("running") }),
    );
    state = applyAssistantEvent(
      state,
      event({ type: "text_delta", attempt: 1, text: "Hel" }),
    );
    state = applyAssistantEvent(
      state,
      event({ type: "text_delta", attempt: 2, text: "Hi" }),
    );
    expect(state.draftText).toBe("Hi");
  });

  it("clears the live state when the turn ends and the reply lands", () => {
    let state = applyAssistantEvent(
      base,
      event({ type: "turn_updated", turn: turn("running") }),
    );
    state = applyAssistantEvent(
      state,
      event({ type: "progress", text: "Reading your profile" }),
    );
    const reply = AssistantMessageSchema.parse({
      id: "msg_reply",
      conversationId: "conv_1",
      role: "assistant",
      origin: "sidebar",
      parts: [{ type: "text", text: "Done." }],
      createdAt: NOW,
    });
    state = applyAssistantEvent(
      state,
      event({ type: "message_added", message: reply }),
    );
    state = applyAssistantEvent(
      state,
      event({ type: "turn_updated", turn: turn("completed") }),
    );
    expect(state.activeTurn).toBeNull();
    expect(state.progress).toEqual([]);
    expect(state.messages.map((message) => message.id)).toEqual(["msg_reply"]);
  });

  it("shows completed commentary once when streamed text becomes progress", () => {
    const text = "I'll start by reading the page you have open. ".repeat(30);
    let state = applyAssistantEvent(
      base,
      event({ type: "text_delta", attempt: 1, text }),
    );
    state = applyAssistantEvent(
      state,
      event({ type: "text_delta", attempt: 1, text: "" }),
    );
    state = applyAssistantEvent(
      state,
      event({ type: "progress", text: text.slice(0, 1_000) }),
    );
    expect(state.progress).toEqual([text.slice(0, 1_000)]);
    expect(state.draftText).toBe("");
    state = applyAssistantEvent(
      state,
      event({ type: "text_delta", attempt: 2, text: "I found ten jobs." }),
    );
    expect(state.draftText).toBe("I found ten jobs.");
  });

  it("ignores events for another conversation", () => {
    const state = applyAssistantEvent(
      base,
      event({ type: "progress", text: "Elsewhere" }, "conv_2"),
    );
    expect(state).toBe(base);
  });
});
