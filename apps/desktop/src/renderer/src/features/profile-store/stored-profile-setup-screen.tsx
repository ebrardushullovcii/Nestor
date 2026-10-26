import { useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import type {
  CandidateProfile,
  JobSearchPreferences,
  ProfileSetupStep,
  ResumeApplicationMode,
} from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { useToast } from "@renderer/components/ui/toast";
import { ProfileSetupScreen } from "@renderer/features/job-finder/components/profile/setup/profile-setup-screen";
import {
  clearProfileSetupJustFinished,
  isProfileSetupJustFinished,
  markProfileSetupJustFinished,
} from "@renderer/pages/profile-setup-finished";
import { editorProfile, profileEdits } from "./profile-edits";
import {
  handOffAfterSetupStep,
  hasProfileEdits,
  nextSetupState,
  resumeGuidedSetup,
  type SetupStepOptions,
} from "./guided-setup";
import { ProfileLeaveGuard } from "./profile-leave-guard";
import { useAllProfileRecords, useStoredProfile } from "./use-stored-profile";
import { useStoredSettings } from "./use-stored-settings";
import { useProfileWorkflow } from "./use-profile-workflow";

const IMPORT_GUARD =
  "Save this step before importing or refreshing from a resume.";

/**
 * Guided setup on the job store: the whole profile is read once per change,
 * a step saves only the fields and records it changed, and the setup state
 * is saved after them.
 */
export function StoredProfileSetupScreen() {
  const store = useStoredProfile();
  const settings = useStoredSettings();
  const workflow = useProfileWorkflow();
  const { records, error: recordsError } = useAllProfileRecords(store.overview);
  const navigate = useNavigate();
  const location = useLocation();
  const { showToast } = useToast();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const profile = useMemo<CandidateProfile | null>(
    () =>
      store.overview && records ? editorProfile(store.overview, records) : null,
    [store.overview, records],
  );
  const setupState = workflow.state?.profileSetupState;

  if (setupState?.status === "completed")
    // A setup finished in this session hands off to Find jobs; a completed
    // setup revisited later goes back to the full Profile editor.
    return (
      <Navigate
        replace
        to={
          isProfileSetupJustFinished()
            ? "/job-finder/discovery"
            : "/job-finder/profile"
        }
      />
    );

  const error = store.error ?? recordsError ?? workflow.error;
  if (!profile || !store.goals || !store.overview || !records || !setupState)
    return error ? (
      <p role="alert">
        {error}{" "}
        <Button
          onClick={() => {
            void store.refresh();
            void workflow.refresh();
          }}
        >
          Try again
        </Button>
      </p>
    ) : (
      <p role="status">Loading guided setup…</p>
    );

  const overview = store.overview;
  const goals = store.goals;

  async function saveStep(
    nextProfile: CandidateProfile,
    nextGoals: JobSearchPreferences,
    nextStep: ProfileSetupStep,
    options: SetupStepOptions & {
      resumeApplicationMode?: ResumeApplicationMode;
    } = {},
  ) {
    const startedOnSetup = location.pathname === "/job-finder/profile/setup";
    setSaving(true);
    try {
      const edits = profileEdits({
        overview,
        records: records!,
        goals,
        beforeProfile: profile!,
        beforeGoals: goals,
        nextProfile,
        nextGoals,
      });
      if (hasProfileEdits(edits) && !(await store.save(edits))) return;
      if (
        options.resumeApplicationMode &&
        options.resumeApplicationMode !==
          settings.settings?.resumeApplicationMode &&
        !(await settings.updateApplicationDefaults({
          resumeApplicationMode: options.resumeApplicationMode,
        }))
      )
        return;
      const sites = await window.nestor.jobs.run("list_sites", { limit: 1 });
      const state = nextSetupState({
        current: setupState!,
        profile: nextProfile,
        goals: nextGoals,
        enabledSites: sites.enabledTotal,
        nextStep,
        options,
        now: new Date().toISOString(),
      });
      // The setup route redirects the moment it renders a finished setup;
      // mark the hand-off first so that redirect goes to Find jobs.
      if (state.status === "completed") markProfileSetupJustFinished();
      const saved = await workflow.saveSetupState(state);
      if (!saved) {
        clearProfileSetupJustFinished();
        return;
      }
      if (state.status !== "completed")
        showToast({
          title:
            options.message ??
            (options.openProfile
              ? "Saved. Opening the full Profile editor."
              : "Saved."),
          tone: "success",
        });
      await handOffAfterSetupStep({ state, options, navigate, startedOnSetup });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ProfileLeaveGuard
        dirty={dirty}
        saving={saving ? "Profile setup" : null}
      />
      <ProfileSetupScreen
        actionState={{
          message: store.error ?? settings.error ?? workflow.message,
        }}
        importResumeGuardMessage={dirty ? IMPORT_GUARD : null}
        isImportResumePending={workflow.isPending("import")}
        isProfileSetupPending={saving || workflow.isPending("setup")}
        isReviewItemPending={(id) => workflow.isPending(`review:${id}`)}
        latestResumeImportReviewCandidates={
          workflow.state!.latestResumeImportReviewCandidates
        }
        latestResumeImportRun={workflow.state!.latestResumeImportRun}
        resumeImportProgress={workflow.importProgress}
        onApplyProfileSetupReviewAction={(id, action, options) =>
          void workflow.applyReviewAction(id, action, options)
        }
        onContinueToProfile={() =>
          void navigate("/job-finder/profile", {
            state: { forceFullProfile: true },
          })
        }
        onImportResume={() => {
          if (dirty) workflow.setMessage(IMPORT_GUARD);
          else void workflow.importResume();
        }}
        onRetryInterruptedImport={() =>
          void workflow.importResume({ retryInterrupted: true })
        }
        onAnalyzeProfileFromResume={() => {
          if (dirty) workflow.setMessage(IMPORT_GUARD);
          else void workflow.analyzeResume();
        }}
        isAnalyzeProfilePending={workflow.isPending("analyze")}
        onCancelImportResume={() => workflow.cancelImportResume(true)}
        onProfileSurfaceDirtyChange={setDirty}
        onProfileSurfaceDraftEdited={() => workflow.setMessage(null)}
        onResumeSetup={(step) =>
          void resumeGuidedSetup(workflow, navigate, location.pathname, step)
        }
        onSaveSetupStep={(nextProfile, nextGoals, nextStep, options) =>
          void saveStep(nextProfile, nextGoals, nextStep, options)
        }
        profile={profile}
        profileSetupState={setupState}
        {...(settings.settings?.resumeApplicationMode
          ? { resumeApplicationMode: settings.settings.resumeApplicationMode }
          : {})}
        searchPreferences={goals}
      />
    </>
  );
}
