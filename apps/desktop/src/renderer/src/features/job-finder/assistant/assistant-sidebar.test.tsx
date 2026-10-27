// @vitest-environment jsdom

import {
  ASSISTANT_MESSAGE_MAX_CHARS,
  AssistantConversationSchema,
  type AssistantActivity,
  type AssistantConversation,
} from "@nestor/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantProvider, useAssistant } from "./assistant-provider";
import { AssistantSidebar } from "./assistant-sidebar";

const conversation = AssistantConversationSchema.parse({
  id: "conv_1",
  title: "New chat",
  status: "active",
  source: "assistant",
  createdAt: "2026-09-27T10:00:00.000Z",
  updatedAt: "2026-09-27T10:00:00.000Z",
  lastMessageAt: "2026-09-27T10:00:00.000Z",
});

function fakeBridge(
  sendMessage: () => Promise<never>,
  activity: AssistantActivity | null = null,
  conversations: AssistantConversation[] = [conversation],
) {
  return {
    getStatus: vi.fn(() =>
      Promise.resolve({
        available: true,
        detail: null,
        model: "x",
        scripted: true,
      }),
    ),
    listConversations: vi.fn(() =>
      Promise.resolve({
        conversations,
        currentConversationId: conversations[0]?.id ?? null,
      }),
    ),
    readConversation: vi.fn(() =>
      Promise.resolve({
        conversation,
        messages: [],
        hasOlderMessages: false,
        activeTurn: null,
        activity,
        draftText: null,
        plans: [],
        lastSequence: 0,
        pendingMessageIds: [],
      }),
    ),
    replayEvents: vi.fn(() => Promise.resolve({ events: [], lastSequence: 0 })),
    onEvent: vi.fn(() => () => undefined),
    sendMessage: vi.fn(sendMessage),
    selectConversation: vi.fn(() => Promise.resolve()),
    createConversation: vi.fn(() => Promise.resolve(conversation)),
    deleteConversation: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    answerQuestion: vi.fn(),
    resolveProposal: vi.fn(),
    undoChange: vi.fn(),
    searchMentions: vi.fn(() => Promise.resolve([])),
    attachFile: vi.fn(),
  };
}

function Opener() {
  const assistant = useAssistant();
  return (
    <button onClick={() => assistant?.setOpen(true)} type="button">
      open
    </button>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no layout scrolling.
  Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { nestor?: unknown }).nestor;
});

async function renderSidebar(bridge: ReturnType<typeof fakeBridge>) {
  (window as unknown as { nestor: unknown }).nestor = {
    assistant: bridge,
  };
  render(
    <MemoryRouter initialEntries={["/job-finder"]}>
      <AssistantProvider>
        <Opener />
        <AssistantSidebar />
      </AssistantProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "open" }));
  await waitFor(() =>
    expect(document.querySelector("[data-assistant-composer]")).not.toBeNull(),
  );
  return document.querySelector(
    "[data-assistant-composer]",
  ) as HTMLTextAreaElement;
}

describe("chat history dismissal", () => {
  it.each([
    { label: "no chats", entries: [] },
    { label: "saved chats", entries: [conversation] },
  ])("closes on Escape and returns focus with $label", async ({ entries }) => {
    await renderSidebar(
      fakeBridge(() => Promise.reject(new Error("unused")), null, entries),
    );
    const opener = screen.getByRole("button", { name: "Chat history" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog", { name: "Chat history" });
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull(),
    );
    expect(document.activeElement).toBe(opener);
  });

  it("switches between history and chat search without stacking them", async () => {
    await renderSidebar(fakeBridge(() => Promise.reject(new Error("unused"))));
    const history = screen.getByRole("button", { name: "Chat history" });
    fireEvent.click(history);
    await screen.findByRole("dialog", { name: "Chat history" });
    fireEvent.click(screen.getByRole("button", { name: "Search this chat" }));
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Find in this chat" }),
    ).toBeTruthy();
    fireEvent.click(history);
    expect(
      screen.queryByRole("textbox", { name: "Find in this chat" }),
    ).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Chat history" });
    fireEvent.keyDown(dialog, { key: "f", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Find in this chat" }),
    ).toBeTruthy();
  });

  it("dismisses on an outside click and reopens the assistant without old panels", async () => {
    const composer = await renderSidebar(
      fakeBridge(() => Promise.reject(new Error("unused"))),
    );
    const history = screen.getByRole("button", { name: "Chat history" });
    fireEvent.click(history);
    fireEvent.mouseDown(composer);
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    fireEvent.click(history);
    fireEvent.click(document.querySelector('[aria-label="New chat"]')!);
    expect(screen.queryByRole("dialog", { name: "Chat history" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search this chat" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Close the assistant" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "open" }));
    expect(
      screen.queryByRole("textbox", { name: "Find in this chat" }),
    ).toBeNull();
  });
});

describe("assistant composer keeps what the person wrote", () => {
  it("shows progress and Stop for a background resume batch after its model turn replied", async () => {
    const bridge = fakeBridge(() => Promise.reject(new Error("unused")), {
      label: "Writing resumes: 2 of 5 finished",
      toolName: "generate_resumes",
      startedAt: new Date().toISOString(),
    });
    await renderSidebar(bridge);
    // The conversation (and its activity) loads after the composer shows.
    expect(
      await screen.findByText("Writing resumes: 2 of 5 finished"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(bridge.stop).toHaveBeenCalledWith(conversation.id),
    );
  });
  it("refuses an over-long message without clearing it and states the limit", async () => {
    const bridge = fakeBridge(() => Promise.reject(new Error("unused")));
    const composer = await renderSidebar(bridge);
    const long = "x".repeat(ASSISTANT_MESSAGE_MAX_CHARS + 1);
    fireEvent.change(composer, { target: { value: long } });
    expect(
      document.querySelector("[data-assistant-too-long]")?.textContent,
    ).toContain("the limit is");
    await act(() => {
      fireEvent.keyDown(composer, { key: "Enter" });
      return Promise.resolve();
    });
    expect(bridge.sendMessage).not.toHaveBeenCalled();
    expect(composer.value).toBe(long);
  });

  it("puts a message back in the box when it could not be sent", async () => {
    const bridge = fakeBridge(() => Promise.reject(new Error("offline")));
    const composer = await renderSidebar(bridge);
    fireEvent.change(composer, { target: { value: "Find me jobs" } });
    await act(() => {
      fireEvent.keyDown(composer, { key: "Enter" });
      return Promise.resolve();
    });
    await waitFor(() => expect(bridge.sendMessage).toHaveBeenCalled());
    await waitFor(() => expect(composer.value).toBe("Find me jobs"));
  });

  it("attaches every file picked at once", async () => {
    const bridge = fakeBridge(() => Promise.reject(new Error("unused")));
    bridge.attachFile = vi.fn(() =>
      Promise.resolve({
        attachment: {
          documentId: "doc_1",
          fileName: "portfolio.pdf",
          kind: "portfolio",
        },
        attachments: [
          { documentId: "doc_1", fileName: "portfolio.pdf", kind: "portfolio" },
          {
            documentId: "doc_2",
            fileName: "transcript.pdf",
            kind: "transcript",
          },
        ],
        message: null,
      }),
    );
    await renderSidebar(bridge);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attach a file" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove transcript.pdf" }),
      ).toBeTruthy(),
    );
    expect(
      screen.getByRole("button", { name: "Remove portfolio.pdf" }),
    ).toBeTruthy();
  });
});

it("shrinks the cleared composer and keeps the narrow switch outside the form", async () => {
  vi.stubGlobal("innerWidth", 592);
  const bridge = fakeBridge(() => new Promise(() => undefined));
  const textarea = await renderSidebar(bridge);
  Object.defineProperty(textarea, "scrollHeight", { value: 300 });
  fireEvent.change(textarea, {
    target: { value: "A long request\nwith several lines" },
  });
  expect(textarea.style.height).not.toBe("auto");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(textarea.value).toBe(""));
  expect(textarea.style.height).toBe("auto");
  expect(textarea.className).toContain("25vh");
  const panel = document.querySelector("aside[data-assistant-sidebar]")!;
  expect(panel.className).toContain("bg-background");
  const toggle = panel.querySelector("[data-assistant-narrow-switch]");
  expect(toggle).not.toBeNull();
  expect(toggle!.closest("form")).toBeNull();
  expect(toggle!.className).not.toContain("fixed");
});
