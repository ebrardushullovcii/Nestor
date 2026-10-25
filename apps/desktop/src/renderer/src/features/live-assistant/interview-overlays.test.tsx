// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { InterviewOverlaySnapshot } from "@nestor/contracts";

import {
  AnswerCueOverlay,
  interviewPopupThemeStyle,
  TranscriptOverlay,
} from "./interview-overlays";

function createAnswerOverlay(): InterviewOverlaySnapshot {
  return {
    confidenceLabel: null,
    currentCue: null,
    interactionMode: false,
    mode: "popup_window",
    opacity: 1,
    protectionState: "verified_protected",
    queuedScreenshotCount: 0,
    statusLabel: "Waiting for questions",
    surfaceKind: "live_answer_overlay",
    transcriptSegments: [],
    visible: true,
  } as unknown as InterviewOverlaySnapshot;
}

function createTranscriptOverlay(): InterviewOverlaySnapshot {
  return {
    confidenceLabel: "grounded",
    currentCue: null,
    interactionMode: false,
    mode: "expanded",
    opacity: 1,
    protectionState: "verified_protected",
    queuedScreenshotCount: 0,
    statusLabel: "Listening",
    surfaceKind: "live_transcript_overlay",
    transcriptSegments: [],
    visible: true,
  } as unknown as InterviewOverlaySnapshot;
}

afterEach(() => {
  cleanup();
});

describe("AnswerCueOverlay empty state", () => {
  test("renders a compact guided placeholder instead of an oversized blank card", () => {
    const rendered = render(
      <AnswerCueOverlay framed snapshot={createAnswerOverlay()} />,
    );

    expect(rendered.getByText("No cue card yet.")).toBeTruthy();
    expect(
      rendered.getByText(
        "Ask a question or let audio detect one and the answer outline will appear here.",
      ),
    ).toBeTruthy();
    expect(rendered.container.innerHTML).not.toContain("min-h-56");
  });
});

describe("TranscriptOverlay popup layout", () => {
  test("fills the popup height and keeps the footer pinned without dead space", () => {
    const rendered = render(
      <TranscriptOverlay
        onCopy={() => undefined}
        onHide={() => undefined}
        snapshot={createTranscriptOverlay()}
      />,
    );

    const popup = rendered.container.querySelector("section")!;
    expect(popup.className).toContain("flex-col");

    const body = rendered.container.querySelector<HTMLElement>(".min-h-0")!;
    expect(body.className).toContain("flex-1");
    expect(body.className).not.toContain("max-h-[28rem]");
    expect(
      popup.contains(rendered.getByText("No transcript segments yet.")),
    ).toBe(true);
    expect(
      rendered.getByText(
        "Start mic or system audio and captured speech will stream in here.",
      ),
    ).toBeTruthy();
  });

  test("keeps framed preview cards constrained to their capped heights", () => {
    const rendered = render(
      <TranscriptOverlay framed snapshot={createTranscriptOverlay()} />,
    );

    const body = rendered.container.querySelector<HTMLElement>(".min-h-0");
    expect(body).toBeNull();
    expect(rendered.container.innerHTML).toContain("max-h-[28rem]");
  });

  test("presents the copy action as an explicit bordered control while protected", () => {
    const rendered = render(
      <TranscriptOverlay
        onCopy={() => undefined}
        onHide={() => undefined}
        snapshot={createTranscriptOverlay()}
      />,
    );

    const copyButton = rendered.getByRole("button", {
      name: "Copy transcript",
    });
    expect(copyButton.className).toContain("border");
    expect(copyButton.className).toContain("text-foreground");
    expect(rendered.getByText("Protected")).toBeTruthy();
  });
});

describe("interview popup overlay status palette", () => {
  // The overlay scope renders outside the app theme on near-black scrims, so
  // it pins its own scrim-tuned copies of the semantic families. These tests
  // keep that hardcoded palette from ever collapsing back into duplicates
  // (success and info were once byte-identical here).
  function channelTriplet(hex: string): [number, number, number] {
    return [
      Number.parseInt(hex.slice(1, 3), 16),
      Number.parseInt(hex.slice(3, 5), 16),
      Number.parseInt(hex.slice(5, 7), 16),
    ];
  }

  function dominanceMargin(hex: string, dominant: 0 | 1 | 2): number {
    const channels = channelTriplet(hex);

    return Math.min(
      ...channels.filter((_, index) => index !== dominant).map(
        (value) => channels[dominant] - value,
      ),
    );
  }

  const overlayTokens = Object.fromEntries(
    Object.entries(interviewPopupThemeStyle).map(([key, value]) => [
      key,
      String(value),
    ]),
  ) as Record<string, string>;

  // noUncheckedIndexedAccess makes Record lookups `string | undefined`; this
  // guard narrows to string while failing the test loudly on a missing key.
  function overlayToken(token: string): string {
    const value = overlayTokens[token];

    if (value === undefined) {
      throw new Error(`Missing ${token} in interviewPopupThemeStyle`);
    }

    return value;
  }

  test("keeps success and info distinct with self-contained semantic families", () => {
    for (const family of ["--warning", "--success", "--info"] as const) {
      for (const part of ["border", "surface", "text"] as const) {
        expect(
          overlayTokens[`${family}-${part}`],
          `${family}-${part} must be pinned in the overlay scope`,
        ).toBeTruthy();
      }
    }

    expect(
      overlayTokens["--success-text"],
      "overlay --success-text must stay sage green",
    ).toBe("#96c4a0");
    expect(
      overlayTokens["--info-text"],
      "overlay --info-text must stay steel blue",
    ).toBe("#a6b9d1");
    expect(dominanceMargin(overlayToken("--success-text"), 1)).toBeGreaterThanOrEqual(12);
    expect(dominanceMargin(overlayToken("--info-text"), 2)).toBeGreaterThanOrEqual(12);
    expect(dominanceMargin(overlayToken("--warning-text"), 0)).toBeGreaterThanOrEqual(12);
  });

  test("never duplicates one family's palette into another inside the scope", () => {
    const triplets = (["--warning", "--success", "--info"] as const).map(
      (family) =>
        JSON.stringify([
          overlayToken(`${family}-border`),
          overlayToken(`${family}-surface`),
          overlayToken(`${family}-text`),
        ]),
    );

    expect(new Set(triplets).size).toBe(triplets.length);
  });
});
