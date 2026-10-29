// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeImportFieldCandidateSummarySchema } from "@nestor/contracts";
import {
  focusProfileImportSuggestion,
  getNeedsYouSuggestionPath,
  getProfileImportSuggestionDestination,
} from "./profile-import-suggestion-navigation";

function buildCandidate(input: {
  id: string;
  key: string;
  recordId?: string | null;
  section:
    | "identity"
    | "experience"
    | "education"
    | "search_preferences"
    | "answer_bank";
}) {
  return ResumeImportFieldCandidateSummarySchema.parse({
    id: input.id,
    target: {
      section: input.section,
      key: input.key,
      recordId: input.recordId ?? null,
    },
    label:
      input.section === "answer_bank" ? "Availability" : "Imported suggestion",
    value: "Suggested value",
    valuePreview: "Suggested value",
    evidenceText: "Resume evidence",
    confidence: 0.9,
    resolution: "needs_review",
    resolutionReason: null,
    notes: [],
  });
}

describe("profile import suggestion navigation", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "matchMedia");
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "nestor");
  });

  it("sends suggested form answers to their saved answer in Needs you", async () => {
    const run = vi.fn((_name: string, input: { key: string }) =>
      Promise.resolve(
        input.key === "resume_import:availability" ? { id: 7 } : null,
      ),
    );
    Object.defineProperty(window, "nestor", {
      configurable: true,
      value: { needsYou: { run } },
    });
    const availability = buildCandidate({
      id: "availability",
      key: "availability",
      section: "answer_bank",
    });
    expect(getProfileImportSuggestionDestination(availability)).toEqual({
      actionLabel: "Review in Needs you",
      section: null,
    });
    expect(focusProfileImportSuggestion(availability)).toBe(false);
    const view = (path: string) =>
      JSON.parse(
        new URL(path, "app://x").searchParams.get("needs")!,
      ) as unknown;
    expect(view(await getNeedsYouSuggestionPath(availability))).toEqual({
      tab: "saved",
      focusId: 7,
    });
    expect(run).toHaveBeenCalledWith("get_form_answer_by_key", {
      key: "resume_import:availability",
    });
    run.mockResolvedValueOnce(null);
    const path = await getNeedsYouSuggestionPath(availability);
    expect(path.startsWith("/job-finder/actions?")).toBe(true);
    expect(view(path)).toEqual({ tab: "saved", text: "Availability" });
  });

  it("maps suggestions to the profile section where they can be edited", () => {
    expect(
      getProfileImportSuggestionDestination(
        buildCandidate({
          id: "identity_headline",
          key: "headline",
          section: "identity",
        }),
      ),
    ).toEqual({ actionLabel: "Review in Basics", section: "basics" });
    expect(
      getProfileImportSuggestionDestination(
        buildCandidate({
          id: "experience_record",
          key: "record",
          recordId: "experience_1",
          section: "experience",
        }),
      ).section,
    ).toBe("experience");
    expect(
      getProfileImportSuggestionDestination(
        buildCandidate({
          id: "education_record",
          key: "record",
          recordId: "education_1",
          section: "education",
        }),
      ).section,
    ).toBe("background");
    expect(
      getProfileImportSuggestionDestination(
        buildCandidate({
          id: "target_roles",
          key: "targetRoles",
          section: "search_preferences",
        }),
      ).section,
    ).toBe("preferences");
  });

  it("opens and focuses an imported record instead of leaving the card as dead-end prose", () => {
    document.body.innerHTML = `
      <button id="experience-tab">Experience</button>
      <details id="experience-record-experience_1">
        <summary>Senior engineer</summary>
        <input id="experience-title" />
      </details>
    `;
    const record = document.getElementById("experience-record-experience_1");
    const input = document.getElementById("experience-title");

    if (!(record instanceof HTMLDetailsElement) || !input) {
      throw new Error("Expected imported experience fixture");
    }

    const scrollIntoView = vi.fn();
    input.scrollIntoView = scrollIntoView;

    expect(
      focusProfileImportSuggestion(
        buildCandidate({
          id: "experience_record",
          key: "record",
          recordId: "experience_1",
          section: "experience",
        }),
      ),
    ).toBe(true);
    expect(record.open).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("uses instant navigation when reduced motion is requested", () => {
    document.body.innerHTML = `
      <button id="basics-tab">Basics</button>
      <input name="identity.headline" />
    `;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    const headline = document.querySelector<HTMLElement>(
      '[name="identity.headline"]',
    );

    if (!headline) {
      throw new Error("Expected scalar navigation fixture");
    }

    const scrollIntoView = vi.fn();
    headline.scrollIntoView = scrollIntoView;

    expect(
      focusProfileImportSuggestion(
        buildCandidate({
          id: "identity_headline",
          key: "headline",
          section: "identity",
        }),
      ),
    ).toBe(true);

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "auto",
      block: "center",
    });
  });

  it("focuses the exact scalar field and falls back to its section tab", () => {
    document.body.innerHTML = `
      <button id="basics-tab">Basics</button>
      <input name="identity.headline" />
      <button id="background-tab">Background</button>
    `;
    const headline = document.querySelector<HTMLElement>(
      '[name="identity.headline"]',
    );
    const backgroundTab = document.getElementById("background-tab");

    if (!headline || !backgroundTab) {
      throw new Error("Expected scalar navigation fixture");
    }

    headline.scrollIntoView = vi.fn();
    backgroundTab.scrollIntoView = vi.fn();

    expect(
      focusProfileImportSuggestion(
        buildCandidate({
          id: "identity_headline",
          key: "headline",
          section: "identity",
        }),
      ),
    ).toBe(true);
    expect(document.activeElement).toBe(headline);

    expect(
      focusProfileImportSuggestion(
        buildCandidate({
          id: "education_missing_record",
          key: "record",
          recordId: "education_missing",
          section: "education",
        }),
      ),
    ).toBe(true);
    expect(document.activeElement).toBe(backgroundTab);
  });
});
