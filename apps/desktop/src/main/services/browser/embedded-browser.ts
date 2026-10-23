import {
  measureWaitingFormMemory,
  waitingFormsHaveCapacity,
} from "./waiting-form-memory";
import { randomUUID } from "node:crypto";
import {
  app,
  BrowserWindow,
  dialog,
  screen,
  session,
  WebContentsView,
  type Session,
  type BrowserWindowConstructorOptions,
} from "electron";
import type { Browser } from "playwright";
import {
  DesktopBrowserStateSchema,
  EMBEDDED_BROWSER_MAX_WORKING_TABS,
  EMBEDDED_BROWSER_MAX_TOTAL_TABS,
  resolveBrowserAddress,
  type DesktopBrowserState,
  type DesktopBrowserAttention,
  type DesktopBrowserCommand,
  type DesktopBrowserSnapshot,
  type RawApplyPage,
  type DesktopBrowserViewport,
  type WaitingFormMemory,
} from "@nestor/contracts";
import path from "node:path";
import { TabLifecycle } from "./tab-lifecycle";
import { routeMainWindowZoomShortcut } from "../../setup/window-zoom";
import { createAgentInputLedger } from "./agent-input-ledger";
import { BrowserCdpBridge, type BrowserCdpPage } from "./browser-cdp-bridge";
import { getEmbeddedBrowserFocusAction } from "./embedded-browser-focus-policy";
import {
  isUsableViewRect,
  resolvePageViewBounds,
  type ViewRect,
} from "./embedded-browser-layout";
import { alignClientHintHeaders } from "./browser-identity";
import {
  browserDisplayUrl,
  browserUserAgent,
  isBrowserNavigationAllowed,
  isSameBrowserNavigation,
  normalizeBrowserNavigation,
} from "./browser-navigation";

export const EMBEDDED_BROWSER_PARTITION = "persist:nestor-browser";
const MAX_TABS = EMBEDDED_BROWSER_MAX_WORKING_TABS;
const MAX_TOTAL_TABS = EMBEDDED_BROWSER_MAX_TOTAL_TABS;
interface BrowserPage extends BrowserCdpPage {
  view: WebContentsView;
  createdAt: number;
  /** Which window currently holds the page's view; see `backstage`. */
  host: "main" | "backstage";
}
interface ActivityHooks {
  pause(reason: string): Promise<void>;
  resume(): Promise<void>;
  /**
   * The person handed back tabs they had stepped into. `owners` are the
   * owner keys of the runs that stepping in stopped, so the host can carry
   * those on.
   */
  handback?(owners: string[]): Promise<void>;
}

/** Why a run stopped when the person stepped into its tab. */
export const STEPPED_IN_ABORT_MESSAGE =
  "Stopped because you stepped into the browser. Hand it back with Resume agent and Job Finder carries on, or press Try again.";

export interface AutomationRunOptions {
  /**
   * An opaque key for the work this run does (for an application, its
   * result id), reported back through `handback` if the person steps in.
   */
  owner?: string | null;
  /** Finished discovery pages can be closed by the person in one action. */
  cleanupOnFinish?: boolean;
}

/** Reports the page a run works in, so a click there stops only that run. */
export type ClaimAutomationPage = (page: {
  evaluate: (fn: (token: string) => string, token: string) => Promise<unknown>;
}) => void;

/** The tabs a run has claimed so far, once every pending claim has landed. */
export type ClaimedAutomationTabs = () => Promise<string[]>;

/**
 * Opens a prepare-only guard a run left in a page. Runs in the page's own
 * world; a page without the guard is untouched.
 */
const OPEN_PREPARE_ONLY_GUARD_FOR_PERSON = `(() => {
  const state = window.__nestorPrepareOnlyMutationGuardV1;
  if (state) state.finalActionAllowed = true;
})();`;

export class EmbeddedBrowser {
  private window: BrowserWindow | null = null;
  private backstage: BrowserWindow | null = null;
  private browserSession: Session | null = null;
  private readonly pageMap = new Map<string, BrowserPage>();
  private readonly tabLifecycle = new TabLifecycle();
  private readonly pageListeners = new Set<(page: BrowserCdpPage) => void>();
  private stateListeners = new Set<(state: DesktopBrowserState) => void>();
  private activeTabId: string | null = null;
  private unboundSendNotice: { id: string; tabId: string } | null = null;
  private readonly personInputAt = new Map<string, number>();

  /** A prompt to record an outcome, never evidence that the site received it. */
  private noteUnboundSend(tabId: string): void {
    if (Date.now() - (this.personInputAt.get(tabId) ?? 0) > 2_000) return;
    if (this.applicationTabLabels.has(tabId)) return;
    this.personInputAt.delete(tabId);
    this.unboundSendNotice = { id: randomUUID(), tabId };
    this.emit();
  }
  private applicationTabLabels = new Map<
    string,
    { title: string; url: string; baseLabel: string; reference: string }
  >();

  setApplicationTabLabel(
    tabId: string,
    title: string,
    company: string,
    location = "",
    reference = tabId.slice(-6),
    restoredLabel?: string,
  ): void {
    const page = this.pageMap.get(tabId);
    if (!page || page.contents.isDestroyed()) return;
    const baseLabel =
      // The place leads, so two tabs for the same role differ where the tab
      // text is cut; the short reference is only added when even that matches.
      restoredLabel?.slice(0, 280) ??
      [location, title.slice(0, 120), company.slice(0, 80)]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 280);
    this.applicationTabLabels.set(tabId, {
      title: baseLabel,
      baseLabel,
      reference,
      url: page.contents.getURL(),
    });
    const matches = [...this.applicationTabLabels.values()].filter(
      (label) => label.baseLabel === baseLabel,
    );
    if (matches.length > 1)
      for (const [index, label] of matches.entries()) {
        const repeated = matches.some(
          (other) => other !== label && other.reference === label.reference,
        );
        label.title = `${label.reference}${repeated ? `-${index + 1}` : ""} · ${baseLabel}`;
      }
    this.emit();
  }

  private automationPlaceholderTabId: string | null = null;
  private presentation: DesktopBrowserState["presentation"] = "minimized";
  private closed = true;
  private closing = false;
  /** Mirror of Job Finder's own pause (Home's Pause). */
  private activityPaused = false;
  /**
   * The person closed the browser from its menu while work ran. Background
   * work does not reopen it; their next deliberate start or Resume does.
   */
  private closedByPerson = false;
  /** Tabs the person stepped into, with the owners of the runs that stopped. */
  private readonly heldTabs = new Map<string, string[]>();
  /**
   * Tabs parked for the person (a source sign-in or check), with the banner
   * each one shows (null once the person dismissed it by working there).
   * Parked tabs are hidden from automation, so no other run can reuse,
   * navigate or close them while the person works there.
   */
  private readonly parkedTabs = new Map<
    string,
    DesktopBrowserAttention | null
  >();
  /** Tabs the person opened themselves; automation never uses or closes them. */
  private readonly personTabs = new Set<string>();
  private readonly personInputTabs = new Set<string>();
  /**
   * Tabs the person lent the assistant by sending a message while looking at
   * them (ADR 0038). Only the assistant's lease works there; the person's own
   * click or key in the tab takes it back at once.
   */
  private readonly lentTabs = new Set<string>();
  private activityHooks: ActivityHooks | null = null;
  private viewport: DesktopBrowserViewport = {
    x: 50,
    y: 130,
    width: 1100,
    height: 640,
    visible: false,
  };
  /** The last on-screen page size, for tabs sized while it is minimized. */
  private lastUsableViewport: ViewRect = {
    x: 50,
    y: 130,
    width: 1100,
    height: 640,
  };
  private readonly operations = new Map<AbortController, string>();
  private readonly automationCommands = new Map<string, number>();
  private readonly automationIdleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** The agent's input, told apart from the person's by source. */
  private readonly agentPresses = createAgentInputLedger();
  private readonly operationClaims = new Map<
    AbortController,
    { id: string; owner: string | null; tabs: Set<string> }
  >();
  private bridge: BrowserCdpBridge | null = null;
  private connection: Promise<Browser> | null = null;
  private attention: DesktopBrowserAttention | null = null;
  /** The parked tab that asked for help, independent of other active work. */
  private attentionTabId: string | null = null;
  private revision = 0;
  private closePromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private handoverPromise: Promise<void> | null = null;
  private releasePending = false;

  attachWindow(window: BrowserWindow): void {
    if (this.window === window) return;
    this.window = window;
    window.on("focus", () => this.hostPages());
    window.on("blur", () => this.hostPages());
    window.on("resize", () => this.layout());
    window.on("show", () => this.layout());
    window.on("restore", () => this.layout());
    window.on("closed", () => {
      if (this.window !== window) return;
      this.window = null;
      if (this.backstage && !this.backstage.isDestroyed())
        this.backstage.destroy();
      this.backstage = null;
      void this.close(false);
    });
  }

  /**
   * Automation pages must not pull the app to the front. On macOS almost
   * anything Chromium does to a page inside the app window can activate the
   * app when that window is not focused: a navigation committing, a popup,
   * a full-page screenshot, emulated focus. Every one of them switched the
   * user out of whatever full-screen app they were in. A hidden
   * non-activating panel window is immune to all of them, so while a run is
   * going and the app window is not focused the pages live there, and they
   * move back into the app window as soon as it is focused again. Nobody can
   * see the pages while the window is unfocused anyway.
   */
  private getBackstage(): BrowserWindow | null {
    if (process.platform !== "darwin") return null;
    if (this.backstage && !this.backstage.isDestroyed()) return this.backstage;
    this.backstage = new BrowserWindow({
      show: false,
      type: "panel",
      focusable: false,
      width: 1280,
      height: 800,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    return this.backstage;
  }

  private pagesBelongBackstage(): boolean {
    if (
      process.platform !== "darwin" ||
      !this.window ||
      this.window.isDestroyed() ||
      this.window.isFocused()
    )
      return false;
    // Once a run sent pages backstage they stay until the window is focused:
    // a site keeps navigating on its own after the run ends.
    return (
      this.operations.size > 0 ||
      [...this.pageMap.values()].some((page) => page.host === "backstage")
    );
  }

  private placePage(page: BrowserPage, host: BrowserPage["host"]): void {
    if (page.contents.isDestroyed() || page.host === host) return;
    if (!this.window || this.window.isDestroyed()) return;
    const to = host === "backstage" ? this.getBackstage() : this.window;
    if (!to) return;
    const from = page.host === "backstage" ? this.backstage : this.window;
    if (from && !from.isDestroyed())
      from.contentView.removeChildView(page.view);
    to.contentView.addChildView(page.view);
    page.host = host;
  }

  /** Move every page to the window it belongs in right now, then lay out. */
  private hostPages(): void {
    const host = this.pagesBelongBackstage() ? "backstage" : "main";
    for (const page of this.pageMap.values()) this.placePage(page, host);
    this.layout();
  }

  ownsRenderer(id: number): boolean {
    return (
      !!this.window &&
      !this.window.isDestroyed() &&
      this.window.webContents.id === id
    );
  }

  setActivityHooks(hooks: ActivityHooks): void {
    this.activityHooks = hooks;
  }
  syncActivityPaused(paused: boolean): void {
    this.activityPaused = paused;
    if (paused) this.abortOperations();
    this.emit();
  }

  /**
   * A deliberate start (Search now, Apply, Check source) after the person
   * closed the browser mid-run: new work may open it again.
   */
  clearPersonPause(): void {
    if (!this.closedByPerson) return;
    this.closedByPerson = false;
    this.emit();
  }

  private automationRefused(): boolean {
    return this.activityPaused || this.closedByPerson || this.closing;
  }

  private visibleAttention(): DesktopBrowserAttention | null {
    if (this.attention && this.attentionTabId === this.activeTabId)
      return this.attention;
    return this.activeTabId
      ? (this.parkedTabs.get(this.activeTabId) ?? null)
      : null;
  }

  private readonly finishedTabs = new Set<string>();
  private readonly ownedTabs = new Map<string, Set<string>>();
  private readonly releasedOwnedTabs = new Set<string>();
  private readonly preparedForms = new Map<string, number>();
  private applicationTabsClosed: ((owner: string | null) => void) | null = null;

  setApplicationTabsClosedHandler(
    handler: (owner: string | null) => void,
  ): void {
    this.applicationTabsClosed = handler;
  }
  private readonly discardedFormLabels = new Map<
    string,
    { title: string; url: string; baseLabel: string; reference: string }
  >();
  private reclaimPreparedForm:
    | ((owner: string, canDiscard: () => boolean) => Promise<boolean>)
    | null = null;

  setPreparedFormReclaimer(
    reclaim: (owner: string, canDiscard: () => boolean) => Promise<boolean>,
  ): void {
    this.reclaimPreparedForm = reclaim;
  }

  markPreparedForm(owner: string): boolean {
    if (!this.ownedTabs.get(owner)?.size) return false;
    this.preparedForms.set(owner, Date.now());
    const label = this.discardedFormLabels.get(owner);
    if (label) {
      for (const id of this.ownedTabs.get(owner) ?? []) {
        const page = this.pageMap.get(id);
        if (page && !page.contents.isDestroyed())
          this.applicationTabLabels.set(id, {
            ...label,
            url: page.contents.getURL(),
          });
      }
      this.discardedFormLabels.delete(owner);
      this.emit();
    }
    return true;
  }

  private canDiscardPreparedForm(owner: string): boolean {
    const tabs = this.ownedTabs.get(owner);
    return (
      Boolean(tabs?.size) &&
      [...(tabs ?? [])].every(
        (id) =>
          !this.heldTabs.has(id) &&
          !this.parkedTabs.has(id) &&
          !this.personTabs.has(id) &&
          !this.personInputTabs.has(id) &&
          !this.lentTabs.has(id) &&
          !(
            this.activeTabId === id &&
            this.presentation !== "minimized" &&
            this.viewport.visible
          ) &&
          ![...this.operationClaims.values()].some((claim) =>
            claim.tabs.has(id),
          ),
      )
    );
  }

  async reclaimOwnedTabs(owner: string): Promise<void> {
    const tabs = this.ownedTabs.get(owner);
    if (!tabs) return;
    for (const id of tabs) {
      this.heldTabs.delete(id);
      this.parkedTabs.delete(id);
      this.personTabs.delete(id);
    }
    await this.getOpenBrowser();
    for (const id of tabs) {
      const page = this.pageMap.get(id);
      await this.closeTabForAutomation(id);
      if (page && this.bridge) await this.bridge.reclaimPage(page);
    }
  }

  transferOwnedTabs(previousKey: string, nextKey: string): void {
    if (previousKey === nextKey) return;
    const tabs = this.ownedTabs.get(previousKey);
    if (!tabs) return;
    const next = this.ownedTabs.get(nextKey) ?? new Set<string>();
    for (const id of tabs) next.add(id);
    this.ownedTabs.set(nextKey, next);
    this.ownedTabs.delete(previousKey);
  }

  /**
   * A finished owner lets go of its tabs. They close, except a tab the person
   * has: with `keepForPerson` (they opened the form to finish it) it becomes
   * their own tab, and a tab they hold or a parked tab is never closed under
   * them.
   */
  releaseOwnedTabs(
    owner: string,
    options: { keepForPerson?: boolean } = {},
  ): void {
    const tabs = this.ownedTabs.get(owner);
    this.ownedTabs.delete(owner);
    this.preparedForms.delete(owner);
    this.discardedFormLabels.delete(owner);
    for (const id of tabs ?? []) {
      if (options.keepForPerson || this.personInputTabs.has(id)) {
        this.personTabs.add(id);
        this.bridge?.releasePage(id);
      } else this.releasedOwnedTabs.add(id);
    }
    this.closeReleasedOwnedTabs();
    if (options.keepForPerson && tabs?.size) this.emit();
  }

  private closeReleasedOwnedTabs(): void {
    for (const id of this.releasedOwnedTabs) {
      if (
        [...this.operationClaims.values()].some((claim) => claim.tabs.has(id))
      )
        continue;
      this.closePageForAutomation(id);
      this.releasedOwnedTabs.delete(id);
    }
  }

  /**
   * A finished search source's leftover tabs (a listing a site opened in a
   * new tab, a popup) close now unless the person is looking at one. Left
   * for the person to close, they piled up to the tab limit over a long
   * search, a renderer process each, and the search then waited for a tab.
   */
  markFinishedTabs(tabIds: readonly string[]): void {
    for (const id of tabIds) this.finishedTabs.add(id);
    this.closeIdleFinishedTabs({ keepActive: true });
  }

  private closeIdleFinishedTabs(options: { keepActive: boolean }): number {
    let closed = 0;
    for (const id of this.finishedTabs) {
      if (
        (options.keepActive && id === this.activeTabId) ||
        this.heldTabs.has(id) ||
        this.parkedTabs.has(id) ||
        this.personTabs.has(id) ||
        this.lentTabs.has(id) ||
        [...this.operationClaims.values()].some((claim) => claim.tabs.has(id))
      )
        continue;
      this.closePage(id);
      closed += 1;
      this.finishedTabs.delete(id);
    }
    return closed;
  }

  private closeFinishedTabs(): void {
    const closed = this.closeIdleFinishedTabs({ keepActive: false });
    if (closed === 0)
      this.requestAttention({
        kind: "error",
        title: "No finished tabs to close",
        detail:
          "The open tabs are still in use or belong to you. Close a tab you no longer need to free space.",
      });
  }
  onStateChanged(listener: (state: DesktopBrowserState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  getState(): DesktopBrowserState {
    // A stopped task on another tab does not describe this page. A prepared
    // form the person owns has no interrupted task for Resume to carry on.
    const paused =
      this.activityPaused ||
      this.closedByPerson ||
      Boolean(
        this.activeTabId &&
        (this.heldTabs.get(this.activeTabId)?.length ?? 0) > 0,
      );
    const activeOperations = [...this.operations.entries()].filter(
      ([controller]) => {
        const claim = this.operationClaims.get(controller);
        return (
          !claim ||
          Boolean(this.activeTabId && claim.tabs.has(this.activeTabId))
        );
      },
    );
    return DesktopBrowserStateSchema.parse({
      revision: this.revision,
      unboundSendNotice: this.unboundSendNotice,
      phase: this.closing
        ? "closing"
        : this.closed
          ? "closed"
          : this.handoverPromise
            ? "pausing"
            : this.visibleAttention()
              ? "needs_you"
              : activeOperations.length > 0
                ? "working"
                : paused
                  ? "paused"
                  : "ready",
      presentation: this.presentation,
      activeTabId: this.activeTabId,
      activity: activeOperations.at(-1)?.[1] ?? null,
      attention: this.visibleAttention(),
      automationPaused: paused,
      tabs: [...this.pageMap.values()]
        .filter((page) => !page.contents.isDestroyed())
        .map((page) => ({
          id: page.id,
          title: (
            (this.applicationTabLabels.get(page.id)?.url ===
            page.contents.getURL()
              ? this.applicationTabLabels.get(page.id)?.title
              : null) ||
            page.contents.getTitle() ||
            "New tab"
          ).slice(0, 300),
          url: browserDisplayUrl(page.contents.getURL()),
          loading: page.contents.isLoading(),
          canGoBack: page.contents.navigationHistory.canGoBack(),
          canGoForward: page.contents.navigationHistory.canGoForward(),
        })),
    });
  }

  private emit(): void {
    this.revision += 1;
    const state = this.getState();
    for (const listener of this.stateListeners) listener(state);
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send("browser:state-changed", state);
    }
  }

  getSession(): Session {
    if (this.browserSession) return this.browserSession;
    const browserSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION);
    browserSession.setUserAgent(
      browserUserAgent(browserSession.getUserAgent(), app.getName()),
    );
    // Present as the Chrome this Chromium is built from: brand headers here,
    // the in-page brand list and window.chrome shape through a bridge-free
    // page preload. Google's sign-in refuses the bare Chromium identity.
    browserSession.registerPreloadScript({
      type: "frame",
      filePath: path.join(__dirname, "../preload/browser-page.cjs"),
    });
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: alignClientHintHeaders(
          details.requestHeaders,
          process.versions.chrome,
        ),
      });
    });
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler(
      (contents, permission, callback) => {
        // Website capabilities are user-owned, independent of agent authority.
        const page = [...this.pageMap.values()].find(
          (item) => item.contents.id === contents?.id,
        );
        // A site asking during a run is declined quietly: the agent never
        // needs device access, and a prompt would stop the run for nothing.
        if (!page || !this.window || this.operations.size > 0) {
          callback(false);
          return;
        }
        if (this.presentation === "minimized") {
          callback(false);
          this.requestAttention({
            kind: "permission",
            title: "Website permission requested",
            detail:
              "Open the browser and click into the page to review this website’s permission request.",
          });
          return;
        }
        const supported = [
          "media",
          "geolocation",
          "notifications",
          "clipboard-sanitized-write",
        ].includes(permission);
        if (!supported) {
          callback(false);
          return;
        }
        void dialog
          .showMessageBox(this.window, {
            type: "question",
            title: "Website permission",
            message: `${new URL(contents.getURL()).hostname} wants ${permission.replaceAll("-", " ")} access.`,
            detail: "Allow only if you expected this request from the website.",
            buttons: ["Don’t allow", "Allow once"],
            defaultId: 0,
            cancelId: 0,
          })
          .then(
            (result) => callback(result.response === 1),
            () => callback(false),
          );
      },
    );
    browserSession.on("will-download", (event, item, contents) => {
      const owned = [...this.pageMap.values()].some(
        (page) => page.contents.id === contents.id,
      );
      if (
        !owned ||
        this.operations.size > 0 ||
        this.presentation === "minimized"
      ) {
        event.preventDefault();
        this.requestAttention({
          kind: "user_action",
          title: "A download needs you",
          detail:
            "Open the browser and click the download again to choose where to save it.",
        });
        return;
      }
      // Electron's native save dialog keeps filesystem selection with the user.
      item.setSaveDialogOptions({ title: "Save browser download" });
    });
    // Service workers are ordinary on modern sites. The submit guard covers
    // their requests too, so a worker starting is not a reason to stop.
    this.browserSession = browserSession;
    return browserSession;
  }

  private isPausedForPerson(): boolean {
    return this.activityPaused || this.closedByPerson || this.heldTabs.size > 0;
  }

  requestAttention(
    attention: DesktopBrowserAttention,
    tabId: string | null = this.activeTabId,
  ): void {
    const clamped = clampAttention(attention);
    if (tabId && this.parkedTabs.has(tabId)) {
      this.parkedTabs.set(tabId, clamped);
    } else {
      this.attention = clamped;
      this.attentionTabId = tabId;
    }
    this.emit();
  }

  /**
   * Parks one tab for the person (a sign-in or a check a search stopped
   * on). Each parked tab keeps its own banner, so a second hand-off never
   * replaces the first, and the tab is hidden from automation until it is
   * handed back or closed.
   */
  parkTab(tabId: string, attention: DesktopBrowserAttention): void {
    if (!this.pageMap.has(tabId)) {
      this.requestAttention(attention, tabId);
      return;
    }
    this.parkedTabs.set(tabId, clampAttention(attention));
    this.bridge?.releasePage(tabId);
    this.openTabForPerson(tabId);
    this.emit();
  }

  /**
   * Opens a parked step's page again when its tab is gone (the app
   * restarted, or the tab was closed): a new tab at the parked address,
   * parked for the person like the original. It takes the old tab's id when
   * given, so the request that saved that id stays bound to it: the sign-in
   * watcher, the step check and Cancel all find this tab.
   */
  reopenParkedTab(
    url: string,
    tabId: string | null,
    attention: DesktopBrowserAttention,
  ): string {
    if (tabId && this.showTab(tabId)) return tabId;
    const page = this.createPage(
      url,
      undefined,
      undefined,
      (id) => this.parkedTabs.set(id, clampAttention(attention)),
      tabId ?? undefined,
    );
    this.bridge?.releasePage(page.id);
    this.showTab(page.id);
    return page.id;
  }

  isTabParked(tabId: string): boolean {
    return this.parkedTabs.has(tabId);
  }

  /** Shows one tab to the person (a parked tab opened from Needs you). */
  showTab(tabId: string): boolean {
    if (!this.pageMap.has(tabId)) return false;
    this.closed = false;
    this.presentation = "peek";
    this.selectPage(tabId);
    this.layout();
    this.emit();
    return true;
  }

  /**
   * Runs `script` in one tab and returns its value along with the tab's
   * address. Reads only; used to check a parked tab without automation.
   */
  async readTab<T>(
    tabId: string,
    script: string,
  ): Promise<{ url: string; value: T } | null> {
    const page = this.pageMap.get(tabId);
    if (!page || page.contents.isDestroyed() || page.contents.isLoading())
      return null;
    const url = page.contents.getURL();
    await this.noteAutomationCommand(tabId, true, false);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = (await Promise.race([
        page.contents.executeJavaScript(script, false),
        new Promise((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("The page did not answer.")),
            3_000,
          );
        }),
      ])) as T;
      return { url, value };
    } finally {
      clearTimeout(deadline);
      await this.noteAutomationCommand(tabId, false, false);
      this.syncTabLifecycle(page);
    }
  }

  private handleUserInput(
    tabId: string,
    kind: "pointer" | "key",
    key?: { code: string; key: string },
  ): void {
    const page = this.pageMap.get(tabId);
    if (!page) return;
    if (kind === "pointer") {
      // Every press automation sends is noted before it reaches the page,
      // so a mouse-down with no noted press behind it is the person's own
      // click, even a second click without moving the pointer or one just
      // after the agent's own input.
      if (this.agentPresses.claimPress(page.id)) return;
      if (!this.isPointerOverPage(page)) return;
    } else {
      if (key && this.agentPresses.claimKey(page.id, key)) return;
    }
    this.notePersonInput(page.id);
    if (this.lentTabs.has(page.id)) {
      // The person's click or key in a lent tab takes it back from the
      // assistant, and only from the assistant (ADR 0038).
      this.revokeLoan(page.id, "You took this tab back.");
      if (this.personTabs.has(page.id)) return;
    }
    const focusAction = getEmbeddedBrowserFocusAction({
      focusedTabId: page.id,
      operations: this.describeOperations(),
      parked: this.parkedTabs.has(page.id),
      // A tab the person opened is already theirs; no run works there.
      held: this.heldTabs.has(page.id) || this.personTabs.has(page.id),
      bannerOnTab:
        (this.parkedTabs.get(page.id) ?? null) !== null ||
        (this.attention !== null && this.attentionTabId === page.id),
      handoverPending: this.handoverPromise !== null,
    });
    if (focusAction.type === "dismiss_attention") {
      // Helping on a parked tab is task-local: its banner goes, and work in
      // other tabs carries on through every click and keystroke here.
      if (this.parkedTabs.has(page.id)) this.parkedTabs.set(page.id, null);
      if (this.attentionTabId === page.id) {
        this.attention = null;
        this.attentionTabId = null;
      }
      this.emit();
    } else if (focusAction.type === "take_tab") {
      this.takeTab(page.id, focusAction.operationIds);
    }
  }

  /** Called only after the native input ledger has excluded automation. */
  private notePersonInput(tabId: string): void {
    this.personInputTabs.add(tabId);
    this.personInputAt.set(tabId, Date.now());
    // An idle prepared form has no running claim, but its guard and network
    // interception still belong to automation. Release that exact tab first.
    const owned = [...this.ownedTabs.values()].some((tabs) => tabs.has(tabId));
    if (owned && !this.heldTabs.has(tabId)) {
      const claims = this.describeOperations().filter((operation) =>
        operation.tabIds.includes(tabId),
      );
      this.takeTab(
        tabId,
        claims.map((claim) => claim.id),
      );
    } else this.openTabForPerson(tabId);
  }

  async readApplicationPageWithPerson(
    owner: string,
  ): Promise<RawApplyPage | null> {
    const tabs = [...(this.ownedTabs.get(owner) ?? [])].filter((id) =>
      this.personInputTabs.has(id),
    );
    if (tabs.length !== 1) return null;
    const read = await this.readTab<{ title: string; bodyText: string }>(
      tabs[0]!,
      "({ title: document.title, bodyText: document.body?.innerText ?? '' })",
    );
    if (!read) return null;
    return {
      url: read.url,
      title: read.value.title,
      bodyText: read.value.bodyText,
      headings: [],
      controls: [],
      actions: [],
      links: [],
      clickables: [],
      openedTabs: [],
      validationErrors: [],
      stepLabel: null,
      loading: false,
    };
  }

  /** Every open tab, the person's own included; the limit counts them all. */
  openTabCount(): number {
    return this.pageMap.size;
  }

  /** Waiting forms keep their renderers and attachments but release working capacity. */
  workingTabCount(): number {
    const working = new Set(
      [...this.operationClaims.values()].flatMap((claim) => [...claim.tabs]),
    );
    const waiting = new Set(
      [...this.ownedTabs.values()].flatMap((tabs) => [...tabs]),
    );
    return [...this.pageMap.keys()].filter(
      (id) =>
        working.has(id) ||
        (!this.parkedTabs.has(id) &&
          !waiting.has(id) &&
          !this.personTabs.has(id) &&
          !this.heldTabs.has(id)),
    ).length;
  }

  private isWaitingTab(id: string): boolean {
    return (
      (this.parkedTabs.has(id) ||
        [...this.ownedTabs.values()].some((tabs) => tabs.has(id))) &&
      ![...this.operationClaims.values()].some((claim) => claim.tabs.has(id))
    );
  }

  private shouldThrottleTab(id: string): boolean {
    return (
      !this.automationCommands.has(id) && !this.automationIdleTimers.has(id)
    );
  }

  private noteAutomationCommand(
    id: string,
    active: boolean,
    emulateFocus = true,
  ): Promise<void> {
    const page = this.pageMap.get(id);
    if (!page || page.contents.isDestroyed()) return Promise.resolve();
    const previousTimer = this.automationIdleTimers.get(id);
    if (previousTimer) clearTimeout(previousTimer);
    this.automationIdleTimers.delete(id);
    const count = Math.max(
      0,
      (this.automationCommands.get(id) ?? 0) + (active ? 1 : -1),
    );
    if (count > 0) {
      this.automationCommands.set(id, count);
      if (emulateFocus) page.contents.setBackgroundThrottling(false);
      return this.tabLifecycle
        .setFrozen(page.contents, false)
        .then(async () => {
          if (emulateFocus && !page.contents.isDestroyed())
            await page.contents.debugger.sendCommand(
              "Emulation.setFocusEmulationEnabled",
              { enabled: true },
            );
        });
    } else {
      this.automationCommands.delete(id);
      // Native DOM probes need no animation frames or focus. Once their
      // result arrives, a waiting form can sleep again immediately.
      if (!emulateFocus) {
        page.contents.setBackgroundThrottling(this.shouldThrottleTab(id));
        return Promise.resolve();
      }
      // Model requests can take minutes. Ads and page timers do not need to
      // run at foreground speed while no browser command is using this page.
      const timer = setTimeout(() => {
        this.automationIdleTimers.delete(id);
        if (page.contents.isDestroyed()) return;
        if (!page.contents.isDestroyed())
          page.contents.setBackgroundThrottling(this.shouldThrottleTab(id));
        if (page.contents.debugger.isAttached() && this.shouldThrottleTab(id))
          void page.contents.debugger
            .sendCommand("Emulation.setFocusEmulationEnabled", {
              enabled: false,
            })
            .catch(() => undefined);
        this.syncTabLifecycle(page);
      }, 5_000);
      timer.unref();
      this.automationIdleTimers.set(id, timer);
    }
    return Promise.resolve();
  }

  private syncTabLifecycle(page: BrowserPage): void {
    if (page.contents.isDestroyed()) return;
    const visible =
      !this.closed &&
      !this.closing &&
      this.presentation !== "minimized" &&
      this.viewport.visible &&
      this.activeTabId === page.id;
    const retained =
      this.isWaitingTab(page.id) ||
      this.personTabs.has(page.id) ||
      this.heldTabs.has(page.id) ||
      this.finishedTabs.has(page.id);
    const working = [...this.operationClaims.values()].some((claim) =>
      claim.tabs.has(page.id),
    );
    const frozen =
      retained &&
      !working &&
      !visible &&
      !page.contents.isLoading() &&
      this.shouldThrottleTab(page.id);
    void this.tabLifecycle
      .setFrozen(page.contents, frozen)
      .catch(() => undefined);
  }

  private memoryCleanup: Promise<void> | null = null;
  private lastMemoryCleanupAt = 0;

  /**
   * A retained application form has its own reclamation target. Only forms
   * with a verified exact refill can be discarded. A search page parked for
   * the person (a sign-in or a site check) is not a form; counting two such
   * pages (530 and 600 MB on a check page) filled the budget and held every
   * other source of a search at "Waiting for a free tab" (ADR 0051).
   */
  private isWaitingFormTab(id: string): boolean {
    return (
      [...this.ownedTabs.values()].some((tabs) => tabs.has(id)) &&
      ![...this.operationClaims.values()].some((claim) => claim.tabs.has(id))
    );
  }

  /** Read native process metrics; no page content or answer leaves its renderer. */
  getWaitingFormMemory(): WaitingFormMemory {
    const tabs = [...this.pageMap.values()].filter(
      (page) => !page.contents.isDestroyed() && this.isWaitingFormTab(page.id),
    );
    return measureWaitingFormMemory({
      recordedAt: new Date().toISOString(),
      tabs: tabs.map((page) => ({
        tabId: page.id,
        processId: page.contents.getOSProcessId(),
        backgroundThrottled: this.shouldThrottleTab(page.id),
      })),
      processes: app.getAppMetrics?.() ?? [],
    });
  }

  async reduceWaitingFormMemory(): Promise<WaitingFormMemory> {
    if (this.memoryCleanup) {
      await this.memoryCleanup;
      return this.getWaitingFormMemory();
    }
    const needsReclaim = () => {
      const memory = this.getWaitingFormMemory();
      return (
        (memory.measurementComplete && !waitingFormsHaveCapacity(memory)) ||
        this.pageMap.size >= MAX_TOTAL_TABS - 2
      );
    };
    if (needsReclaim() && Date.now() - this.lastMemoryCleanupAt > 10_000) {
      this.lastMemoryCleanupAt = Date.now();
      this.memoryCleanup = (async () => {
        const oldest = [...this.preparedForms].sort((a, b) => a[1] - b[1]);
        const started = Date.now();
        for (const [owner] of oldest) {
          if (!needsReclaim()) break;
          // Exact refill verification needs a temporary working tab. Wait
          // for one rather than treating a full browser as an unsafe form.
          if (!this.hasTabCapacity()) break;
          if (!this.canDiscardPreparedForm(owner)) continue;
          if (Date.now() - started > 5_000) break;
          const label = [...(this.ownedTabs.get(owner) ?? [])]
            .map((id) => this.applicationTabLabels.get(id))
            .find((value) => value !== undefined);
          const discarded = await this.reclaimPreparedForm?.(owner, () =>
            this.canDiscardPreparedForm(owner),
          ).catch(() => false);
          if (discarded && label) this.discardedFormLabels.set(owner, label);
        }
        if (!needsReclaim()) return;
        // Unsupported forms keep their exact page; reclaim unreachable objects
        // without retrying an AI preparation or changing their answers.
        const hidden = this.getWaitingFormMemory().tabs.filter(
          (tab) =>
            tab.tabId !== this.activeTabId || this.presentation === "minimized",
        );
        await Promise.all(
          hidden.map(async ({ tabId }) => {
            const page = this.pageMap.get(tabId);
            if (
              !page ||
              page.contents.isDestroyed() ||
              !this.isWaitingTab(tabId)
            )
              return;
            page.contents.setBackgroundThrottling(true);
            // Only unreachable objects are collected. The live DOM, selected files,
            // session and form answers remain in the same tab.
            if (page.contents.debugger.isAttached()) {
              let deadline: ReturnType<typeof setTimeout> | undefined;
              await Promise.race([
                page.contents.debugger
                  .sendCommand("HeapProfiler.collectGarbage")
                  .catch(() => undefined),
                new Promise<void>((resolve) => {
                  deadline = setTimeout(resolve, 2_000);
                }),
              ]).finally(() => clearTimeout(deadline));
            }
          }),
        );
      })().finally(() => {
        this.memoryCleanup = null;
      });
      await this.memoryCleanup;
    }
    return this.getWaitingFormMemory();
  }

  hasAutomationTabCapacity(reservedTabs = 0): boolean {
    const memory = this.getWaitingFormMemory();
    if (
      (memory.measurementComplete && !waitingFormsHaveCapacity(memory)) ||
      this.pageMap.size + reservedTabs >= MAX_TOTAL_TABS - 2
    )
      void this.reduceWaitingFormMemory().catch(() => undefined);
    // Finished search tabs give way before a search waits for a free tab;
    // they close asynchronously, so the room shows at the next check.
    if (!this.hasTabCapacity(reservedTabs))
      this.closeIdleFinishedTabs({ keepActive: false });
    return this.hasTabCapacity(reservedTabs);
  }

  private hasTabCapacity(reservedTabs = 0): boolean {
    return (
      this.pageMap.size + reservedTabs < MAX_TOTAL_TABS &&
      this.workingTabCount() + reservedTabs < MAX_TABS
    );
  }

  assertAutomationSafe(): void {
    if (
      Object.keys(this.getSession().serviceWorkers.getAllRunning()).length > 0
    ) {
      throw new Error(
        "A website has a background worker running. Close the browser, then resume activity to start a guarded session.",
      );
    }
  }

  private createPage(
    url: string,
    openerId?: string,
    popupOptions?: BrowserWindowConstructorOptions,
    beforeAnnounce?: (id: string) => void,
    fixedId?: string,
    selectOnCreate = true,
  ): BrowserPage {
    if (this.closing)
      throw new Error(
        "The browser is closing. Open it again when it has finished.",
      );
    if (!this.window || this.window.isDestroyed())
      throw new Error("The app window is not available.");
    if (!this.hasTabCapacity())
      throw new Error("The browser is full. Close an unused tab to continue.");
    const destination = normalizeBrowserNavigation(url);
    const view = new WebContentsView({
      ...popupOptions,
      webPreferences: {
        ...popupOptions?.webPreferences,
        session: this.getSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: true,
        spellcheck: true,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    const host = this.pagesBelongBackstage() ? "backstage" : "main";
    const page: BrowserPage = {
      id: fixedId && !this.pageMap.has(fixedId) ? fixedId : randomUUID(),
      contents: view.webContents,
      view,
      createdAt: Date.now(),
      host,
      ...(openerId ? { openerId } : {}),
    };
    this.pageMap.set(page.id, page);
    // Let navigation and CDP initialization finish before freezing a new
    // about:blank target; freezing it here can strand context.newPage().
    void this.noteAutomationCommand(page.id, false);
    beforeAnnounce?.(page.id);
    this.closed = false;
    const selected = this.activeTabId
      ? this.pageMap.get(this.activeTabId)
      : undefined;
    const replacesPlaceholder =
      selected?.id === this.automationPlaceholderTabId &&
      (selected.contents.getURL() === "about:blank" ||
        selected.contents.getURL() === "") &&
      !this.heldTabs.has(selected.id) &&
      !this.parkedTabs.has(selected.id) &&
      !this.personTabs.has(selected.id) &&
      ![...this.operationClaims.values()].some((claim) =>
        claim.tabs.has(selected.id),
      );
    // Show the first useful page, then keep the person's selected tab stable
    // while other application pages open in the background.
    if (selectOnCreate || !this.activeTabId || replacesPlaceholder)
      this.activeTabId = page.id;
    view.setBorderRadius(12);
    (host === "backstage"
      ? (this.getBackstage() ?? this.window)
      : this.window
    ).contentView.addChildView(view);
    const update = () => {
      if (!page.contents.isDestroyed()) {
        this.syncTabLifecycle(page);
        this.emit();
      }
    };
    page.contents.on("did-start-loading", update);
    page.contents.on("did-stop-loading", update);
    // Observe the person's final control without cancelling it or granting
    // page scripts access to any app command. The native input ledger excludes
    // automation; this message can only create a dismissible recording hint.
    const submitNoticeToken = `nestor-unbound-send-${randomUUID()}`;
    const installSubmitNotice = () => {
      if (page.contents.isDestroyed()) return;
      for (const frame of page.contents.mainFrame.framesInSubtree)
        void frame
          .executeJavaScript(
            `(() => {
        if (window.__nestorUnboundSendObserver) return;
        window.__nestorUnboundSendObserver = true;
        const isBound = () => window.__nestorPreparedApplication || sessionStorage.getItem('__nestorPreparedApplication');
        const finalControl = element => element && /(?:submit|send[-_\\s]*application|complete[-_\\s]*(?:the[-_\\s]*)?application|apply[-_\\s]*(?:now|job))/iu.test([element.textContent, element.getAttribute('aria-label'), element.value].filter(Boolean).join(' '));
        const note = element => { if (!isBound() && finalControl(element)) console.debug(${JSON.stringify(submitNoticeToken)}); };
        document.addEventListener('submit', event => { if (event.isTrusted) note(event.submitter); }, true);
        document.addEventListener('click', event => { if (event.isTrusted) note(event.target?.closest('button,input[type=submit],[role=button]')); }, true);
      })()`,
          )
          .catch(() => undefined);
    };
    page.contents.on("dom-ready", installSubmitNotice);
    page.contents.on("did-frame-finish-load", installSubmitNotice);
    page.contents.on("console-message", (details) => {
      if (details.message === submitNoticeToken) this.noteUnboundSend(page.id);
    });
    page.contents.on("page-title-updated", update);
    page.contents.on("did-navigate", update);
    page.contents.on("did-navigate-in-page", update);
    page.contents.on("will-navigate", (event, target) => {
      if (!isBrowserNavigationAllowed(target)) event.preventDefault();
    });
    page.contents.on("will-redirect", (event, target) => {
      if (!isBrowserNavigationAllowed(target)) event.preventDefault();
    });
    page.contents.on("will-frame-navigate", (event) => {
      if (
        event.url &&
        !isBrowserNavigationAllowed(event.url) &&
        event.url !== "about:srcdoc"
      )
        event.preventDefault();
    });
    page.contents.on(
      "did-fail-load",
      (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3 && !this.closing) {
          this.requestAttention({
            kind: "error",
            title: "This page couldn’t load",
            detail:
              "Check your connection or try reloading. You can enter another website above.",
          });
        }
      },
    );
    page.contents.on("render-process-gone", () => {
      if (!this.closing)
        this.requestAttention({
          kind: "error",
          title: "This browser tab stopped",
          detail:
            "Reload the page to continue. Your saved sign-ins are still kept.",
        });
    });
    // Agent input arrives over CDP and never moves the pointer. Pages also
    // take native focus on their own (a script focusing a field, a new tab),
    // so focus with the pointer merely resting over the view is not the user:
    // watching an application fill in must never end it. Only a real click or
    // keypress on the page is the user stepping in.
    // Then the agent stops and their input lands, without a control button.
    page.contents.on("input-event", (_event, input) => {
      if (input.type === "mouseDown") this.handleUserInput(page.id, "pointer");
    });
    page.contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const mainContents = this.window?.webContents;
      if (
        mainContents &&
        !mainContents.isDestroyed() &&
        routeMainWindowZoomShortcut(event, input, mainContents)
      ) {
        this.layout();
        return;
      }
      // Native input-event reports rawKeyDown; before-input-event supplies
      // the same key code that was recorded before an automation dispatch.
      this.handleUserInput(page.id, "key", {
        code: input.code,
        key: input.key,
      });
      const mod = process.platform === "darwin" ? input.meta : input.control;
      if (input.key === "Escape" && !input.isComposing) {
        event.preventDefault();
        this.presentation = "minimized";
        this.layout();
        this.emit();
      }
      if (mod && input.key.toLowerCase() === "w") {
        event.preventDefault();
        void this.command({ type: "close_tab", tabId: page.id });
      }
      if (mod && input.key.toLowerCase() === "l") {
        event.preventDefault();
        this.window?.webContents.focus();
        this.window?.webContents.send("browser:focus-address");
      }
    });
    // Return a WebContentsView directly: popups remain in this window and session.
    // No app-level CDP auto-attach pauses Electron's synchronous createWindow path.
    page.contents.setWindowOpenHandler((details) => {
      if (
        !isBrowserNavigationAllowed(details.url) ||
        !this.hasTabCapacity() ||
        this.closing
      )
        return { action: "deny" };
      return {
        action: "allow",
        createWindow: (options) => {
          const popup = this.createPage("about:blank", page.id, options);
          for (const claim of this.operationClaims.values())
            if (claim.tabs.has(page.id)) claim.tabs.add(popup.id);
          for (const tabs of this.ownedTabs.values())
            if (tabs.has(page.id)) tabs.add(popup.id);
          return popup.contents;
        },
      };
    });
    page.contents.once("destroyed", () => {
      const idleTimer = this.automationIdleTimers.get(page.id);
      if (idleTimer) clearTimeout(idleTimer);
      this.automationIdleTimers.delete(page.id);
      this.automationCommands.delete(page.id);
      this.tabLifecycle.forget(page.contents.id);
      this.applicationTabLabels.delete(page.id);
      this.pageMap.delete(page.id);
      this.finishedTabs.delete(page.id);
      this.releasedOwnedTabs.delete(page.id);
      for (const [owner, tabs] of this.ownedTabs) {
        tabs.delete(page.id);
        if (tabs.size === 0) {
          this.ownedTabs.delete(owner);
          this.preparedForms.delete(owner);
          this.applicationTabsClosed?.(owner);
        }
      }
      this.agentPresses.forget(page.id);
      this.personInputTabs.delete(page.id);
      this.personInputAt.delete(page.id);
      this.parkedTabs.delete(page.id);
      this.heldTabs.delete(page.id);
      this.personTabs.delete(page.id);
      this.lentTabs.delete(page.id);
      for (const claim of this.operationClaims.values())
        claim.tabs.delete(page.id);
      if (this.activeTabId === page.id)
        this.activeTabId = [...this.pageMap.keys()].at(-1) ?? null;
      const holder = page.host === "backstage" ? this.backstage : this.window;
      if (holder && !holder.isDestroyed())
        holder.contentView.removeChildView(view);
      this.layout();
      this.emit();
    });
    this.layout();
    // Attaching Debugger inside Electron's synchronous popup factory deadlocks
    // the opener. Wait until createWindow has returned before attaching a popup.
    if (openerId)
      setImmediate(() => {
        if (!page.contents.isDestroyed())
          for (const listener of this.pageListeners) listener(page);
      });
    else for (const listener of this.pageListeners) listener(page);
    this.emit();
    if (!openerId) {
      void page.contents.loadURL(destination).catch(() => undefined);
    }
    return page;
  }

  private selectPage(id: string): void {
    if (!this.pageMap.has(id)) return;
    this.activeTabId = id;
    this.layout();
    this.emit();
  }
  private closePage(id: string): void {
    const page = this.pageMap.get(id);
    if (!page || page.contents.isDestroyed()) return;
    page.contents.close({ waitForBeforeUnload: false });
  }

  /**
   * Automation asked to close a tab. A tab the person holds or a parked tab
   * is never closed under them: it is taken away from automation instead,
   * which is all the run needed.
   */
  private closePageForAutomation(id: string): void {
    if (
      this.heldTabs.has(id) ||
      this.parkedTabs.has(id) ||
      this.personTabs.has(id)
    ) {
      this.bridge?.releasePage(id);
      return;
    }
    this.closePage(id);
  }

  /**
   * Close one workflow handoff tab without taking control or aborting any
   * automation that owns another tab in the shared browser host.
   */
  closeParkedTab(id: string): void {
    this.closePage(id);
  }

  /**
   * A still of the active page for the renderer to show while its own chrome
   * (a menu, the import picker) needs to sit where the native view paints.
   */
  async captureActivePage(): Promise<DesktopBrowserSnapshot> {
    const page = this.activeTabId
      ? this.pageMap.get(this.activeTabId)
      : undefined;
    if (
      !page ||
      page.contents.isDestroyed() ||
      page.contents.getURL() === "about:blank" ||
      !this.viewport.visible
    )
      return { dataUrl: null };
    try {
      await this.noteAutomationCommand(page.id, true, false);
      const image = await page.contents.capturePage();
      if (image.isEmpty()) return { dataUrl: null };
      return {
        dataUrl: `data:image/jpeg;base64,${image.toJPEG(82).toString("base64")}`,
      };
    } catch {
      return { dataUrl: null };
    } finally {
      await this.noteAutomationCommand(page.id, false, false);
      this.syncTabLifecycle(page);
    }
  }

  setViewport(viewport: DesktopBrowserViewport): void {
    this.viewport = { ...viewport };
    this.layout();
  }
  private layout(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const zoom = this.window.webContents.getZoomFactor();
    const [windowWidth = 1, windowHeight = 1] = this.window.getContentSize();
    const x = Math.max(
      0,
      Math.min(windowWidth, Math.round(this.viewport.x * zoom)),
    );
    const y = Math.max(
      0,
      Math.min(windowHeight, Math.round(this.viewport.y * zoom)),
    );
    const width = Math.max(
      1,
      Math.min(windowWidth - x, Math.round(this.viewport.width * zoom)),
    );
    const height = Math.max(
      1,
      Math.min(windowHeight - y, Math.round(this.viewport.height * zoom)),
    );
    const viewport = { x, y, width, height };
    if (isUsableViewRect(viewport)) this.lastUsableViewport = viewport;
    const last = this.lastUsableViewport;
    const backstage =
      this.backstage && !this.backstage.isDestroyed() ? this.backstage : null;
    if (backstage) {
      const [backstageWidth = 0, backstageHeight = 0] =
        backstage.getContentSize();
      const size = resolvePageViewBounds({
        viewport,
        current: { x: 0, y: 0, width: backstageWidth, height: backstageHeight },
        lastUsable: last,
      });
      if (size) backstage.setContentSize(size.width, size.height);
    }
    for (const page of this.pageMap.values()) {
      if (page.contents.isDestroyed()) continue;
      if (page.host === "backstage") {
        // Same size as the on-screen viewport so layout and screenshots match
        // what the user would see; always visible, the window itself is not.
        const bounds = resolvePageViewBounds({
          viewport: { ...viewport, x: 0, y: 0 },
          current: page.view.getBounds(),
          lastUsable: { ...last, x: 0, y: 0 },
        });
        if (bounds) page.view.setBounds(bounds);
        page.view.setVisible(true);
        page.contents.setBackgroundThrottling(this.shouldThrottleTab(page.id));
        this.syncTabLifecycle(page);
        continue;
      }
      // Minimize preserves the last usable viewport; never resize a live page
      // to 0. A tab opened while minimized gets that size too: a hidden page
      // at 0×0 lays out nothing the agent can click.
      const bounds = resolvePageViewBounds({
        viewport,
        current: page.view.getBounds(),
        lastUsable: last,
      });
      if (bounds) page.view.setBounds(bounds);
      page.view.setVisible(
        !this.closed &&
          !this.closing &&
          this.presentation !== "minimized" &&
          this.viewport.visible &&
          this.activeTabId === page.id,
      );
      // Native view visibility can hide a newly created render widget after
      // its preferences were applied. Reassert the active-run rendering policy
      // after visibility changes so background tabs keep animation frames.
      page.contents.setBackgroundThrottling(this.shouldThrottleTab(page.id));
      this.syncTabLifecycle(page);
    }
  }

  private disconnectAutomation(): void {
    this.connectionGeneration += 1;
    this.bridge?.close();
    this.bridge = null;
    this.connection = null;
  }
  private abortOperations(): void {
    for (const controller of this.operations.keys())
      controller.abort(
        new DOMException(
          "Stopped because you stepped into the browser or closed it. Press Try again when you are ready.",
          "AbortError",
        ),
      );
    this.disconnectAutomation();
  }

  private describeOperations(): Array<{ id: string; tabIds: string[] }> {
    return [...this.operations.keys()].map((controller) => {
      const claim = this.operationClaims.get(controller);
      return { id: claim?.id ?? "", tabIds: claim ? [...claim.tabs] : [] };
    });
  }

  /**
   * The person stepped into one tab. Exactly the runs working there stop,
   * the tab stays open and is taken away from automation until it is handed
   * back, and every other run keeps its tabs and its connection.
   */
  /**
   * A tab handed to the person is theirs to finish: the prepare-only guard a
   * run left in the page must not cancel their own "Save and continue" or
   * send (ADR 0024, ADR 0033). The run is detached from the tab, so the guard
   * is opened here, in every frame (an embedded ATS form has its own).
   */
  private openTabForPerson(tabId: string): void {
    const page = this.pageMap.get(tabId);
    if (!page || page.contents.isDestroyed()) return;
    for (const frame of page.contents.mainFrame.framesInSubtree) {
      void frame
        .executeJavaScript(OPEN_PREPARE_ONLY_GUARD_FOR_PERSON)
        .catch(() => undefined);
    }
  }

  private async closeTabForAutomation(tabId: string): Promise<void> {
    this.personInputTabs.delete(tabId);
    this.personInputAt.delete(tabId);
    const page = this.pageMap.get(tabId);
    if (!page || page.contents.isDestroyed()) return;
    await Promise.all(
      page.contents.mainFrame.framesInSubtree.map((frame) =>
        frame
          .executeJavaScript(
            `(() => {
              const state = window.__nestorPrepareOnlyMutationGuardV1;
              if (state) {
                state.finalActionAllowed = false;
                state.authorizedFormActionWindow = null;
              }
            })()`,
          )
          .catch(() => undefined),
      ),
    );
  }

  private takeTab(tabId: string, operationIds: readonly string[]): void {
    const stopping = [...this.operationClaims.entries()].filter(([, claim]) =>
      operationIds.includes(claim.id),
    );
    const owners = stopping
      .map(([, claim]) => claim.owner)
      .filter((owner): owner is string => Boolean(owner));
    this.heldTabs.set(tabId, [...(this.heldTabs.get(tabId) ?? []), ...owners]);
    // Release before aborting: a stopped run closes its page on the way out,
    // and that close must find the page already gone from automation.
    this.bridge?.releasePage(tabId);
    this.openTabForPerson(tabId);
    for (const [controller] of stopping)
      controller.abort(
        new DOMException(STEPPED_IN_ABORT_MESSAGE, "AbortError"),
      );
    this.emit();
  }

  /**
   * Lends one tab to the assistant (ADR 0038). A tab another run is working
   * in is refused; a tab the person opened becomes reachable by automation
   * for the length of the loan only.
   */
  async lendTab(tabId: string): Promise<void> {
    const page = this.pageMap.get(tabId);
    if (!page || page.contents.isDestroyed())
      throw new Error("That browser tab is closed.");
    if (this.lentTabs.has(tabId))
      throw new Error(
        "The assistant is already working in this tab. Wait for the turn to finish.",
      );
    const busy = [...this.operationClaims.values()].some(
      (claim) =>
        claim.tabs.has(tabId) && !(claim.owner ?? "").startsWith("assistant:"),
    );
    if (busy)
      throw new Error(
        "A search or an application is working in that tab. Use another tab or wait for it to finish.",
      );
    await this.closeTabForAutomation(tabId);
    this.lentTabs.add(tabId);
    if (this.bridge) await this.bridge.reclaimPage(page);
  }

  /** Ends a loan; a tab that belongs to the person leaves automation again. */
  endLoan(tabId: string): void {
    if (!this.lentTabs.delete(tabId)) return;
    if (
      this.heldTabs.has(tabId) ||
      this.parkedTabs.has(tabId) ||
      this.personTabs.has(tabId)
    ) {
      this.bridge?.releasePage(tabId);
      this.openTabForPerson(tabId);
    }
  }

  getApplicationTabIds(owner: string): string[] {
    return [...(this.ownedTabs.get(owner) ?? [])].filter((id) => {
      const page = this.pageMap.get(id);
      return page && !page.contents.isDestroyed();
    });
  }

  isApplicationPageLent(owner: string): boolean {
    return [...(this.ownedTabs.get(owner) ?? [])].some((tabId) =>
      this.lentTabs.has(tabId),
    );
  }

  isTabLent(tabId: string): boolean {
    return this.lentTabs.has(tabId);
  }

  /** Stops the assistant work in a lent tab and ends the loan. */
  revokeLoan(tabId: string, reason: string): void {
    for (const [controller, claim] of this.operationClaims) {
      if (claim.tabs.has(tabId) && (claim.owner ?? "").startsWith("assistant:"))
        controller.abort(new DOMException(reason, "AbortError"));
    }
    this.endLoan(tabId);
    this.emit();
  }

  /** Which tab an automation page is, told by the connection itself. */
  async identifyAutomationPage(page: {
    evaluate: (
      fn: (token: string) => string,
      token: string,
    ) => Promise<unknown>;
  }): Promise<string | null> {
    const bridge = this.bridge;
    if (!bridge) return null;
    const token = `nestor-identify-${randomUUID()}`;
    const landed = bridge.waitForToken(token, 3_000);
    void page.evaluate((value) => value, token).catch(() => undefined);
    return landed;
  }

  async getOpenBrowser(): Promise<Browser | null> {
    if (this.pageMap.size === 0 || this.closing) return null;
    return this.connectInternal(true);
  }

  async connect(): Promise<Browser> {
    return this.connectInternal(false);
  }

  private async connectInternal(observationOnly: boolean): Promise<Browser> {
    if ((!observationOnly && this.automationRefused()) || this.closing)
      throw new Error(
        "Browser activity is paused. Resume it from the browser toolbar.",
      );
    if (this.connection) return this.connection;
    const generation = this.connectionGeneration;
    const creation = (async () => {
      if (this.pageMap.size === 0)
        this.automationPlaceholderTabId = this.createPage("about:blank").id;
      const bridge = new BrowserCdpBridge({
        // Tabs the person holds and parked tabs stay out of automation.
        pages: () =>
          [...this.pageMap.values()].filter(
            (page) =>
              this.lentTabs.has(page.id) ||
              (!this.heldTabs.has(page.id) &&
                !this.parkedTabs.has(page.id) &&
                !this.personTabs.has(page.id)),
          ),
        createPage: (url) =>
          Promise.resolve(
            this.createPage(
              url,
              undefined,
              undefined,
              undefined,
              undefined,
              false,
            ),
          ),
        closePage: (id) => this.closePageForAutomation(id),
        selectPage: (id) => this.selectPage(id),
        onPageCreated: (listener) => {
          this.pageListeners.add(listener);
          return () => this.pageListeners.delete(listener);
        },
        userAgent: () => this.getSession().getUserAgent(),
        emulateFocus: (pageId) =>
          Boolean(pageId && !this.shouldThrottleTab(pageId)) &&
          !this.automationRefused(),
        onAutomationInput: (pageId, input) => {
          if (input?.pointerDown) this.agentPresses.notePress(pageId);
          if (input?.keyDown) this.agentPresses.noteKey(pageId, input.keyDown);
        },
        onAutomationCommand: (pageId, active) =>
          this.noteAutomationCommand(pageId, active),
      });
      this.bridge = bridge;
      const transport = await bridge.start();
      // Playwright loads here, on the first automation, not with the app.
      const { chromium } = await import("playwright");
      const browser = await chromium.connectOverCDP(transport.endpoint, {
        headers: transport.headers,
        noDefaults: true,
        timeout: 15_000,
      });
      if (
        generation !== this.connectionGeneration ||
        (!observationOnly && this.automationRefused()) ||
        this.closing
      ) {
        bridge.close();
        throw new Error("Browser activity was stopped while connecting.");
      }
      browser.once("disconnected", () => {
        if (this.bridge === bridge) this.disconnectAutomation();
      });
      return browser;
    })();
    this.connection = creation;
    void creation.catch(() => {
      if (this.connection === creation) this.disconnectAutomation();
    });
    return creation;
  }

  async runAutomation<T>(
    label: string,
    signal: AbortSignal | undefined,
    work: (
      signal: AbortSignal,
      updateActivity: (label: string) => void,
      claimPage: ClaimAutomationPage,
      claimedTabs: ClaimedAutomationTabs,
    ) => Promise<T>,
    options: AutomationRunOptions = {},
  ): Promise<T> {
    if (this.automationRefused())
      throw new Error(
        this.closedByPerson && !this.activityPaused
          ? "You closed the Job Finder browser, so background work waits. Start the search or application again when you are ready."
          : "Browser activity is paused. Resume it from the browser toolbar.",
      );
    signal?.throwIfAborted();
    const controller = new AbortController();
    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    this.operations.set(controller, label);
    const claim = {
      id: randomUUID(),
      owner: options.owner ?? null,
      tabs: new Set<string>(),
    };
    this.operationClaims.set(controller, claim);
    const pendingClaims = new Set<Promise<void>>();
    const claimPage: ClaimAutomationPage = (page) => {
      const bridge = this.bridge;
      if (!bridge || !this.operations.has(controller)) return;
      const token = `nestor-claim-${randomUUID()}`;
      const landed = bridge
        .waitForToken(token, 5_000, combined)
        .then((tabId) => {
          if (tabId && this.operations.has(controller)) {
            claim.tabs.add(tabId);
            if (claim.owner) {
              const tabs = this.ownedTabs.get(claim.owner) ?? new Set<string>();
              tabs.add(tabId);
              this.ownedTabs.set(claim.owner, tabs);
            }
            this.finishedTabs.delete(tabId);
            const claimedPage = this.pageMap.get(tabId);
            if (claimedPage && !claimedPage.contents.isDestroyed())
              claimedPage.contents.setBackgroundThrottling(false);
            if (claimedPage)
              void this.tabLifecycle
                .setFrozen(claimedPage.contents, false)
                .catch(() => undefined);
          }
        })
        .catch(() => undefined)
        .finally(() => pendingClaims.delete(landed));
      pendingClaims.add(landed);
      void page.evaluate((value) => value, token).catch(() => undefined);
    };
    const claimedTabs: ClaimedAutomationTabs = async () => {
      await Promise.all([...pendingClaims]);
      return [...claim.tabs];
    };
    this.attention = null;
    this.attentionTabId = null;
    this.closed = false;
    this.releasePending = false;
    for (const page of this.pageMap.values())
      if (!page.contents.isDestroyed())
        page.contents.setBackgroundThrottling(this.shouldThrottleTab(page.id));
    this.focusApp();
    this.hostPages();
    this.emit();
    const updateActivity = (nextLabel: string): void => {
      if (!this.operations.has(controller)) return;
      this.operations.set(controller, nextLabel.slice(0, 200));
      this.emit();
    };
    try {
      await this.bridge?.syncFocusEmulation();
      combined.throwIfAborted();
      return await work(combined, updateActivity, claimPage, claimedTabs);
    } catch (error) {
      combined.throwIfAborted();
      throw error;
    } finally {
      if (options.cleanupOnFinish) this.markFinishedTabs(await claimedTabs());
      this.operations.delete(controller);
      this.operationClaims.delete(controller);
      // Finished tabs can only close after this operation releases its claim.
      // Also retry tabs marked finished by the work before it returned.
      this.closeIdleFinishedTabs({ keepActive: true });
      this.closeReleasedOwnedTabs();
      for (const page of this.pageMap.values()) {
        if (!page.contents.isDestroyed())
          page.contents.setBackgroundThrottling(
            this.shouldThrottleTab(page.id),
          );
        this.syncTabLifecycle(page);
      }
      void this.reduceWaitingFormMemory().catch(() => undefined);
      if (this.operations.size === 0)
        await this.bridge?.syncFocusEmulation().catch(() => undefined);
      this.emit();
    }
  }

  async command(command: DesktopBrowserCommand): Promise<DesktopBrowserState> {
    if (command.type === "close") {
      await this.close(true);
      return this.getState();
    }
    if (this.closing) return this.getState();
    if (command.type === "open") {
      this.closed = false;
      this.presentation = "peek";
      if (command.url) {
        const requestedUrl = command.url;
        const existingPage = [...this.pageMap.values()].find(
          (page) =>
            !page.contents.isDestroyed() &&
            isSameBrowserNavigation(page.contents.getURL(), requestedUrl),
        );
        if (existingPage) this.selectPage(existingPage.id);
        else this.createPage(requestedUrl);
      }
    } else if (command.type === "minimize") {
      this.presentation = "minimized";
      if (
        this.releasePending &&
        this.operations.size === 0 &&
        !this.isPausedForPerson() &&
        !this.visibleAttention() &&
        this.parkedTabs.size === 0 &&
        this.personTabs.size === 0
      ) {
        this.layout();
        await this.close(false);
        return this.getState();
      }
    } else if (command.type === "expand")
      this.presentation = command.expanded ? "expanded" : "peek";
    else if (command.type === "take_control") {
      if (this.activeTabId) this.takeTabByPerson(this.activeTabId, true);
    } else if (command.type === "resume") {
      await this.handoverPromise;
      await this.closePromise;
      await this.activityHooks?.resume();
      const handedBack = [...this.heldTabs.entries()];
      this.heldTabs.clear();
      for (const [tabId] of handedBack) {
        const page = this.pageMap.get(tabId);
        await this.closeTabForAutomation(tabId);
        if (page && this.bridge) await this.bridge.reclaimPage(page);
      }
      this.closedByPerson = false;
      this.attention = null;
      this.attentionTabId = null;
      for (const tabId of this.parkedTabs.keys())
        this.parkedTabs.set(tabId, null);
      this.focusApp();
      const owners = handedBack.flatMap(([, tabOwners]) => tabOwners);
      if (owners.length > 0 && this.activityHooks?.handback)
        void this.activityHooks.handback(owners).catch(() => undefined);
    } else if (command.type === "select_tab") this.selectPage(command.tabId);
    else if (command.type === "close_finished_tabs") this.closeFinishedTabs();
    else if (command.type === "new_tab") this.openPersonTab("about:blank");
    else if (command.type === "close_tab") {
      this.takeTabByPerson(command.tabId, false, true);
      this.closePage(command.tabId);
      if (this.pageMap.size === 0) await this.close(false);
    } else {
      if (this.activeTabId) this.takeTabByPerson(this.activeTabId, false);
      const page = this.activeTabId
        ? this.pageMap.get(this.activeTabId)
        : undefined;
      if (this.attentionTabId === this.activeTabId) {
        this.attention = null;
        this.attentionTabId = null;
      }
      if (command.type === "navigate") {
        // Typed input follows browser rules: an address opens, anything else
        // becomes a search. Agent and app navigation ("open") stays strict.
        const url = normalizeBrowserNavigation(
          resolveBrowserAddress(command.url)?.url ?? command.url,
        );
        if (!page) this.openPersonTab(url);
        else void page.contents.loadURL(url).catch(() => undefined);
      }
      if (page && !page.contents.isDestroyed()) {
        if (
          command.type === "back" &&
          page.contents.navigationHistory.canGoBack()
        )
          page.contents.navigationHistory.goBack();
        if (
          command.type === "forward" &&
          page.contents.navigationHistory.canGoForward()
        )
          page.contents.navigationHistory.goForward();
        if (command.type === "reload") page.contents.reload();
        if (command.type === "stop") page.contents.stop();
      }
    }
    this.layout();
    this.emit();
    return this.getState();
  }

  /** A tab the person opens is theirs: no run reuses, navigates or closes it. */
  private openPersonTab(url: string): void {
    const page = this.createPage(url, undefined, undefined, (id) =>
      this.personTabs.add(id),
    );
    this.bridge?.releasePage(page.id);
  }

  /**
   * A toolbar action on one tab (navigate, reload, close, take control)
   * during automation is the person stepping into that tab: the runs working
   * there stop, as they would for a click on the page.
   */
  private takeTabByPerson(
    tabId: string,
    holdEvenIfIdle: boolean,
    claimedOnly = false,
  ): void {
    if (this.heldTabs.has(tabId) || !this.pageMap.has(tabId)) return;
    const action = getEmbeddedBrowserFocusAction({
      focusedTabId: tabId,
      operations: this.describeOperations(),
      closingTab: claimedOnly,
      parked: this.parkedTabs.has(tabId),
      held: false,
      bannerOnTab: false,
      handoverPending: false,
    });
    if (action.type === "take_tab") this.takeTab(tabId, action.operationIds);
    else if (holdEvenIfIdle && !this.parkedTabs.has(tabId))
      this.takeTab(tabId, []);
  }

  /**
   * Stops everything the browser runs (importing sign-ins from another
   * browser). Background work waits until the person's next deliberate
   * start or Resume.
   */
  takeControl(): Promise<void> {
    return this.stopEverythingForClose();
  }

  /** Close from the browser menu: everything the browser runs stops. */
  private async stopEverythingForClose(): Promise<void> {
    if (this.handoverPromise) return this.handoverPromise;
    this.closedByPerson = true;
    this.abortOperations();
    const handover = Promise.resolve().finally(() => {
      this.handoverPromise = null;
      this.emit();
    });
    this.handoverPromise = handover;
    this.emit();
    return handover;
  }

  /** The page is on screen and the pointer is over it. */
  private isPointerOverPage(page: BrowserPage): boolean {
    if (
      page.host === "backstage" ||
      !this.window ||
      this.window.isDestroyed() ||
      this.presentation === "minimized" ||
      !this.viewport.visible ||
      this.activeTabId !== page.id ||
      page.contents.isDestroyed() ||
      Date.now() - page.createdAt < 1500
    )
      return false;
    const content = this.window.getContentBounds();
    const bounds = page.view.getBounds();
    const cursor = screen.getCursorScreenPoint();
    return (
      cursor.x >= content.x + bounds.x &&
      cursor.x <= content.x + bounds.x + bounds.width &&
      cursor.y >= content.y + bounds.y &&
      cursor.y <= content.y + bounds.y + bounds.height
    );
  }

  /**
   * When automation starts on a page the user was typing into, move keyboard
   * focus back to the app so their keystrokes stop landing in that page.
   *
   * Only while this window is already the focused window. On macOS and Linux
   * `webContents.focus()` also focuses the owning window, which activates the
   * app: a scheduled source check would pull the user out of whatever
   * full-screen app they were in. When the window is in the background there
   * is nothing to protect, so nothing is done.
   */
  private focusApp(): void {
    if (
      this.window &&
      !this.window.isDestroyed() &&
      this.window.isFocused() &&
      [...this.pageMap.values()].some(
        (page) => !page.contents.isDestroyed() && page.contents.isFocused(),
      )
    )
      this.window.webContents.focus();
  }

  async releaseAutomationSession(): Promise<void> {
    // Workflow finally-blocks must not close a page handed to the user, nor
    // wait on Close while Close is waiting for those same workflows to settle.
    if (this.isPausedForPerson() || this.closing) return;
    // Another run (a search finishing seconds after an apply started) still
    // owns this browser; closing it now would abort that run as if the
    // person had stepped in. The last run to finish releases the browser.
    if (this.operations.size > 0) return;
    // A run that ends while the user is watching leaves its pages on screen,
    // and a run that stopped because it needs the user (sign-in, a challenge)
    // keeps the page it stopped on. Both are released on Close, or when the
    // panel is minimized with nothing left for the user to do.
    if (
      this.visibleAttention() ||
      this.parkedTabs.size > 0 ||
      // A tab the person opened stays until they close it.
      this.personTabs.size > 0 ||
      (this.presentation !== "minimized" && this.viewport.visible)
    ) {
      this.releasePending = true;
      this.emit();
      return;
    }
    await this.close(false);
  }

  async close(pauseActivity: boolean): Promise<void> {
    if (this.closePromise) {
      const pending = this.closePromise;
      if (pauseActivity) await this.stopEverythingForClose();
      return pending;
    }
    this.closing = true;
    this.applicationTabsClosed?.(null);
    this.releasePending = false;
    if (pauseActivity && this.operations.size > 0) this.closedByPerson = true;
    this.abortOperations();
    this.presentation = "minimized";
    this.viewport.visible = false;
    this.emit();
    const closing = (async () => {
      for (const id of [...this.pageMap.keys()]) this.closePage(id);
      this.pageMap.clear();
      this.activeTabId = null;
      this.automationPlaceholderTabId = null;
      if (this.browserSession) {
        await this.browserSession.cookies.flushStore();
        // Workers must not outlive Close; cookies and site sign-in storage remain.
        await this.browserSession.clearStorageData({
          storages: ["serviceworkers", "cachestorage"],
        });
        await this.browserSession.closeAllConnections();
      }
    })().finally(() => {
      this.closed = true;
      this.closing = false;
      this.attention = null;
      this.attentionTabId = null;
      this.parkedTabs.clear();
      this.heldTabs.clear();
      this.ownedTabs.clear();
      this.preparedForms.clear();
      this.discardedFormLabels.clear();
      this.releasedOwnedTabs.clear();
      this.closePromise = null;
      this.emit();
    });
    this.closePromise = closing;
    if (pauseActivity) await this.stopEverythingForClose();
    return closing;
  }
}

function clampAttention(
  attention: DesktopBrowserAttention,
): DesktopBrowserAttention {
  // The banner shows a run's own sentence, which can run long. The state
  // schema caps it; an over-long sentence used to make the state read throw,
  // which failed the apply call that had just finished the form.
  const clamp = (text: string, max: number): string =>
    text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
  return {
    ...attention,
    title: clamp(attention.title, 160),
    detail: clamp(attention.detail, 500),
  };
}

let browser: EmbeddedBrowser | null = null;
export function getEmbeddedBrowser(): EmbeddedBrowser {
  return (browser ??= new EmbeddedBrowser());
}
