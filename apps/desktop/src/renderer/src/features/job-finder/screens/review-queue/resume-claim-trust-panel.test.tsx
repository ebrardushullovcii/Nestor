// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResumeValidationResultSchema,
  resumeClaimOwnershipStatement,
  type ResumeClaimConfirmation,
} from "@nordri/contracts";
import { ResumeClaimTrustPanel } from "./resume-claim-trust-panel";

const assessedAt = "2026-07-30T12:00:00.000Z";

function buildClaim(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `claim_${index}`,
    field: "section_bullet",
    sectionId: "section_experience",
    entryId: "entry_1",
    bulletId: `bullet_${index}`,
    claimText: `Claim ${index}`,
    claimOrigin: "imported",
    contentHash: `fnv1a32:${index.toString(16).padStart(8, "0")}`,
    status: "exact",
    evidenceRefs: [
      {
        id: `evidence_${index}`,
        sourceKind: "resume",
        sourceId: "resume_1",
        snippet: `Candidate evidence ${index}`,
      },
    ],
    verifier: "deterministic_candidate_evidence_v1",
    assessedAt,
    ...overrides,
  };
}

function buildValidation(claimAssessments: unknown[]) {
  return ResumeValidationResultSchema.parse({
    id: "validation_1",
    draftId: "draft_1",
    issues: [],
    draftContentHash: "fnv1a32:12345678",
    claimAssessments,
    pageCount: null,
    validatedAt: assessedAt,
  });
}

describe("ResumeClaimTrustPanel", () => {
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

  function renderPanel(
    claimAssessments: unknown[],
    hasUnsavedChanges = false,
    claimConfirmations: ResumeClaimConfirmation[] = [],
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <ResumeClaimTrustPanel
          draft={{ id: "draft_1", claimConfirmations }}
          hasUnsavedChanges={hasUnsavedChanges}
          validation={buildValidation(claimAssessments)}
        />,
      );
    });
  }

  it("explains candidate-only evidence and distinguishes blockers from user edits", () => {
    renderPanel(
      [
        buildClaim(1),
        buildClaim(2, {
          claimOrigin: "ai_generated",
          status: "review",
          evidenceRefs: [],
        }),
        buildClaim(3, {
          claimOrigin: "user_edited",
          status: "review",
          evidenceRefs: [],
        }),
      ],
      true,
    );

    expect(container?.textContent).toContain("Candidate evidence only");
    expect(container?.textContent).toContain("1 blocking");
    expect(container?.textContent).toContain("Needs your decision");
    expect(container?.textContent).toContain("Review your edit");
    expect(container?.textContent).toContain(
      "Save your edits to refresh claim evidence",
    );
    expect(container?.querySelectorAll("details")).toHaveLength(3);
  });

  it("counts the person's own unsupported edit as theirs and drops it once approved", () => {
    const edit = buildClaim(1, {
      claimOrigin: "user_edited",
      status: "unsupported",
      evidenceRefs: [],
      verifier: "deterministic_candidate_evidence_v2",
    });
    renderPanel([edit]);
    expect(container?.textContent).toContain("1 blocking");
    expect(container?.textContent).toContain("Your edits to decide1");
    expect(container?.textContent).toContain("Generated lines to decide0");

    act(() => root?.unmount());
    container?.remove();
    renderPanel([edit], false, [
      {
        id: "claim_confirmation_1",
        draftId: "draft_1",
        field: "section_bullet",
        sectionId: "section_experience",
        entryId: "entry_1",
        bulletId: "bullet_1",
        confirmedClaimContentHash: edit.contentHash,
        ownershipStatement: resumeClaimOwnershipStatement,
        confirmedAt: assessedAt,
      },
    ]);
    expect(container?.textContent).toContain("Nothing blocking");
    expect(container?.textContent).toContain("Approved by you");
  });

  it("credits a verbatim line to the person, not to the generator", () => {
    renderPanel([
      buildClaim(1, { claimOrigin: "ai_generated", status: "exact" }),
      buildClaim(2, {
        claimOrigin: "ai_generated",
        status: "paraphrase",
      }),
    ]);

    expect(container?.textContent).toContain(
      "Your wording, kept word for word",
    );
    // The reworded line is still credited to the generator.
    expect(container?.textContent).toContain("AI generated");
  });

  it("limits the initial claim DOM and reveals more on demand", () => {
    renderPanel(Array.from({ length: 8 }, (_, index) => buildClaim(index + 1)));

    expect(container?.querySelectorAll("details")).toHaveLength(6);
    const button = [...(container?.querySelectorAll("button") ?? [])].find(
      (entry) => entry.textContent?.includes("Show 2 more claims"),
    );
    expect(button).toBeDefined();

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container?.querySelectorAll("details")).toHaveLength(8);
    expect(container?.textContent).not.toContain("Show 2 more claims");
  });
});
