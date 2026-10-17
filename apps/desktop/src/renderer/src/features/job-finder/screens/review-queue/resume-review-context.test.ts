import { expect, it } from "vitest";
import {
  ResumeCoverageRoleComparisonSchema,
  WorkHistoryReviewSuggestionSchema,
} from "@nestor/contracts";
import { describeReviewRole } from "./resume-review-context";

it("identifies missing draft entries from the exact coverage record without borrowing another role", () => {
  const suggestion = WorkHistoryReviewSuggestionSchema.parse({
    id: "suggestion",
    profileRecordId: "role-2",
    kind: "weak_fit",
    action: "consider_showing",
    message: "Weaker career-family fit.",
    messageContentHash: "fnv1a32:12345678",
  });
  const role = ResumeCoverageRoleComparisonSchema.parse({
    profileRecordId: "role-2",
    title: "Support Specialist",
    employer: "Example Ltd",
    status: "missing",
    included: false,
    originalIndex: 1,
    originalClaimCount: 2,
    retainedClaimCount: 0,
  });
  expect(describeReviewRole(suggestion, [], [role])).toEqual({
    title: "Support Specialist",
    detail: "Example Ltd",
  });
  expect(
    describeReviewRole(
      { ...suggestion, profileRecordId: "unavailable" },
      [],
      [role],
    ),
  ).toEqual({ title: "Role details unavailable", detail: "" });
});
