import {
  createStubBrowserSessionRuntime,
  type AgentDiscoveryOptions,
  type BrowserSessionRuntime,
} from "@nestor/browser-runtime";
import { DiscoveryRunResultSchema } from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";

import type { EmbeddedBrowser } from "./embedded-browser";
import {
  resolveSourceAccessProbeTab,
  withEmbeddedBrowserActivity,
} from "./embedded-browser-runtime";
import { describeApplicationPreparationProgress } from "@nestor/job-finder";

describe("withEmbeddedBrowserActivity", () => {
  test("terminal cleanup reaches the host even when its automation page was detached", async () => {
    const base = createStubBrowserSessionRuntime({ sessions: [], catalog: [] });
    const releaseApplicationPageBinding = vi.fn(() =>
      Promise.reject(new Error("Page detached")),
    );
    const releaseOwnedTabs = vi.fn();
    const wrapped = withEmbeddedBrowserActivity(
      { ...base, releaseApplicationPageBinding },
      { releaseOwnedTabs } as unknown as EmbeddedBrowser,
    );
    await expect(
      wrapped.releaseApplicationPageBinding!("target_site", "sent_result"),
    ).rejects.toThrow("Page detached");
    expect(releaseOwnedTabs).toHaveBeenCalledExactlyOnceWith("sent_result", {
      keepForPerson: false,
    });
  });

  test("a finished form the person has stays open as their tab", async () => {
    const base = createStubBrowserSessionRuntime({ sessions: [], catalog: [] });
    const releaseOwnedTabs = vi.fn();
    const wrapped = withEmbeddedBrowserActivity(
      {
        ...base,
        releaseApplicationPageBinding: vi.fn(() => Promise.resolve(false)),
      },
      { releaseOwnedTabs } as unknown as EmbeddedBrowser,
    );
    await expect(
      wrapped.releaseApplicationPageBinding!("target_site", "sent_result"),
    ).resolves.toBe(false);
    expect(releaseOwnedTabs).toHaveBeenCalledExactlyOnceWith("sent_result", {
      keepForPerson: true,
    });
  });

  test("a replacement attempt reclaims and transfers the host's exact tab owner", async () => {
    const base = createStubBrowserSessionRuntime({ sessions: [], catalog: [] });
    const transferApplicationPageBinding = vi.fn(() => Promise.resolve(true));
    const reclaimOwnedTabs = vi.fn(() => Promise.resolve());
    const transferOwnedTabs = vi.fn();
    const wrapped = withEmbeddedBrowserActivity(
      { ...base, transferApplicationPageBinding },
      { reclaimOwnedTabs, transferOwnedTabs } as unknown as EmbeddedBrowser,
    );
    await expect(
      wrapped.transferApplicationPageBinding!("target_site", "old", "retry"),
    ).resolves.toBe(true);
    expect(reclaimOwnedTabs).toHaveBeenCalledExactlyOnceWith("old");
    expect(transferOwnedTabs).toHaveBeenCalledExactlyOnceWith("old", "retry");
    expect(reclaimOwnedTabs.mock.invocationCallOrder[0]).toBeLessThan(
      transferApplicationPageBinding.mock.invocationCallOrder[0]!,
    );
  });

  test("keeps form values out of the visible progress label", () => {
    expect(
      describeApplicationPreparationProgress(
        'fill_fields → Filled in "Phone". +1 555 0100 from your profile',
      ),
    ).toBe("Filling in form fields");
    expect(
      describeApplicationPreparationProgress('type → Filled in "Full name"'),
    ).toBe("Filling a text field");
  });

  test("opens the browser for passive viewing without taking global control", async () => {
    const baseRuntime = createStubBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const takeControl = vi.fn().mockResolvedValue(undefined);
    const browser = {
      command,
      takeControl,
    } as unknown as EmbeddedBrowser;
    const wrapped = withEmbeddedBrowserActivity(baseRuntime, browser);

    await wrapped.openSession("target_site", {
      targetUrl: "https://jobs.example.com/parked",
    });

    expect(command).toHaveBeenCalledWith({
      type: "open",
      url: "https://jobs.example.com/parked",
    });
    expect(takeControl).not.toHaveBeenCalled();
  });

  test("closes an exact parked tab without closing the shared runtime session", async () => {
    const baseRuntime = createStubBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const closeSession = vi.fn<BrowserSessionRuntime["closeSession"]>(
      (source) => baseRuntime.closeSession(source),
    );
    const closeParkedTab = vi.fn();
    const browser = { closeParkedTab } as unknown as EmbeddedBrowser;
    const wrapped = withEmbeddedBrowserActivity(
      { ...baseRuntime, closeSession },
      browser,
    );

    await wrapped.closeParkedTab?.("target_site", {
      tabId: "tab_second_handoff",
      url: "https://jobs.example.com/verify",
      title: "Verify",
    });

    expect(closeParkedTab).toHaveBeenCalledWith("tab_second_handoff");
    expect(closeSession).not.toHaveBeenCalled();
  });

  test("refreshes a protected parked page by tab identity before discovery", async () => {
    const baseRuntime = createStubBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const result = DiscoveryRunResultSchema.parse({
      source: "target_site",
      startedAt: "2026-09-12T10:00:00.000Z",
      completedAt: "2026-09-12T10:00:01.000Z",
      querySummary: "Second source",
      warning: null,
      inventoryCompleteness: "complete",
      jobs: [],
    });
    const runAgentDiscovery = vi.fn<
      NonNullable<BrowserSessionRuntime["runAgentDiscovery"]>
    >((_source, options) => {
      expect(options.protectedPages).toEqual([
        {
          tabId: "tab_verification",
          url: "https://jobs.example.com/challenge/continued",
          title: "Challenge continued",
        },
      ]);
      return Promise.resolve(result);
    });
    const runtime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery,
    };
    const browser = {
      getState: () => ({
        phase: "open",
        tabs: [
          {
            id: "tab_verification",
            url: "https://jobs.example.com/challenge/continued",
            title: "Challenge continued",
          },
        ],
      }),
      requestAttention: vi.fn(),
      runAutomation: async (
        _label: string,
        _signal: AbortSignal | undefined,
        work: (
          signal: AbortSignal,
          updateActivity: (label: string) => void,
          claimPage: () => void,
          claimedTabs: () => Promise<string[]>,
        ) => Promise<unknown>,
      ) =>
        work(
          new AbortController().signal,
          () => undefined,
          () => undefined,
          () => Promise.resolve([]),
        ),
    } as unknown as EmbeddedBrowser;
    const wrapped = withEmbeddedBrowserActivity(runtime, browser);
    if (!wrapped.runAgentDiscovery) {
      throw new Error("Expected agent discovery support.");
    }

    await wrapped.runAgentDiscovery("target_site", {
      userProfile: {} as AgentDiscoveryOptions["userProfile"],
      searchPreferences: { targetRoles: [], locations: [] },
      targetJobCount: 1,
      maxSteps: 1,
      startingUrls: ["https://second.example.com/jobs"],
      protectedPages: [
        {
          tabId: "tab_verification",
          url: "https://jobs.example.com/verify",
          title: "Verify you are human",
        },
      ],
      siteLabel: "Second source",
      navigationHostnames: ["second.example.com"],
    });

    expect(runAgentDiscovery).toHaveBeenCalledOnce();
  });

  test("records the live embedded tab when discovery stops at a wall", async () => {
    const session = {
      source: "target_site" as const,
      status: "ready" as const,
      driver: "catalog_seed" as const,
      label: "Browser open",
      detail: "The saved verification tab is open.",
      lastCheckedAt: "2026-09-12T10:00:00.000Z",
    };
    const baseRuntime = createStubBrowserSessionRuntime({
      sessions: [session],
      catalog: [],
    });
    const closeSession = vi.fn<BrowserSessionRuntime["closeSession"]>(
      (source) => baseRuntime.closeSession(source),
    );
    const discoveryResult = DiscoveryRunResultSchema.parse({
      source: "target_site",
      startedAt: "2026-09-12T10:00:00.000Z",
      completedAt: "2026-09-12T10:00:01.000Z",
      querySummary: "Example Jobs",
      warning: "The source stopped at a human-verification page.",
      inventoryCompleteness: "partial",
      jobs: [],
      agentMetadata: {
        accessBlockerReason: "site_protection",
        // The run reports the full address; the browser state shows tabs
        // without query or fragment.
        parkedTab: {
          tabId: null,
          url: "https://jobs.example.com/verify?next=%2Fjobs#top",
          title: null,
        },
      },
    });
    const runtime: BrowserSessionRuntime = {
      ...baseRuntime,
      closeSession,
      runAgentDiscovery: vi.fn(() => Promise.resolve(discoveryResult)),
    };
    const requestAttention = vi.fn();
    const parkTab = vi.fn();
    const browser = {
      getState: () => ({
        phase: "attention",
        activeTabId: "tab_verification",
        tabs: [
          {
            id: "tab_verification",
            url: "https://jobs.example.com/verify",
            title: "Verify you are human",
          },
        ],
      }),
      requestAttention,
      parkTab,
      runAutomation: async (
        _label: string,
        _signal: AbortSignal | undefined,
        work: (
          signal: AbortSignal,
          updateActivity: (label: string) => void,
          claimPage: () => void,
          claimedTabs: () => Promise<string[]>,
        ) => Promise<unknown>,
      ) =>
        work(
          new AbortController().signal,
          () => undefined,
          () => undefined,
          () => Promise.resolve([]),
        ),
    } as unknown as EmbeddedBrowser;
    const wrapped = withEmbeddedBrowserActivity(runtime, browser);
    if (!wrapped.runAgentDiscovery) {
      throw new Error("Expected agent discovery support.");
    }

    const result = await wrapped.runAgentDiscovery(
      "target_site",
      {} as AgentDiscoveryOptions,
    );
    expect(result.agentMetadata?.parkedTab).toMatchObject({
      tabId: "tab_verification",
      title: "Verify you are human",
    });

    expect(closeSession).not.toHaveBeenCalled();
    // The tab is parked for the person: its own banner, hidden from other
    // runs until the step is done.
    expect(parkTab).toHaveBeenCalledWith(
      "tab_verification",
      expect.objectContaining({
        kind: "challenge",
        title: "This page needs you: Example Jobs",
      }),
    );
    expect(requestAttention).not.toHaveBeenCalled();
  });
  test("binds the run's own tab when several sources search at once", async () => {
    const baseRuntime = createStubBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const discoveryResult = DiscoveryRunResultSchema.parse({
      source: "target_site",
      startedAt: "2026-09-12T10:00:00.000Z",
      completedAt: "2026-09-12T10:00:01.000Z",
      querySummary: "Sign-in Jobs",
      warning: "This site needs a sign-in.",
      inventoryCompleteness: "partial",
      jobs: [],
      agentMetadata: {
        accessBlockerReason: "auth_required",
        parkedTab: {
          tabId: null,
          url: "https://signin.example.com/jobs/",
          title: null,
        },
      },
    });
    const runtime: BrowserSessionRuntime = {
      ...baseRuntime,
      runAgentDiscovery: vi.fn(() => Promise.resolve(discoveryResult)),
    };
    const parkTab = vi.fn();
    const browser = {
      // Another source's tab is in front; the run's own tab (claimed through
      // the automation connection) sits behind it at the parked address.
      getState: () => ({
        phase: "open",
        activeTabId: "tab_other_source",
        tabs: [
          {
            id: "tab_other_source",
            url: "https://board.example.com/jobs/",
            title: "Board",
          },
          {
            id: "tab_sign_in_run",
            url: "https://signin.example.com/jobs/",
            title: "Sign in",
          },
        ],
      }),
      requestAttention: vi.fn(),
      parkTab,
      runAutomation: async (
        _label: string,
        _signal: AbortSignal | undefined,
        work: (
          signal: AbortSignal,
          updateActivity: (label: string) => void,
          claimPage: () => void,
          claimedTabs: () => Promise<string[]>,
        ) => Promise<unknown>,
      ) =>
        work(
          new AbortController().signal,
          () => undefined,
          () => undefined,
          () => Promise.resolve(["tab_sign_in_run"]),
        ),
    } as unknown as EmbeddedBrowser;
    const wrapped = withEmbeddedBrowserActivity(runtime, browser);

    const result = await wrapped.runAgentDiscovery!(
      "target_site",
      {} as AgentDiscoveryOptions,
    );

    expect(result.agentMetadata?.parkedTab).toMatchObject({
      tabId: "tab_sign_in_run",
      title: "Sign in",
    });
    expect(parkTab).toHaveBeenCalledWith(
      "tab_sign_in_run",
      expect.objectContaining({ kind: "sign_in" }),
    );
  });

  test("opens a gone parked tab again under the same id instead of failing", async () => {
    const baseRuntime = createStubBrowserSessionRuntime({
      sessions: [],
      catalog: [],
    });
    const command = vi.fn().mockResolvedValue(undefined);
    const reopenParkedTab = vi
      .fn()
      .mockReturnValue("tab_parked_before_restart");
    const browser = {
      command,
      showTab: vi.fn().mockReturnValue(false),
      reopenParkedTab,
    } as unknown as EmbeddedBrowser;
    const wrapped = withEmbeddedBrowserActivity(baseRuntime, browser);

    await wrapped.openSession("target_site", {
      targetUrl: "https://signin.example.com/jobs/",
      tabId: "tab_parked_before_restart",
      parkedFor: "sign_in",
    });

    expect(reopenParkedTab).toHaveBeenCalledWith(
      "https://signin.example.com/jobs/",
      "tab_parked_before_restart",
      expect.objectContaining({ kind: "sign_in" }),
    );
    expect(command).not.toHaveBeenCalled();
  });

  test("checks a step without a live parked tab through the only tab on its site", () => {
    const tabs = [
      { id: "tab_board", url: "http://127.0.0.1:47963/board/" },
      { id: "tab_person", url: "http://localhost:47963/authboard/" },
    ];
    const expectedOrigin = "http://localhost:47963/";
    expect(resolveSourceAccessProbeTab(tabs, { expectedOrigin })).toBe(
      "tab_person",
    );
    expect(
      resolveSourceAccessProbeTab(tabs, { expectedOrigin, tabId: "tab_gone" }),
    ).toBe("tab_person");
    expect(
      resolveSourceAccessProbeTab(
        [...tabs, { id: "tab_second", url: "http://localhost:47963/x" }],
        { expectedOrigin },
      ),
    ).toBeNull();
    expect(
      resolveSourceAccessProbeTab(
        [...tabs, { id: "tab_second", url: "http://localhost:47963/x" }],
        { expectedOrigin, tabId: "tab_second" },
      ),
    ).toBe("tab_second");
  });
});

test("reads the exact native person-owned application even when CDP released its page", async () => {
  const base = createStubBrowserSessionRuntime({ sessions: [], catalog: [] });
  const page = {
    bodyText: "Application received",
    loading: false,
  } as unknown as NonNullable<
    Awaited<
      ReturnType<
        NonNullable<BrowserSessionRuntime["readApplicationPageWithPerson"]>
      >
    >
  >;
  const readApplicationPageWithPerson = vi.fn(() => Promise.resolve(page));
  const fallback = vi.fn(() => Promise.resolve(null));
  const browser = {
    readApplicationPageWithPerson,
  } as unknown as EmbeddedBrowser;
  const wrapped = withEmbeddedBrowserActivity(
    { ...base, readApplicationPageWithPerson: fallback },
    browser,
  );
  expect(
    await wrapped.readApplicationPageWithPerson?.(
      "target_site",
      "result_waiting",
    ),
  ).toBe(page);
  expect(readApplicationPageWithPerson).toHaveBeenCalledWith("result_waiting");
  expect(fallback).not.toHaveBeenCalled();
});

test("does not send a prepared form while its exact tab is lent for editing", async () => {
  const base = createStubBrowserSessionRuntime({ sessions: [], catalog: [] });
  const execute = vi.fn<
    NonNullable<BrowserSessionRuntime["executeExactlyOneFinalAction"]>
  >(() => Promise.resolve({} as never));
  const browser = {
    isApplicationPageLent: vi.fn((owner: string) => owner === "editing_result"),
    runAutomation: async (
      _label: string,
      _signal: AbortSignal | undefined,
      work: (signal: AbortSignal) => Promise<unknown>,
    ) => work(new AbortController().signal),
  } as unknown as EmbeddedBrowser;
  const wrapped = withEmbeddedBrowserActivity(
    {
      ...base,
      executeExactlyOneFinalAction: execute,
    },
    browser,
  );
  const input = { pageBindingKey: "editing_result" } as Parameters<
    NonNullable<BrowserSessionRuntime["executeExactlyOneFinalAction"]>
  >[1];
  await expect(
    wrapped.executeExactlyOneFinalAction!("target_site", input),
  ).rejects.toThrow("Wait for the turn to finish before sending");
  expect(execute).not.toHaveBeenCalled();
});
