// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  ProfileSetupStateSchema,
  ProfileReviewItemSchema,
} from "@nestor/contracts";
import {
  ProfileSetupPathCard,
  ProfileSetupReviewQueueCard,
} from "./profile-setup-screen-sections";
afterEach(cleanup);
test("saved imported steps stop saying Ready to review", () => {
  const props = {
    currentStep: "background" as const,
    hasImportedResume: true,
    onGoToStep: vi.fn(),
    profileSetupState: ProfileSetupStateSchema.parse({
      status: "in_progress",
      currentStep: "background",
    }),
  };
  const { rerender } = render(<ProfileSetupPathCard {...props} />);
  expect(screen.getAllByText("Ready to review")).toHaveLength(2);
  rerender(
    <ProfileSetupPathCard
      {...props}
      profileSetupState={{
        ...props.profileSetupState,
        reviewedSteps: ["essentials", "background"],
      }}
    />,
  );
  expect(screen.queryByText("Ready to review")).toBeNull();
  expect(
    screen.getByRole("button", { name: /Work history/ }).textContent,
  ).toContain("Complete");
});
test("keeps optional suggestions behind one closed disclosure with working Confirm", () => {
  const onApplyReviewAction = vi.fn();
  const items = [0, 1].map((index) => ({
    ...ProfileReviewItemSchema.parse({
      id: `proof_${index}`,
      step: "extras",
      target: { domain: "proof_point", key: "record", recordId: null },
      label: "Delivered work",
      reason:
        "Check this achievement before saving it for future applications.",
      severity: "optional",
      status: "pending",
      proposedValue: "Delivered work on time · 20% improvement",
      sourceCandidateId: `candidate_${index}`,
      createdAt: "2026-10-04T00:00:00.000Z",
    }),
    savedStatus: "pending" as const,
    statusSource: "saved" as const,
  }));
  const { container } = render(
    <ProfileSetupReviewQueueCard
      items={items}
      latestResumeImportReviewCandidates={[]}
      isReviewItemPending={() => false}
      onApplyReviewAction={onApplyReviewAction}
      onEditReviewItem={vi.fn()}
    />,
  );
  const disclosure = screen
    .getByText("2 optional suggestions")
    .closest("details");
  expect(disclosure?.open).toBe(false);
  expect(container.querySelectorAll("details")).toHaveLength(1);
  if (!disclosure) throw new Error("Missing suggestions disclosure");
  disclosure.open = true;
  fireEvent.click(screen.getAllByRole("button", { name: "Confirm" })[0]!);
  expect(onApplyReviewAction).toHaveBeenCalledWith(
    "proof_0",
    "confirm",
    undefined,
  );
});
test("matched saved role retains its comparison and Confirm action", () => {
  const item = {
    ...ProfileReviewItemSchema.parse({
      id: "copperline",
      step: "background",
      target: { domain: "experience", key: "record", recordId: "role_saved" },
      label: "Digital Marketing Intern",
      reason: "Complete the saved role",
      severity: "recommended",
      status: "pending",
      proposedValue: "Digital Marketing Intern · Jun–Aug 2025 · Manchester",
      sourceCandidateId: "candidate_copperline",
      createdAt: "2026-10-04T00:00:00.000Z",
    }),
    savedStatus: "pending" as const,
    statusSource: "saved" as const,
  };
  render(
    <ProfileSetupReviewQueueCard
      items={[item]}
      getSavedValue={() => "Copperline Studio · Captions · Canva"}
      latestResumeImportReviewCandidates={[]}
      isReviewItemPending={() => false}
      onApplyReviewAction={vi.fn()}
      onEditReviewItem={vi.fn()}
    />,
  );
  expect(screen.getByText("Currently saved")).toBeTruthy();
  expect(screen.getByText("Suggested value")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
});
