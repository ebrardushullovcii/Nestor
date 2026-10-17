// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { HashRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  InterviewLiveSession,
  InterviewWorkspaceView,
} from "@nordri/contracts";

import {
  summarizeInterviewSession,
  InterviewTranscriptSegmentSchema,
} from "@nordri/contracts";

import { LiveAssistantPage } from "./live-assistant-page";

vi.mock("./interview-media-stream-probes", () => ({
  InterviewMediaStreamProbes: () => <div data-testid="media-probes-stub" />,
}));

function createEndedSession(): InterviewLiveSession {
  return {
    automaticCueSensitivity: "conservative",
    chatConversation: null,
    cueCards: [],
    cueSummary: "No summary yet.",
    diagnostics: [],
    endedAt: "2026-08-19T10:30:00.000Z",
    id: "session_past_1",
    listening: false,
    protectedSurfaces: [],
    startedAt: "2026-08-19T10:00:00.000Z",
    status: "ended",
    targetContext: {
      company: null,
      confirmedAt: "2026-08-19T09:00:00.000Z",
      id: "target_1",
      kind: "general_interview",
      label: "General interview",
      notes: null,
      profileSnapshot: null,
      role: null,
      savedJob: null,
      sourceUrl: null,
    },
    transcriptAnnotations: [],
    transcriptSegments: [],
    visualBatches: [],
  } as unknown as InterviewLiveSession;
}

function createWorkspace(recentSessions: InterviewLiveSession[] = []) {
  return {
    activeSession: null,
    answerOverlay: {
      confidenceLabel: null,
      currentCue: null,
      interactionMode: false,
      mode: "popup_window",
      opacity: 1,
      protectionState: "best_effort",
      queuedScreenshotCount: 0,
      statusLabel: "Ready",
      surfaceKind: "live_answer_overlay",
      transcriptSegments: [],
      visible: true,
    },
    generatedAt: "2026-08-20T10:00:00.000Z",
    module: "live-assistant",
    overlayPreferences: [],
    recentSessions,
    setup: {
      autoCaptureOnCue: false,
      consent: {
        acceptedAt: null,
        localRetention: false,
        meetingAudioCapture: false,
        microphoneCapture: false,
        modelTransmission: false,
        overlayProtectionNotice: false,
        screenshotCapture: false,
      },
      cueSensitivity: "conservative",
      prepArtifacts: [],
      rehearsal: null,
      targetContext: null,
      transcriptionLanguage: "en-US",
    },
    transcriptOverlay: {
      confidenceLabel: null,
      currentCue: null,
      interactionMode: false,
      mode: "popup_window",
      opacity: 1,
      protectionState: "best_effort",
      queuedScreenshotCount: 0,
      statusLabel: "Ready",
      surfaceKind: "live_transcript_overlay",
      transcriptSegments: [],
      visible: true,
    },
  } as unknown as InterviewWorkspaceView;
}

function installDesktopApi(
  workspace: InterviewWorkspaceView,
  isFullScreen = false,
) {
  Object.defineProperty(window, "nordri", {
    configurable: true,
    value: {
      liveAssistant: {
        getWorkspace: vi.fn().mockResolvedValue(workspace),
        getSession: vi
          .fn()
          .mockImplementation((id: string) =>
            Promise.resolve(
              workspace.recentSessions.find((session) => session.id === id) ??
                null,
            ),
          ),
        onWorkspaceChange: vi.fn().mockReturnValue(() => undefined),
      },
      ping: vi.fn().mockResolvedValue({ platform: "darwin" }),
      window: {
        getControlsState: vi.fn().mockResolvedValue({
          isClosable: true,
          isFullScreen,
          isMaximized: isFullScreen,
          isMinimizable: true,
        }),
        onControlsStateChange: vi.fn().mockReturnValue(() => undefined),
      },
    },
  });
}

function renderInterviewShell() {
  window.location.hash = "#/live-assistant";
  return render(
    <HashRouter>
      <Routes>
        <Route element={<LiveAssistantPage />} path="/live-assistant" />
      </Routes>
    </HashRouter>,
  );
}

function getSectionNav(container: HTMLElement) {
  return container.querySelector('nav[aria-label="Live Assistant sections"]')!;
}

function getCurrentSectionLabels(container: HTMLElement) {
  return Array.from(
    getSectionNav(container).querySelectorAll('button[aria-current="page"]'),
  ).map((tab) => tab.textContent);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Live Assistant section navigation", () => {
  test("moves the suite wordmark fully left in native macOS fullscreen", async () => {
    installDesktopApi(createWorkspace(), true);
    const rendered = renderInterviewShell();

    await rendered.findByRole("heading", { name: "Start interview" });

    const brand = rendered.container.querySelector<HTMLElement>(
      "[data-desktop-brand]",
    );
    expect(brand?.style.paddingInlineStart).toBe("");
  });

  test("marks exactly one section as current and moves it when switching sections", async () => {
    installDesktopApi(createWorkspace([createEndedSession()]));
    const rendered = renderInterviewShell();

    await rendered.findByRole("button", { name: "Review" });

    expect(getCurrentSectionLabels(rendered.container)).toEqual(["Review"]);

    fireEvent.click(rendered.getByRole("button", { name: "Settings" }));

    expect(
      await rendered.findByRole("heading", { name: "Preferences" }),
    ).toBeTruthy();
    expect(getCurrentSectionLabels(rendered.container)).toEqual(["Settings"]);
    expect(getCurrentSectionLabels(rendered.container)).toHaveLength(1);
    expect(
      rendered.queryByRole("heading", { name: "Post-session review" }),
    ).toBeNull();
  });

  test("keeps Settings reachable from exactly one control", async () => {
    installDesktopApi(createWorkspace());
    const rendered = renderInterviewShell();

    await rendered.findByRole("heading", { name: "Start interview" });

    expect(rendered.getAllByRole("button", { name: "Settings" })).toHaveLength(
      1,
    );
    expect(
      rendered.getAllByRole("button", { name: "Change settings" }),
    ).toHaveLength(1);
  });

  test("states the setup stage once without repeating the primary action label", async () => {
    installDesktopApi(createWorkspace());
    const rendered = renderInterviewShell();

    expect(
      await rendered.findAllByText("Accept notices and continue"),
    ).toHaveLength(1);
    expect(rendered.getByText("Accept the required notices")).toBeTruthy();
    expect(
      rendered.getByText(
        "Accept the assistant, local-retention, and visible-overlay notices. Microphone, system audio, and screenshots remain separate opt-ins.",
      ),
    ).toBeTruthy();
  });

  test("renders a compact actionable empty state when Review has no sessions", async () => {
    installDesktopApi(createWorkspace());
    const rendered = renderInterviewShell();

    fireEvent.click(await rendered.findByRole("button", { name: "Review" }));

    expect(
      await rendered.findByText("No saved interview session yet"),
    ).toBeTruthy();
    expect(rendered.container.innerHTML).toContain("min-h-[12rem]");
    expect(rendered.container.innerHTML).not.toContain("min-h-[18rem]");

    fireEvent.click(rendered.getByRole("button", { name: "Go to setup" }));

    expect(
      await rendered.findByRole("heading", { name: "Start interview" }),
    ).toBeTruthy();
  });
  test("loads a complete archived transcript for review from a summary-only workspace", async () => {
    const session = createEndedSession();
    session.transcriptSegments = [
      InterviewTranscriptSegmentSchema.parse({
        id: "retained_segment",
        sessionId: session.id,
        source: "meeting_native_transcript",
        state: "final",
        startedAt: session.startedAt,
        engineKind: "platform_local",
        text: "Complete retained transcript loaded on demand.",
      }),
    ];
    installDesktopApi({
      ...createWorkspace(),
      recentSessions: [summarizeInterviewSession(session)],
    });
    let resolveBody: (session: InterviewLiveSession) => void = () => undefined;
    const body = new Promise<InterviewLiveSession>((resolve) => {
      resolveBody = resolve;
    });
    vi.mocked(window.nordri.liveAssistant.getSession).mockReturnValueOnce(body);
    const rendered = renderInterviewShell();
    expect(
      await rendered.findByText("Loading retained session..."),
    ).toBeTruthy();
    expect(window.nordri.liveAssistant.getSession).toHaveBeenCalledWith(
      session.id,
    );
    expect(
      rendered.queryByText(session.transcriptSegments[0]!.text),
    ).toBeNull();
    await act(async () => {
      resolveBody(session);
      await body;
    });
    expect(
      await rendered.findByText(session.transcriptSegments[0]!.text, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(rendered.queryByText("Loading retained session...")).toBeNull();
  });

  test("pages a retained transcript in chronological order, keeps annotation drafts, and exports the full session", async () => {
    const session = createEndedSession();
    session.transcriptSegments = Array.from({ length: 85 }, (_, index) =>
      InterviewTranscriptSegmentSchema.parse({
        id: `segment_${index}`,
        sessionId: session.id,
        source: index % 2 ? "microphone" : "meeting_native_transcript",
        state: "final",
        startedAt: new Date(
          Date.parse(session.startedAt) + index * 1_000,
        ).toISOString(),
        engineKind: "platform_local",
        text: `Retained segment ${index}`,
      }),
    );
    installDesktopApi({
      ...createWorkspace(),
      recentSessions: [summarizeInterviewSession(session)],
    });
    vi.mocked(window.nordri.liveAssistant.getSession).mockResolvedValue(
      session,
    );
    const exported = {
      format: "markdown",
      fileName: "session.md",
      content: session.transcriptSegments
        .map((segment) => segment.text)
        .join("\n"),
    };
    const exportSession = vi.fn().mockResolvedValue(exported);
    Object.assign(window.nordri.liveAssistant, { exportSession });
    const rendered = renderInterviewShell();
    const transcript = await rendered.findByRole("region", {
      name: "Retained transcript",
    });
    const nav = rendered.getByRole("navigation", {
      name: "Transcript pagination",
    });
    const paragraphs = () => [...transcript.querySelectorAll("p")];
    expect(paragraphs()).toHaveLength(40);
    expect(paragraphs()[0]!.textContent).toContain("Retained segment 0");
    expect(paragraphs()[39]!.textContent).toContain("Retained segment 39");
    const draft = rendered.getByPlaceholderText(
      "Add a correction or review note without changing the original transcript.",
    );
    fireEvent.change(draft, { target: { value: "Unsaved annotation draft" } });
    const target = rendered
      .getByRole("option", { name: "1. Meeting transcript" })
      .closest("select")!;
    fireEvent.change(target, { target: { value: "segment_84" } });
    for (const [first, last, length] of [
      [40, 79, 40],
      [80, 84, 5],
    ]) {
      fireEvent.click(
        within(nav).getByRole("button", { name: "Next transcript page" }),
      );
      await waitFor(() => expect(nav.getAttribute("aria-busy")).toBe("false"));
      expect(paragraphs()).toHaveLength(length!);
      expect(paragraphs()[0]!.textContent).toContain(
        `Retained segment ${first}`,
      );
      expect(paragraphs().at(-1)!.textContent).toContain(
        `Retained segment ${last}`,
      );
    }
    expect(document.activeElement).toBe(
      within(nav).getByRole("button", { name: "Previous transcript page" }),
    );
    expect((draft as HTMLTextAreaElement).value).toBe(
      "Unsaved annotation draft",
    );
    expect(target.value).toBe("segment_84");
    fireEvent.click(rendered.getByRole("button", { name: "Export notes" }));
    await waitFor(() =>
      expect(exportSession).toHaveBeenCalledWith(session.id, "markdown"),
    );
    await waitFor(() =>
      expect(rendered.container.querySelector("pre")?.textContent).toBe(
        exported.content,
      ),
    );
    expect(session.transcriptSegments).toHaveLength(85);
  });

  test("keeps Review transcript text unavailable during an active live session", async () => {
    const scrollToDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollTo",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    try {
      const session = createEndedSession();
      session.status = "active";
      session.endedAt = null;
      session.transcriptSegments = [
        InterviewTranscriptSegmentSchema.parse({
          id: "live_segment",
          sessionId: session.id,
          source: "meeting_native_transcript",
          state: "final",
          startedAt: session.startedAt,
          engineKind: "platform_local",
          text: "Active live transcript stays in its popup",
        }),
      ];
      installDesktopApi({
        ...createWorkspace([session]),
        activeSession: session,
      });
      const rendered = renderInterviewShell();
      fireEvent.click(await rendered.findByRole("button", { name: "Review" }));
      expect(
        await rendered.findByText("Review opens after the live session ends."),
      ).toBeTruthy();
      expect(
        rendered.queryByRole("region", { name: "Retained transcript" }),
      ).toBeNull();
      expect(
        rendered.queryByText(session.transcriptSegments[0]!.text),
      ).toBeNull();
      expect(window.nordri.liveAssistant.getSession).not.toHaveBeenCalled();
    } finally {
      if (scrollToDescriptor)
        Object.defineProperty(
          HTMLElement.prototype,
          "scrollTo",
          scrollToDescriptor,
        );
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
  });
});
