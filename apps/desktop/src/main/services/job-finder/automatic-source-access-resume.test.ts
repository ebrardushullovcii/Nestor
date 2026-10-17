import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopBrowserState,
  UserActionRequest,
} from "@nestor/contracts";
import { installAutomaticSourceAccessResume } from "./automatic-source-access-resume";

const origin = "http://127.0.0.1:47950/";
const request = {
  id: "discovery_access_fixture",
  revision: 2,
  state: "page_opened",
  scope: {
    type: "discovery_source",
    source: "target_site",
    parkedTab: { tabId: "parked_tab", url: origin, title: "Sign in" },
  },
  verification: { type: "source_access", expectedOrigin: origin },
} as UserActionRequest;

function browserState(
  overrides: Partial<DesktopBrowserState> = {},
): DesktopBrowserState {
  return {
    revision: 1,
    phase: "needs_you",
    presentation: "peek",
    activeTabId: "parked_tab",
    activity: null,
    attention: {
      kind: "sign_in",
      title: "Sign in",
      detail: "Sign in to continue",
    },
    automationPaused: false,
    tabs: [
      {
        id: "parked_tab",
        title: "Sign in",
        url: `${origin}authboard/`,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
    ...overrides,
  };
}

function setup(requests: UserActionRequest[] = [request]) {
  let state = browserState();
  let listener: ((state: DesktopBrowserState) => void) | null = null;
  let paused = false;
  const inspectSourceAccess = vi.fn().mockResolvedValue({
    state: "authenticated",
    currentOrigin: origin,
    signals: ["sign_out_control"],
  });
  const performUserAction = vi.fn().mockResolvedValue(undefined);
  const input = {
    browser: {
      getState: () => state,
      onStateChanged: (next: (state: DesktopBrowserState) => void) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    browserRuntime: { inspectSourceAccess },
    repository: {
      getActivityControl: () => Promise.resolve({ paused }),
      listUserActionRequests: (query?: { states?: string[] }) =>
        Promise.resolve(
          requests.filter(
            (candidate) =>
              !query?.states || query.states.includes(candidate.state),
          ),
        ),
    },
    performUserAction,
    delayMs: 10,
  } as unknown as Parameters<typeof installAutomaticSourceAccessResume>[0];
  const dispose = installAutomaticSourceAccessResume(input);
  return {
    emit(next: DesktopBrowserState) {
      state = next;
      listener?.(next);
    },
    setPaused(value: boolean) {
      paused = value;
    },
    inspectSourceAccess,
    performUserAction,
    dispose,
  };
}

afterEach(() => vi.useRealTimers());

describe("automatic source access resume", () => {
  it("resumes the exact parked request after a person's sign-in, although their first click cleared the banner", async () => {
    vi.useFakeTimers();
    const flow = setup();
    // The person's first click in the parked tab dismisses the banner: the
    // browser reads "ready" with no attention from here on.
    const afterClick = { phase: "ready" as const, attention: null };
    flow.emit(browserState({ revision: 2, ...afterClick })); // Focus/typing alone changes no page signature.
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).not.toHaveBeenCalled();

    flow.emit(
      browserState({
        revision: 3,
        ...afterClick,
        tabs: [{ ...browserState().tabs[0]!, loading: true }],
      }),
    );
    flow.emit(
      browserState({
        revision: 4,
        ...afterClick,
        tabs: [{ ...browserState().tabs[0]!, title: "Signed-in jobs" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).toHaveBeenCalledWith("target_site", {
      expectedOrigin: origin,
      tabId: "parked_tab",
    });
    expect(flow.performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirm_done",
        requestId: request.id,
        expectedRevision: 2,
        submitAuthorized: false,
      }),
    );
    flow.dispose();
  });

  it("keeps the card while activity is paused, and reads only the parked tab when another tab shares its site", async () => {
    vi.useFakeTimers();
    const flow = setup();
    flow.setPaused(true);
    flow.emit(
      browserState({
        tabs: [{ ...browserState().tabs[0]!, title: "Signed-in jobs" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).not.toHaveBeenCalled();
    flow.setPaused(false);
    flow.emit(
      browserState({
        activeTabId: "other_tab",
        tabs: [
          { ...browserState().tabs[0]!, title: "Signed-in jobs 2" },
          { ...browserState().tabs[0]!, id: "other_tab" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).toHaveBeenCalledTimes(1);
    expect(flow.inspectSourceAccess).toHaveBeenCalledWith("target_site", {
      expectedOrigin: origin,
      tabId: "parked_tab",
    });
    expect(flow.performUserAction).toHaveBeenCalledOnce();
    flow.dispose();
  });

  it("does not resume when the parked tab moves on during a slow probe", async () => {
    vi.useFakeTimers();
    const flow = setup();
    let finishProbe: ((value: unknown) => void) | undefined;
    flow.inspectSourceAccess.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = resolve;
        }),
    );
    flow.emit(
      browserState({
        tabs: [{ ...browserState().tabs[0]!, title: "Signed-in jobs" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).toHaveBeenCalledOnce();

    flow.emit(
      browserState({
        tabs: [
          {
            ...browserState().tabs[0]!,
            title: "Signed out",
            url: `${origin}authboard/signout`,
          },
        ],
      }),
    );
    finishProbe?.({
      state: "authenticated",
      currentOrigin: origin,
      signals: ["sign_out_control"],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flow.performUserAction).not.toHaveBeenCalled();
    flow.dispose();
  });
  it("watches a step whose parked tab is gone through the only tab on its site", async () => {
    vi.useFakeTimers();
    // The restart closed the parked tab; the person opened the site again
    // in a tab of their own and signed in there.
    const unbound = {
      ...request,
      scope: {
        ...request.scope,
        parkedTab: { tabId: null, url: origin, title: null },
      },
    } as UserActionRequest;
    const flow = setup([unbound]);
    const personTab = { ...browserState().tabs[0]!, id: "person_tab" };
    flow.emit(browserState({ activeTabId: "person_tab", tabs: [personTab] }));
    flow.emit(
      browserState({
        activeTabId: "person_tab",
        tabs: [{ ...personTab, title: "Signed-in jobs" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).toHaveBeenCalledWith("target_site", {
      expectedOrigin: origin,
      tabId: "person_tab",
    });
    expect(flow.performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "confirm_done", requestId: request.id }),
    );

    // Two tabs on the site: neither is guessed.
    flow.inspectSourceAccess.mockClear();
    flow.emit(
      browserState({
        tabs: [
          { ...personTab, title: "Signed-in jobs 2" },
          { ...personTab, id: "second_tab", title: "Other" },
        ],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.inspectSourceAccess).not.toHaveBeenCalled();
    flow.dispose();
  });
  it("still carries on a step an earlier check left still blocked", async () => {
    vi.useFakeTimers();
    const flow = setup([{ ...request, state: "still_blocked" } as UserActionRequest]);
    flow.emit(
      browserState({
        tabs: [{ ...browserState().tabs[0]!, title: "Signed-in jobs" }],
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    expect(flow.performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "confirm_done", requestId: request.id }),
    );
    flow.dispose();
  });
});
