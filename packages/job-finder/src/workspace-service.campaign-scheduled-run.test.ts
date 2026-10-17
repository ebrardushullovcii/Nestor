import { describe, expect, test, vi } from "vitest";

import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import {
  CampaignNotificationSchema,
  type CampaignPauseWindow,
  type CampaignRunFacts,
  type JobSearchCampaign,
  type JobSearchCampaignSchedule,
  type JobSearchPreferences,
  type SaveJobSearchCampaignInput,
} from "@nestor/contracts";
import { JobSearchCampaignScheduleSchema } from "@nestor/contracts";

import { createWorkspaceServiceHarness } from "./workspace-service.test-harness";
import {
  createAiClient,
  createBrowserRuntime,
  createDocumentManager,
} from "./workspace-service.test-runtimes";
import { createJobFinderWorkspaceService } from "./index";

function createSchedule(
  overrides: Partial<JobSearchCampaignSchedule> = {},
): JobSearchCampaignSchedule {
  return JobSearchCampaignScheduleSchema.parse({
    mode: "manual",
    enabled: false,
    daysOfWeek: [],
    localStartTime: null,
    timeZone: null,
    pauseWindows: [],
    runFacts: {},
    ...overrides,
  });
}

function createRunFacts(
  overrides: Partial<CampaignRunFacts> = {},
): CampaignRunFacts {
  return {
    nextRunAt: null,
    lastRunAt: null,
    lastRunOutcome: null,
    lastRunSummary: null,
    consecutiveFailures: 0,
    ...overrides,
  };
}

function createPauseWindow(
  id: string,
  startsAt: string,
  endsAt: string,
): CampaignPauseWindow {
  return { id, startsAt, endsAt, reason: null, enabled: true };
}

function toCampaignInput(
  campaign: JobSearchCampaign,
  overrides: Partial<SaveJobSearchCampaignInput> = {},
): SaveJobSearchCampaignInput {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    mode: campaign.mode,
    status: campaign.status,
    searchPreferences: campaign.searchPreferences,
    sourceTargetIds: campaign.sourceTargetIds,
    minimumFitScore: campaign.minimumFitScore,
    limits: campaign.limits,
    stopRules: campaign.stopRules,
    applicationPolicy: campaign.applicationPolicy,
    rules: campaign.rules,
    schedule: campaign.schedule,
    latestDigest: campaign.latestDigest,
    ...overrides,
  };
}

async function getActiveCampaign(
  harness: ReturnType<typeof createWorkspaceServiceHarness>,
): Promise<JobSearchCampaign> {
  const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
  const active = snapshot.campaigns.find(
    (campaign) => campaign.id === snapshot.activeCampaignId,
  );
  if (!active) throw new Error("Expected an active campaign fixture.");
  return active;
}

/** Preferences that only match the `linkedin_pause_case` catalog posting. */
function narrowPreferencesToPauseCase(
  source: JobSearchPreferences,
): JobSearchPreferences {
  const preferences = structuredClone(source);
  preferences.targetRoles = ["Principal UX Engineer"];
  preferences.locations = ["Remote"];
  return preferences;
}

/** Preferences that match no catalog posting (deterministic run failure). */
function preferencesMatchingNothing(
  source: JobSearchPreferences,
): JobSearchPreferences {
  const preferences = structuredClone(source);
  preferences.targetRoles = ["No Such Role Anywhere"];
  preferences.locations = ["Atlantis"];
  return preferences;
}

describe("workspace campaign scheduled runs", () => {
  test("a duplicate-only second plan retains shared jobs without calling them new to you", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const firstPlan = await getActiveCampaign(harness);

    await workspaceService.runCampaignNow({ campaignId: firstPlan.id });
    const afterFirstRun = await repository.getCampaignState();
    const retainedByFirst = afterFirstRun?.campaigns.find(
      (campaign) => campaign.id === firstPlan.id,
    )?.jobIds;
    expect(retainedByFirst?.length).toBeGreaterThan(0);

    const created = await workspaceService.saveCampaign(
      toCampaignInput(firstPlan, {
        id: null,
        name: "Overlapping plan",
        searchPreferences: firstPlan.searchPreferences,
        schedule: createSchedule(),
      }),
    );
    const secondPlan = created.campaigns.find(
      (campaign) => campaign.name === "Overlapping plan",
    );
    if (!secondPlan) throw new Error("Expected the overlapping plan.");

    await workspaceService.runCampaignNow({ campaignId: secondPlan.id });

    const finalState = await repository.getCampaignState();
    const retainedBySecond = finalState?.campaigns.find(
      (campaign) => campaign.id === secondPlan.id,
    );
    expect(retainedBySecond?.jobIds.length).toBeGreaterThan(0);
    expect(retainedBySecond?.latestDigest?.report?.new).toBe(0);
    expect(retainedBySecond?.latestDigest?.report?.unique).toBeGreaterThan(0);
    expect(retainedBySecond?.latestDigest?.report?.retained).toBeGreaterThan(0);

    const sharedJob = (await repository.listSavedJobs()).find((job) =>
      retainedBySecond?.jobIds.includes(job.id),
    );
    expect(sharedJob?.campaignIds).toEqual(
      expect.arrayContaining([firstPlan.id, secondPlan.id]),
    );
  });

  test("runCampaignNow uses the supplied campaign preferences without changing the active campaign or global preferences", async () => {
    const captured: JobSearchPreferences[] = [];
    const base = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runAgentDiscovery: async (source, options) => {
        captured.push(
          structuredClone({
            targetRoles: options.searchPreferences.targetRoles,
            locations: options.searchPreferences.locations,
          }) as JobSearchPreferences,
        );
        return base.runAgentDiscovery!(source, options);
      },
    };
    const harness = createWorkspaceServiceHarness({ browserRuntime });
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    const bPreferences = narrowPreferencesToPauseCase(active.searchPreferences);
    const created = await workspaceService.saveCampaign(
      toCampaignInput(active, {
        id: null,
        name: "Campaign B",
        searchPreferences: bPreferences,
        schedule: createSchedule(),
      }),
    );
    const campaignB = created.campaigns.find(
      (campaign) => campaign.name === "Campaign B",
    );
    if (!campaignB) throw new Error("Expected campaign B.");
    // saveCampaign activates new campaigns; restore the original selection.
    await workspaceService.selectCampaign(active.id);

    const snapshot = await workspaceService.runCampaignNow({
      campaignId: campaignB.id,
    });

    // Selection and global preferences are preserved.
    expect(snapshot.activeCampaignId).toBe(active.id);
    const globalPreferences = await repository.getSearchPreferences();
    expect(globalPreferences.targetRoles).toEqual(
      active.searchPreferences.targetRoles,
    );
    expect(globalPreferences.locations).toContain("London");

    // Discovery ran against campaign B's own preferences.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.locations).toEqual(["Remote"]);
    expect(captured[0]?.targetRoles).toEqual(["Principal UX Engineer"]);
    expect(captured[0]?.locations).not.toContain("London");

    const state = await repository.getCampaignState();
    const ran = state?.campaigns.find(
      (campaign) => campaign.id === campaignB.id,
    );
    expect(ran?.jobIds.length).toBeGreaterThan(0);
    expect(ran?.history[0]?.kind).toBe("discovery_run");
    expect(ran?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(ran?.schedule.runFacts.lastRunAt).not.toBeNull();
    expect(ran?.progress.lastRunAt).not.toBeNull();
  });

  test("runDueScheduledCampaigns skips disabled, manual, and not-yet-due schedules", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const now = new Date().toISOString();
    const overdue = new Date(Date.now() - 60 * 60 * 1_000).toISOString();

    const disabled = createSchedule({
      mode: "daily",
      enabled: false,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts({ nextRunAt: overdue }),
    });
    await workspaceService.saveCampaign(
      toCampaignInput(active, { schedule: disabled }),
    );
    await workspaceService.runDueScheduledCampaigns(now);
    let state = await repository.getCampaignState();
    let current = state?.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    expect(current?.schedule.runFacts.lastRunAt).toBeNull();
    expect(
      current?.history.filter((entry) => entry.kind === "discovery_run"),
    ).toHaveLength(0);

    const manual = createSchedule({
      mode: "manual",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts({ nextRunAt: overdue }),
    });
    await workspaceService.saveCampaign(
      toCampaignInput(active, { schedule: manual }),
    );
    await workspaceService.runDueScheduledCampaigns(now);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.schedule.runFacts.lastRunAt).toBeNull();

    const notDue = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts({ nextRunAt: "2099-01-01T00:00:00.000Z" }),
    });
    await workspaceService.saveCampaign(
      toCampaignInput(active, { schedule: notDue }),
    );
    await workspaceService.runDueScheduledCampaigns(now);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.schedule.runFacts.lastRunAt).toBeNull();
    expect(current?.schedule.runFacts.nextRunAt).toBe(
      "2099-01-01T00:00:00.000Z",
    );
    expect(
      current?.history.filter((entry) => entry.kind === "discovery_run"),
    ).toHaveLength(0);
  });

  test("runDueScheduledCampaigns runs an overdue persisted schedule once and then waits", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const now = new Date().toISOString();
    const overdue = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts({ nextRunAt: overdue }),
    });
    await workspaceService.saveCampaign(toCampaignInput(active, { schedule }));

    await workspaceService.runDueScheduledCampaigns(now);
    let state = await repository.getCampaignState();
    let current = state?.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    expect(current?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(current?.schedule.runFacts.lastRunAt).not.toBeNull();
    const firstRunAt = current?.schedule.runFacts.lastRunAt;
    expect(current?.schedule.runFacts.nextRunAt).not.toBeNull();
    expect(
      current?.history.filter((entry) => entry.kind === "discovery_run"),
    ).toHaveLength(1);

    // The recomputed next run is strictly after the completion, so a second
    // tick at the same instant must not run the campaign again.
    await workspaceService.runDueScheduledCampaigns(now);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.schedule.runFacts.lastRunAt).toBe(firstRunAt);
    expect(
      current?.history.filter((entry) => entry.kind === "discovery_run"),
    ).toHaveLength(1);
  });

  test("initializes a missing nextRunAt without immediate work, then runs when due", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const now = new Date().toISOString();
    const schedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts(),
    });
    await workspaceService.saveCampaign(toCampaignInput(active, { schedule }));

    await workspaceService.runDueScheduledCampaigns(now);
    let state = await repository.getCampaignState();
    let current = state?.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    const initializedNextRunAt = current?.schedule.runFacts.nextRunAt;
    expect(initializedNextRunAt).not.toBeNull();
    expect(Date.parse(initializedNextRunAt!)).toBeGreaterThan(Date.parse(now));
    expect(current?.schedule.runFacts.lastRunAt).toBeNull();
    expect(
      current?.history.filter((entry) => entry.kind === "discovery_run"),
    ).toHaveLength(0);

    // Catching up at the initialized instant runs the campaign exactly once.
    await workspaceService.runDueScheduledCampaigns(initializedNextRunAt!);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(current?.schedule.runFacts.lastRunAt).not.toBeNull();
    expect(
      current?.history.filter((entry) => entry.kind === "discovery_run"),
    ).toHaveLength(1);
  });

  test("runDueScheduledCampaigns respects pause windows and global pause", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const now = new Date().toISOString();
    const overdue = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const windowed = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      pauseWindows: [
        createPauseWindow(
          "pause_noon",
          new Date(Date.now() - 30 * 60 * 1_000).toISOString(),
          new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
        ),
      ],
      runFacts: createRunFacts({ nextRunAt: overdue }),
    });
    await workspaceService.saveCampaign(
      toCampaignInput(active, { schedule: windowed }),
    );

    // Inside the pause window: skipped, still due afterwards.
    await workspaceService.runDueScheduledCampaigns(now);
    let state = await repository.getCampaignState();
    let current = state?.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    expect(current?.schedule.runFacts.lastRunAt).toBeNull();
    expect(current?.schedule.runFacts.nextRunAt).toBe(overdue);

    // After the window ends, the overdue run executes once.
    const afterWindow = new Date(
      Date.now() + 2 * 60 * 60 * 1_000,
    ).toISOString();
    await workspaceService.runDueScheduledCampaigns(afterWindow);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.schedule.runFacts.lastRunOutcome).toBe("success");

    // Global activity pause suppresses scheduled runs entirely.
    const again = new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString();
    const pausedSchedule = createSchedule({
      mode: "daily",
      enabled: true,
      localStartTime: "09:00",
      timeZone: "UTC",
      runFacts: createRunFacts({ nextRunAt: again }),
    });
    await workspaceService.saveCampaign(
      toCampaignInput(active, { schedule: pausedSchedule }),
    );
    await workspaceService.setActivityControl({
      paused: true,
      reason: "Global pause.",
    });
    await workspaceService.runDueScheduledCampaigns(again);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.schedule.runFacts.nextRunAt).toBe(again);
  });

  test("runCampaignNow ignores schedule.enabled and pause windows but obeys campaign and global pause", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    const disabledWithWindow = createSchedule({
      mode: "manual",
      enabled: false,
      pauseWindows: [
        createPauseWindow(
          "pause_now",
          new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
          new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
        ),
      ],
    });
    await workspaceService.saveCampaign(
      toCampaignInput(active, { schedule: disabledWithWindow }),
    );

    // Manual runs are not gated by schedule.enabled or pause windows.
    await workspaceService.runCampaignNow();
    let state = await repository.getCampaignState();
    let current = state?.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    expect(current?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(current?.schedule.runFacts.lastRunAt).not.toBeNull();

    // A paused campaign rejects manual runs.
    await workspaceService.saveCampaign(
      toCampaignInput(active, { status: "paused" }),
    );
    await expect(workspaceService.runCampaignNow()).rejects.toThrow(
      "Set it to active",
    );

    // A globally paused workspace no longer rejects a manual run: Run now
    // is an explicit click, so it resumes background work first. The paused
    // plan itself still refuses.
    await workspaceService.setActivityControl({
      paused: true,
      reason: "Global pause.",
    });
    await expect(workspaceService.runCampaignNow()).rejects.toThrow(
      "Set it to active",
    );
    expect(
      (await workspaceService.getWorkspaceSnapshot()).activityControl.paused,
    ).toBe(false);
    state = await repository.getCampaignState();
    current = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(current?.status).toBe("paused");
  });

  test("commits run facts, digest, and notifications atomically after a run", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    const bPreferences = narrowPreferencesToPauseCase(active.searchPreferences);
    const created = await workspaceService.saveCampaign(
      toCampaignInput(active, {
        id: null,
        name: "Campaign B",
        searchPreferences: bPreferences,
        schedule: createSchedule({
          mode: "daily",
          enabled: true,
          localStartTime: "09:00",
          timeZone: "UTC",
          runFacts: createRunFacts(),
        }),
      }),
    );
    const campaignB = created.campaigns.find(
      (campaign) => campaign.name === "Campaign B",
    );
    if (!campaignB) throw new Error("Expected campaign B.");
    await workspaceService.selectCampaign(active.id);

    await workspaceService.runCampaignNow({ campaignId: campaignB.id });

    const jobs = await repository.listSavedJobs();
    const pauseCase = jobs.find(
      (job) => job.sourceJobId === "linkedin_pause_case",
    );
    if (!pauseCase) throw new Error("Expected the pause-case posting.");

    const state = await repository.getCampaignState();
    const ran = state?.campaigns.find(
      (campaign) => campaign.id === campaignB.id,
    );
    expect(ran?.jobIds).toContain(pauseCase.id);

    // Run facts are recorded truthfully and advance the schedule.
    expect(ran?.schedule.runFacts.lastRunOutcome).toBe("success");
    expect(ran?.schedule.runFacts.lastRunAt).not.toBeNull();
    expect(ran?.schedule.runFacts.nextRunAt).not.toBeNull();
    expect(ran?.schedule.runFacts.consecutiveFailures).toBe(0);

    // Digest counts and job ids come straight from the finished run.
    expect(ran?.latestDigest?.campaignId).toBe(campaignB.id);
    expect(ran?.latestDigest?.counts.new).toBe(1);
    expect(ran?.latestDigest?.jobIds).toEqual(
      expect.arrayContaining([pauseCase.id]),
    );
    expect(ran?.progress.lastRunAt).not.toBeNull();

    // Strong-match notifications are emitted only when the computed score
    // clears the strong-match bar (the pure helper owns the threshold).
    const strongForPauseCase = state?.notifications.some(
      (notification) =>
        notification.kind === "strong_match" &&
        notification.jobId === pauseCase.id,
    );
    expect(strongForPauseCase).toBe(pauseCase.matchAssessment.score >= 86);
  });

  test("retention refresh keeps in-flight jobs beyond the target and views stay coherent after reopen", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    // Shrink retention so ranked selection alone could keep only one job.
    await workspaceService.saveCampaign(
      toCampaignInput(active, {
        limits: { ...active.limits, retainedJobTarget: 1 },
      }),
    );

    await workspaceService.runCampaignNow();

    // Both seeded jobs carry in-flight work (ready_for_review with a ready
    // asset; drafting with a generating asset), so both survive the
    // target-1 refresh even if a fresh arrival outranks them.
    const state = await repository.getCampaignState();
    const ran = state?.campaigns.find((campaign) => campaign.id === active.id);
    expect(ran?.jobIds).toContain("job_ready");
    expect(ran?.jobIds).toContain("job_generating");

    // Reopening the workspace over the same persisted state (service
    // restart) keeps the campaign-scoped views coherent: the review queue
    // still exposes both in-flight jobs.
    const reopenedService = createJobFinderWorkspaceService({
      repository,
      browserRuntime: createBrowserRuntime(),
      aiClient: createAiClient(),
      documentManager: createDocumentManager(),
    });
    const reopenedSnapshot = await reopenedService.getWorkspaceSnapshot();
    expect(
      reopenedSnapshot.reviewQueue.some((item) => item.jobId === "job_ready"),
    ).toBe(true);
    expect(
      reopenedSnapshot.reviewQueue.some(
        (item) => item.jobId === "job_generating",
      ),
    ).toBe(true);
    const reopenedCampaign = reopenedSnapshot.campaigns.find(
      (campaign) => campaign.id === active.id,
    );
    expect(reopenedCampaign?.jobIds).toContain("job_ready");
    expect(reopenedCampaign?.jobIds).toContain("job_generating");
  });

  test("records a failed run in run facts and emits a blocked notification", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);

    const failingPreferences = preferencesMatchingNothing(
      active.searchPreferences,
    );
    const created = await workspaceService.saveCampaign(
      toCampaignInput(active, {
        id: null,
        name: "Campaign C",
        searchPreferences: failingPreferences,
        schedule: createSchedule(),
      }),
    );
    const campaignC = created.campaigns.find(
      (campaign) => campaign.name === "Campaign C",
    );
    if (!campaignC) throw new Error("Expected campaign C.");
    await workspaceService.selectCampaign(active.id);

    await expect(
      workspaceService.runCampaignNow({ campaignId: campaignC.id }),
    ).rejects.toThrow("No catalog jobs matched");

    const state = await repository.getCampaignState();
    const ran = state?.campaigns.find(
      (campaign) => campaign.id === campaignC.id,
    );
    expect(ran?.schedule.runFacts.lastRunOutcome).toBe("failed");
    expect(ran?.schedule.runFacts.consecutiveFailures).toBe(1);
    expect(ran?.schedule.runFacts.lastRunSummary).not.toBeNull();
    expect(
      state?.notifications.some(
        (notification) =>
          notification.kind === "blocked_work" &&
          notification.title === "Failed: search plan run",
      ),
    ).toBe(true);
  });

  test("enforces a single active discovery across concurrent manual runs", async () => {
    const base = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...base,
      runDiscovery: async (source, searchPreferences) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 40));
        return base.runDiscovery(source, searchPreferences);
      },
    };
    const harness = createWorkspaceServiceHarness({ browserRuntime });
    const { workspaceService } = harness;
    await getActiveCampaign(harness);

    const results = await Promise.allSettled([
      workspaceService.runCampaignNow(),
      workspaceService.runCampaignNow(),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected.some(
        (result) =>
          result.status === "rejected" &&
          String(result.reason).includes(
            "A search is already running for this plan.",
          ),
      ),
    ).toBe(true);
  });

  test("markCampaignNotificationRead flips one notification and ignores unknown ids", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const state = await repository.getCampaignState();
    if (!state) throw new Error("Expected campaign state.");
    const seededNotification = CampaignNotificationSchema.parse({
      id: "notification-read-test",
      campaignId: active.id,
      kind: "digest_ready",
      title: "A campaign digest is ready",
      body: null,
      createdAt: "2026-08-15T10:00:00.000Z",
      readAt: null,
      unread: true,
      jobId: null,
      sourceTargetId: null,
    });
    await repository.saveCampaignState({
      ...state,
      notifications: [...state.notifications, seededNotification],
    });
    const seededState = await repository.getCampaignState();
    const unread = seededState?.notifications.find(
      (notification) => notification.unread,
    );
    if (!unread) throw new Error("Expected an unread notification.");
    const unreadCountBefore = seededState?.notifications.filter(
      (notification) => notification.unread,
    ).length;

    const readAt = new Date().toISOString();
    const snapshot = await workspaceService.markCampaignNotificationRead({
      notificationId: unread.id,
      readAt,
    });
    const marked = snapshot.campaignNotifications.find(
      (notification) => notification.id === unread.id,
    );
    expect(marked?.unread).toBe(false);
    expect(marked?.readAt).toBe(readAt);
    expect(
      snapshot.campaignNotifications.filter(
        (notification) => notification.unread,
      ),
    ).toHaveLength((unreadCountBefore ?? 0) - 1);

    // The flip is persisted through the campaign collection, not just the
    // snapshot.
    const persistedState = await repository.getCampaignState();
    const persisted = persistedState?.notifications.find(
      (notification) => notification.id === unread.id,
    );
    expect(persisted?.unread).toBe(false);
    expect(persisted?.readAt).toBe(readAt);

    // Unknown ids are a no-op: nothing changes and nothing is thrown.
    const unchanged = await workspaceService.markCampaignNotificationRead({
      notificationId: "notification_does_not_exist",
      readAt: new Date().toISOString(),
    });
    expect(unchanged.campaignNotifications).toEqual(
      snapshot.campaignNotifications,
    );
  });

  test("markAllCampaignNotificationsRead flips every unread notification and keeps read timestamps", async () => {
    const harness = createWorkspaceServiceHarness();
    const { repository, workspaceService } = harness;
    const active = await getActiveCampaign(harness);
    const state = await repository.getCampaignState();
    if (!state) throw new Error("Expected campaign state.");
    const alreadyRead = CampaignNotificationSchema.parse({
      id: "notification-already-read",
      campaignId: active.id,
      kind: "strong_match",
      title: "Already read",
      body: null,
      createdAt: "2026-08-14T10:00:00.000Z",
      readAt: "2026-08-14T12:00:00.000Z",
      unread: false,
      jobId: null,
      sourceTargetId: null,
    });
    const firstUnread = CampaignNotificationSchema.parse({
      id: "notification-first",
      campaignId: active.id,
      kind: "digest_ready",
      title: "First digest",
      body: null,
      createdAt: "2026-08-15T10:00:00.000Z",
      readAt: null,
      unread: true,
      jobId: null,
      sourceTargetId: null,
    });
    const secondUnread = CampaignNotificationSchema.parse({
      id: "notification-second",
      campaignId: active.id,
      kind: "blocked_work",
      title: "Blocked work",
      body: "A run was blocked.",
      createdAt: "2026-08-15T11:00:00.000Z",
      readAt: null,
      unread: true,
      jobId: null,
      sourceTargetId: null,
    });
    await repository.saveCampaignState({
      ...state,
      notifications: [alreadyRead, firstUnread, secondUnread],
    });

    const readAt = new Date().toISOString();
    const snapshot = await workspaceService.markAllCampaignNotificationsRead({
      readAt,
    });
    const byId = new Map(
      snapshot.campaignNotifications.map((notification) => [
        notification.id,
        notification,
      ]),
    );
    expect(byId.get("notification-first")).toMatchObject({
      unread: false,
      readAt,
    });
    expect(byId.get("notification-second")).toMatchObject({
      unread: false,
      readAt,
    });
    // Already-read notifications keep their original timestamp.
    expect(byId.get("notification-already-read")).toMatchObject({
      unread: false,
      readAt: "2026-08-14T12:00:00.000Z",
    });
    expect(
      snapshot.campaignNotifications.filter(
        (notification) => notification.unread,
      ),
    ).toHaveLength(0);

    const persistedState = await repository.getCampaignState();
    expect(
      persistedState?.notifications.filter(
        (notification) => notification.unread,
      ),
    ).toHaveLength(0);
  });
});

test("selecting a manual or future plan does not search or resume paused work", async () => {
  const base = createBrowserRuntime();
  const runAgentDiscovery = vi.spyOn(base, "runAgentDiscovery");
  const harness = createWorkspaceServiceHarness({
    browserRuntime: { ...base, runAgentDiscovery },
  });
  const { workspaceService } = harness;
  const active = await getActiveCampaign(harness);
  const saved = await workspaceService.saveCampaign(
    toCampaignInput(active, {
      id: null,
      name: "Other plan",
      schedule: createSchedule(),
    }),
  );
  const other = saved.campaigns.find((entry) => entry.name === "Other plan")!;
  await workspaceService.setActivityControl({ paused: true });
  await workspaceService.selectCampaign(active.id);
  const selected = await workspaceService.selectCampaign(other.id);
  expect(selected.activeCampaignId).toBe(other.id);
  expect(selected.activityControl.paused).toBe(true);
  expect(runAgentDiscovery).not.toHaveBeenCalled();
});

test("a pause after a scheduled tick starts prevents slot claiming and searching", async () => {
  const base = createBrowserRuntime();
  const runAgentDiscovery = vi.spyOn(base, "runAgentDiscovery");
  const harness = createWorkspaceServiceHarness({
    browserRuntime: { ...base, runAgentDiscovery },
  });
  const active = await getActiveCampaign(harness);
  const due = "2026-08-15T08:00:00.000Z";
  await harness.workspaceService.saveCampaign(
    toCampaignInput(active, {
      schedule: createSchedule({
        mode: "daily",
        enabled: true,
        localStartTime: "08:00",
        timeZone: "UTC",
        runFacts: createRunFacts({ nextRunAt: due }),
      }),
    }),
  );
  const control = await harness.repository.getActivityControl();
  const readControl = vi
    .spyOn(harness.repository, "getActivityControl")
    .mockResolvedValue({ ...control, paused: true })
    .mockResolvedValueOnce({ ...control, paused: false });
  try {
    await harness.workspaceService.runDueScheduledCampaigns(
      "2026-08-15T09:00:00.000Z",
    );
    expect(runAgentDiscovery).not.toHaveBeenCalled();
    expect(
      (await harness.repository.getCampaignState())?.campaigns.find(
        (entry) => entry.id === active.id,
      )?.schedule.runFacts.nextRunAt,
    ).toBe(due);
  } finally {
    readControl.mockRestore();
  }
});
