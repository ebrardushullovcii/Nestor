import type { ApplicationRecord, ApplyJobResult } from "@nestor/contracts";
import { describe, expect, it } from "vitest";

import { getApplicationApplyPresentation } from "./applications-apply-state";

/**
 * The five things an application can be.
 *
 * These tests exist to stop the screen ever telling somebody their application
 * was sent when only an attempt was recorded, and to stop a paused application
 * hiding behind a tidier word.
 */

function record(overrides: Partial<ApplicationRecord> = {}): ApplicationRecord {
  return {
    company: "Northwind Tools",
    lastAttemptState: null,
    latestBlocker: null,
    nextActionLabel: null,
    status: "drafting",
    automationMode: "prepare_only",
    consentSummary: { status: "none", pendingCount: 0 },
    lastActionLabel: "Prepared",
    ...overrides,
  } as unknown as ApplicationRecord;
}

function applyResult(
  outcome: "submitted" | "outcome_uncertain" | "not_submitted" | null,
): ApplyJobResult {
  return {
    privacyReceipt: {
      submissionOutcome: outcome ? { outcome } : null,
    },
  } as unknown as ApplyJobResult;
}

describe("where an application stands", () => {
  it("says filled in, and that nothing was sent, by default", () => {
    const presentation = getApplicationApplyPresentation({
      record: record(),
    });
    expect(presentation.state).toBe("filled");
    expect(presentation.label).toBe("Filled in");
    expect(presentation.summary).toContain("Nothing has been sent");
  });

  it("says ready to send when the person chose to look it over first", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({ automationMode: "confirm_before_submit" }),
    });
    expect(presentation.state).toBe("awaiting_your_review");
    expect(presentation.label).toBe("Ready to send");
    expect(presentation.nextStep).toBe("Review it and send it");
  });

  it("never calls an unconfirmed attempt submitted, and never offers a retry", () => {
    const presentation = getApplicationApplyPresentation({
      record: record(),
      applyResult: {
        ...applyResult("outcome_uncertain"),
        state: "awaiting_review",
        blockerReason: null,
      } as ApplyJobResult,
    });
    expect(presentation.state).toBe("submitted_unverified");
    expect(presentation.label).toBe("Needs you");
    expect(presentation.summary).toContain("could not confirm whether");
    expect(presentation.summary).toContain(
      "Check the employer site before sending it again",
    );
    expect(presentation.summary).not.toMatch(/try again|retry/iu);
    expect(presentation.nextStep).toContain("Northwind Tools");
  });

  it("says submitted only once it is confirmed", () => {
    const presentation = getApplicationApplyPresentation({
      record: record(),
      applyResult: applyResult("submitted"),
    });
    expect(presentation.state).toBe("submitted_verified");
    expect(presentation.nextStep).toBeNull();
  });

  it("treats an outcome the person recorded themselves as confirmed", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({ status: "interview" }),
    });
    expect(presentation.state).toBe("submitted_verified");
  });

  it("shows the pause reason in the person's own words", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({
        lastAttemptState: "paused",
        latestBlocker: {
          code: "site_login_required",
          summary: "The site wants you signed in first.",
        },
        nextActionLabel: "Sign in on the site",
      }),
    });
    expect(presentation.state).toBe("paused");
    expect(presentation.summary).toBe("The site wants you signed in first.");
    expect(presentation.nextStep).toBe("Sign in on the site");
  });

  it("a pause outranks being ready to send", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({
        lastAttemptState: "paused",
        automationMode: "confirm_before_submit",
      }),
    });
    expect(presentation.state).toBe("paused");
  });

  it("lets a blocker-free resumed review result replace a stale paused record", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({
        lastAttemptState: "paused",
        automationMode: "confirm_before_submit",
      }),
      applyResult: {
        ...applyResult(null),
        state: "awaiting_review",
        blockerReason: null,
      } as ApplyJobResult,
    });

    expect(presentation.state).toBe("awaiting_your_review");
    expect(presentation.nextStep).toBe("Review it and send it");
  });

  it("keeps a current review result with a person blocker paused", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({
        lastAttemptState: "paused",
        automationMode: "confirm_before_submit",
        latestBlocker: {
          code: "site_login_required",
          summary: "The site wants you signed in first.",
        },
      }),
      applyResult: {
        ...applyResult(null),
        state: "awaiting_review",
        blockerReason: "auth_required",
      } as ApplyJobResult,
    });

    expect(presentation.state).toBe("paused");
    expect(presentation.summary).toBe("The site wants you signed in first.");
  });

  it("an unconfirmed send outranks a local pause", () => {
    const presentation = getApplicationApplyPresentation({
      record: record({ lastAttemptState: "paused" }),
      applyResult: applyResult("outcome_uncertain"),
    });
    expect(presentation.state).toBe("submitted_unverified");
  });
});
