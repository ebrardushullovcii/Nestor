// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { HashRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { InterviewWorkspaceSnapshot } from "@nestor/contracts";

import { LiveAssistantPage } from "./live-assistant-page";

const LAST_JOB_FINDER_ROUTE_STORAGE_KEY =
  "nestor.live-assistant.last-job-finder-route";

vi.mock("./interview-media-stream-probes", () => ({
  InterviewMediaStreamProbes: () => <div data-testid="media-probes-stub" />,
}));

function createWorkspace(): InterviewWorkspaceSnapshot {
  return {
    module: "live-assistant",
    generatedAt: "2026-08-01T09:00:00.000Z",
    setup: {
      consent: {
        microphoneCapture: false,
        meetingAudioCapture: false,
        screenshotCapture: true,
        modelTransmission: true,
        localRetention: true,
        overlayProtectionNotice: true,
        acceptedAt: "2026-08-01T08:59:00.000Z",
      },
      targetContext: null,
      prepArtifacts: [],
      rehearsal: null,
      transcriptionLanguage: "en-US",
      cueSensitivity: "conservative",
      autoCaptureOnCue: false,
    },
    activeSession: null,
    recentSessions: [],
    answerOverlay: {
      surfaceKind: "live_answer_overlay",
      mode: "popup_window",
      visible: true,
      interactionMode: false,
      opacity: 1,
      protectionState: "best_effort",
      currentCue: null,
      statusLabel: "Live",
    },
    transcriptOverlay: {
      surfaceKind: "live_transcript_overlay",
      mode: "popup_window",
      visible: true,
      interactionMode: false,
      opacity: 1,
      protectionState: "best_effort",
      currentCue: null,
      statusLabel: "Live",
    },
  } as unknown as InterviewWorkspaceSnapshot;
}

function installDesktopApi(workspace: InterviewWorkspaceSnapshot) {
  const liveAssistant = {
    getWorkspace: vi.fn().mockResolvedValue(workspace),
    onWorkspaceChange: vi.fn().mockReturnValue(() => undefined),
  };
  Object.defineProperty(window, "nestor", {
    configurable: true,
    value: {
      liveAssistant,
      ping: vi.fn().mockResolvedValue({ platform: "darwin" }),
      window: {
        getControlsState: vi.fn().mockResolvedValue({
          isClosable: true,
          isFullScreen: false,
          isMaximized: false,
          isMinimizable: true,
        }),
        onControlsStateChange: vi.fn().mockReturnValue(() => undefined),
      },
    },
  });
}

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="route-probe">{location.pathname}</p>;
}

function renderInterviewShell() {
  window.location.hash = "#/live-assistant";
  return render(
    <HashRouter>
      <Routes>
        <Route element={<LiveAssistantPage />} path="/live-assistant" />
        <Route element={<LocationProbe />} path="*" />
      </Routes>
    </HashRouter>,
  );
}

type RenderedShell = ReturnType<typeof renderInterviewShell>;

/**
 * The switcher is a caption trigger plus a menu, so the other module only
 * exists in the tree once the menu is open. Every test that wants to leave for
 * Job Finder goes through the same two steps a person does.
 */
async function openModuleMenu(rendered: RenderedShell) {
  const trigger = await rendered.findByRole("button", {
    name: "Live Assistant, switch module",
  });
  fireEvent.click(trigger);
  return {
    jobFinderItem: rendered.getByRole("menuitemradio", {
      name: "Open Job Finder",
    }),
    trigger,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("Live Assistant product-switcher return target", () => {
  test("navigates to the Job Finder root when no route was recorded yet", async () => {
    installDesktopApi(createWorkspace());
    const rendered = renderInterviewShell();

    const { jobFinderItem } = await openModuleMenu(rendered);

    expect(
      rendered
        .getByRole("img", { name: "Nestor" })
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("#/job-finder");

    fireEvent.click(jobFinderItem);

    const probe = await rendered.findByTestId("route-probe");
    expect(probe.textContent).toBe("/job-finder");
  });

  test("navigates to the last visited Job Finder route once recorded", async () => {
    window.sessionStorage.setItem(
      LAST_JOB_FINDER_ROUTE_STORAGE_KEY,
      "/job-finder/applications",
    );
    installDesktopApi(createWorkspace());

    const outboundVisit = renderInterviewShell();

    expect(
      (await outboundVisit.findByRole("img", { name: "Nestor" }))
        .closest("a")
        ?.getAttribute("href"),
    ).toBe("#/job-finder/applications");

    fireEvent.click(
      outboundVisit.getByRole("link", { name: "Open Job Finder" }),
    );
    expect((await outboundVisit.findByTestId("route-probe")).textContent).toBe(
      "/job-finder/applications",
    );

    cleanup();
    const returnVisit = renderInterviewShell();

    fireEvent.click((await openModuleMenu(returnVisit)).jobFinderItem);
    const returnProbe = await returnVisit.findByTestId("route-probe");
    expect(returnProbe.textContent).toBe("/job-finder/applications");
  });

  test("records Job Finder routes reached while Live Assistant is mounted", async () => {
    installDesktopApi(createWorkspace());
    const rendered = renderInterviewShell();

    const { jobFinderItem } = await openModuleMenu(rendered);
    fireEvent.click(jobFinderItem);
    await rendered.findByTestId("route-probe");

    expect(
      window.sessionStorage.getItem(LAST_JOB_FINDER_ROUTE_STORAGE_KEY),
    ).toBe("/job-finder");
  });

  test("shares the Job Finder module switch and marks Live Assistant selected", async () => {
    installDesktopApi(createWorkspace());
    const rendered = renderInterviewShell();

    // Mirrors the Job Finder shell contract, because it is the same control:
    // one caption trigger under the wordmark naming the module a person is in,
    // and a menu that names both, the current one checked.
    const { jobFinderItem, trigger } = await openModuleMenu(rendered);
    const moduleNav = rendered.container.querySelector(
      "[data-desktop-module-navigation]",
    );
    if (!moduleNav) {
      throw new Error("Desktop module navigation is missing");
    }

    // It sits in the brand block, under the wordmark — never floating in the
    // caption row between the brand and the window controls.
    expect(moduleNav.closest("[data-desktop-brand]")).not.toBeNull();
    expect(moduleNav.contains(trigger)).toBe(true);
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    const menu = rendered.getByRole("menu", { name: "Switch module" });
    const checked = Array.from(menu.querySelectorAll('[aria-checked="true"]'));
    expect(checked).toHaveLength(1);
    expect(checked[0]?.getAttribute("aria-label")).toBe("Live Assistant");
    expect(checked[0]?.textContent).toContain("Live Assistant");
    expect(menu.querySelector("[aria-current]")).toBeNull();
    expect(jobFinderItem.getAttribute("aria-checked")).toBe("false");
  });
});
