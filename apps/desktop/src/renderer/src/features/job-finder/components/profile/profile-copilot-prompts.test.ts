import type { ProfileSetupState } from "@nestor/contracts";
import { describe, expect, it } from "vitest";
import { buildProfileSectionStarterQuestion } from "./profile-copilot-prompts";

describe("buildProfileSectionStarterQuestion", () => {
  it("asks for work history when the pending item represents a missing record", () => {
    const reviewItems: ProfileSetupState["reviewItems"] = [
      {
        id: "work-history",
        createdAt: "2026-04-15T09:00:00.000Z",
        label: "Work history",
        proposedValue: null,
        reason: "Missing work history",
        resolvedAt: null,
        severity: "recommended",
        sourceCandidateId: null,
        sourceRunId: null,
        sourceSnippet: null,
        status: "pending",
        step: "background",
        target: { domain: "experience", key: "record", recordId: null },
      },
    ];

    expect(buildProfileSectionStarterQuestion(reviewItems, "experience")).toBe(
      "What work experience should I add first?",
    );
  });

  it("scopes starter questions to the active profile section", () => {
    const reviewItems: ProfileSetupState["reviewItems"] = [
      {
        id: "headline",
        createdAt: "2026-04-15T09:00:00.000Z",
        label: "Headline",
        proposedValue: null,
        reason: "Missing headline",
        resolvedAt: null,
        severity: "critical",
        sourceCandidateId: null,
        sourceRunId: null,
        sourceSnippet: null,
        status: "pending",
        step: "essentials",
        target: { domain: "identity", key: "headline", recordId: null },
      },
      {
        id: "target-roles",
        createdAt: "2026-04-15T08:00:00.000Z",
        label: "Target roles",
        proposedValue: null,
        reason: "Missing target roles",
        resolvedAt: null,
        severity: "recommended",
        sourceCandidateId: null,
        sourceRunId: null,
        sourceSnippet: null,
        status: "pending",
        step: "targeting",
        target: {
          domain: "search_preferences",
          key: "targetRoles",
          recordId: null,
        },
      },
    ];

    expect(buildProfileSectionStarterQuestion(reviewItems, "preferences")).toBe(
      "What target role or roles should I use for your job search?",
    );
    expect(buildProfileSectionStarterQuestion(reviewItems, "basics")).toBe(
      "What headline should I save on your profile?",
    );
  });
});
