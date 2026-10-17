import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type {
  DesktopBrowserState,
  UserActionCommandInput,
  UserActionRequest,
} from "@nestor/contracts";
import type { JobFinderRepository } from "@nestor/db";
import { inspectApplicationAccessPage } from "@nestor/job-finder";
import type { EmbeddedBrowser } from "../browser/embedded-browser";

type BrowserStateListener = Pick<EmbeddedBrowser, "onStateChanged">;

const APPLICATION_ACCESS_KINDS = new Set<UserActionRequest["kind"]>([
  "login",
  "signup",
  "mfa",
  "email_verification",
]);

function isWaitingApplicationAccessRequest(
  request: UserActionRequest,
): boolean {
  if (request.scope.type !== "application" || !request.scope.resultId) {
    return false;
  }
  // A security check the person solves on the kept page (ticking the box,
  // finishing the puzzle) is watched the same way: once the page no longer
  // shows it, the application carries on without a "check" press.
  if (request.kind === "captcha") return true;
  return (
    APPLICATION_ACCESS_KINDS.has(request.kind) &&
    request.verification.type === "source_access"
  );
}

/** The site a sign-in step belongs to, when the step names it. */
function siteOf(request: UserActionRequest): string | null {
  return request.verification.type === "source_access"
    ? (request.verification.expectedOrigin ?? null)
    : null;
}

function applicationKey(request: UserActionRequest): string {
  return request.scope.type === "application"
    ? `${request.scope.source}:${request.scope.resultId ?? ""}`
    : request.id;
}

/**
 * Carries an application on by itself once the person has signed in.
 *
 * Signing in on the retained application page is already the person's action,
 * so it must not need a second "check" press. After any tab finishes a
 * navigation, and on a slow poll, the exact page bound to each waiting
 * application is read. When its sign-in wall is gone, the same `confirm_done`
 * command the person would press is issued; the normal verifier then re-reads
 * that exact page before the run continues.
 *
 * The page is identified by its binding, never by URL or origin, and nothing
 * here grants anything a press would not. It is deliberately not gated on the
 * browser's "needs you" phase: a person's first click in the tab clears that
 * attention, and signing in always starts with a click.
 *
 * A request is confirmed after this watcher has seen its wall and then seen it
 * gone. A request whose page already reads clear on the first look is
 * confirmed at most once per application in this process, so a wall the page
 * reader cannot recognise can never cause a loop of continuations.
 */
export function installAutomaticApplicationAccessResume(input: {
  browser?: BrowserStateListener;
  browserRuntime: Pick<
    BrowserSessionRuntime,
    "readApplicationPageBinding" | "reloadApplicationPageBinding"
  >;
  repository: Pick<
    JobFinderRepository,
    "getActivityControl" | "getUserActionRequest" | "listUserActionRequests"
  >;
  performUserAction: (command: UserActionCommandInput) => Promise<unknown>;
  /**
   * Runs after each look at the waiting hand-offs, on the same navigation
   * and poll triggers: used to notice a filled-in application the person
   * sent themselves on the page they were handed.
   */
  afterCheck?: () => Promise<void>;
  delayMs?: number;
  pollMs?: number;
}): () => void {
  const delayMs = input.delayMs ?? 600;
  const pollMs = input.pollMs ?? 3_000;
  const signatures = new Map<string, string>();
  const sawWall = new Set<string>();
  const confirmedWithoutWall = new Set<string>();
  const continuing = new Set<string>();
  /** Requests whose page was reloaded after a sign-in elsewhere on its site. */
  const reloadedAfterSiteSignIn = new Set<string>();
  let navigationTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let rerun = false;
  let disposed = false;

  function schedulePoll(): void {
    if (disposed || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void check();
    }, pollMs);
    pollTimer.unref?.();
  }

  async function checkOnce(): Promise<void> {
    await checkWaitingHandoffs();
    if (!disposed) await input.afterCheck?.().catch(() => undefined);
  }

  async function checkWaitingHandoffs(): Promise<void> {
    if ((await input.repository.getActivityControl()).paused) return;
    const requests = (
      await input.repository.listUserActionRequests({
        states: ["pending", "page_opened", "awaiting_user", "still_blocked"],
        scopeType: "application",
      })
    ).filter(isWaitingApplicationAccessRequest);
    const waitingIds = new Set(requests.map((request) => request.id));
    for (const id of [...sawWall]) {
      if (!waitingIds.has(id)) sawWall.delete(id);
    }

    const stillBlocked: UserActionRequest[] = [];
    const signedInSites = new Set<string>();
    for (const request of requests) {
      if (disposed) return;
      const pageState = await inspectApplicationAccessPage({
        browserRuntime: input.browserRuntime,
        request,
      });
      if (pageState === "still_blocked") {
        sawWall.add(request.id);
        stillBlocked.push(request);
        continue;
      }
      if (pageState !== "verified") continue;

      const resultKey = applicationKey(request);
      const wallSeen = sawWall.has(request.id);
      const site = siteOf(request);
      if (wallSeen && site) signedInSites.add(site);
      if (
        continuing.has(resultKey) ||
        (!wallSeen && confirmedWithoutWall.has(resultKey))
      )
        continue;

      // The read may have awaited a page while the card moved on.
      const current = await input.repository.getUserActionRequest(request.id);
      if (
        disposed ||
        !current ||
        current.revision !== request.revision ||
        current.state !== request.state ||
        (await input.repository.getActivityControl()).paused
      ) {
        continue;
      }
      continuing.add(resultKey);
      // Not awaited: the command runs the whole continuation, and other
      // waiting applications must still be watched meanwhile. The command id
      // makes a repeat for the same revision a no-op.
      void input
        .performUserAction({
          action: "confirm_done",
          requestId: request.id,
          commandId: `auto_application_access_${request.id}_r${request.revision}`,
          expectedRevision: request.revision,
          credentialsPolicy: "browser_only",
          submitAuthorized: false,
          accountCreationAuthorized: false,
        })
        .then(() => {
          confirmedWithoutWall.add(resultKey);
          sawWall.delete(request.id);
        })
        .catch(() => {
          // A transient continuation failure must not permanently hide a completed sign-in.
        })
        .finally(() => continuing.delete(resultKey));
    }

    // One sign-in covers the site: the other applications waiting on the
    // same site still show the sign-in form they loaded before it. Each is
    // reloaded once; the next look sees the wall gone and carries it on.
    for (const request of stillBlocked) {
      const site = siteOf(request);
      const key = `${request.id}:r${request.revision}`;
      if (
        disposed ||
        !site ||
        !signedInSites.has(site) ||
        reloadedAfterSiteSignIn.has(key) ||
        request.scope.type !== "application" ||
        !request.scope.resultId ||
        !input.browserRuntime.reloadApplicationPageBinding
      ) {
        continue;
      }
      reloadedAfterSiteSignIn.add(key);
      await input.browserRuntime
        .reloadApplicationPageBinding(
          request.scope.source,
          request.scope.resultId,
        )
        .catch(() => undefined);
      rerun = true;
    }
  }

  function check(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) {
      rerun = true;
      return inFlight;
    }
    inFlight = checkOnce()
      .catch(() => {
        // A read can fail while a page settles; the poll gives it another go.
      })
      .finally(() => {
        inFlight = null;
        if (rerun && !disposed) {
          rerun = false;
          void check();
          return;
        }
        // The poll never stops: a new hand-off must be seen with its wall
        // before the person signs in, whether or not a tab navigates.
        schedulePoll();
      });
    return inFlight;
  }

  function onStateChanged(state: DesktopBrowserState): void {
    let completedNavigation = false;
    for (const tab of state.tabs) {
      const signature = `${tab.url}\n${tab.title}\n${tab.loading}`;
      const previous = signatures.get(tab.id);
      signatures.set(tab.id, signature);
      if (previous !== undefined && previous !== signature && !tab.loading) {
        completedNavigation = true;
      }
    }
    if (!completedNavigation || disposed) return;
    if (navigationTimer) clearTimeout(navigationTimer);
    navigationTimer = setTimeout(() => {
      navigationTimer = null;
      void check();
    }, delayMs);
  }

  const unsubscribe = input.browser?.onStateChanged(onStateChanged);
  // Pick up hand-offs left open before this install (for example after the
  // workspace service was recreated).
  schedulePoll();

  return () => {
    disposed = true;
    unsubscribe?.();
    if (navigationTimer) clearTimeout(navigationTimer);
    if (pollTimer) clearTimeout(pollTimer);
  };
}
