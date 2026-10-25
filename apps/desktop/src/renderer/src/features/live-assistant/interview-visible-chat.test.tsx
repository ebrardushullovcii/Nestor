// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  InterviewWorkspaceSnapshotSchema,
  type InterviewChatConversation,
  type InterviewWorkspaceSnapshot,
} from "@nestor/contracts";

import { InterviewVisibleChat } from "./interview-visible-chat";

vi.mock("./interview-media-stream-probes", () => ({
  InterviewMediaStreamProbes: (props: { listening: boolean }) => (
    <div data-listening={String(props.listening)} data-testid="media-probes" />
  ),
}));

const originalScrollTo = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalScrollTo) {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScrollTo);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  }
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createChatConversation(
  overrides: Partial<InterviewChatConversation> & {
    updatedAt: string;
    messages: InterviewChatConversation["messages"];
  },
): InterviewChatConversation {
  return {
    id: "conversation_1",
    sessionId: "session_1",
    messages: overrides.messages,
    createdAt: "2026-05-13T05:00:00.000Z",
    updatedAt: overrides.updatedAt,
    ...(overrides.id ? { id: overrides.id } : {}),
    ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  };
}

function createWorkspace(): InterviewWorkspaceSnapshot {
  return InterviewWorkspaceSnapshotSchema.parse({
    module: "live-assistant",
    generatedAt: "2026-05-13T05:00:00.000Z",
    setup: {
      consent: {
        microphoneCapture: true,
        meetingAudioCapture: true,
        screenshotCapture: true,
        modelTransmission: true,
        localRetention: true,
        overlayProtectionNotice: true,
        acceptedAt: "2026-05-13T04:59:00.000Z",
      },
      transcriptionLanguage: "en-US",
    },
    activeSession: {
      id: "session_1",
      status: "active",
      targetContext: {
        kind: "general_interview",
        id: "target_1",
        label: "General interview",
      },
      startedAt: "2026-05-13T05:00:00.000Z",
      listening: true,
      cueCards: [],
      chatConversation: null,
      transcriptSegments: [],
    },
    answerOverlay: {
      surfaceKind: "live_answer_overlay",
      mode: "compact",
      visible: true,
      interactionMode: false,
      opacity: 0.86,
      protectionState: "best_effort",
      statusLabel: "Ready",
      queuedScreenshotCount: 0,
    },
    transcriptOverlay: {
      surfaceKind: "live_transcript_overlay",
      mode: "compact",
      visible: true,
      interactionMode: false,
      opacity: 0.86,
      protectionState: "best_effort",
      statusLabel: "Ready",
      queuedScreenshotCount: 0,
    },
  });
}

describe("InterviewVisibleChat capture controls", () => {
  test("suspends local capture before the pause IPC resolves", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const pauseGate = createDeferred();
    const onPerform = vi.fn(() => pauseGate.promise);
    const rendered = render(
      <InterviewVisibleChat
        audioTranscriptionAvailable
        onGoToReview={() => undefined}
        onGoToSetup={() => undefined}
        onPerform={onPerform}
        onWorkspaceChange={() => undefined}
        pendingAction={null}
        workspace={createWorkspace()}
      />,
    );

    expect(
      rendered.getByTestId("media-probes").getAttribute("data-listening"),
    ).toBe("true");
    fireEvent.click(rendered.getByRole("button", { name: "Pause" }));

    expect(onPerform).toHaveBeenCalledWith("toggle_listening");
    expect(
      rendered.getByTestId("media-probes").getAttribute("data-listening"),
    ).toBe("false");

    await act(async () => {
      pauseGate.resolve();
      await pauseGate.promise;
    });
  });

  test("replaces ended Assist controls with deliberate next-step navigation", () => {
    const baseWorkspace = createWorkspace();
    if (!baseWorkspace.activeSession) {
      throw new Error("Expected an active interview session.");
    }
    const endedSession: NonNullable<
      InterviewWorkspaceSnapshot["activeSession"]
    > = {
      ...baseWorkspace.activeSession,
      status: "ended",
      listening: false,
      endedAt: "2026-05-13T05:02:00.000Z",
    };
    const workspace: InterviewWorkspaceSnapshot = {
      ...baseWorkspace,
      activeSession: endedSession,
      recentSessions: [endedSession],
    };

    const onGoToReview = vi.fn();
    const onGoToSetup = vi.fn();

    const rendered = render(
      <InterviewVisibleChat
        audioTranscriptionAvailable
        onGoToReview={onGoToReview}
        onGoToSetup={onGoToSetup}
        onPerform={vi.fn()}
        onWorkspaceChange={() => undefined}
        pendingAction={null}
        workspace={workspace}
      />,
    );

    expect(rendered.getByText("No interview is active")).toBeTruthy();
    expect(rendered.container.innerHTML).toContain("min-h-[18rem]");
    expect(rendered.container.innerHTML).not.toContain("min-h-[32rem]");
    expect(rendered.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(rendered.queryByRole("button", { name: "End session" })).toBeNull();
    fireEvent.click(
      rendered.getByRole("button", { name: "Review last session" }),
    );
    expect(onGoToReview).toHaveBeenCalledOnce();
    fireEvent.click(
      rendered.getByRole("button", { name: "Start a new interview" }),
    );
    expect(onGoToSetup).toHaveBeenCalledOnce();
  });

  test("renders assistant answers as escaped markdown", () => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    const baseWorkspace = createWorkspace();
    if (!baseWorkspace.activeSession) {
      throw new Error("Expected an active interview session.");
    }
    const chatConversation = createChatConversation({
      updatedAt: "2026-05-13T05:01:00.000Z",
      messages: [
        {
          id: "msg_assistant_1",
          conversationId: "conversation_1",
          sessionId: "session_1",
          role: "assistant",
          content:
            '## Structure\n\n**Answer** the *question* directly.\n\n1. Context\n2. Result <img src=x onerror="alert(1)">',
          replyToMessageId: "msg_user_1",
          attachments: [],
          usedAttachmentIds: [],
          createdAt: "2026-05-13T05:01:00.000Z",
        },
      ],
    });
    const workspace: InterviewWorkspaceSnapshot = {
      ...baseWorkspace,
      activeSession: {
        ...baseWorkspace.activeSession,
        chatConversation,
      },
    };

    const rendered = render(
      <InterviewVisibleChat
        audioTranscriptionAvailable
        onGoToReview={() => undefined}
        onGoToSetup={() => undefined}
        onPerform={vi.fn()}
        onWorkspaceChange={() => undefined}
        pendingAction={null}
        workspace={workspace}
      />,
    );

    const markdownRoot = rendered.container.querySelector(
      "[data-interview-markdown]",
    );
    expect(markdownRoot).not.toBeNull();
    expect(markdownRoot?.querySelector("h4")?.textContent).toBe("Structure");
    expect(markdownRoot?.querySelector("strong")?.textContent).toBe("Answer");
    expect(markdownRoot?.querySelector("em")?.textContent).toBe("question");
    expect(markdownRoot?.querySelectorAll("ol li")).toHaveLength(2);
    expect(markdownRoot?.querySelector("img")).toBeNull();
    expect(markdownRoot?.textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
  });

  test("autoscrolls the conversation through the shared reduced-motion policy", () => {
    const scrollToMock = vi.fn<(options: ScrollToOptions) => void>();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock,
    });
    const setReducedMotion = (matches: boolean) => {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches }),
      });
    };

    const baseWorkspace = createWorkspace();
    const buildChatWorkspace = (
      updatedAt: string,
    ): InterviewWorkspaceSnapshot => {
      if (!baseWorkspace.activeSession) {
        throw new Error("Expected an active interview session.");
      }
      return {
        ...baseWorkspace,
        activeSession: {
          ...baseWorkspace.activeSession,
          chatConversation: createChatConversation({
            updatedAt,
            messages: [],
          }),
        },
      };
    };

    const rendered = render(
      <InterviewVisibleChat
        audioTranscriptionAvailable
        onGoToReview={() => undefined}
        onGoToSetup={() => undefined}
        onPerform={vi.fn()}
        onWorkspaceChange={() => undefined}
        pendingAction={null}
        workspace={buildChatWorkspace("2026-05-13T05:01:00.000Z")}
      />,
    );
    scrollToMock.mockClear();

    // Reduced motion must downgrade the autoscroll to an instant jump.
    setReducedMotion(true);
    act(() => {
      rendered.rerender(
        <InterviewVisibleChat
          audioTranscriptionAvailable
          onGoToReview={() => undefined}
          onGoToSetup={() => undefined}
          onPerform={vi.fn()}
          onWorkspaceChange={() => undefined}
          pendingAction={null}
          workspace={buildChatWorkspace("2026-05-13T05:02:00.000Z")}
        />,
      );
    });
    expect(scrollToMock.mock.lastCall?.[0]?.behavior).toBe("auto");
    expect(typeof scrollToMock.mock.lastCall?.[0]?.top).toBe("number");

    // Standard motion keeps the smooth conversation follow.
    setReducedMotion(false);
    act(() => {
      rendered.rerender(
        <InterviewVisibleChat
          audioTranscriptionAvailable
          onGoToReview={() => undefined}
          onGoToSetup={() => undefined}
          onPerform={vi.fn()}
          onWorkspaceChange={() => undefined}
          pendingAction={null}
          workspace={buildChatWorkspace("2026-05-13T05:03:00.000Z")}
        />,
      );
    });
    expect(scrollToMock.mock.lastCall?.[0]?.behavior).toBe("smooth");
    expect(typeof scrollToMock.mock.lastCall?.[0]?.top).toBe("number");
  });
});
