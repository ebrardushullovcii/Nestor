// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeImportFieldCandidateSummarySchema } from "@nestor/contracts";
import { ProfileImportSuggestionList } from "./profile-import-suggestion-list";

describe("ProfileImportSuggestionList", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    container = null;
    root = null;
  });

  it.each(["preferredLinkUrls", "preferredLinkIds"])(
    "labels %s with application-facing copy",
    (key) => {
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      act(() =>
        root?.render(
          <ProfileImportSuggestionList
            onReviewCandidate={vi.fn()}
            candidates={[
              ResumeImportFieldCandidateSummarySchema.parse({
                id: "links",
                target: {
                  section: "application_identity",
                  key,
                  recordId: null,
                },
                label: "Preferred link ids",
                value: ["https://example.test/portfolio"],
                confidence: 0.9,
                resolution: "needs_review",
                notes: [],
              }),
            ]}
          />,
        ),
      );
      expect(container.textContent).toContain(
        "Links to include in applications",
      );
      expect(container.textContent).not.toContain("Preferred link ids");
    },
  );
  it("turns imported record JSON into human-readable suggestion cards", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const onReviewCandidate = vi.fn();

    const educationValue = {
      id: "education_1",
      schoolName: "Budapest University of Technology",
      degree: "BSc",
      fieldOfStudy: "Computer Science",
      startDate: "2018",
      endDate: "2022",
    };
    const languageValue = {
      id: "language_1",
      language: "Albanian",
      proficiency: "Native",
    };

    act(() => {
      root?.render(
        <ProfileImportSuggestionList
          onReviewCandidate={onReviewCandidate}
          candidates={[
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "education_candidate",
              target: {
                section: "education",
                key: "record",
                recordId: "education_1",
              },
              label: "EDUCATION RECORD",
              value: JSON.stringify(educationValue),
              valuePreview: JSON.stringify(educationValue),
              evidenceText: "Budapest University of Technology",
              confidence: 0.91,
              resolution: "needs_review",
              resolutionReason: null,
              notes: [],
            }),
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "language_candidate",
              target: {
                section: "language",
                key: "record",
                recordId: "language_1",
              },
              label: "LANGUAGE RECORD - ALBANIAN",
              value: languageValue,
              valuePreview: JSON.stringify(languageValue),
              evidenceText: "Albanian — Native",
              confidence: 0.96,
              resolution: "needs_review",
              resolutionReason: null,
              notes: [],
            }),
          ]}
        />,
      );
    });

    expect(container?.textContent).toContain(
      "Education · Budapest University of Technology",
    );
    expect(container?.textContent).toContain("Degree: BSc");
    expect(container?.textContent).toContain(
      "Field of study: Computer Science",
    );
    expect(container?.textContent).toContain("Language · Albanian");
    expect(container?.textContent).toContain("Proficiency: Native");
    expect(container?.textContent).not.toContain("EDUCATION RECORD");
    expect(container?.textContent).not.toContain("LANGUAGE RECORD");

    const details = container?.querySelectorAll("details");
    expect(details).toHaveLength(2);
    expect([...details].every((detail) => !detail.open)).toBe(true);
    expect(container?.querySelectorAll("summary")[0]?.textContent).toContain(
      "View source value",
    );
    expect(container?.querySelector("pre")?.textContent).toContain(
      '"schoolName"',
    );
    const reviewButtons = [
      ...(container?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    expect(reviewButtons.map((button) => button.textContent?.trim())).toEqual([
      "Review in Background",
      "Review in Background",
    ]);

    act(() => {
      reviewButtons[0]?.click();
    });
    expect(onReviewCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "education_candidate" }),
    );
  });

  it("keeps ordinary scalar suggestions concise without a source-value disclosure", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ProfileImportSuggestionList
          candidates={[
            ResumeImportFieldCandidateSummarySchema.parse({
              id: "headline_candidate",
              target: { section: "identity", key: "headline", recordId: null },
              label: "TARGET HEADLINE SUGGESTION",
              value: "Principal systems designer",
              valuePreview: "Principal systems designer",
              evidenceText: "Principal systems designer",
              confidence: 0.88,
              resolution: "needs_review",
              resolutionReason: null,
              notes: [],
            }),
          ]}
        />,
      );
    });

    expect(container?.textContent).toContain("Target Headline Suggestion");
    expect(container?.textContent).toContain("Principal systems designer");
    expect(container?.querySelector("details")).toBeNull();
  });
});
