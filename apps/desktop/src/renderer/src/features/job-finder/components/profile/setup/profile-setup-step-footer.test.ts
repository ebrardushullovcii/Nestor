import { describe, expect, it, vi } from "vitest";
import {
  formatProfileSetupFinishReadiness,
  getProfileSetupStepFooterFinish,
  getProfileSetupStepFooterPrimary,
} from "./profile-setup-step-footer";

describe("getProfileSetupStepFooterPrimary", () => {
  it("keeps Save and continue as the primary action on Essentials", () => {
    const onSaveAndGoToStep = vi.fn();
    const primary = getProfileSetupStepFooterPrimary({
      canFinishSetup: false,
      currentStep: "essentials",
      onSaveAndFinish: vi.fn(),
      onSaveAndGoToStep,
    });

    expect(primary).toMatchObject({
      disabled: false,
      label: "Save and continue to Work history",
    });
    primary.onPrimary?.();
    expect(onSaveAndGoToStep).toHaveBeenCalledWith("background");
  });

  it("gates Finish until setup is materially complete", () => {
    const onSaveAndFinish = vi.fn();
    const blocked = getProfileSetupStepFooterPrimary({
      canFinishSetup: false,
      currentStep: "extras",
      onSaveAndFinish,
      onSaveAndGoToStep: vi.fn(),
    });
    expect(blocked).toMatchObject({
      disabled: true,
      label: "Finish setup and find jobs",
      onPrimary: null,
    });

    const ready = getProfileSetupStepFooterPrimary({
      canFinishSetup: true,
      currentStep: "extras",
      onSaveAndFinish,
      onSaveAndGoToStep: vi.fn(),
    });
    expect(ready.disabled).toBe(false);
    expect(ready.label).toBe("Finish setup and find jobs");
    ready.onPrimary?.();
    expect(onSaveAndFinish).toHaveBeenCalledTimes(1);
  });

  it("keeps Save and continue as the filled primary on Job targets, ready or not", () => {
    const onSaveAndGoToStep = vi.fn();
    for (const canFinishSetup of [true, false]) {
      const primary = getProfileSetupStepFooterPrimary({
        canFinishSetup,
        currentStep: "targeting",
        onSaveAndFinish: vi.fn(),
        onSaveAndGoToStep,
      });
      expect(primary.label).toBe("Save and continue to Extras");
      primary.onPrimary?.();
    }
    expect(onSaveAndGoToStep).toHaveBeenCalledWith("extras");
  });

  it("resolves a retired stored step onto the step that owns its content", () => {
    const onSaveAndFinish = vi.fn();

    expect(
      getProfileSetupStepFooterPrimary({
        canFinishSetup: true,
        currentStep: "ready_check",
        onSaveAndFinish,
        onSaveAndGoToStep: vi.fn(),
      }).label,
    ).toBe("Save and continue to Extras");
    expect(
      getProfileSetupStepFooterPrimary({
        canFinishSetup: false,
        currentStep: "narrative",
        onSaveAndFinish,
        onSaveAndGoToStep: vi.fn(),
      }).label,
    ).toBe("Finish setup and find jobs");
  });
});

describe("getProfileSetupStepFooterFinish", () => {
  it("offers an enabled Finish on any step once nothing required is missing", () => {
    const onSaveAndFinish = vi.fn();
    for (const currentStep of [
      "essentials",
      "background",
      "targeting",
    ] as const) {
      const finish = getProfileSetupStepFooterFinish({
        canFinishSetup: true,
        currentStep,
        onSaveAndFinish,
      });
      expect(finish).toMatchObject({
        disabled: false,
        label: "Finish setup and find jobs",
      });
      finish?.onFinish?.();
    }
    expect(onSaveAndFinish).toHaveBeenCalledTimes(3);
  });

  it("shows Finish disabled on Job targets while something required is missing", () => {
    expect(
      getProfileSetupStepFooterFinish({
        canFinishSetup: false,
        currentStep: "targeting",
        onSaveAndFinish: vi.fn(),
      }),
    ).toMatchObject({ disabled: true, onFinish: null });
    // Earlier steps keep one button until Finish is possible.
    expect(
      getProfileSetupStepFooterFinish({
        canFinishSetup: false,
        currentStep: "essentials",
        onSaveAndFinish: vi.fn(),
      }),
    ).toBeNull();
    // On Extras, Finish is the primary itself.
    expect(
      getProfileSetupStepFooterFinish({
        canFinishSetup: true,
        currentStep: "extras",
        onSaveAndFinish: vi.fn(),
      }),
    ).toBeNull();
  });
});

describe("formatProfileSetupFinishReadiness", () => {
  it("collapses a long run of imported-detail reviews into one count per step", () => {
    // Twenty-three "Confirm ..." items used to print in full and push the
    // step's form off screen. Real blockers stay named; review items become
    // one line per step, because the step itself lists them.
    const confirms = Array.from(
      { length: 20 },
      (_, index) => `Confirm acme field ${index + 1}`,
    );
    expect(
      formatProfileSetupFinishReadiness({
        canFinishSetup: false,
        remainingBlockerLabels: [
          "Add a job site (Job targets step)",
          ...confirms,
          "Fill in bluebird title (Basics step)",
          "Confirm bluebird company (Basics step)",
        ],
      }),
    ).toBe(
      "Still needed to finish: Add a job site (Job targets step) · Fill in bluebird title (Basics step) · Review 20 imported details on this step · Review 1 imported detail (Basics step).",
    );
    // Three or fewer stay named in full, whatever they are.
    expect(
      formatProfileSetupFinishReadiness({
        canFinishSetup: false,
        remainingBlockerLabels: [
          "Confirm acme company",
          "Confirm acme title",
          "Confirm acme start date",
        ],
      }),
    ).toBe(
      "Still needed to finish: Confirm acme company · Confirm acme title · Confirm acme start date.",
    );
  });

  it("names what is missing instead of publishing a second count", () => {
    expect(
      formatProfileSetupFinishReadiness({
        canFinishSetup: false,
        remainingBlockerLabels: ["Add work history"],
      }),
    ).toBe("Still needed to finish: Add work history.");
    expect(
      formatProfileSetupFinishReadiness({
        canFinishSetup: true,
        remainingBlockerLabels: [],
      }),
    ).toBe("Everything required is in. You can finish setup.");
  });
});
