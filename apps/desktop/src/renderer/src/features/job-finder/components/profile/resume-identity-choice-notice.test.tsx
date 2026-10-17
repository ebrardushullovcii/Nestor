// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateProfileSchema } from "@nordri/contracts";
import { ResumeIdentityChoiceNotice } from "./resume-identity-choice-notice";

function profileWith(email: string) {
  return CandidateProfileSchema.parse({
    id: "candidate_identity_notice",
    firstName: "Morgan",
    lastName: "Lee",
    fullName: "Morgan Lee",
    yearsExperience: 9,
    email,
    baseResume: {
      id: "resume_identity_notice",
      fileName: "morgan-lee-resume.txt",
      uploadedAt: "2026-09-23T10:00:00.000Z",
      extractionStatus: "ready",
      textContent:
        "Morgan Lee\nSenior Backend Engineer\nmorgan.lee@example.test",
    },
  });
}

describe("ResumeIdentityChoiceNotice", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("asks about the email when only the email differs", () => {
    // The person changed their email after importing; the name-choice
    // sentence read "the resume says Morgan Lee while your profile says
    // Morgan Lee".
    const onUseProfileName = vi.fn();
    render(
      <ResumeIdentityChoiceNotice
        onKeepResumeName={vi.fn()}
        onUseProfileName={onUseProfileName}
        profile={profileWith("morgan@lee-mail.test")}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "email is “morgan.lee@example.test” and your profile uses “morgan@lee-mail.test”",
    );
    expect(screen.queryByRole("button", { name: /instead/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Got it" }),
    );
    expect(onUseProfileName).toHaveBeenCalledOnce();
  });

  it("says nothing when the resume and the profile agree", () => {
    render(
      <ResumeIdentityChoiceNotice
        onKeepResumeName={vi.fn()}
        onUseProfileName={vi.fn()}
        profile={profileWith("morgan.lee@example.test")}
      />,
    );

    expect(screen.queryByRole("status")).toBeNull();
  });
});
