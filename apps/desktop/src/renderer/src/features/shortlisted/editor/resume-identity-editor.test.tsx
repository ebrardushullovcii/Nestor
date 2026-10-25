// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResumeDraftIdentity } from "@nestor/contracts";
import { getResumeIdentityTargetId } from "@nestor/contracts";
import { ResumeIdentityEditor } from "./resume-identity-editor";

const identity: ResumeDraftIdentity = {
  fullName: "Alex Vanguard",
  headline: "Senior systems designer",
  location: "London, UK",
  email: "alex@example.com",
  phone: "+44 7700 900123",
  portfolioUrl: null,
  linkedinUrl: "https://www.linkedin.com/in/alex-vanguard",
  githubUrl: null,
  personalWebsiteUrl: null,
  additionalLinks: [],
};

describe("ResumeIdentityEditor", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("collapses into a summary and keeps fields out of the way until opened", () => {
    const { container } = render(
      <ResumeIdentityEditor
        disabled={false}
        identity={identity}
        selectedTargetId={null}
        onChange={vi.fn()}
      />,
    );

    const details = container.querySelector<HTMLDetailsElement>(
      "[data-resume-identity-details]",
    );
    expect(details).toBeTruthy();
    expect(details?.open).toBe(false);
    expect(screen.getByText("Resume identity")).toBeTruthy();
  });

  it("auto-opens and focuses the exact field targeted by preview selection", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    const { container } = render(
      <ResumeIdentityEditor
        disabled={false}
        identity={identity}
        selectedTargetId={getResumeIdentityTargetId("linkedinUrl")}
        onChange={vi.fn()}
      />,
    );

    expect(
      container.querySelector<HTMLDetailsElement>(
        "[data-resume-identity-details]",
      )?.open,
    ).toBe(true);
    expect(document.activeElement?.id).toBe("resume_identity_linkedin");
  });

  it("still edits identity values after opening", () => {
    const onChange = vi.fn();
    const { container } = render(
      <ResumeIdentityEditor
        disabled={false}
        identity={identity}
        selectedTargetId={getResumeIdentityTargetId("fullName")}
        onChange={onChange}
      />,
    );

    container.querySelector<HTMLDetailsElement>(
      "[data-resume-identity-details]",
    )!.open = true;

    const fullName = screen.getByLabelText("Full name");
    fireEvent.change(fullName, { target: { value: "Alexandra Vanguard" } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toMatchObject({
      fullName: "Alexandra Vanguard",
    });
  });

  it("uses a full-strength focus ring so keyboard focus stays >=3:1 in both themes", () => {
    // Diluted ring-primary/60 composites to ~2.1-2.8:1 on interior surfaces in
    // both themes (audit: dark #29313a 2.42 at 60%, light #c9cdd1 2.42 at 60%),
    // below WCAG 2.4.11's 3:1 non-text floor. Full --ring is pinned >=3:1 by
    // styles/globals.test.ts, so the disclosure must bind to that token.
    const { container } = render(
      <ResumeIdentityEditor
        disabled={false}
        identity={identity}
        selectedTargetId={null}
        onChange={vi.fn()}
      />,
    );

    const summary = container.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(summary?.className).toContain("focus-visible:ring-2");
    expect(summary?.className).toContain("focus-visible:ring-ring");
    expect(summary?.className).not.toMatch(/ring-primary\/\d/);
    // Non-focus borders/backgrounds intentionally stay diluted; only the
    // keyboard indicator is promoted.
    const details = container.querySelector("[data-resume-identity-details]");
    expect(details?.className).toContain("border-(--surface-panel-border)");
  });
});
