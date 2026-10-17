// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useForm } from "react-hook-form";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateProfileSchema,
  normalizeProfileSetupStep,
  type ProfileSetupStep,
} from "@nestor/contracts";
import {
  createProfileEditorValues,
  type ProfileEditorValues,
} from "../../../lib/profile-editor";
import { PreferredApplicationLinksField } from "../preferred-application-links-field";
import {
  formatProfileSetupFinishReadiness,
  getProfileSetupStepFooterPrimary,
} from "./profile-setup-step-footer";

describe("profile readiness quality", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  function mount(node: React.ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(node));
  }

  it("states setup readiness once, in words, in the sticky footer", () => {
    // One readiness system: the stepper chips carry per-step counts and this
    // line owns whether setup can finish. It names what is missing instead of
    // publishing a second, different total.
    expect(
      formatProfileSetupFinishReadiness({
        canFinishSetup: true,
        remainingBlockerLabels: [],
      }),
    ).toBe("Everything required is in. You can finish setup.");
    expect(
      formatProfileSetupFinishReadiness({
        canFinishSetup: false,
        remainingBlockerLabels: [
          "Add your name and an email or phone",
          "Enable a job source",
        ],
      }),
    ).toBe(
      "Still needed to finish: Add your name and an email or phone · Enable a job source.",
    );
  });

  it("offers Finish from Job targets as soon as the required items are met", () => {
    const onSaveAndFinish = vi.fn();
    const onSaveAndGoToStep = vi.fn<(step: ProfileSetupStep) => void>();

    const ready = getProfileSetupStepFooterPrimary({
      canFinishSetup: true,
      currentStep: "targeting",
      onSaveAndFinish,
      onSaveAndGoToStep,
    });
    expect(ready.label).toBe("Finish setup and find jobs");
    expect(ready.disabled).toBe(false);
    ready.onPrimary?.();
    expect(onSaveAndFinish).toHaveBeenCalledTimes(1);

    // Not finishable yet: Job targets still continues to the optional step.
    const blocked = getProfileSetupStepFooterPrimary({
      canFinishSetup: false,
      currentStep: "targeting",
      onSaveAndFinish,
      onSaveAndGoToStep,
    });
    expect(blocked.label).toBe("Save and continue to Extras");
    blocked.onPrimary?.();
    expect(onSaveAndGoToStep).toHaveBeenCalledWith("extras");

    // The last step has nowhere to continue to, so it keeps Finish disabled
    // and leans on the readiness line beside it.
    const blockedExtras = getProfileSetupStepFooterPrimary({
      canFinishSetup: false,
      currentStep: "extras",
      onSaveAndFinish,
      onSaveAndGoToStep,
    });
    expect(blockedExtras.label).toBe("Finish setup and find jobs");
    expect(blockedExtras.disabled).toBe(true);
    expect(blockedExtras.onPrimary).toBeNull();
  });

  it("resumes a workspace parked on a retired step at a step that still exists", () => {
    expect(normalizeProfileSetupStep("ready_check")).toBe("targeting");
    expect(normalizeProfileSetupStep("narrative")).toBe("extras");
    expect(normalizeProfileSetupStep("answers")).toBe("extras");
  });

  it("shows public-link labels and URLs instead of internal IDs", () => {
    const profile = CandidateProfileSchema.parse({
      id: "candidate_links",
      firstName: "Alex",
      lastName: "Vanguard",
      fullName: "Alex Vanguard",
      headline: "Staff Engineer",
      summary: "Builds reliable systems.",
      currentLocation: "London, UK",
      yearsExperience: 8,
      email: "alex@example.com",
      baseResume: {
        id: "resume_1",
        fileName: "resume.pdf",
        uploadedAt: "2026-07-16T10:00:00.000Z",
      },
      links: [
        {
          id: "link_linkedin_internal_opaque",
          label: "LinkedIn",
          kind: "linkedin",
          url: "https://www.linkedin.com/in/alex",
        },
      ],
      applicationIdentity: {
        preferredLinkIds: ["link_linkedin_internal_opaque"],
      },
    });

    function Harness() {
      const form = useForm<ProfileEditorValues>({
        defaultValues: createProfileEditorValues(profile),
      });
      return (
        <PreferredApplicationLinksField
          fieldId="preferred-links"
          profileForm={form}
        />
      );
    }

    mount(<Harness />);

    expect(container?.textContent).toContain("LinkedIn");
    expect(container?.textContent).toContain(
      "https://www.linkedin.com/in/alex",
    );
    expect(container?.textContent).not.toContain(
      "link_linkedin_internal_opaque",
    );
    expect(
      container
        ?.querySelector('button[role="checkbox"]')
        ?.getAttribute("data-state"),
    ).toBe("checked");
  });
});
