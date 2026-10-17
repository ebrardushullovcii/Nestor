import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  DesktopBrowserState,
  UserActionCommandInput,
  UserActionRequest,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import type { EmbeddedBrowser } from "../browser/embedded-browser";

type BrowserStateListener = Pick<
  EmbeddedBrowser,
  "getState" | "onStateChanged"
>;

function siteKey(url: string): string | null {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return null;
  }
}

/**
 * A step whose parked tab is gone (a restart closed it, or none was
 * recorded) is watched through the only tab open on its site: the person may
 * have gone there in a tab of their own. Two tabs on that site, or two such
 * steps, and neither is guessed.
 */
function findUnboundRequestForOnlyTabOnSite(
  requests: readonly UserActionRequest[],
  tabs: DesktopBrowserState["tabs"],
  tab: DesktopBrowserState["tabs"][number],
): UserActionRequest | undefined {
  const site = siteKey(tab.url);
  if (!site) return undefined;
  if (tabs.filter((candidate) => siteKey(candidate.url) === site).length !== 1)
    return undefined;
  const liveTabIds = new Set(tabs.map((candidate) => candidate.id));
  const unbound = requests.filter(
    (candidate) =>
      candidate.scope.type === "discovery_source" &&
      candidate.verification.type === "source_access" &&
      candidate.verification.expectedOrigin === site &&
      !(
        candidate.scope.parkedTab?.tabId &&
        liveTabIds.has(candidate.scope.parkedTab.tabId)
      ),
  );
  return unbound.length === 1 ? unbound[0] : undefined;
}

/**
 * A successful browser sign-in is already the person's action. Once the exact
 * parked tab finishes navigating, read that tab's access state and resume its
 * search without asking for a second confirmation click. No probe runs while
 * a page is still loading or merely receiving focus/typing.
 *
 * Deliberately not gated on the browser's "needs you" banner: the person's
 * first click in the tab dismisses it, and signing in always starts with a
 * click. The durable request, parked on this exact tab, is the gate.
 */
export function installAutomaticSourceAccessResume(input: {
  browser: BrowserStateListener;
  browserRuntime: Pick<BrowserSessionRuntime, "inspectSourceAccess">;
  repository: Pick<
    JobFinderRepository,
    "getActivityControl" | "listUserActionRequests"
  >;
  performUserAction: (command: UserActionCommandInput) => Promise<unknown>;
  delayMs?: number;
}): () => void {
  const signatures = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Set<string>();
  let disposed = false;

  function remember(state: DesktopBrowserState): void {
    for (const tab of state.tabs) {
      signatures.set(tab.id, `${tab.url}\n${tab.title}\n${tab.loading}`);
    }
  }

  async function inspect(tabId: string, signature: string): Promise<void> {
    if (disposed || inFlight.has(tabId)) return;
    inFlight.add(tabId);
    try {
      const state = input.browser.getState();
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (
        !tab ||
        tab.loading ||
        `${tab.url}\n${tab.title}\n${tab.loading}` !== signature ||
        (await input.repository.getActivityControl()).paused
      ) {
        return;
      }

      const requests = await input.repository.listUserActionRequests({
        // A check that failed earlier (the page was still loading, or the
        // app was closing) leaves the step "still blocked"; the person's
        // sign-in after that must still carry it on by itself.
        states: ["pending", "page_opened", "still_blocked"],
      });
      const request =
        requests.find(
          (candidate) =>
            candidate.scope.type === "discovery_source" &&
            candidate.scope.parkedTab?.tabId === tabId &&
            candidate.verification.type === "source_access" &&
            candidate.verification.expectedOrigin,
        ) ?? findUnboundRequestForOnlyTabOnSite(requests, state.tabs, tab);
      if (
        !request ||
        request.scope.type !== "discovery_source" ||
        request.verification.type !== "source_access" ||
        !request.verification.expectedOrigin ||
        !input.browserRuntime.inspectSourceAccess
      ) {
        return;
      }
      const expectedOrigin = request.verification.expectedOrigin;

      // Read the exact parked tab; another tab on the same site (a second
      // source, an application page) never stands in for it.
      const access = await input.browserRuntime.inspectSourceAccess(
        request.scope.source,
        { expectedOrigin, tabId },
      );
      if (
        access.state !== "authenticated" ||
        access.currentOrigin !== expectedOrigin
      ) {
        return;
      }

      const currentState = input.browser.getState();
      const currentTab = currentState.tabs.find(
        (candidate) => candidate.id === tabId,
      );
      if (
        disposed ||
        !currentTab ||
        currentTab.loading ||
        `${currentTab.url}\n${currentTab.title}\n${currentTab.loading}` !==
          signature
      ) {
        return;
      }
      if ((await input.repository.getActivityControl()).paused) return;

      await input.performUserAction({
        action: "confirm_done",
        requestId: request.id,
        commandId: `auto_source_access_${request.id}_r${request.revision}`,
        expectedRevision: request.revision,
        credentialsPolicy: "browser_only",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      });
    } catch {
      // A read-only probe can be inconclusive while a page settles. A later
      // completed navigation gives it another chance; the card stays visible.
    } finally {
      inFlight.delete(tabId);
    }
  }

  remember(input.browser.getState());
  const unsubscribe = input.browser.onStateChanged((state) => {
    const previousSignatures = new Map(signatures);
    remember(state);
    for (const tab of state.tabs) {
      if (tab.loading) continue;
      const previous = previousSignatures.get(tab.id);
      const signature = signatures.get(tab.id);
      if (!signature || !previous || signature === previous) continue;
      const existing = timers.get(tab.id);
      if (existing) clearTimeout(existing);
      timers.set(
        tab.id,
        setTimeout(() => {
          timers.delete(tab.id);
          void inspect(tab.id, signature);
        }, input.delayMs ?? 500),
      );
    }
  });

  return () => {
    disposed = true;
    unsubscribe();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
