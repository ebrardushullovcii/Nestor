import {
  openJobStore,
  createJobSitesStore,
  type JobStore,
} from "@nestor/db/job-store";
import { createJobCommandRunner } from "@nestor/job-finder/job-commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeFirstSearchRequest } from "@renderer/features/find-jobs/first-search";
import type { SetStateAction } from "react";
import {
  CandidateProfileSchema,
  JobSearchPreferencesSchema,
  type JobFinderRendererWorkspaceSnapshot,
  type ResumeExtractionStatus,
} from "@nestor/contracts";
import type {
  ActionState,
  JobFinderShellActions,
} from "@renderer/features/job-finder/lib/job-finder-types";
import {
  createActionRunners,
  createDiscoveryWorkspaceRefreshCoordinator,
  createPrimaryPageActions,
  clearJobFinderNavigationHint,
  noteJobFinderNavigation,
  setJobFinderStatusRoute,
  stripActionStateOwner,
  type ActionStateStatusWrite,
} from "./use-job-finder-page-controller-actions";
import { createJobFinderSaveCoordinator } from "./job-finder-save-state";
import {
  type PendingActionState,
  clearPendingActionScopes,
  invalidatePendingActionScope,
  jobFinderPendingActions,
} from "./job-finder-pending-actions";

describe("createActionRunners", () => {
  it("removes route ownership without dropping saved-file action state", () => {
    expect(
      stripActionStateOwner({
        message: "Saved.",
        ownerPath: "/job-finder/review-queue/job_1/resume",
        savedFilePath: "/tmp/alex-resume.pdf",
      }),
    ).toEqual({
      message: "Saved.",
      savedFilePath: "/tmp/alex-resume.pdf",
    });
  });

  it("keeps scoped pending state active until async success work finishes", async () => {
    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    const observedPendingStates: PendingActionState[] = [];
    const scope = jobFinderPendingActions.profileMutation();
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
      observedPendingStates.push({ ...pendingActionState });
    };

    const { runAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    const succeeded = await runAction(
      async () => {
        await Promise.resolve();
        return "result";
      },
      async () => {
        await Promise.resolve();
        observedPendingStates.push({ ...pendingActionState });
      },
      "Saved",
      { scope },
    );

    expect(observedPendingStates).toEqual([{ [scope]: 1 }, { [scope]: 1 }, {}]);
    expect(actionState.message).toBe("Saved");
    expect(succeeded).toBe(true);
  });
  it("shows a start message while a long action is pending", async () => {
    let actionState: ActionState = { message: "Previous result" };
    let pendingActionState: PendingActionState = {};
    let resolveAction: (value: string) => void = () => undefined;
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const pendingResult = new Promise<string>((resolve) => {
      resolveAction = resolve;
    });
    const { runAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    const actionPromise = runAction(
      () => pendingResult,
      () => undefined,
      "Complete",
      {
        scope: jobFinderPendingActions.apply(),
        startMessage: "Preparing safely",
      },
    );

    expect(actionState.message).toBe("Preparing safely");
    expect(pendingActionState).toEqual({
      [jobFinderPendingActions.apply()]: 1,
    });

    resolveAction("done");
    await actionPromise;
    expect(actionState.message).toBe("Complete");
    expect(pendingActionState).toEqual({});
  });

  it("releases a stuck command button with an honest timeout message", async () => {
    vi.useFakeTimers();
    try {
      let actionState: ActionState = { message: null };
      let pendingActionState: PendingActionState = {};
      let resolveAction!: (value: string) => void;
      const scope = jobFinderPendingActions.userAction("request_1");
      const { runAction } = createActionRunners({
        setActionState: (next) => {
          actionState = typeof next === "function" ? next(actionState) : next;
        },
        setPendingActionState: (next) => {
          pendingActionState =
            typeof next === "function" ? next(pendingActionState) : next;
        },
      });
      const pendingResult = new Promise<string>((resolve) => {
        resolveAction = resolve;
      });
      const actionPromise = runAction(
        () => pendingResult,
        () => undefined,
        "Saved",
        {
          scope,
          releasePendingAfterMs: 90_000,
          pendingTimeoutMessage:
            "This took too long to confirm. Check its status before trying again.",
        },
      );

      await vi.advanceTimersByTimeAsync(90_000);
      expect(pendingActionState).toEqual({});
      expect(actionState.message).toBe(
        "This took too long to confirm. Check its status before trying again.",
      );

      resolveAction("done");
      await actionPromise;
      expect(actionState.message).toBe("Saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stale finally clear a newer operation after navigation cleanup", async () => {
    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    let resolveOlder!: () => void;
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const scope = jobFinderPendingActions.resumeExport("job-1");
    const { withPendingScope } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    const older = withPendingScope(
      scope,
      () =>
        new Promise<void>((resolve) => {
          resolveOlder = resolve;
        }),
    );
    expect(pendingActionState).toEqual({ [scope]: 1 });

    invalidatePendingActionScope(scope);
    pendingActionState = clearPendingActionScopes(pendingActionState, [scope]);

    await withPendingScope(scope, () => Promise.resolve(undefined));
    expect(pendingActionState).toEqual({});

    resolveOlder();
    await older;
    expect(pendingActionState).toEqual({});
  });

  it("shows the actionable message from Electron IPC failures", async () => {
    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const { runAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    const succeeded = await runAction(
      () =>
        Promise.reject(
          new Error(
            "Error invoking remote method 'job-finder:start-apply-copilot-run': Error: The approved tailored CV changed after it was saved.",
          ),
        ),
      () => undefined,
      "Complete",
      { scope: jobFinderPendingActions.apply() },
    );

    expect(actionState.message).toBe(
      "The approved tailored CV changed after it was saved.",
    );
    // A failure carries its tone so it never becomes a toast (ADR 0042).
    expect(actionState.tone).toBe("failure");
    expect(pendingActionState).toEqual({});
    expect(succeeded).toBe(false);
  });
  it("reports a toast-only save through the coordinator without a lingering route copy", async () => {
    let actionState: ActionState = { message: "Previous route message" };
    let pendingActionState: PendingActionState = {};
    const saveStates: string[] = [];
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const coordinator = createJobFinderSaveCoordinator({
      onStateChange: (state) => saveStates.push(state.state),
    });
    const { runSaveAction } = createActionRunners({
      saveCoordinator: coordinator,
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    const saved = await runSaveAction({
      action: () => Promise.resolve("saved"),
      dedupeKey: "profile:toast-only",
      failedFallback: "This setup step was not saved.",
      label: "Profile setup",
      onSuccess: () => undefined,
      routeSuccessMessage: "toast_only",
      savedMessage: "Saved. Next: Work history.",
      scope: jobFinderPendingActions.profileSetup(),
      surface: "profile",
    });

    // The shared toast owns the confirmation (coordinator reached "saved");
    // the route message is cleared instead of receiving a second copy.
    expect(saved).toBe(true);
    expect(saveStates).toEqual(["saving", "saved"]);
    expect(actionState.message).toBeNull();

    const failed = await runSaveAction({
      action: () => Promise.reject(new Error("offline")),
      dedupeKey: "profile:toast-only-failure",
      failedFallback: "This setup step was not saved.",
      label: "Profile setup",
      onSuccess: () => undefined,
      routeSuccessMessage: "toast_only",
      savedMessage: "Saved. Next: Work history.",
      scope: jobFinderPendingActions.profileSetup(),
      surface: "profile",
    });

    expect(failed).toBe(false);
    expect(actionState.message).toBe("offline");
  });
  it("keeps a failed save retryable and updates the action message after retry", async () => {
    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    const saveStates: string[] = [];
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const coordinator = createJobFinderSaveCoordinator({
      onStateChange: (state) => saveStates.push(state.state),
    });
    const action = (() => {
      let attempt = 0;
      return () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new Error("offline"))
          : Promise.resolve("saved");
      };
    })();
    const { runSaveAction } = createActionRunners({
      saveCoordinator: coordinator,
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    await runSaveAction({
      action,
      dedupeKey: "profile:retry-test",
      failedFallback: "Profile was not saved.",
      label: "Profile",
      onSuccess: () => undefined,
      savedMessage: "Profile saved.",
      scope: jobFinderPendingActions.profileMutation(),
      surface: "profile",
    });

    expect(actionState.message).toBe("offline");
    await coordinator.retry();
    expect(actionState.message).toBe("Profile saved.");
    expect(saveStates).toEqual(["saving", "failed", "saving", "saved"]);
    expect(pendingActionState).toEqual({});
  });

  it("keeps a newer save status when an older save fails after it settled", async () => {
    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    let rejectOlder: (error: unknown) => void = () => undefined;
    const coordinator = createJobFinderSaveCoordinator({
      onStateChange: () => undefined,
    });
    const { runSaveAction } = createActionRunners({
      saveCoordinator: coordinator,
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });

    const olderSave = runSaveAction({
      action: () =>
        new Promise<string>((_resolve, reject) => {
          rejectOlder = reject;
        }),
      dedupeKey: "profile:older",
      failedFallback: "Older was not saved.",
      label: "Older",
      onSuccess: () => undefined,
      savedMessage: "Older saved.",
      scope: jobFinderPendingActions.profileMutation(),
      surface: "profile",
    });
    const newerSucceeded = await runSaveAction({
      action: () => Promise.resolve("newer"),
      dedupeKey: "settings:newer",
      failedFallback: "Newer was not saved.",
      label: "Newer",
      onSuccess: () => undefined,
      savedMessage: "Newer saved.",
      scope: jobFinderPendingActions.settingsSave(),
      surface: "settings",
    });
    expect(newerSucceeded).toBe(true);
    expect(actionState.message).toBe("Newer saved.");

    // The older operation settles last with a failure. Its route status
    // writes are fenced by the coordinator's operation token, so the newer
    // success message must survive untouched.
    rejectOlder(new Error("offline"));
    const olderSucceeded = await olderSave;

    expect(olderSucceeded).toBe(false);
    expect(actionState.message).toBe("Newer saved.");
    expect(pendingActionState).toEqual({});
  });
});

describe("createDiscoveryWorkspaceRefreshCoordinator", () => {
  it("coalesces a 511-source burst and still performs one final refresh", async () => {
    vi.useFakeTimers();

    try {
      const refreshWorkspace = vi.fn().mockResolvedValue({});
      const coordinator = createDiscoveryWorkspaceRefreshCoordinator(
        refreshWorkspace,
        { intervalMs: 250 },
      );

      for (let index = 0; index < 511; index += 1) {
        coordinator.notifySourceCompleted();
      }

      expect(refreshWorkspace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      expect(refreshWorkspace).toHaveBeenCalledTimes(1);

      await coordinator.flushFinal();
      expect(refreshWorkspace).toHaveBeenCalledTimes(2);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends progress refreshes to the paced background refresh and reads directly only at the end", async () => {
    vi.useFakeTimers();

    try {
      const refreshWorkspace = vi.fn().mockResolvedValue({});
      const requestProgressiveRefresh = vi.fn();
      const coordinator = createDiscoveryWorkspaceRefreshCoordinator(
        refreshWorkspace,
        { intervalMs: 250, requestProgressiveRefresh },
      );

      coordinator.notifyRunStarted();
      await vi.advanceTimersByTimeAsync(250);
      coordinator.notifyJobsPersisted();
      await vi.advanceTimersByTimeAsync(250);
      expect(requestProgressiveRefresh).toHaveBeenCalledTimes(2);
      expect(refreshWorkspace).not.toHaveBeenCalled();

      await coordinator.flushFinal();
      expect(refreshWorkspace).toHaveBeenCalledTimes(1);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps refreshes single-flight when another source completes during a slow read", async () => {
    vi.useFakeTimers();

    try {
      let resolveRefresh: () => void = () => undefined;
      let refreshCallCount = 0;
      const refreshWorkspace = vi.fn(() => {
        refreshCallCount += 1;
        if (refreshCallCount === 1) {
          return new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          });
        }

        return Promise.resolve();
      });
      const coordinator = createDiscoveryWorkspaceRefreshCoordinator(
        refreshWorkspace,
        { intervalMs: 1 },
      );

      coordinator.notifySourceCompleted();
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshWorkspace).toHaveBeenCalledTimes(1);

      coordinator.notifySourceCompleted();
      const finalRefresh = coordinator.flushFinal();
      resolveRefresh();
      await finalRefresh;

      expect(refreshWorkspace).toHaveBeenCalledTimes(2);
      coordinator.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createPrimaryPageActions", () => {
  let setupStore: JobStore;
  beforeEach(() => {
    setupStore = openJobStore(":memory:");
    createJobSitesStore(setupStore).add({
      text: "https://signal.example/careers",
    });
    vi.stubGlobal("window", {
      nestor: { jobs: { run: createJobCommandRunner({ store: setupStore }) } },
    });
  });
  afterEach(() => {
    setupStore.close();
    vi.unstubAllGlobals();
  });

  const completeSetupProfile = CandidateProfileSchema.parse({
    id: "candidate_setup_ready",
    firstName: "Alex",
    lastName: "Vanguard",
    fullName: "Alex Vanguard",
    headline: "Senior systems designer",
    summary: "Builds resilient workflows.",
    currentLocation: "London, UK",
    yearsExperience: 10,
    email: "alex@example.com",
    baseResume: {
      id: "resume_setup_ready",
      fileName: "alex.pdf",
      uploadedAt: "2026-08-23T10:00:00.000Z",
      textContent: "Alex Vanguard",
      extractionStatus: "ready",
    },
    workEligibility: {
      authorizedWorkCountries: ["United Kingdom"],
      requiresVisaSponsorship: false,
      remoteEligible: true,
    },
    targetRoles: ["Principal Designer"],
    experiences: [
      {
        id: "experience_setup_ready",
        companyName: "Signal Systems",
        title: "Senior Product Designer",
        startDate: "2022-01",
        isCurrent: true,
        summary: "Owned workflow tooling.",
      },
    ],
  });
  const completeSetupPreferences = JobSearchPreferencesSchema.parse({
    targetRoles: ["Principal Designer"],
    locations: ["Remote"],
    workModes: ["remote"],
    minimumSalaryUsd: null,
    approvalMode: "review_before_submit",
    tailoringMode: "balanced",
    discovery: { targets: [] },
  });

  function createSetupActions(
    input: {
      profile?: typeof completeSetupProfile;
      preferences?: typeof completeSetupPreferences;
      sites?: "none" | "disabled";
      reviewItems?: JobFinderRendererWorkspaceSnapshot["profileSetupState"]["reviewItems"];
      locationPathname?: string;
    } = {},
  ) {
    if (input.sites === "none") createJobSitesStore(setupStore).remove(1);
    if (input.sites === "disabled")
      createJobSitesStore(setupStore).update({ id: 1, enabled: false });
    const profile = input.profile ?? completeSetupProfile;
    const searchPreferences = input.preferences ?? completeSetupPreferences;
    const profileSetupState: JobFinderRendererWorkspaceSnapshot["profileSetupState"] =
      {
        status: "in_progress",
        currentStep: "answers",
        completedAt: null,
        lastResumedAt: null,
        reviewItems: input.reviewItems ?? [],
      };
    const snapshot = {
      profile,
      profileSetupState,
      searchPreferences,
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const saveProfileSetupState = vi.fn(
      (nextState: JobFinderRendererWorkspaceSnapshot["profileSetupState"]) =>
        Promise.resolve({ ...snapshot, profileSetupState: nextState }),
    );
    const navigate = vi.fn();
    const runSaveAction = vi.fn(
      async (saveInput: {
        action: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        onSuccess: (
          result: JobFinderRendererWorkspaceSnapshot,
        ) => void | Promise<void>;
      }) => {
        const result = await saveInput.action();
        await saveInput.onSuccess(result);
        return true;
      },
    );
    const runAction = vi.fn(
      async <TResult>(
        action: () => Promise<TResult>,
        onSuccess: (result: TResult) => void | Promise<void>,
      ) => {
        await onSuccess(await action());
        return true;
      },
    );
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveProfileSetupState,
        saveWorkspaceInputs: vi.fn().mockResolvedValue(snapshot),
      } as unknown as JobFinderShellActions,
      getLocationPathname: () =>
        input.locationPathname ?? "/job-finder/profile/setup",
      navigate,
      runAction,
      runSaveAction,
      workspace: snapshot,
    } as unknown as PrimaryPageActionArgs);

    return { navigate, pageActions, runSaveAction, saveProfileSetupState };
  }

  it("persists draft-resolved suggestions with the step and finishes despite a recommended pending suggestion", async () => {
    const recommendedLocationItem = {
      id: "review_locations",
      step: "targeting" as const,
      target: {
        domain: "search_preferences" as const,
        key: "locations",
        recordId: null,
      },
      label: "Preferred locations",
      reason: "Confirm the imported location.",
      severity: "recommended" as const,
      status: "pending" as const,
      proposedValue: "Cedar Park, TX 78613",
      sourceSnippet: null,
      sourceCandidateId: "candidate_locations",
      sourceRunId: "run_1",
      createdAt: "2026-07-16T10:00:00.000Z",
      resolvedAt: null,
    };
    const setup = createSetupActions({
      reviewItems: [recommendedLocationItem],
    });

    setup.pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "narrative",
      { resolvedReviewItems: [{ id: "review_locations", status: "edited" }] },
    );
    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    const persisted = setup.saveProfileSetupState.mock.calls[0]?.[0];
    expect(persisted?.reviewItems[0]).toMatchObject({
      id: "review_locations",
      status: "edited",
    });
    expect(typeof persisted?.reviewItems[0]?.resolvedAt).toBe("string");
    expect(persisted?.reviewedSteps).toContain("answers");

    // A still-pending recommended suggestion must not block finishing.
    const finish = createSetupActions({
      reviewItems: [recommendedLocationItem],
    });
    finish.pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );
    await vi.waitFor(() =>
      expect(finish.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(finish.saveProfileSetupState.mock.calls[0]?.[0]).toMatchObject({
      status: "completed",
    });
    expect(finish.navigate).toHaveBeenCalledWith("/job-finder/discovery", {
      replace: true,
    });
    expect(finish.navigate).not.toHaveBeenCalledWith("/job-finder/profile");
  });

  it("starts the first search when the source was added on the finishing step", async () => {
    takeFirstSearchRequest();
    // The source is added independently of the profile save; both snapshots
    // keep their legacy targets empty.
    createJobSitesStore(setupStore).remove(1);
    const staleWorkspace = {
      activeCampaignId: "setup_plan",
      profile: completeSetupProfile,
      searchPreferences: {
        ...completeSetupPreferences,
        discovery: { ...completeSetupPreferences.discovery, targets: [] },
      },
      profileSetupState: {
        status: "in_progress",
        currentStep: "targeting",
        completedAt: null,
        lastResumedAt: null,
        reviewItems: [],
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const savedSnapshot = {
      ...staleWorkspace,
      searchPreferences: completeSetupPreferences,
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const navigate = vi.fn();
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveProfileSetupState: vi.fn(
          (
            nextState: JobFinderRendererWorkspaceSnapshot["profileSetupState"],
          ) =>
            Promise.resolve({ ...savedSnapshot, profileSetupState: nextState }),
        ),
        saveWorkspaceInputs: vi.fn().mockResolvedValue(savedSnapshot),
      } as unknown as JobFinderShellActions,
      getLocationPathname: () => "/job-finder/profile/setup",
      navigate,
      runAction: vi.fn(),
      runSaveAction: vi.fn(
        async (saveInput: {
          action: () => Promise<JobFinderRendererWorkspaceSnapshot>;
          onSuccess: (
            result: JobFinderRendererWorkspaceSnapshot,
          ) => void | Promise<void>;
        }) => {
          await saveInput.onSuccess(await saveInput.action());
          return true;
        },
      ),
      workspace: staleWorkspace,
    } as unknown as PrimaryPageActionArgs);

    createJobSitesStore(setupStore).add({
      text: "https://new-site.example/jobs",
    });
    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true },
    );
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/job-finder/discovery", {
        replace: true,
      }),
    );
    expect(takeFirstSearchRequest()).toBe(true);
  });

  it("hands off to Find jobs after the completed setup state is persisted", async () => {
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const snapshot = {
      profile: completeSetupProfile,
      searchPreferences: completeSetupPreferences,
      profileSetupState: {
        status: "in_progress",
        currentStep: "ready_check",
        completedAt: null,
        lastResumedAt: null,
        reviewItems: [],
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const saveProfileSetupState = vi.fn(
      async (
        nextState: JobFinderRendererWorkspaceSnapshot["profileSetupState"],
      ) => {
        await saveGate;
        return { ...snapshot, profileSetupState: nextState };
      },
    );
    const navigate = vi.fn();
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveProfileSetupState,
        saveWorkspaceInputs: vi.fn().mockResolvedValue(snapshot),
      } as unknown as JobFinderShellActions,
      getLocationPathname: () => "/job-finder/profile/setup",
      navigate,
      runAction: vi.fn(),
      runSaveAction: vi.fn(
        async (saveInput: {
          action: () => Promise<JobFinderRendererWorkspaceSnapshot>;
          onSuccess: (
            result: JobFinderRendererWorkspaceSnapshot,
          ) => void | Promise<void>;
        }) => {
          const result = await saveInput.action();
          await saveInput.onSuccess(result);
          return true;
        },
      ),
      workspace: snapshot,
    } as unknown as PrimaryPageActionArgs);

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );

    await vi.waitFor(() =>
      expect(saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    // No navigation while the completed state is still saving: the route
    // blocker would park and drop it. The hand-off happens once the whole
    // save settles, replacing the setup route's own Profile redirect.
    expect(navigate).not.toHaveBeenCalled();
    releaseSave();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate).toHaveBeenCalledWith("/job-finder/discovery", {
      replace: true,
    });
  });

  it("changes setup steps without re-navigating the mounted setup route", async () => {
    const setup = createSetupActions();

    setup.pageActions.onResumeProfileSetup("background");

    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(setup.saveProfileSetupState.mock.calls[0]?.[0]).toMatchObject({
      currentStep: "background",
      status: "in_progress",
    });
    expect(setup.navigate).not.toHaveBeenCalled();
  });

  it("navigates into setup when resuming it from another route", async () => {
    const setup = createSetupActions({
      locationPathname: "/job-finder/home",
    });

    setup.pageActions.onResumeProfileSetup("essentials");

    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(setup.navigate).toHaveBeenCalledOnce();
    expect(setup.navigate).toHaveBeenCalledWith("/job-finder/profile/setup");
  });

  it("keeps the save confirmation short and toast-only", async () => {
    const setup = createSetupActions();

    setup.pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "background",
    );

    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    const runSaveActionMock = setup.pageActions as unknown as {
      __unused?: never;
    };
    void runSaveActionMock;
    expect(setup.runSaveAction).toHaveBeenCalledOnce();
    // "Next: <step>" was stale the moment the next step rendered — the toast
    // then described where the user already was.
    expect(setup.runSaveAction.mock.calls[0]?.[0]).toMatchObject({
      routeSuccessMessage: "toast_only",
      savedMessage: "Saved.",
    });

    setup.pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );
    await vi.waitFor(() =>
      expect(setup.runSaveAction).toHaveBeenCalledTimes(2),
    );
    expect(setup.runSaveAction.mock.calls[1]?.[0]).toMatchObject({
      savedMessage: "Setup finished. Next: find jobs.",
    });
  });

  it("keeps setup in progress when Answers advances to the readiness check", async () => {
    const { navigate, pageActions, saveProfileSetupState } =
      createSetupActions();

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
    );

    await vi.waitFor(() =>
      expect(saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(saveProfileSetupState.mock.calls[0]?.[0]).toMatchObject({
      completedAt: null,
      currentStep: "ready_check",
      status: "in_progress",
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    { label: "source", profile: completeSetupProfile, sites: "none" as const },
    {
      label: "enabled source",
      profile: completeSetupProfile,
      sites: "disabled" as const,
    },
    {
      label: "contact",
      profile: { ...completeSetupProfile, email: null, phone: null },
      sites: undefined,
    },
  ])(
    "blocks an explicit finish when canonical readiness is missing $label",
    async ({ profile, sites }) => {
      const setup = createSetupActions({
        profile,
        ...(sites ? { sites } : {}),
      });
      setup.pageActions.onSaveSetupStep(
        profile,
        completeSetupPreferences,
        "ready_check",
        { finishSetup: true, openProfile: true },
      );
      await vi.waitFor(() =>
        expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
      );
      expect(setup.saveProfileSetupState.mock.calls[0]?.[0].status).toBe(
        "in_progress",
      );
      expect(setup.navigate).not.toHaveBeenCalled();
    },
  );

  it("completes only an explicit canonically ready finish with no blocking reviews", async () => {
    const setup = createSetupActions();

    setup.pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );

    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(setup.saveProfileSetupState.mock.calls[0]?.[0]).toMatchObject({
      // A completed setup parks on Job targets, the step that owns Finish.
      currentStep: "targeting",
      status: "completed",
    });
    // Finishing setup hands off into Find jobs instead of the Profile editor.
    expect(setup.navigate).toHaveBeenCalledWith("/job-finder/discovery", {
      replace: true,
    });
  });

  it("keeps setup open until both work-eligibility answers are in", async () => {
    // Countries alone are half the answer: the sponsorship question is the
    // other one every application form asks.
    const profileWithoutSponsorship = CandidateProfileSchema.parse({
      ...completeSetupProfile,
      workEligibility: {
        ...completeSetupProfile.workEligibility,
        requiresVisaSponsorship: null,
      },
    });
    const setup = createSetupActions({ profile: profileWithoutSponsorship });

    setup.pageActions.onSaveSetupStep(
      profileWithoutSponsorship,
      completeSetupPreferences,
      "targeting",
      { finishSetup: true, openProfile: true },
    );

    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(setup.saveProfileSetupState.mock.calls[0]?.[0].status).toBe(
      "in_progress",
    );
    expect(setup.navigate).not.toHaveBeenCalled();
  });

  it("persists setup's unchanged-original choice through the existing application mode", async () => {
    let persistedSnapshot = {
      profile: completeSetupProfile,
      searchPreferences: completeSetupPreferences,
      profileSetupState: {
        status: "in_progress",
        currentStep: "targeting",
        completedAt: null,
        lastResumedAt: null,
        reviewItems: [],
      },
      settings: {
        resumeApplicationMode: "tailored_per_job",
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    const saveWorkspaceInputs = vi.fn(
      (
        profile: typeof completeSetupProfile,
        searchPreferences: typeof completeSetupPreferences,
      ) => {
        persistedSnapshot = {
          ...persistedSnapshot,
          profile,
          searchPreferences,
        };
        return Promise.resolve(persistedSnapshot);
      },
    );
    const updateApplicationDefaults = vi.fn(
      (input: {
        resumeApplicationMode?: "tailored_per_job" | "original_resume";
      }) => {
        persistedSnapshot = {
          ...persistedSnapshot,
          settings: {
            ...persistedSnapshot.settings,
            ...input,
          },
        };
        return Promise.resolve(persistedSnapshot);
      },
    );
    const saveProfileSetupState = vi.fn(
      (
        profileSetupState: JobFinderRendererWorkspaceSnapshot["profileSetupState"],
      ) => {
        persistedSnapshot = { ...persistedSnapshot, profileSetupState };
        return Promise.resolve(persistedSnapshot);
      },
    );
    const runSaveAction = vi.fn(
      async (saveInput: {
        action: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        onSuccess: (
          result: JobFinderRendererWorkspaceSnapshot,
        ) => void | Promise<void>;
      }) => {
        await saveInput.onSuccess(await saveInput.action());
        return true;
      },
    );
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveProfileSetupState,
        saveWorkspaceInputs,
        updateApplicationDefaults,
      } as unknown as JobFinderShellActions,
      getLocationPathname: () => "/job-finder/profile/setup",
      navigate: vi.fn(),
      runSaveAction,
      workspace: persistedSnapshot,
    } as unknown as PrimaryPageActionArgs);

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "targeting",
      { resumeApplicationMode: "original_resume" },
    );

    await vi.waitFor(() =>
      expect(saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(updateApplicationDefaults).toHaveBeenCalledWith({
      resumeApplicationMode: "original_resume",
    });
    expect(persistedSnapshot.settings.resumeApplicationMode).toBe(
      "original_resume",
    );
  });

  it("blocks an explicit ready finish while a critical setup item remains pending", async () => {
    // Only a critical pending item still gates Finish. A recommended field the
    // resume left empty is a hint: it never stands between a person with a
    // name, a contact, and a source and their first search.
    const setup = createSetupActions({
      reviewItems: [
        {
          id: "review_setup_blocker",
          step: "essentials",
          target: {
            domain: "identity",
            key: "email",
            recordId: null,
          },
          label: "Email",
          reason: "Add an email address or phone number.",
          severity: "critical",
          status: "pending",
          proposedValue: null,
          sourceSnippet: null,
          sourceCandidateId: null,
          sourceRunId: null,
          createdAt: "2026-08-23T10:00:00.000Z",
          resolvedAt: null,
        },
      ],
    });

    setup.pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );

    await vi.waitFor(() =>
      expect(setup.saveProfileSetupState).toHaveBeenCalledOnce(),
    );
    expect(setup.saveProfileSetupState.mock.calls[0]?.[0].status).toBe(
      "in_progress",
    );
    expect(setup.navigate).not.toHaveBeenCalled();
  });

  it("persists a fresh setup journey without bypassing source enablement or the explicit ready-check finish", async () => {
    createJobSitesStore(setupStore).update({ id: 1, enabled: false });
    const disabledPreferences = JobSearchPreferencesSchema.parse({
      ...completeSetupPreferences,
      discovery: {
        ...completeSetupPreferences.discovery,
        targets: completeSetupPreferences.discovery.targets.map((target) => ({
          ...target,
          enabled: false,
        })),
      },
    });
    let persistedSnapshot = {
      profile: completeSetupProfile,
      searchPreferences: disabledPreferences,
      profileSetupState: {
        status: "not_started",
        currentStep: "import",
        completedAt: null,
        lastResumedAt: null,
        reviewItems: [],
      },
    } as unknown as JobFinderRendererWorkspaceSnapshot;
    let shouldCreateImportReview = true;
    const persistedSetupStates: JobFinderRendererWorkspaceSnapshot["profileSetupState"][] =
      [];
    const saveWorkspaceInputs = vi.fn(
      (
        profile: typeof completeSetupProfile,
        searchPreferences: typeof completeSetupPreferences,
      ) => {
        persistedSnapshot = {
          ...persistedSnapshot,
          profile,
          searchPreferences,
          profileSetupState: shouldCreateImportReview
            ? {
                ...persistedSnapshot.profileSetupState,
                reviewItems: [
                  {
                    id: "review_imported_headline",
                    step: "essentials",
                    target: {
                      domain: "identity",
                      key: "headline",
                      recordId: null,
                    },
                    label: "Headline",
                    reason: "Confirm the imported headline.",
                    severity: "recommended",
                    status: "pending",
                    proposedValue: completeSetupProfile.headline,
                    sourceSnippet: completeSetupProfile.headline,
                    sourceCandidateId: "candidate_imported_headline",
                    sourceRunId: "resume_import_first_run",
                    createdAt: "2026-08-23T10:00:00.000Z",
                    resolvedAt: null,
                  },
                ],
              }
            : persistedSnapshot.profileSetupState,
        };
        shouldCreateImportReview = false;
        return Promise.resolve(persistedSnapshot);
      },
    );
    const saveProfileSetupState = vi.fn(
      (
        profileSetupState: JobFinderRendererWorkspaceSnapshot["profileSetupState"],
      ) => {
        persistedSnapshot = { ...persistedSnapshot, profileSetupState };
        persistedSetupStates.push(profileSetupState);
        return Promise.resolve(persistedSnapshot);
      },
    );
    const navigate = vi.fn();
    const runSaveAction = vi.fn(
      async (saveInput: {
        action: () => Promise<JobFinderRendererWorkspaceSnapshot>;
        onSuccess: (
          result: JobFinderRendererWorkspaceSnapshot,
        ) => void | Promise<void>;
      }) => {
        await saveInput.onSuccess(await saveInput.action());
        return true;
      },
    );
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveProfileSetupState,
        saveWorkspaceInputs,
      } as unknown as JobFinderShellActions,
      getLocationPathname: () => "/job-finder/profile/setup",
      navigate,
      runSaveAction,
      workspace: persistedSnapshot,
    } as unknown as PrimaryPageActionArgs);

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      disabledPreferences,
      "background",
    );
    await vi.waitFor(() => expect(persistedSetupStates).toHaveLength(1));
    expect(persistedSetupStates.at(-1)).toMatchObject({
      status: "in_progress",
      currentStep: "background",
      completedAt: null,
    });
    expect(persistedSetupStates.at(-1)?.reviewItems[0]).toMatchObject({
      id: "review_imported_headline",
      status: "pending",
    });

    persistedSnapshot = {
      ...persistedSnapshot,
      profileSetupState: {
        ...persistedSnapshot.profileSetupState,
        reviewItems: persistedSnapshot.profileSetupState.reviewItems.map(
          (item) => ({
            ...item,
            status: "confirmed" as const,
            resolvedAt: "2026-08-23T10:01:00.000Z",
          }),
        ),
      },
    };

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      disabledPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );
    await vi.waitFor(() => expect(persistedSetupStates).toHaveLength(2));
    expect(persistedSetupStates.at(-1)).toMatchObject({
      status: "in_progress",
      currentStep: "ready_check",
      completedAt: null,
    });
    expect(navigate).not.toHaveBeenCalled();

    createJobSitesStore(setupStore).update({ id: 1, enabled: true });
    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "targeting",
    );
    await vi.waitFor(() => expect(persistedSetupStates).toHaveLength(3));
    expect(createJobSitesStore(setupStore).get(1)?.enabled).toBe(true);
    expect(persistedSnapshot.searchPreferences.discovery.targets).toEqual([]);
    expect(persistedSetupStates.at(-1)).toMatchObject({
      status: "in_progress",
      currentStep: "targeting",
    });

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
    );
    await vi.waitFor(() => expect(persistedSetupStates).toHaveLength(4));
    expect(persistedSetupStates.at(-1)).toMatchObject({
      status: "in_progress",
      currentStep: "ready_check",
      completedAt: null,
    });
    expect(navigate).not.toHaveBeenCalled();

    pageActions.onSaveSetupStep(
      completeSetupProfile,
      completeSetupPreferences,
      "ready_check",
      { finishSetup: true, openProfile: true },
    );
    await vi.waitFor(() => expect(persistedSetupStates).toHaveLength(5));
    expect(persistedSetupStates.at(-1)).toMatchObject({
      status: "completed",
      currentStep: "targeting",
    });
    expect(persistedSetupStates.at(-1)?.completedAt).toEqual(
      expect.any(String),
    );
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/job-finder/discovery", {
      replace: true,
    });
  });

  it("keeps a cancelled or failed resume import retryable without replacing the saved profile", async () => {
    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const importResume = vi
      .fn<JobFinderShellActions["importResume"]>()
      .mockRejectedValueOnce(
        new Error("Resume import failed. Try another file."),
      )
      .mockResolvedValueOnce({
        profile: completeSetupProfile,
      } as JobFinderRendererWorkspaceSnapshot);
    const { runAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: { importResume } as unknown as JobFinderShellActions,
      canImportResume: true,
      importResumeGuardMessage: null,
      runAction,
      setActionState: applyActionState,
      workspace: {
        profile: completeSetupProfile,
      } as JobFinderRendererWorkspaceSnapshot,
    } as unknown as PrimaryPageActionArgs);

    pageActions.onImportResume();
    await vi.waitFor(() =>
      expect(actionState.message).toBe(
        "Resume import failed. Try another file.",
      ),
    );
    expect(pendingActionState).toEqual({});
    expect(completeSetupProfile.fullName).toBe("Alex Vanguard");

    pageActions.onImportResume();
    await vi.waitFor(() =>
      expect(actionState.message).toBe(
        "No resume selected. Your profile was not changed.",
      ),
    );
    expect(importResume).toHaveBeenCalledTimes(2);
    expect(pendingActionState).toEqual({});
  });

  it("R3-231 clears a cancelled-picker notice when the next import starts and succeeds", async () => {
    let state: ActionState = { message: null };
    let pending: PendingActionState = {};
    const setActionState = (next: SetStateAction<ActionState>) => {
      state = typeof next === "function" ? next(state) : next;
    };
    const { runAction } = createActionRunners({
      setActionState,
      setPendingActionState: (next) => {
        pending = typeof next === "function" ? next(pending) : next;
      },
    });
    let finish!: (snapshot: JobFinderRendererWorkspaceSnapshot) => void;
    const importResume = vi
      .fn<JobFinderShellActions["importResume"]>()
      .mockResolvedValueOnce({
        profile: completeSetupProfile,
      } as JobFinderRendererWorkspaceSnapshot)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    const actions = createPrimaryPageActions({
      actions: { importResume } as unknown as JobFinderShellActions,
      canImportResume: true,
      importResumeGuardMessage: null,
      runAction,
      setActionState,
      workspace: { profile: completeSetupProfile },
    } as unknown as Parameters<typeof createPrimaryPageActions>[0]);
    actions.onImportResume();
    await vi.waitFor(() =>
      expect(state.message).toContain("No resume selected"),
    );
    actions.onImportResume();
    expect(state.message).toBeNull();
    finish({
      profile: {
        ...completeSetupProfile,
        baseResume: {
          ...completeSetupProfile.baseResume,
          id: "resume_new",
          fileName: "fatima-noor.md",
          extractionStatus: "ready",
        },
      },
    } as JobFinderRendererWorkspaceSnapshot);
    await vi.waitFor(() =>
      expect(state.message).toContain("fatima-noor.md was imported"),
    );
    expect(state.message).not.toContain("No resume selected");
  });

  it("classifies resolved imports by extraction status instead of claiming extracted details", async () => {
    const extractionStatusExpectations = [
      {
        extractionStatus: "ready",
        expectedMessage:
          "alex.pdf was imported. Review the extracted details before approving them.",
      },
      {
        extractionStatus: "needs_text",
        expectedMessage:
          "alex.pdf was saved, but no text could be read from it, so no details were extracted. Try another file, or add your details manually in Profile.",
      },
      {
        extractionStatus: "failed",
        expectedMessage:
          "alex.pdf was saved, but extracting its details failed. Try importing it again, or add your details manually in Profile.",
      },
      {
        extractionStatus: "not_started",
        expectedMessage:
          "alex.pdf was saved, but its details have not been extracted yet. Open Profile and refresh from the saved resume.",
      },
    ] as const satisfies ReadonlyArray<{
      extractionStatus: ResumeExtractionStatus;
      expectedMessage: string;
    }>;

    let actionState: ActionState = { message: null };
    let pendingActionState: PendingActionState = {};
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const applyPendingActionState = (
      next: SetStateAction<PendingActionState>,
    ) => {
      pendingActionState =
        typeof next === "function" ? next(pendingActionState) : next;
    };
    const { runAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState: applyPendingActionState,
    });
    const importResume = vi.fn<JobFinderShellActions["importResume"]>();
    for (const expectation of extractionStatusExpectations) {
      // Mirror the domain shape: only `ready`/`not_started` imply readable
      // saved text (`profile-merge.ts` derives both from textContent).
      const hasReadableText =
        expectation.extractionStatus === "ready" ||
        expectation.extractionStatus === "not_started";
      importResume.mockResolvedValueOnce({
        profile: CandidateProfileSchema.parse({
          ...completeSetupProfile,
          id: `candidate_import_${expectation.extractionStatus}`,
          baseResume: {
            ...completeSetupProfile.baseResume,
            id: `resume_import_${expectation.extractionStatus}`,
            extractionStatus: expectation.extractionStatus,
            textContent: hasReadableText
              ? completeSetupProfile.baseResume.textContent
              : null,
          },
        }),
      } as JobFinderRendererWorkspaceSnapshot);
    }
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: { importResume } as unknown as JobFinderShellActions,
      canImportResume: true,
      importResumeGuardMessage: null,
      runAction,
      setActionState: applyActionState,
      workspace: {
        profile: completeSetupProfile,
      } as JobFinderRendererWorkspaceSnapshot,
    } as unknown as PrimaryPageActionArgs);

    for (const expectation of extractionStatusExpectations) {
      pageActions.onImportResume();
      await vi.waitFor(() =>
        expect(actionState.message).toBe(expectation.expectedMessage),
      );
    }

    expect(importResume).toHaveBeenCalledTimes(
      extractionStatusExpectations.length,
    );
    expect(pendingActionState).toEqual({});
  });

  it("routes application-default saves through the scoped action without touching tracker CRM or whole-object save", async () => {
    const snapshot = {} as JobFinderRendererWorkspaceSnapshot;
    const saveSettings = vi.fn<JobFinderShellActions["saveSettings"]>();
    const updateApplicationDefaults = vi
      .fn<JobFinderShellActions["updateApplicationDefaults"]>()
      .mockResolvedValue(snapshot);
    const runSaveAction = vi.fn(
      async (input: { action: () => Promise<unknown> }) => {
        await input.action();
        return true;
      },
    );
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveSettings,
        updateApplicationDefaults,
      } as unknown as JobFinderShellActions,
      runSaveAction,
      workspace: {} as JobFinderRendererWorkspaceSnapshot,
    } as unknown as PrimaryPageActionArgs);

    await pageActions.onUpdateApplicationDefaults({
      resumeApplicationMode: "original_resume",
      resumeTemplateId: "modern_split",
    });

    expect(updateApplicationDefaults).toHaveBeenCalledOnce();
    expect(updateApplicationDefaults).toHaveBeenCalledWith({
      resumeApplicationMode: "original_resume",
      resumeTemplateId: "modern_split",
    });
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("routes appearance and workspace-behavior saves through their scoped methods", async () => {
    const snapshot = {} as JobFinderRendererWorkspaceSnapshot;
    const saveSettings = vi.fn<JobFinderShellActions["saveSettings"]>();
    const updateApplicationDefaults =
      vi.fn<JobFinderShellActions["updateApplicationDefaults"]>();
    const updateAppearanceTheme = vi
      .fn<JobFinderShellActions["updateAppearanceTheme"]>()
      .mockResolvedValue(snapshot);
    const updateWorkspaceBehavior = vi
      .fn<JobFinderShellActions["updateWorkspaceBehavior"]>()
      .mockResolvedValue(snapshot);
    const updateAiBehavior = vi
      .fn<JobFinderShellActions["updateAiBehavior"]>()
      .mockResolvedValue(snapshot);
    const runSaveAction = vi.fn(
      async (input: { action: () => Promise<unknown> }) => {
        await input.action();
        return true;
      },
    );
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        saveSettings,
        updateApplicationDefaults,
        updateAppearanceTheme,
        updateWorkspaceBehavior,
        updateAiBehavior,
      } as unknown as JobFinderShellActions,
      runSaveAction,
      workspace: {} as JobFinderRendererWorkspaceSnapshot,
    } as unknown as PrimaryPageActionArgs);

    const behaviorCompleted = await pageActions.onUpdateWorkspaceBehavior({
      keepSessionAlive: true,
      discoveryOnly: true,
    });
    const themeCompleted = await pageActions.onUpdateAppearanceTheme("dark");
    const aiCompleted = await pageActions.onUpdateAiBehavior({
      resumeApproach: "conservative",
    });

    expect(behaviorCompleted).toBe(true);
    expect(themeCompleted).toBe(true);
    expect(aiCompleted).toBe(true);
    expect(updateAppearanceTheme).toHaveBeenCalledWith("dark");
    expect(updateWorkspaceBehavior).toHaveBeenCalledWith({
      keepSessionAlive: true,
      discoveryOnly: true,
    });
    expect(updateAiBehavior).toHaveBeenCalledWith({
      resumeApproach: "conservative",
    });
    expect(updateApplicationDefaults).not.toHaveBeenCalled();
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it("reports scoped settings failures through the action state and resolves as not saved", async () => {
    let actionState: ActionState = { message: null };
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const setPendingActionState = vi.fn();
    const { runSaveAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState,
    });
    const updateApplicationDefaults = vi
      .fn<JobFinderShellActions["updateApplicationDefaults"]>()
      .mockRejectedValue(new Error("CV defaults were not committed."));
    type PrimaryPageActionArgs = Parameters<typeof createPrimaryPageActions>[0];
    const pageActions = createPrimaryPageActions({
      actions: {
        updateApplicationDefaults,
      } as unknown as JobFinderShellActions,
      runSaveAction,
      workspace: {} as JobFinderRendererWorkspaceSnapshot,
    } as unknown as PrimaryPageActionArgs);

    const completed = await pageActions.onUpdateApplicationDefaults({
      resumeTemplateId: "modern_split",
    });

    expect(completed).toBe(false);
    expect(actionState.message).toBe("CV defaults were not committed.");
  });

  it("resolves a no-coordinator scoped save with the real outcome after success", async () => {
    let actionState: ActionState = { message: null };
    const applyActionState = (next: SetStateAction<ActionState>) => {
      actionState = typeof next === "function" ? next(actionState) : next;
    };
    const setPendingActionState = vi.fn();
    // No saveCoordinator: runSaveAction takes the fallback path.
    const { runSaveAction } = createActionRunners({
      setActionState: applyActionState,
      setPendingActionState,
    });
    const updateAppearanceTheme = vi
      .fn<JobFinderShellActions["updateAppearanceTheme"]>()
      .mockResolvedValue({} as JobFinderRendererWorkspaceSnapshot);

    const completed = await runSaveAction({
      action: () => updateAppearanceTheme("dark"),
      dedupeKey: "settings:fallback-success",
      failedFallback: "Appearance was not saved.",
      label: "Appearance",
      onSuccess: () => undefined,
      savedMessage: "Appearance saved.",
      scope: jobFinderPendingActions.settingsSave(),
      surface: "settings",
    });

    expect(completed).toBe(true);
    expect(actionState.message).toBe("Appearance saved.");
  });

  describe("action status route ownership", () => {
    afterEach(() => {
      setJobFinderStatusRoute(null);
      clearJobFinderNavigationHint();
    });

    function collectStatusWrites(
      setActionState: ReturnType<typeof vi.fn>,
    ): ActionStateStatusWrite[] {
      return setActionState.mock.calls
        .map((call) => call[0] as ActionStateStatusWrite)
        .filter((next) => next.message !== null);
    }

    it("owns every runner status write by the route where the action started", async () => {
      setJobFinderStatusRoute("/job-finder/discovery");
      const setActionState = vi.fn();
      const setPendingActionState = vi.fn();
      const { runAction } = createActionRunners({
        setActionState,
        setPendingActionState,
      });

      const completed = await runAction(
        () => Promise.resolve("ok"),
        () => undefined,
        "Job hidden.",
        { scope: jobFinderPendingActions.discoveryJob("job_1") },
      );

      expect(completed).toBe(true);
      const statusWrites = collectStatusWrites(setActionState);
      expect(statusWrites).toHaveLength(1);
      expect(statusWrites[0]).toMatchObject({
        message: "Job hidden.",
        ownerPath: "/job-finder/discovery",
      });
    });

    it("owns a save status by the navigation the save performs on completion", async () => {
      setJobFinderStatusRoute("/job-finder/profile/setup");
      // The save's own onSuccess navigates to the profile route; the status
      // written as part of that same completion belongs there.
      noteJobFinderNavigation("/job-finder/profile");
      const setActionState = vi.fn();
      const setPendingActionState = vi.fn();
      const coordinator = createJobFinderSaveCoordinator({
        onStateChange: () => undefined,
      });
      const { runSaveAction } = createActionRunners({
        saveCoordinator: coordinator,
        setActionState,
        setPendingActionState,
      });

      await runSaveAction({
        action: () => Promise.resolve("saved"),
        dedupeKey: "profile:owner-hint",
        failedFallback: "Profile setup was not saved.",
        label: "Profile setup",
        onSuccess: () => undefined,
        savedMessage: "Saved.",
        scope: jobFinderPendingActions.profileSetup(),
        surface: "profile",
      });

      const statusWrites = collectStatusWrites(setActionState);
      expect(statusWrites.at(-1)).toMatchObject({
        message: "Saved.",
        ownerPath: "/job-finder/profile",
      });
    });
  });
});
