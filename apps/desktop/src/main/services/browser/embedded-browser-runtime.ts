import type {
  BrowserSessionRuntime,
  OpenBrowserSessionOptions,
} from "@nestor/browser-runtime";
import type {
  ApplyExecutionResult,
  BrowserSessionState,
  DiscoveryRunResult,
  JobSource,
} from "@nestor/contracts";
import {
  classifySourceAccess,
  collectVisibleAccessSignals,
  type VisibleAccessSignals,
} from "@nestor/browser-runtime";
import { describeApplicationPreparationProgress } from "@nestor/job-finder";
import { browserDisplayUrl } from "./browser-navigation";
import type { EmbeddedBrowser } from "./embedded-browser";

// The same read the runtime runs through Playwright, run directly in one tab.
const VISIBLE_ACCESS_SIGNALS_SCRIPT = `(${collectVisibleAccessSignals.toString()})()`;
// An application attempt in these states leaves no page waiting on the person.
const WAITING_PAGE_ENDS = new Set<string>([
  "failed",
  "submitted",
  "cancelled",
  "unsupported",
]);

function tabOriginKey(url: string): string | null {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return null;
  }
}

/**
 * The tab a source-access check reads: the parked tab while it is open,
 * otherwise the only open tab on the expected site (none when two share it).
 */
export function resolveSourceAccessProbeTab(
  tabs: ReadonlyArray<{ id: string; url: string }>,
  input: { expectedOrigin: string; tabId?: string | null | undefined },
): string | null {
  if (input.tabId && tabs.some((tab) => tab.id === input.tabId))
    return input.tabId;
  const sameSite = tabs.filter(
    (tab) => tabOriginKey(tab.url) === input.expectedOrigin,
  );
  return sameSite.length === 1 ? sameSite[0]!.id : null;
}

/**
 * Desktop activity/lifecycle adapter; workflow and authority remain in the
 * runtime. When a run stops because only the user can continue (sign-in, a
 * human-verification challenge), the browser keeps that page and asks for
 * attention so the launcher can show it; the runtime never enters credentials.
 */
export function withEmbeddedBrowserActivity(
  runtime: BrowserSessionRuntime,
  browser: EmbeddedBrowser,
): BrowserSessionRuntime {
  const applicationSources = new Map<string, JobSource>();
  if (
    runtime.forgetClosedApplicationPage ||
    runtime.clearApplicationPageRecovery
  ) {
    browser.setApplicationTabsClosedHandler((owner) => {
      if (owner === null) {
        runtime.clearApplicationPageRecovery?.();
        applicationSources.clear();
        return;
      }
      const source = applicationSources.get(owner);
      if (source && runtime.forgetClosedApplicationPage?.(source, owner))
        applicationSources.delete(owner);
    });
  }
  if (runtime.hibernateApplicationPageBinding) {
    browser.setPreparedFormReclaimer(async (owner, canDiscard) => {
      const source = applicationSources.get(owner);
      return source
        ? runtime.hibernateApplicationPageBinding!(source, owner, canDiscard)
        : false;
    });
  }
  const flagSession = (session: BrowserSessionState): BrowserSessionState => {
    if (session.status === "login_required")
      browser.requestAttention({
        kind: "sign_in",
        title: "Sign in to continue",
        detail:
          "This site needs you to sign in. Your password stays with you; the agent picks up again afterwards.",
      });
    return session;
  };
  const flagResult = (
    result: ApplyExecutionResult,
    tabId?: string | null,
    siteLabel?: string,
  ): ApplyExecutionResult => {
    const code = result.blocker?.code;
    if (code === "site_login_required")
      browser.requestAttention(
        {
          kind: "sign_in",
          title: siteLabel
            ? `Sign in to continue: ${siteLabel}`.slice(0, 160)
            : "Sign in to continue",
          detail:
            "This application needs you to sign in. Your password stays with you; Job Finder carries on by itself once you're in.",
        },
        tabId,
      );
    else if (code === "requires_manual_review" && result.blocker?.summary)
      browser.requestAttention(
        {
          kind: "challenge",
          title: "This page needs a human",
          detail: result.blocker.summary,
        },
        tabId,
      );
    return result;
  };
  const attachParkedTab = (
    result: DiscoveryRunResult,
    claimedTabIds: readonly string[] = [],
    siteLabel = result.querySummary,
  ): DiscoveryRunResult => {
    const parked = result.agentMetadata?.parkedTab;
    if (!parked) return result;
    // The run's own tab is the parked one: the runtime leaves it open, and
    // the tab it claimed through the automation connection is that page.
    // Several sources search at once, so the active tab or another tab at
    // the same address is only a fallback. Tab addresses in the browser
    // state drop the query and fragment; the run reports the full address.
    const state = browser.getState();
    const parkedDisplayUrl = browserDisplayUrl(parked.url);
    const claimed = state.tabs.filter((candidate) =>
      claimedTabIds.includes(candidate.id),
    );
    const matches = state.tabs.filter(
      (candidate) => candidate.url === parkedDisplayUrl,
    );
    const tab =
      claimed.find((candidate) => candidate.url === parkedDisplayUrl) ??
      matches.find((candidate) => candidate.id === state.activeTabId) ??
      matches.at(-1) ??
      claimed.at(-1);
    const attention = {
      kind:
        result.agentMetadata?.accessBlockerReason === "auth_required"
          ? "sign_in"
          : "challenge",
      title:
        result.agentMetadata?.accessBlockerReason === "auth_required"
          ? `Sign in to continue: ${siteLabel}`.slice(0, 160)
          : `This page needs you: ${siteLabel}`.slice(0, 160),
      detail:
        result.warning?.slice(0, 500) ??
        "Finish the step in this browser tab; Job Finder carries on with this source by itself.",
    } as const;
    if (tab) browser.parkTab(tab.id, attention);
    else browser.requestAttention(attention, null);
    return {
      ...result,
      agentMetadata: result.agentMetadata
        ? {
            ...result.agentMetadata,
            parkedTab: {
              ...parked,
              tabId: tab?.id ?? null,
              title: tab?.title ?? null,
            },
          }
        : null,
    };
  };
  const flagAfter = async <T>(source: JobSource, work: Promise<T>) => {
    const result = await work;
    await runtime.getSessionState(source).then(flagSession, () => undefined);
    return result;
  };
  return {
    ...runtime,
    ...(runtime.readRenderedPage
      ? {
          readRenderedPage: (url: string, options?: { signal?: AbortSignal }) =>
            browser.runAutomation(
              "Reading job listing",
              undefined,
              (signal, _update, claimPage, claimedTabs) =>
                runtime.readRenderedPage!(url, {
                  signal: options?.signal
                    ? AbortSignal.any([signal, options.signal])
                    : signal,
                  onPage: async (page) => {
                    claimPage(page);
                    await claimedTabs();
                  },
                }),
            ),
        }
      : {}),
    async getSessionState(source) {
      const session = await runtime.getSessionState(source);
      const state = browser.getState();
      return state.phase === "closed" || state.phase === "closing"
        ? {
            ...session,
            status: "unknown",
            label: "Browser closed",
            detail:
              "Open the browser to visit a website. Saved sign-ins are kept.",
          }
        : session.status === "unknown"
          ? {
              ...session,
              status: "ready",
              label: "Browser open",
              detail:
                "The browser is available. A website may still require sign-in.",
            }
          : session;
    },
    async openSession(source, options?: OpenBrowserSessionOptions) {
      if (options?.purpose === "automation") {
        return browser.runAutomation("Opening browser", undefined, () =>
          runtime.openSession(source, options).then(flagSession),
        );
      }
      // Opening the shared browser is observation or task-local help, not a
      // request to stop every other discovery or preparation. A tab parked
      // for this step is shown as it is; its address may have moved on since
      // it was parked, and opening that address again would make a second tab.
      const shown = options?.tabId ? browser.showTab(options.tabId) : false;
      if (!shown && options?.parkedFor && options.targetUrl)
        // The parked tab is gone (a restart, or it was closed): open the
        // address again as that parked tab, bound to the same request.
        browser.reopenParkedTab(
          options.targetUrl,
          options.tabId ?? null,
          options.parkedFor === "sign_in"
            ? {
                kind: "sign_in",
                title: "Sign in to continue",
                detail:
                  "Sign in here; Job Finder carries on with this source by itself once you're in.",
              }
            : {
                kind: "challenge",
                title: "This page needs a human",
                detail:
                  "Finish the step in this tab; Job Finder carries on with this source by itself.",
              },
        );
      else if (!shown)
        await browser.command({
          type: "open",
          ...(options?.targetUrl ? { url: options.targetUrl } : {}),
        });
      // Human sign-in remains usable while agent activity is paused.
      return {
        ...(await runtime.getSessionState(source)),
        status: "ready",
        label: "Browser open",
        detail: "Sign in in the browser, then return to your workflow.",
      };
    },
    closeSession: (source) => runtime.closeSession(source),
    async readApplicationPageBinding(source, key) {
      const raw = await runtime.readApplicationPageBinding?.(source, key);
      return raw
        ? ((await browser.withPersonFieldAnswers?.(key, raw)) ?? raw)
        : null;
    },
    async readApplicationPageWithPerson(source, key) {
      const page = await browser.readApplicationPageWithPerson(key);
      if (!page)
        return (
          (await runtime.readApplicationPageWithPerson?.(source, key)) ?? null
        );
      // The person's read sees the page; the automation's read of the same
      // page also heard its upload requests. Carry the server's word on each
      // file across, so a repair is judged by it and not by the page alone.
      // Both reads use the same collector, so one control is the same
      // position, frame handle, id, name and label in each. A file that
      // cannot be tied to exactly one heard control, or a heard read that
      // failed, is unconfirmed: the page alone does not settle it.
      if (!page.controls.some((control) => control.upload)) return page;
      const heard = await runtime
        .readApplicationPageBinding?.(source, key)
        .catch(() => null);
      return {
        ...page,
        controls: page.controls.map((control) => {
          if (!control.upload) return control;
          const same =
            heard?.controls.filter(
              (other) =>
                other.inputType === "file" &&
                other.index === control.index &&
                other.ref === control.ref &&
                other.id === control.id &&
                other.name === control.name &&
                other.label === control.label,
            ) ?? [];
          const network =
            same.length === 1 ? same[0]!.upload?.network : "unconfirmed";
          return network
            ? { ...control, upload: { ...control.upload, network } }
            : control;
        }),
      };
    },
    async releaseApplicationPageBinding(source, key) {
      try {
        await runtime.releaseApplicationPageBinding?.(source, key);
      } finally {
        applicationSources.delete(key);
        browser.releaseOwnedTabs(key, { finished: true });
      }
    },
    ...(runtime.transferApplicationPageBinding
      ? {
          async transferApplicationPageBinding(
            source: JobSource,
            previousKey: string,
            nextKey: string,
          ) {
            await browser.reclaimOwnedTabs(previousKey);
            const transferred = await runtime.transferApplicationPageBinding!(
              source,
              previousKey,
              nextKey,
            );
            if (transferred) browser.transferOwnedTabs(previousKey, nextKey);
            if (transferred) {
              applicationSources.delete(previousKey);
              applicationSources.set(nextKey, source);
            }
            return transferred;
          },
        }
      : {}),
    async closeParkedTab(source, tab) {
      if (tab.tabId) {
        browser.closeParkedTab(tab.tabId);
        return;
      }
      await runtime.closeParkedTab?.(source, tab);
    },
    runDiscovery: (source, preferences) =>
      browser.runAutomation("Finding jobs", undefined, () =>
        flagAfter(source, runtime.runDiscovery(source, preferences)),
      ),
    executeEasyApply: (source, input) =>
      browser.runAutomation("Preparing application", undefined, () =>
        runtime.executeEasyApply(source, input).then(flagResult),
      ),
    async inspectSourceAccess(source, input) {
      // A parked tab is read in place, and only that tab: another tab on the
      // same site never stands in for it. Without a live parked tab (none
      // was recorded, or a restart closed it), the one tab open on the
      // expected site is read, and only when exactly one is: the person may
      // have signed in in a tab they opened themselves, which automation
      // cannot see.
      const probeTabId = resolveSourceAccessProbeTab(
        browser.getState().tabs,
        input,
      );
      if (probeTabId) {
        const read = await browser
          .readTab<VisibleAccessSignals>(
            probeTabId,
            VISIBLE_ACCESS_SIGNALS_SCRIPT,
          )
          .catch(() => null);
        if (!read)
          return {
            state: "inconclusive" as const,
            checkedAt: new Date().toISOString(),
            currentOrigin: null,
            signals: [],
          };
        return classifySourceAccess({
          currentUrl: read.url,
          input,
          readSignals: () => Promise.resolve(read.value),
        });
      }
      return runtime.inspectSourceAccess
        ? runtime.inspectSourceAccess(source, input)
        : {
            state: "inconclusive" as const,
            checkedAt: new Date().toISOString(),
            currentOrigin: null,
            signals: [],
          };
    },
    executeApplicationFlow: (source, input, options) =>
      browser.runAutomation(
        "Preparing application",
        options?.signal,
        (signal, updateActivity, claimPage, claimedTabs) =>
          runtime
            .executeApplicationFlow(
              source,
              {
                ...input,
                prepareApplicationForm: (formInput) =>
                  input.prepareApplicationForm({
                    ...formInput,
                    onProgress: (progress) =>
                      updateActivity(
                        `Preparing application: ${describeApplicationPreparationProgress(progress.note)}`,
                      ),
                  }),
              },
              {
                ...options,
                signal,
                onAutomationPage: async (page) => {
                  claimPage(page);
                  await claimedTabs();
                },
              },
            )
            .then(async (result) => {
              const tabs = await claimedTabs();
              for (const tabId of tabs)
                browser.setApplicationTabLabel(
                  tabId,
                  input.job.title,
                  input.job.company,
                  input.job.location,
                  input.applicationPageBindingKey?.slice(-6),
                );
              if (result.state === "failed" || result.state === "submitted")
                browser.markFinishedTabs(tabs);
              // Every page left waiting on the person counts toward the
              // live limit: Ready forms and pages stopped at Needs you.
              if (
                input.applicationPageBindingKey &&
                !WAITING_PAGE_ENDS.has(result.state) &&
                browser.markPreparedForm(input.applicationPageBindingKey)
              ) {
                applicationSources.set(input.applicationPageBindingKey, source);
              }
              return flagResult(result, tabs.at(-1) ?? null, input.job.company);
            }),
        { owner: input.applicationPageBindingKey ?? null },
      ),
    ...(runtime.runAgentDiscovery
      ? ({
          runAgentDiscovery: (source, options) =>
            browser.runAutomation(
              `Browsing ${options.siteLabel}`.slice(0, 200),
              options.signal,
              (signal, _updateActivity, claimPage, claimedTabs) => {
                const currentTabs = browser.getState().tabs;
                const protectedPages = (options.protectedPages ?? []).map(
                  (protectedPage) => {
                    const currentTab = protectedPage.tabId
                      ? currentTabs.find(
                          (candidate) => candidate.id === protectedPage.tabId,
                        )
                      : null;
                    return currentTab
                      ? {
                          ...protectedPage,
                          url: currentTab.url,
                          title: currentTab.title,
                        }
                      : protectedPage;
                  },
                );
                return runtime.runAgentDiscovery!(source, {
                  ...options,
                  protectedPages,
                  signal,
                  onAutomationPage: async (page) => {
                    claimPage(page);
                    await claimedTabs();
                  },
                  onWaitingForBrowserTab: () => {
                    _updateActivity(
                      "Browser tab limit reached · Waiting for a free tab",
                    );
                    options.onWaitingForBrowserTab?.();
                  },
                }).then(async (result) =>
                  attachParkedTab(
                    result,
                    result.agentMetadata?.parkedTab ? await claimedTabs() : [],
                    options.siteLabel ?? result.querySummary,
                  ),
                );
              },
              { cleanupOnFinish: true },
            ),
        } satisfies Partial<BrowserSessionRuntime>)
      : {}),
    ...(runtime.observeApplicationForm
      ? ({
          observeApplicationForm: (source, options) =>
            browser.runAutomation("Reading application", undefined, () =>
              runtime.observeApplicationForm!(source, options),
            ),
        } satisfies Partial<BrowserSessionRuntime>)
      : {}),
    ...(runtime.getApplicationPageState
      ? {
          getApplicationPageState: (source: JobSource, key: string) =>
            browser.getApplicationTabIds(key).length > 0
              ? Promise.resolve({
                  resultId: key,
                  state: "open" as const,
                  reason: null,
                })
              : runtime.getApplicationPageState!(source, key),
        }
      : {}),
    ...(runtime.reopenApplicationPage
      ? ({
          async reopenApplicationPage(source, key, onProgress) {
            const tabs = browser.getApplicationTabIds(key);
            if (tabs.length === 1 && browser.showTab(tabs[0]!)) {
              applicationSources.set(key, source);
              onProgress?.({ resultId: key, phase: "ready" });
              return { resultId: key, state: "open", reason: null };
            }
            const state = await runtime.reopenApplicationPage!(
              source,
              key,
              onProgress,
            );
            if (state.state === "open") applicationSources.set(key, source);
            return state;
          },
        } satisfies Partial<BrowserSessionRuntime>)
      : {}),
    ...(runtime.hasApplicationPageBinding
      ? ({
          hasApplicationPageBinding: (source, pageBindingKey) =>
            // A person-held native tab stays live when its automation Page
            // detaches. A CDP-only check otherwise retires the application
            // before its own submit can be observed.
            browser.getApplicationTabIds(pageBindingKey).length > 0
              ? Promise.resolve(true)
              : runtime.hasApplicationPageBinding!(source, pageBindingKey),
        } satisfies Partial<BrowserSessionRuntime>)
      : {}),
    ...(runtime.focusApplicationPageBinding
      ? {
          async focusApplicationPageBinding(source: JobSource, key: string) {
            const tabs = browser.getApplicationTabIds(key);
            if (tabs.length === 1 && browser.showTab(tabs[0]!)) return true;
            const focused = await runtime.focusApplicationPageBinding!(
              source,
              key,
            );
            if (!focused) {
              browser.releaseOwnedTabs(key);
              applicationSources.delete(key);
            }
            return focused;
          },
        }
      : {}),
    ...(runtime.executeExactlyOneFinalAction
      ? ({
          executeExactlyOneFinalAction: (source, input) =>
            browser.runAutomation(
              "Reviewing authorized action",
              input.signal,
              (signal) => {
                if (
                  input.pageBindingKey &&
                  browser.isApplicationPageLent(input.pageBindingKey)
                )
                  throw new Error(
                    "The assistant is editing this application. Wait for the turn to finish before sending.",
                  );
                return runtime.executeExactlyOneFinalAction!(source, {
                  ...input,
                  signal,
                });
              },
            ),
        } satisfies Partial<BrowserSessionRuntime>)
      : {}),
    ...(runtime.captureVisualSnapshot
      ? ({
          captureVisualSnapshot: (source, request) =>
            browser.runAutomation("Reading browser page", undefined, () =>
              runtime.captureVisualSnapshot!(source, request),
            ),
        } satisfies Partial<BrowserSessionRuntime>)
      : {}),
  };
}
