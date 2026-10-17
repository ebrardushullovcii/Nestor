// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFieldArray, useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateProfileSchema } from "@nestor/contracts";
import {
  createProfileEditorValues,
  type ProfileEditorValues,
} from "../../../lib/profile-editor";
import { ProfileExperienceTab } from "../profile-experience-tab";

const profile = CandidateProfileSchema.parse({
  id: "candidate_work_history_empty",
  firstName: "Alex",
  lastName: "Vanguard",
  fullName: "Alex Vanguard",
  headline: "Platform engineer",
  summary: "Builds dependable systems.",
  currentLocation: "Prishtina, Kosovo",
  yearsExperience: 0,
  email: "alex@example.com",
  baseResume: {
    id: "resume_work_history_empty",
    fileName: "alex.pdf",
    uploadedAt: "2026-08-25T09:00:00.000Z",
    extractionStatus: "ready",
  },
  workEligibility: {},
  professionalSummary: {},
  narrative: {},
  targetRoles: [],
  locations: [],
  skills: [],
  experiences: [],
  education: [],
  certifications: [],
  links: [],
  projects: [],
  spokenLanguages: [],
});

function Harness(props: { onContinueWithoutWorkHistory?: () => void }) {
  const profileForm = useForm<ProfileEditorValues>({
    defaultValues: createProfileEditorValues(profile),
  });
  const experienceArray = useFieldArray({
    control: profileForm.control,
    keyName: "fieldKey",
    name: "records.experiences",
  });

  return (
    <ProfileExperienceTab
      experienceArray={experienceArray}
      onContinueWithoutWorkHistory={props.onContinueWithoutWorkHistory}
      profileForm={profileForm}
    />
  );
}

describe("profile setup work history empty state", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  function render(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(node));
  }

  function findButtons(label: string) {
    return [...(container?.querySelectorAll("button") ?? [])].filter(
      (button) => button.textContent?.trim() === label,
    );
  }

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  it("keeps one accessible recovery action, validates an empty history, and offers an honest continue path", () => {
    if (typeof crypto.randomUUID !== "function") {
      Object.defineProperty(crypto, "randomUUID", {
        value: () => "work_history_empty_test",
      });
    }

    const onContinueWithoutWorkHistory = vi.fn();
    render(
      <Harness onContinueWithoutWorkHistory={onContinueWithoutWorkHistory} />,
    );

    // Plain user-facing copy replaces internal "structured experience" wording
    // and states plainly that having no formal experience is valid.
    expect(container?.textContent).toContain("No work history yet");
    expect(container?.textContent).not.toContain(
      "No structured experience yet",
    );
    expect(container?.textContent).toContain(
      "No formal roles yet is a fine place to start.",
    );

    // The recovery action lives inside the empty state, with no duplicate
    // primary Add action at the top of the section.
    const addButtons = findButtons("Add experience");
    expect(addButtons).toHaveLength(1);
    expect(addButtons[0]).toBeTruthy();

    // A clear skip/continue path is exposed next to that message.
    const continueButtons = findButtons("Continue without adding a role");
    expect(continueButtons).toHaveLength(1);

    act(() => {
      continueButtons[0]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(onContinueWithoutWorkHistory).toHaveBeenCalledTimes(1);
    // Skipping must not pretend a role exists: no record card is fabricated.
    expect(
      container?.querySelectorAll('details[id^="experience-record-"]'),
    ).toHaveLength(0);

    // Adding still works from the empty state and restores the header Add
    // action for populated multi-record use, again without duplicates.
    act(() => {
      findButtons("Add experience")[0]?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(
      container?.querySelectorAll('details[id^="experience-record-"]'),
    ).toHaveLength(1);
    expect(findButtons("Add experience")).toHaveLength(1);
    expect(findButtons("Continue without adding a role")).toHaveLength(0);
    expect(container?.textContent).not.toContain("No work history yet");
  });
});
