import {
  ApplicationAttemptBlockerSchema,
  applicationBlockerCodeValues,
  userActionRequestKindValues,
} from "@nestor/contracts";
import { describe, expect, test } from "vitest";

import {
  buildApplicationBlockerFingerprint,
  isApplicationAuthenticationUserActionKind,
  isApplicationTechnicalFailureBlocker,
  mapApplicationBlockerToUserActionKind,
} from "./internal/workspace-application-user-action";
import { mapExecutionResultToApplyBlockerReason } from "./internal/workspace-apply-run-support";

const blockerReasonCases = [
  ["missing_candidate_answer", "required_human_input"],
  ["requires_manual_review", "required_human_input"],
  ["unknown", "required_human_input"],
  ["missing_resume", "resume_missing"],
  ["missing_consent", "signup_consent_required"],
  ["external_redirect", "unexpected_navigation"],
  ["unsupported_apply_path", "unexpected_navigation"],
  ["site_login_required", "auth_required"],
  ["application_page_unreachable", "application_page_unreachable"],
  ["application_closed", "application_closed"],
  ["site_saves_as_you_go", "required_human_input"],
] as const;

describe("application blocker manual-action mapping", () => {
  test("limits source-access verification to authentication-family kinds", () => {
    expect(
      userActionRequestKindValues.filter(
        isApplicationAuthenticationUserActionKind,
      ),
    ).toEqual(["login", "signup", "mfa", "email_verification"]);
  });
  test.each([
    ["site_login_required", "login"],
    ["missing_candidate_answer", "manual_answer"],
    ["missing_resume", "manual_upload"],
    ["missing_consent", "legal_consent"],
    ["external_redirect", "external_redirect"],
    ["unsupported_apply_path", "external_redirect"],
    ["requires_manual_review", "other"],
    ["unknown", "other"],
    ["application_page_unreachable", "other"],
  ] as const)("maps legacy blocker %s to %s", (code, expectedKind) => {
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code,
      summary: "A safe manual step is required.",
    });

    expect(mapApplicationBlockerToUserActionKind(blocker)).toBe(expectedKind);
  });

  test("treats an unreachable application page as a technical failure without a user action", () => {
    const blocker = ApplicationAttemptBlockerSchema.parse({
      code: "application_page_unreachable",
      summary: "Job Finder could not open the application page.",
      detail:
        "The dedicated browser could not load this employer page, so preparation stopped before the page opened.",
      questionIds: [],
      sourceDebugEvidenceRefIds: [],
      url: "https://jobs.example.com/apply/123",
    });

    expect(isApplicationTechnicalFailureBlocker(blocker)).toBe(true);
  });

  test("covers every application blocker code in reason mapping", () => {
    expect(blockerReasonCases.map(([code]) => code).sort()).toEqual(
      [...applicationBlockerCodeValues].sort(),
    );
  });

  test.each(blockerReasonCases)(
    "maps apply blocker reason %s to %s",
    (code, expectedReason) => {
      expect(
        mapExecutionResultToApplyBlockerReason(
          ApplicationAttemptBlockerSchema.parse({
            code,
            summary: "A safe manual step is required.",
          }),
        ),
      ).toBe(expectedReason);
    },
  );
  test.each(userActionRequestKindValues)(
    "preserves explicit %s classification over a generic blocker code",
    (kind) => {
      const blocker = ApplicationAttemptBlockerSchema.parse({
        code: "requires_manual_review",
        userActionKind: kind,
        summary: "A specifically classified manual step is required.",
      });

      expect(mapApplicationBlockerToUserActionKind(blocker)).toBe(kind);
    },
  );

  test("keeps blocker identity stable across prose and evidence changes", () => {
    const original = ApplicationAttemptBlockerSchema.parse({
      code: "missing_candidate_answer",
      userActionKind: "manual_answer",
      summary: "Answer the required question.",
      detail: "The employer asks for a short response.",
      questionIds: ["question_work_authorization"],
      sourceDebugEvidenceRefIds: ["evidence_old"],
      url: "https://jobs.example.com/apply/123?step=2",
    });
    const sameBlocker = ApplicationAttemptBlockerSchema.parse({
      ...original,
      summary: "A required answer is still missing.",
      detail: "Updated wording after the page rerendered.",
      sourceDebugEvidenceRefIds: ["evidence_new"],
      url: "https://jobs.example.com/apply/123?step=2&render=2",
    });
    const nextQuestion = ApplicationAttemptBlockerSchema.parse({
      ...sameBlocker,
      questionIds: ["question_salary_expectation"],
    });
    const nextPage = ApplicationAttemptBlockerSchema.parse({
      ...sameBlocker,
      url: "https://jobs.example.com/apply/123/review",
    });

    expect(buildApplicationBlockerFingerprint(sameBlocker)).toBe(
      buildApplicationBlockerFingerprint(original),
    );
    expect(buildApplicationBlockerFingerprint(nextQuestion)).not.toBe(
      buildApplicationBlockerFingerprint(original),
    );
    expect(buildApplicationBlockerFingerprint(nextPage)).not.toBe(
      buildApplicationBlockerFingerprint(original),
    );
  });
});
