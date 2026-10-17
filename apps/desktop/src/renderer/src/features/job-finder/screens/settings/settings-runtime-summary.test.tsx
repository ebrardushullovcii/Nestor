// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BrowserSessionState,
  JobFinderSettings,
} from "@nestor/contracts";
import {
  getApplySafeguardCopy,
  SettingsRuntimeSummary,
} from "./settings-runtime-summary";

afterEach(cleanup);

const browserSession = {
  source: "target_site",
  status: "ready",
  driver: "chrome_profile_agent",
  label: "Browser ready",
  detail: null,
  lastCheckedAt: "2026-07-30T10:00:00.000Z",
} as BrowserSessionState;

const settings = {
  keepSessionAlive: false,
  discoveryOnly: true,
  resumeApplicationMode: "original_resume",
} as JobFinderSettings;

describe("getApplySafeguardCopy", () => {
  it("describes resume checks without overriding the chosen apply mode", () => {
    for (const usesOriginalResume of [true, false]) {
      const copy = getApplySafeguardCopy(usesOriginalResume);
      expect(copy.description).toContain(
        "Sending follows the mode you choose under Applying.",
      );
      expect(copy.description).not.toMatch(
        /never performs|stops before final submit/i,
      );
      expect(copy.description).not.toMatch(/no application was submitted/i);
    }
  });
});

describe("SettingsRuntimeSummary", () => {
  it("renders the apply safeguard disclosure", () => {
    render(
      <SettingsRuntimeSummary
        browserSession={browserSession}
        settings={settings}
      />,
    );

    expect(screen.getByText("Original resume required")).not.toBeNull();
    expect(
      screen.getByText(/Sending follows the mode you choose under Applying/),
    ).not.toBeNull();
  });
});
