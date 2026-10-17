import { useEffect, useMemo, useState } from "react";
import type {
  CandidateProfile,
  JobSearchPreferences,
  ProfileSetupStep,
  ResumeApplicationMode,
} from "@nestor/contracts";
import { hasProfileSetupPlaceholderValue } from "@nestor/contracts";
import type {
  ProfileEditorValues,
  SearchPreferencesEditorValues,
} from "../../../lib/profile-editor";
import {
  buildProfilePayload,
  buildSearchPreferencesPayload,
} from "../../../lib/profile-editor";
import { getJobFinderScrollBehavior } from "../../../lib/job-finder-scroll-behavior";
import { revealBelowShellHeader } from "../../../lib/job-finder-scroll-reveal";
import { getReviewItemScrollTargetId } from "./profile-setup-review-scroll-targets";
import {
  PROFILE_SETUP_VALIDATION_ALERT_ID,
  type ProfileSetupReviewItemDisplay,
} from "./profile-setup-screen-helpers";

/** A pending review item the current draft already resolved by editing its field. */
export interface ProfileSetupResolvedReviewItem {
  id: string;
  status: "confirmed" | "edited";
}

export { getJobFinderScrollBehavior as getProfileSetupScrollBehavior } from "../../../lib/job-finder-scroll-behavior";

/**
 * Guided setup keeps its essentials intentionally compact: location and the
 * short summary are each edited through one field. Profile Basics exposes the
 * same facts through the newer structured fields, so normalize the compact
 * setup draft before it crosses the save boundary. This keeps the canonical
 * snapshot useful to every profile surface without changing the meaning of a
 * direct Profile edit.
 */
function normalizeSetupProfileValues(
  profile: CandidateProfile,
  values: ProfileEditorValues,
): ProfileEditorValues {
  const setupLocation = values.identity.currentLocation.trim();
  const persistedLocation = profile.currentLocation?.trim() ?? "";
  // The compact line is no longer an input: it is seeded from the stored
  // profile and can only be written by applying an imported location
  // suggestion, which itself only fires while the profile records no location
  // of its own. Once a location is stored, city, region and country are the
  // editors, and the line left behind on a still-mounted form must not rewrite
  // them — a later step's save turned a saved "Chicago / Illinois / United
  // States" into City "Remote - United States" with the other two emptied.
  const storesOwnLocation =
    persistedLocation.length > 0 &&
    !hasProfileSetupPlaceholderValue("currentLocation", profile.currentLocation);
  const locationChanged = !storesOwnLocation && setupLocation !== persistedLocation;
  const locationParts = setupLocation
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const summary = values.identity.summary.trim();
  const persistedSummary = profile.summary?.trim() ?? "";
  const summaryChanged = summary !== persistedSummary;

  return {
    ...values,
    identity: {
      ...values.identity,
      ...(locationChanged
        ? {
            // The compact setup field is authoritative when it changes. Set
            // every structured location field explicitly so a shorter edit
            // cannot retain a stale country/region from the previous draft.
            currentCity: locationParts[0] ?? "",
            currentRegion: locationParts[1] ?? "",
            currentCountry:
              locationParts.length > 2 ? (locationParts.at(-1) ?? "") : "",
          }
        : {}),
    },
    summary: {
      ...values.summary,
      // An explicit setup edit (including clearing it) is authoritative;
      // unchanged summaries preserve any existing structured short summary.
      shortValueProposition: summaryChanged
        ? summary
        : values.summary.shortValueProposition,
    },
  };
}

export function buildProfileSetupPayload(
  profile: CandidateProfile,
  values: ProfileEditorValues,
) {
  const profileResult = buildProfilePayload(
    profile,
    normalizeSetupProfileValues(profile, values),
  );

  if (!profileResult.payload) {
    return profileResult;
  }

  // Preserve the stored display line only while the person left every field
  // it is built from alone. Guided setup now edits city, region and country
  // directly, and testing the retired compact field on its own made that test
  // always true: a typed "Austin, TX" was composed correctly and then
  // overwritten with the old stored line, so "Save and continue" reported a
  // save and showed the previous value back.
  const locationPartUnchanged = (
    draft: string,
    stored: string | null | undefined,
  ) => draft.trim() === (stored?.trim() ?? "");
  const locationUnchanged =
    locationPartUnchanged(
      values.identity.currentLocation,
      profile.currentLocation,
    ) &&
    locationPartUnchanged(values.identity.currentCity, profile.currentCity) &&
    locationPartUnchanged(
      values.identity.currentRegion,
      profile.currentRegion,
    ) &&
    locationPartUnchanged(
      values.identity.currentCountry,
      profile.currentCountry,
    );
  if (!locationUnchanged) {
    return profileResult;
  }

  return {
    ...profileResult,
    payload: {
      ...profileResult.payload,
      currentLocation: profile.currentLocation,
    },
  };
}

/**
 * Bring the one canonical validation alert into view after an aborted
 * save-and-move so the failure is visible next to the control the person just
 * used, instead of only at the bottom of a long step. The role="alert" element
 * already announces itself; this only makes it visible, so screen readers
 * never hear the message twice.
 */
export function revealProfileSetupValidationAlert(): void {
  const reveal = () => {
    document.getElementById(PROFILE_SETUP_VALIDATION_ALERT_ID)?.scrollIntoView({
      behavior: getJobFinderScrollBehavior(),
      block: "center",
    });
  };

  if (document.getElementById(PROFILE_SETUP_VALIDATION_ALERT_ID)) {
    reveal();
    return;
  }

  // The alert renders only after the validation message state commits.
  window.requestAnimationFrame(reveal);
}

export function useProfileSetupScreenActions(input: {
  draftAwareReviewItems: readonly ProfileSetupReviewItemDisplay[];
  hasUnsavedChanges: boolean;
  onContinueToProfile: () => void;
  onResumeSetup: (step: ProfileSetupStep) => void;
  onSaveSetupStep: (
    profile: CandidateProfile,
    searchPreferences: JobSearchPreferences,
    nextStep: ProfileSetupStep,
    options?: {
      finishSetup?: boolean;
      message?: string;
      openProfile?: boolean;
      resolvedReviewItems?: readonly ProfileSetupResolvedReviewItem[];
      resumeApplicationMode?: ResumeApplicationMode;
      stayOnCurrentStep?: boolean;
    },
  ) => void;
  profile: CandidateProfile;
  profileFormValues: () => ProfileEditorValues;
  profileSetupCurrentStep: ProfileSetupStep;
  resumeApplicationMode?: ResumeApplicationMode;
  searchPreferences: JobSearchPreferences;
  preferencesFormValues: () => SearchPreferencesEditorValues;
  setValidationMessage: (message: string | null) => void;
}) {
  const [focusedReviewItemId, setFocusedReviewItemId] = useState<string | null>(
    null,
  );
  const [focusedReviewRequestKey, setFocusedReviewRequestKey] = useState(0);

  const currentStepReviewItems = useMemo(
    () =>
      input.draftAwareReviewItems.filter(
        (item) => item.step === input.profileSetupCurrentStep,
      ),
    [input.draftAwareReviewItems, input.profileSetupCurrentStep],
  );

  function openAndScrollToReviewTarget(targetId: string) {
    const target = document.getElementById(targetId);

    if (!target) {
      return;
    }

    const parentDetails = target.closest("details");
    if (parentDetails instanceof HTMLDetailsElement) {
      parentDetails.open = true;
    }

    if (target instanceof HTMLDetailsElement) {
      target.open = true;
    }

    target.scrollIntoView({
      behavior: getJobFinderScrollBehavior(),
      block: "center",
    });
    const view = target.ownerDocument.defaultView;
    if (view) {
      // Native centering gets a lower target into view; the shared reveal
      // helper then corrects the final position below the fixed shell header
      // and its 16px breathing gap without scrolling the window directly.
      revealBelowShellHeader(target, view);
    }

    window.requestAnimationFrame(() => {
      const focusTarget =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLButtonElement
          ? target
          : target.querySelector<HTMLElement>(
              'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
            );

      focusTarget?.focus({ preventScroll: true });
    });
  }

  useEffect(() => {
    if (!focusedReviewItemId) {
      return;
    }

    const focusedItem = input.draftAwareReviewItems.find(
      (item) => item.id === focusedReviewItemId,
    );
    if (!focusedItem || focusedItem.step !== input.profileSetupCurrentStep) {
      return;
    }

    const targetId = getReviewItemScrollTargetId(focusedItem);
    if (!targetId) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      openAndScrollToReviewTarget(targetId);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    focusedReviewItemId,
    input.draftAwareReviewItems,
    input.profileSetupCurrentStep,
  ]);

  function handleSaveStep(
    nextStep: ProfileSetupStep,
    options?: {
      finishSetup?: boolean;
      message?: string;
      openProfile?: boolean;
      resumeApplicationMode?: ResumeApplicationMode;
      stayOnCurrentStep?: boolean;
    },
  ) {
    const profileResult = buildProfileSetupPayload(
      input.profile,
      input.profileFormValues(),
    );
    if (!profileResult.payload) {
      input.setValidationMessage(
        profileResult.validationMessage ?? "Profile data is invalid.",
      );
      revealProfileSetupValidationAlert();
      return;
    }

    const preferencesResult = buildSearchPreferencesPayload(
      input.searchPreferences,
      input.preferencesFormValues(),
    );
    if (!preferencesResult.payload) {
      input.setValidationMessage(
        preferencesResult.validationMessage ??
          "Search preferences are invalid.",
      );
      revealProfileSetupValidationAlert();
      return;
    }

    input.setValidationMessage(null);
    const resumeApplicationMode =
      input.resumeApplicationMode ?? options?.resumeApplicationMode;
    // The draft-aware queue already knows which pending suggestions this
    // draft edits or confirms. Carry those resolutions with the save so the
    // persisted setup state matches what the person just saved instead of
    // asking them to come back and click Confirm on a field they edited.
    const resolvedReviewItems = input.draftAwareReviewItems.flatMap((item) =>
      item.statusSource === "draft" &&
      (item.status === "confirmed" || item.status === "edited")
        ? [{ id: item.id, status: item.status }]
        : [],
    );
    const saveOptions = {
      ...options,
      ...(resumeApplicationMode ? { resumeApplicationMode } : {}),
      ...(resolvedReviewItems.length > 0 ? { resolvedReviewItems } : {}),
    };
    input.onSaveSetupStep(
      profileResult.payload,
      preferencesResult.payload,
      nextStep,
      saveOptions,
    );
  }

  function goToStep(step: ProfileSetupStep) {
    if (step === input.profileSetupCurrentStep) {
      return;
    }

    if (input.hasUnsavedChanges) {
      const profileResult = buildProfileSetupPayload(
        input.profile,
        input.profileFormValues(),
      );
      if (!profileResult.payload) {
        input.setValidationMessage(
          profileResult.validationMessage ?? "Profile data is invalid.",
        );
        revealProfileSetupValidationAlert();
        return;
      }

      const preferencesResult = buildSearchPreferencesPayload(
        input.searchPreferences,
        input.preferencesFormValues(),
      );
      if (!preferencesResult.payload) {
        input.setValidationMessage(
          preferencesResult.validationMessage ??
            "Search preferences are invalid.",
        );
        revealProfileSetupValidationAlert();
        return;
      }

      // Valid dirty setup draft: retain the exact draft object across steps.
      // Moving between setup steps shares the same profile/preferences forms,
      // so no draft is lost and no Stay/Leave prompt is needed. The unsaved
      // confirmation remains armed for any shell navigation that would unmount
      // the draft (Home, Profile, Find jobs, etc.).
      input.setValidationMessage(null);
      input.onResumeSetup(step);
      return;
    }

    input.onResumeSetup(step);
  }

  function handleEditReviewItem(item: ProfileSetupReviewItemDisplay) {
    setFocusedReviewItemId(item.id);
    setFocusedReviewRequestKey((current) => current + 1);

    if (item.step !== input.profileSetupCurrentStep) {
      goToStep(item.step);
      return;
    }

    const targetId = getReviewItemScrollTargetId(item);
    if (!targetId) {
      return;
    }

    window.requestAnimationFrame(() => {
      openAndScrollToReviewTarget(targetId);
    });
  }

  function openProfile() {
    if (input.hasUnsavedChanges) {
      handleSaveStep(input.profileSetupCurrentStep, { openProfile: true });
      return;
    }

    input.onContinueToProfile();
  }

  function handleSaveCurrentStep() {
    handleSaveStep(input.profileSetupCurrentStep, {
      message: "Saved this step.",
      stayOnCurrentStep: true,
    });
  }

  return {
    currentStepReviewItems,
    focusedReviewItemId,
    focusedReviewRequestKey,
    goToStep,
    handleEditReviewItem,
    handleSaveCurrentStep,
    handleSaveStep,
    openProfile,
  };
}
