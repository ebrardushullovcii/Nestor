import type {
  AgentDiscoveryOptions,
  BrowserSessionRuntime,
} from "@nestor/browser-runtime";
import {
  DiscoveryRunRecordSchema,
  DiscoveryRunResultSchema,
  DiscoveryTargetExecutionSchema,
  SourceDebugRunRecordSchema,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  persistDiscoveryLoginUserAction,
  persistDiscoveryRunBlockerUserAction,
  resolveSourceAccessRequestsAfterCompletedRun,
} from "./internal/workspace-source-user-action";
import { createBrowserRuntime } from "./workspace-service.test-runtimes";
import {
  createSeed,
  createWorkspaceServiceHarness,
} from "./workspace-service.test-support";

function createPausedRun(summary: string) {
  return SourceDebugRunRecordSchema.parse({
    id: "source_debug_run_login_required",
    targetId: "target_linkedin_default",
    state: "paused_manual",
    startedAt: "2026-07-30T08:00:00.000Z",
    updatedAt: "2026-07-30T08:01:00.000Z",
    completedAt: "2026-07-30T08:01:00.000Z",
    activePhase: "access_auth_probe",
    phases: [
      "access_auth_probe",
      "site_structure_mapping",
      "search_filter_probe",
      "job_detail_validation",
      "apply_path_validation",
      "replay_verification",
    ],
    targetLabel: "LinkedIn",
    targetUrl: "https://www.linkedin.com/jobs/search/",
    targetHostname: "www.linkedin.com",
    manualPrerequisiteSummary: summary,
    finalSummary: summary,
    attemptIds: [],
    phaseSummaries: [],
    instructionArtifactId: null,
    timing: null,
  });
}

describe("discovery source login UserActionRequest adoption", () => {
  test("a later source opens a new page without reusing or closing a parked page", async () => {
    const seed = createSeed();
    seed.settings.keepSessionAlive = false;
    const firstTarget = seed.searchPreferences.discovery.targets[0];
    if (!firstTarget) throw new Error("Expected a saved source.");
    const secondTarget = {
      ...firstTarget,
      id: "target_second_source",
      label: "Second source",
      startingUrl: "https://second.example.com/jobs",
    };
    seed.searchPreferences.discovery.targets = [firstTarget, secondTarget];
    const pages = new Set<string>();
    const protectedInputs: Array<
      NonNullable<AgentDiscoveryOptions["protectedPages"]>
    > = [];
    const baseRuntime = createBrowserRuntime();
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery: (source, options) => {
        protectedInputs.push([...(options.protectedPages ?? [])]);
        const targetUrl = options.startingUrls[0];
        if (!targetUrl) throw new Error("Expected a target URL.");
        if (pages.size === 0) {
          pages.add(targetUrl);
          return Promise.resolve(
            DiscoveryRunResultSchema.parse({
              source,
              startedAt: "2026-09-12T10:00:00.000Z",
              completedAt: "2026-09-12T10:00:01.000Z",
              querySummary: firstTarget.label,
              warning: "The source stopped at a sign-in page.",
              inventoryCompleteness: "partial",
              jobs: [],
              agentMetadata: {
                accessBlockerReason: "auth_required",
                parkedTab: { tabId: "tab_parked", url: targetUrl, title: null },
              },
            }),
          );
        }

        // A run in its own tab (the way sources search side by side now)
        // never closes another tab; only a shared-tab run closes the
        // unprotected ones, and a parked tab is always protected.
        if (!options.dedicatedPage) {
          for (const existingPage of [...pages]) {
            if (
              !options.protectedPages?.some(
                (protectedPage) => protectedPage.url === existingPage,
              )
            ) {
              pages.delete(existingPage);
            }
          }
        }
        pages.add(targetUrl);
        return Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source,
            startedAt: "2026-09-12T10:00:02.000Z",
            completedAt: "2026-09-12T10:00:03.000Z",
            querySummary: secondTarget.label,
            warning: null,
            inventoryCompleteness: "complete",
            jobs: [],
          }),
        );
      },
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });

    await harness.workspaceService.runAgentDiscovery();

    // Sources start side by side, so the second run may begin before the
    // first parks its tab; what must hold is that the parked tab survives.
    expect(protectedInputs).toHaveLength(2);
    expect(pages).toEqual(
      new Set([firstTarget.startingUrl, secondTarget.startingUrl]),
    );
  });

  test("a later run does not close an unresolved handoff from an earlier run", async () => {
    const seed = createSeed();
    seed.settings.keepSessionAlive = false;
    const firstTarget = seed.searchPreferences.discovery.targets[0];
    if (!firstTarget) throw new Error("Expected a saved source.");
    const secondTarget = {
      ...firstTarget,
      id: "target_later_run",
      label: "Later source",
      startingUrl: "https://later.example.com/jobs",
    };
    seed.searchPreferences.discovery.targets = [firstTarget, secondTarget];
    const pages = new Set<string>();
    const baseRuntime = createBrowserRuntime();
    const closeSession = vi.fn<BrowserSessionRuntime["closeSession"]>(
      async (source) => {
        pages.clear();
        return baseRuntime.closeSession(source);
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      closeSession,
      runAgentDiscovery: (source, options) => {
        const targetUrl = options.startingUrls[0];
        if (!targetUrl) throw new Error("Expected a target URL.");
        pages.add(targetUrl);
        return Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source,
            startedAt: "2026-09-12T10:00:00.000Z",
            completedAt: "2026-09-12T10:00:01.000Z",
            querySummary: options.siteLabel,
            warning:
              targetUrl === firstTarget.startingUrl
                ? "The source stopped at a sign-in page."
                : null,
            inventoryCompleteness:
              targetUrl === firstTarget.startingUrl ? "partial" : "complete",
            jobs: [],
            ...(targetUrl === firstTarget.startingUrl
              ? {
                  agentMetadata: {
                    accessBlockerReason: "auth_required",
                    parkedTab: {
                      tabId: "tab_earlier_handoff",
                      url: targetUrl,
                      title: firstTarget.label,
                    },
                  },
                }
              : {}),
          }),
        );
      },
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });

    await expect(
      harness.workspaceService.runAgentDiscovery(
        undefined,
        undefined,
        firstTarget.id,
      ),
    ).rejects.toThrow("sign-in page");
    await harness.workspaceService.runAgentDiscovery(
      undefined,
      undefined,
      secondTarget.id,
    );

    expect(closeSession).not.toHaveBeenCalled();
    expect(pages.has(firstTarget.startingUrl)).toBe(true);
    expect(
      (await harness.repository.listUserActionRequests()).some(
        (request) =>
          request.scope.type === "discovery_source" &&
          request.scope.parkedTab?.tabId === "tab_earlier_handoff" &&
          request.state === "pending",
      ),
    ).toBe(true);
  });

  test("a second wall on the same source replaces the first card and closes its tab", async () => {
    const seed = createSeed();
    seed.settings.keepSessionAlive = false;
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    let run = 0;
    const baseRuntime = createBrowserRuntime();
    const closeParkedTab = vi.fn(() => Promise.resolve());
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      closeParkedTab,
      runAgentDiscovery: (source) => {
        run += 1;
        return Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source,
            startedAt: `2026-09-12T10:0${run}:00.000Z`,
            completedAt: `2026-09-12T10:0${run}:01.000Z`,
            querySummary: target.label,
            warning: "The source stopped at a sign-in page.",
            inventoryCompleteness: "partial",
            jobs: [],
            agentMetadata: {
              accessBlockerReason: "auth_required",
              parkedTab: {
                tabId: `tab_wall_${run}`,
                url: target.startingUrl,
                title: target.label,
              },
            },
          }),
        );
      },
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        harness.workspaceService.runAgentDiscovery(
          undefined,
          undefined,
          target.id,
        ),
      ).rejects.toThrow("sign-in page");
    }

    const open = (await harness.repository.listUserActionRequests()).filter(
      (request) =>
        request.scope.type === "discovery_source" &&
        !["resolved", "cancelled", "superseded", "skipped", "expired"].includes(
          request.state,
        ),
    );
    expect(open).toHaveLength(1);
    expect(open[0]?.scope).toMatchObject({
      parkedTab: { tabId: "tab_wall_2" },
    });
    expect(closeParkedTab).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tabId: "tab_wall_1" }),
    );
    expect(closeParkedTab).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tabId: "tab_wall_2" }),
    );
  });

  test("keeps a wall tab open until its Needs you item is dismissed", async () => {
    const seed = createSeed();
    seed.settings.keepSessionAlive = false;
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const baseRuntime = createBrowserRuntime();
    const closeSession = vi.fn<BrowserSessionRuntime["closeSession"]>(
      (source) => baseRuntime.closeSession(source),
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      closeSession,
      runAgentDiscovery: (source) =>
        Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source,
            startedAt: "2026-09-12T10:00:00.000Z",
            completedAt: "2026-09-12T10:00:01.000Z",
            querySummary: target.label,
            warning: "The source stopped at a human-verification page.",
            inventoryCompleteness: "partial",
            jobs: [],
            agentMetadata: {
              accessBlockerReason: "site_protection",
              parkedTab: {
                tabId: "tab_parked",
                url: target.startingUrl,
                title: target.label,
              },
            },
          }),
        ),
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });

    await expect(
      harness.workspaceService.runAgentDiscovery(
        undefined,
        undefined,
        target.id,
      ),
    ).rejects.toThrow("human-verification page");
    const stopped = await harness.workspaceService.getWorkspaceSnapshot();
    const request = stopped.userActionRequests[0];
    if (!request) throw new Error("Expected a parked-tab action.");
    expect(request.scope).toMatchObject({
      type: "discovery_source",
      parkedTab: { tabId: "tab_parked" },
    });
    expect(closeSession).not.toHaveBeenCalled();
    expect(stopped.recentDiscoveryRuns[0]?.summary.browserCloseout?.mode).toBe(
      "kept_alive",
    );

    await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: request.id,
      commandId: "dismiss_live_parked_discovery_tab",
      expectedRevision: request.revision,
      reason: "User dismissed the item.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledWith("target_site");
  });

  test("closes only the dismissed handoff tab until the final handoff is gone", async () => {
    const seed = createSeed();
    const firstTarget = seed.searchPreferences.discovery.targets[0];
    if (!firstTarget) throw new Error("Expected a saved source.");
    const secondTarget = {
      ...firstTarget,
      id: "target_second_pending_handoff",
      label: "Second pending handoff",
      startingUrl: "https://second.example.com/jobs",
    };
    seed.searchPreferences.discovery.targets = [firstTarget, secondTarget];

    const openTabs = new Set(["tab_first_handoff", "tab_second_handoff"]);
    const baseRuntime = createBrowserRuntime();
    const closeParkedTab = vi.fn<
      NonNullable<BrowserSessionRuntime["closeParkedTab"]>
    >((_source, tab) => {
      if (tab.tabId) openTabs.delete(tab.tabId);
      return Promise.resolve();
    });
    const closeSession = vi.fn<BrowserSessionRuntime["closeSession"]>(
      (source) => baseRuntime.closeSession(source),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: { ...baseRuntime, closeParkedTab, closeSession },
    });

    for (const [runId, target, tabId] of [
      ["run_first_handoff", firstTarget, "tab_first_handoff"],
      ["run_second_handoff", secondTarget, "tab_second_handoff"],
    ] as const) {
      await persistDiscoveryRunBlockerUserAction({
        repository: harness.repository,
        runId,
        target,
        execution: DiscoveryTargetExecutionSchema.parse({
          targetId: target.id,
          adapterKind: target.adapterKind,
          state: "failed",
          accessBlockerReason: "site_protection",
          parkedTab: { tabId, url: target.startingUrl, title: target.label },
        }),
        occurredAt: "2026-09-12T10:01:00.000Z",
      });
    }

    const requests = await harness.repository.listUserActionRequests();
    const firstRequest = requests.find(
      (request) =>
        request.scope.type === "discovery_source" &&
        request.scope.targetId === firstTarget.id,
    );
    const secondRequest = requests.find(
      (request) =>
        request.scope.type === "discovery_source" &&
        request.scope.targetId === secondTarget.id,
    );
    if (!firstRequest || !secondRequest) {
      throw new Error("Expected two pending handoffs.");
    }

    await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: firstRequest.id,
      commandId: "dismiss_first_pending_handoff",
      expectedRevision: firstRequest.revision,
      reason: "Dismiss the first handoff.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(openTabs).toEqual(new Set(["tab_second_handoff"]));
    expect(closeSession).not.toHaveBeenCalled();

    await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: secondRequest.id,
      commandId: "dismiss_second_pending_handoff",
      expectedRevision: secondRequest.revision,
      reason: "Dismiss the second handoff.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(openTabs).toEqual(new Set());
    expect(closeParkedTab).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledOnce();
  });

  test("opening a parked sign-in asks the host for that tab, or to open it again as that tab", async () => {
    const seed = createSeed();
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const harness = createWorkspaceServiceHarness({ seed });
    const openSession = vi.spyOn(harness.browserRuntime, "openSession");
    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_sign_in",
      target,
      execution: DiscoveryTargetExecutionSchema.parse({
        targetId: target.id,
        adapterKind: target.adapterKind,
        state: "failed",
        accessBlockerReason: "auth_required",
        parkedTab: {
          tabId: "tab_before_restart",
          url: target.startingUrl,
          title: target.label,
        },
      }),
      occurredAt: "2026-07-30T08:01:00.000Z",
    });
    const [request] = await harness.repository.listUserActionRequests();
    if (!request) throw new Error("Expected a sign-in action.");

    await harness.workspaceService.performUserAction({
      action: "open_page",
      requestId: request.id,
      commandId: "open_parked_sign_in",
      expectedRevision: request.revision,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(openSession).toHaveBeenCalledWith(
      "target_site",
      expect.objectContaining({
        targetUrl: target.startingUrl,
        tabId: "tab_before_restart",
        parkedFor: "sign_in",
      }),
    );
  });

  test("a later search that reads the source closes its open sign-in card and returns the parked tab", async () => {
    const seed = createSeed();
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const harness = createWorkspaceServiceHarness({ seed });
    const parkedTab = {
      tabId: "tab_sign_in",
      url: target.startingUrl,
      title: target.label,
    };
    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_wall",
      target,
      execution: DiscoveryTargetExecutionSchema.parse({
        targetId: target.id,
        adapterKind: target.adapterKind,
        state: "failed",
        accessBlockerReason: "auth_required",
        parkedTab,
      }),
      occurredAt: "2026-07-30T08:01:00.000Z",
    });

    // A run that met the wall again, or read nothing, leaves the card alone.
    await expect(
      resolveSourceAccessRequestsAfterCompletedRun({
        repository: harness.repository,
        runId: "discovery_run_empty",
        target,
        execution: DiscoveryTargetExecutionSchema.parse({
          targetId: target.id,
          adapterKind: target.adapterKind,
          state: "completed",
        }),
        occurredAt: "2026-07-30T08:02:00.000Z",
      }),
    ).resolves.toEqual([]);

    const closed = await resolveSourceAccessRequestsAfterCompletedRun({
      repository: harness.repository,
      runId: "discovery_run_signed_in",
      target,
      execution: DiscoveryTargetExecutionSchema.parse({
        targetId: target.id,
        adapterKind: target.adapterKind,
        state: "completed",
        // Every listing was already saved: read, but nothing new.
        jobsSkippedByLedger: 10,
      }),
      occurredAt: "2026-07-30T08:05:00.000Z",
    });

    expect(closed).toEqual([parkedTab]);
    const [request] = await harness.repository.listUserActionRequests();
    expect(request?.state).toBe("superseded");
  });

  test("creates one run-scoped item for a source that stopped at a parked verification tab", async () => {
    const seed = createSeed();
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const harness = createWorkspaceServiceHarness({ seed });
    const closeSession = vi.spyOn(harness.browserRuntime, "closeSession");
    const execution = DiscoveryTargetExecutionSchema.parse({
      targetId: target.id,
      adapterKind: target.adapterKind,
      state: "failed",
      accessBlockerReason: "site_protection",
      parkedTab: {
        tabId: "tab_parked",
        url: target.startingUrl,
        title: target.label,
      },
    });

    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_1",
      target,
      execution,
      occurredAt: "2026-07-30T08:01:00.000Z",
    });
    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_1",
      target,
      execution,
      occurredAt: "2026-07-30T08:01:00.000Z",
    });

    const requests = await harness.repository.listUserActionRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      kind: "captcha",
      title: `Finish the check on ${target.label}`,
      scope: {
        type: "discovery_source",
        discoveryRunId: "discovery_run_1",
        parkedTab: { tabId: "tab_parked", url: target.startingUrl },
      },
    });

    const request = requests[0];
    if (!request) throw new Error("Expected a parked-tab action.");
    await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: request.id,
      commandId: "dismiss_parked_discovery_tab",
      expectedRevision: request.revision,
      reason: "User dismissed the item.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledWith("target_site");
  });

  test("persists one strict browser-owned request for a login-required source prompt", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const run = createPausedRun("Please sign in first.");

    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });
    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });

    const snapshot = await harness.workspaceService.getWorkspaceSnapshot();
    expect(snapshot.userActionRequests).toHaveLength(1);
    expect(snapshot.userActionRequests[0]).toMatchObject({
      kind: "login",
      state: "pending",
      requirement: "required",
      actionUrl: "https://www.linkedin.com/jobs/search/",
      displayOrigin: "https://www.linkedin.com/",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
      scope: {
        type: "discovery_source",
        targetId: "target_linkedin_default",
        source: "target_site",
        sourceDebugRunId: run.id,
      },
      verification: {
        type: "source_access",
        targetId: "target_linkedin_default",
        expectedOrigin: "https://www.linkedin.com/",
      },
    });
  });

  test("does not turn an unrelated manual prerequisite into a login request", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });

    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run: createPausedRun("Choose a search category manually."),
    });

    expect(await harness.repository.listUserActionRequests()).toEqual([]);
  });

  test("never reopens or clears a terminal request when the same blocker is persisted again", async () => {
    const harness = createWorkspaceServiceHarness({ seed: createSeed() });
    const run = createPausedRun("Please sign in first.");
    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });
    const request = (await harness.repository.listUserActionRequests())[0];
    if (!request) throw new Error("Expected a persisted login request.");

    await harness.workspaceService.performUserAction({
      action: "cancel",
      requestId: request.id,
      commandId: "cancel_login_request",
      expectedRevision: request.revision,
      reason: "User chose not to sign in.",
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });
    await persistDiscoveryLoginUserAction({
      repository: harness.repository,
      run,
    });

    const requests = await harness.repository.listUserActionRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.state).toBe("cancelled");
  });
});

describe("continuing a search after the person clears a wall", () => {
  test("reads the source again once its Needs you item is resolved", async () => {
    const seed = createSeed();
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const baseRuntime = createBrowserRuntime();
    const expectedOrigin = new URL(target.startingUrl).origin;
    const runAgentDiscovery = vi.fn(
      (
        source: Parameters<
          NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>
        >[0],
      ) =>
        Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source,
            startedAt: "2026-09-12T10:00:00.000Z",
            completedAt: "2026-09-12T10:00:01.000Z",
            querySummary: target.label,
            warning: null,
            inventoryCompleteness: "partial",
            jobs: [],
          }),
        ),
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery,
      inspectSourceAccess: () =>
        Promise.resolve({
          state: "authenticated" as const,
          currentOrigin: `${expectedOrigin}/`,
          checkedAt: "2026-09-12T10:05:00.000Z",
          signals: ["account_menu_control" as const],
        }),
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    const initialized = await harness.workspaceService.getWorkspaceSnapshot();
    const campaignId = initialized.activeCampaignId;
    if (!campaignId) throw new Error("Expected an active search plan.");
    await harness.repository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      recentRuns: [
        DiscoveryRunRecordSchema.parse({
          id: "discovery_run_blocked",
          campaignId,
          state: "failed",
          scope: "single_target",
          startedAt: "2026-09-12T10:00:00.000Z",
          completedAt: "2026-09-12T10:01:00.000Z",
          targetIds: [target.id],
        }),
        ...current.recentRuns,
      ],
    }));

    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_blocked",
      target,
      execution: DiscoveryTargetExecutionSchema.parse({
        targetId: target.id,
        adapterKind: target.adapterKind,
        state: "failed",
        accessBlockerReason: "site_protection",
        parkedTab: {
          tabId: "tab_parked",
          url: target.startingUrl,
          title: target.label,
        },
      }),
      occurredAt: "2026-09-12T10:01:00.000Z",
    });

    const [request] = await harness.repository.listUserActionRequests();
    if (!request) throw new Error("Expected a parked-tab action.");
    expect(runAgentDiscovery).not.toHaveBeenCalled();

    await harness.workspaceService.performUserAction({
      action: "confirm_done",
      requestId: request.id,
      commandId: "confirm_cleared_discovery_wall",
      expectedRevision: request.revision,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    // The search that stopped at the wall picks up on that source rather than
    // leaving the person to start a whole new one.
    await vi.waitFor(() => {
      expect(runAgentDiscovery).toHaveBeenCalled();
    });
    const resolved = await harness.repository.getUserActionRequest(request.id);
    expect(resolved?.state).toBe("resolved");
  });

  test("a sign-in finished while another search runs searches the source once that search ends", async () => {
    const seed = createSeed();
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const baseRuntime = createBrowserRuntime();
    const expectedOrigin = new URL(target.startingUrl).origin;
    let releaseRunning: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    let calls = 0;
    const runAgentDiscovery = vi.fn(
      async (
        source: Parameters<
          NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>
        >[0],
      ) => {
        calls += 1;
        // The first search is still running when the person signs in.
        if (calls === 1) await running;
        return Promise.resolve(
          DiscoveryRunResultSchema.parse({
            source,
            startedAt: "2026-09-12T10:00:00.000Z",
            completedAt: "2026-09-12T10:00:01.000Z",
            querySummary: target.label,
            warning: null,
            inventoryCompleteness: "partial",
            jobs: [],
          }),
        );
      },
    );
    const browserRuntime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery,
      inspectSourceAccess: () =>
        Promise.resolve({
          state: "authenticated" as const,
          currentOrigin: `${expectedOrigin}/`,
          checkedAt: "2026-09-12T10:05:00.000Z",
          signals: ["account_menu_control" as const],
        }),
    };
    const harness = createWorkspaceServiceHarness({ seed, browserRuntime });
    const initialized = await harness.workspaceService.getWorkspaceSnapshot();
    const campaignId = initialized.activeCampaignId;
    if (!campaignId) throw new Error("Expected an active search plan.");
    await harness.repository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      recentRuns: [
        DiscoveryRunRecordSchema.parse({
          id: "discovery_run_blocked",
          campaignId,
          state: "failed",
          scope: "single_target",
          startedAt: "2026-09-12T10:00:00.000Z",
          completedAt: "2026-09-12T10:01:00.000Z",
          targetIds: [target.id],
        }),
        ...current.recentRuns,
      ],
    }));

    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_blocked",
      target,
      execution: DiscoveryTargetExecutionSchema.parse({
        targetId: target.id,
        adapterKind: target.adapterKind,
        state: "failed",
        accessBlockerReason: "site_protection",
        parkedTab: {
          tabId: "tab_parked",
          url: target.startingUrl,
          title: target.label,
        },
      }),
      occurredAt: "2026-09-12T10:01:00.000Z",
    });

    const [request] = await harness.repository.listUserActionRequests();
    if (!request) throw new Error("Expected a parked-tab action.");
    expect(runAgentDiscovery).not.toHaveBeenCalled();

    const runningSearch = harness.workspaceService.runAgentDiscovery();
    await vi.waitFor(() => {
      expect(runAgentDiscovery).toHaveBeenCalledTimes(1);
    });

    const confirmed = harness.workspaceService.performUserAction({
      action: "confirm_done",
      requestId: request.id,
      commandId: "confirm_cleared_discovery_wall",
      expectedRevision: request.revision,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    // The source is not searched while the other search holds the browser,
    // and the card is not closed as if it had been.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runAgentDiscovery).toHaveBeenCalledTimes(1);
    releaseRunning();
    await runningSearch.catch(() => undefined);
    await confirmed;

    // It was searched once the running search ended, and only then resolved.
    await vi.waitFor(() => {
      expect(runAgentDiscovery.mock.calls.length).toBeGreaterThan(1);
    });
    const resolved = await harness.repository.getUserActionRequest(request.id);
    expect(resolved?.state).toBe("resolved");
  });

  test("keeps the handoff visible with plain copy when its search plan was removed", async () => {
    const seed = createSeed();
    const target = seed.searchPreferences.discovery.targets[0];
    if (!target) throw new Error("Expected a saved source.");
    const baseRuntime = createBrowserRuntime();
    const runAgentDiscovery = vi.fn(
      (
        ...args: Parameters<
          NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>
        >
      ) => baseRuntime.runAgentDiscovery!(...args),
    );
    const harness = createWorkspaceServiceHarness({
      seed,
      browserRuntime: {
        ...baseRuntime,
        runAgentDiscovery,
        inspectSourceAccess: (_source, input) =>
          Promise.resolve({
            state: "authenticated" as const,
            currentOrigin: input.expectedOrigin,
            checkedAt: "2026-09-12T10:05:00.000Z",
            signals: ["account_menu_control" as const],
          }),
      },
    });
    await harness.workspaceService.getWorkspaceSnapshot();
    await harness.repository.commitDiscoveryStateUpdate((current) => ({
      ...current,
      recentRuns: [
        DiscoveryRunRecordSchema.parse({
          id: "discovery_run_removed_plan",
          campaignId: "campaign_removed",
          state: "failed",
          scope: "single_target",
          startedAt: "2026-09-12T10:00:00.000Z",
          completedAt: "2026-09-12T10:01:00.000Z",
          targetIds: [target.id],
        }),
        ...current.recentRuns,
      ],
    }));
    await persistDiscoveryRunBlockerUserAction({
      repository: harness.repository,
      runId: "discovery_run_removed_plan",
      target,
      execution: DiscoveryTargetExecutionSchema.parse({
        targetId: target.id,
        adapterKind: target.adapterKind,
        state: "failed",
        accessBlockerReason: "site_protection",
        parkedTab: {
          tabId: "tab_removed_plan",
          url: target.startingUrl,
          title: target.label,
        },
      }),
      occurredAt: "2026-09-12T10:01:00.000Z",
    });
    const [request] = await harness.repository.listUserActionRequests();
    if (!request) throw new Error("Expected a blocked source handoff.");

    await harness.workspaceService.performUserAction({
      action: "confirm_done",
      requestId: request.id,
      commandId: "continue_removed_plan",
      expectedRevision: request.revision,
      credentialsPolicy: "browser_only",
      submitAuthorized: false,
      accountCreationAuthorized: false,
    });

    const stillVisible = await harness.repository.getUserActionRequest(
      request.id,
    );
    expect(stillVisible).toMatchObject({
      state: "still_blocked",
      summary: "This search plan was removed; run the plan again",
    });
    expect(runAgentDiscovery).not.toHaveBeenCalled();
  });
});
