import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  DesktopBrowserState,
  RawApplyPage,
  UserActionRequest,
} from "@nestor/contracts";
import { installAutomaticApplicationAccessResume } from "./automatic-application-access-resume";

const request = {
  id: "application_login",
  kind: "login",
  revision: 3,
  state: "page_opened",
  scope: {
    type: "application",
    source: "target_site",
    jobId: "job_1",
    runId: "run_1",
    resultId: "result_1",
  },
  verification: {
    type: "source_access",
    expectedOrigin: "http://127.0.0.1:47950",
  },
} as unknown as UserActionRequest;

const control: RawApplyPage["controls"][number] = {
  index: 0,
  tagName: "input",
  inputType: "text",
  role: "textbox",
  id: "name",
  name: "name",
  label: "Full name",
  groupLabel: "",
  placeholder: "",
  autocomplete: "",
  required: true,
  invalid: false,
  validationMessage: "",
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  checked: false,
  multiple: false,
  options: [],
  selectedOptionLabel: "",
};

function page(signedIn: boolean): RawApplyPage {
  return {
    url: signedIn
      ? "http://127.0.0.1:47950/workday/apply/1/step/1"
      : "http://127.0.0.1:47950/workday/account/signin/1",
    title: signedIn ? "My Information" : "Sign in",
    bodyText: signedIn ? "My Information" : "Sign in to apply",
    headings: [],
    controls: signedIn
      ? [control]
      : [
          { ...control, label: "Email", inputType: "email" },
          { ...control, index: 1, label: "Password", inputType: "password" },
        ],
    actions: [
      {
        index: 0,
        label: signedIn ? "Save and Continue" : "Sign in",
        visible: true,
        disabled: false,
      },
    ],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    stepLabel: null,
    loading: false,
  };
}

function state(url: string): DesktopBrowserState {
  return {
    revision: 1,
    // A person's first click clears attention; the watcher must not need it.
    phase: "idle",
    presentation: "peek",
    activeTabId: "tab_1",
    activity: null,
    attention: null,
    automationPaused: false,
    tabs: [
      {
        id: "tab_1",
        title: "Page",
        url,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
      {
        // Another tab on the same origin must not matter.
        id: "tab_2",
        title: "Other",
        url: "http://127.0.0.1:47950/lever/",
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    ],
  } as unknown as DesktopBrowserState;
}

function setup(options: {
  signedIn: boolean;
  requests?: UserActionRequest[];
  afterCheck?: () => Promise<void>;
}) {
  let signedIn = options.signedIn;
  let paused = false;
  let requests = options.requests ?? [request];
  let listener: ((state: DesktopBrowserState) => void) | null = null;
  const readApplicationPageBinding = vi.fn(() =>
    Promise.resolve(page(signedIn)),
  );
  const performUserAction = vi.fn(() => Promise.resolve(undefined));
  const dispose = installAutomaticApplicationAccessResume({
    browser: {
      onStateChanged: (next) => {
        listener = next;
        return () => {
          listener = null;
        };
      },
    },
    browserRuntime: { readApplicationPageBinding },
    repository: {
      getActivityControl: () => Promise.resolve({ paused }),
      listUserActionRequests: () => Promise.resolve(requests),
      getUserActionRequest: (id: string) =>
        Promise.resolve(
          requests.find((candidate) => candidate.id === id) ?? null,
        ),
    } as never,
    performUserAction,
    ...(options.afterCheck ? { afterCheck: options.afterCheck } : {}),
    delayMs: 5,
    pollMs: 20,
  });
  return {
    dispose,
    performUserAction,
    readApplicationPageBinding,
    signIn() {
      signedIn = true;
    },
    pause(value: boolean) {
      paused = value;
    },
    setRequests(next: UserActionRequest[]) {
      requests = next;
    },
    navigate(url: string) {
      listener?.(state(url));
    },
  };
}

async function waitFor(predicate: () => boolean, ms = 500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > ms) throw new Error("Timed out waiting.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("installAutomaticApplicationAccessResume", () => {
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
  });

  it("carries on once the kept page's sign-in wall is gone, with no press", async () => {
    const watcher = setup({ signedIn: false });
    disposers.push(watcher.dispose);
    watcher.navigate("http://127.0.0.1:47950/workday/account/signin/1");
    await waitFor(
      () => watcher.readApplicationPageBinding.mock.calls.length > 0,
    );
    expect(watcher.performUserAction).not.toHaveBeenCalled();

    watcher.signIn();
    watcher.navigate("http://127.0.0.1:47950/workday/apply/1/step/1");
    await waitFor(() => watcher.performUserAction.mock.calls.length > 0);
    expect(watcher.performUserAction).toHaveBeenCalledTimes(1);
    expect(watcher.performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirm_done",
        requestId: "application_login",
        expectedRevision: 3,
        commandId: "auto_application_access_application_login_r3",
        submitAuthorized: false,
        accountCreationAuthorized: false,
      }),
    );
    expect(watcher.readApplicationPageBinding).toHaveBeenCalledWith(
      "target_site",
      "result_1",
    );
  });

  it("one sign-in covers the site: another waiting page there is reloaded once and carries on", async () => {
    const second = {
      ...request,
      id: "application_login_second",
      scope: { ...request.scope, jobId: "job_2", resultId: "result_2" },
    } as unknown as UserActionRequest;
    const signedInPages = new Set<string>();
    const readApplicationPageBinding = vi.fn((_source: string, key: string) =>
      Promise.resolve(page(signedInPages.has(key))),
    );
    // Reloading a page on a site the person is signed in to shows it signed in.
    const reloadApplicationPageBinding = vi.fn(
      (_source: string, key: string) => {
        signedInPages.add(key);
        return Promise.resolve();
      },
    );
    const performUserAction = vi.fn(() => Promise.resolve(undefined));
    const listeners: Array<(next: DesktopBrowserState) => void> = [];
    const dispose = installAutomaticApplicationAccessResume({
      browser: {
        onStateChanged: (next) => {
          listeners.push(next);
          return () => undefined;
        },
      },
      browserRuntime: {
        readApplicationPageBinding,
        reloadApplicationPageBinding,
      } as never,
      repository: {
        getActivityControl: () => Promise.resolve({ paused: false }),
        listUserActionRequests: () => Promise.resolve([request, second]),
        getUserActionRequest: (id: string) =>
          Promise.resolve([request, second].find((r) => r.id === id) ?? null),
      } as never,
      performUserAction,
      delayMs: 5,
      pollMs: 20,
    });
    disposers.push(dispose);
    await waitFor(() => readApplicationPageBinding.mock.calls.length >= 2);
    expect(reloadApplicationPageBinding).not.toHaveBeenCalled();

    // The person signs in on the first application's page only.
    signedInPages.add("result_1");
    for (const listener of listeners)
      listener(state("http://127.0.0.1:47950/workday/apply/1/step/1"));
    await waitFor(() => performUserAction.mock.calls.length >= 2, 1_000);

    expect(reloadApplicationPageBinding).toHaveBeenCalledTimes(1);
    expect(reloadApplicationPageBinding).toHaveBeenCalledWith(
      "target_site",
      "result_2",
    );
    expect(performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "application_login_second" }),
    );
  });

  it("looks for applications the person sent themselves on every check, and survives its failure", async () => {
    let calls = 0;
    const afterCheck = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("page went away"))
        : Promise.resolve();
    });
    const watcher = setup({ signedIn: false, requests: [], afterCheck });
    disposers.push(watcher.dispose);
    await waitFor(() => afterCheck.mock.calls.length >= 2);
  });

  it("does nothing while activity is paused", async () => {
    const watcher = setup({ signedIn: false });
    disposers.push(watcher.dispose);
    await waitFor(
      () => watcher.readApplicationPageBinding.mock.calls.length > 0,
    );
    watcher.pause(true);
    watcher.signIn();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(watcher.performUserAction).not.toHaveBeenCalled();
    watcher.pause(false);
    await waitFor(() => watcher.performUserAction.mock.calls.length > 0);
  });

  it("confirms a page that already reads clear at most once per application", async () => {
    const watcher = setup({ signedIn: true });
    disposers.push(watcher.dispose);
    await waitFor(() => watcher.performUserAction.mock.calls.length > 0);
    // The run paused again on a wall this reader cannot see: a new request
    // for the same application must not start another continuation.
    watcher.setRequests([
      {
        ...request,
        id: "application_login_again",
        revision: 1,
      } as UserActionRequest,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watcher.performUserAction).toHaveBeenCalledTimes(1);
  });

  it("carries a security check on once the person has solved it on the kept page", async () => {
    let ticked = false;
    const captchaPage = (): RawApplyPage => ({
      ...page(true),
      bodyText: "Apply I am not a robot Local fake CAPTCHA",
      controls: [
        control,
        {
          ...control,
          index: 1,
          inputType: "checkbox",
          role: "checkbox",
          name: "human",
          label: "I am not a robot",
          required: false,
          checked: ticked,
          value: "yes",
        },
      ],
    });
    const captcha = {
      ...request,
      id: "application_captcha",
      kind: "captcha",
      revision: 1,
      verification: { type: "page_blocker_absent" },
    } as unknown as UserActionRequest;
    const watcher = setup({ signedIn: false, requests: [captcha] });
    disposers.push(watcher.dispose);
    watcher.readApplicationPageBinding.mockImplementation(() =>
      Promise.resolve(captchaPage()),
    );
    await waitFor(
      () => watcher.readApplicationPageBinding.mock.calls.length > 1,
    );
    expect(watcher.performUserAction).not.toHaveBeenCalled();

    ticked = true;
    await waitFor(() => watcher.performUserAction.mock.calls.length > 0);
    expect(watcher.performUserAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "confirm_done",
        requestId: "application_captcha",
        commandId: "auto_application_access_application_captcha_r1",
      }),
    );
  });

  it("ignores source sign-ins and non-sign-in application steps", async () => {
    const watcher = setup({
      signedIn: true,
      requests: [
        {
          ...request,
          id: "source_login",
          scope: { type: "discovery_source", source: "target_site" },
        } as unknown as UserActionRequest,
        {
          ...request,
          id: "upload",
          kind: "manual_upload",
          verification: { type: "page_blocker_absent" },
        } as unknown as UserActionRequest,
      ],
    });
    disposers.push(watcher.dispose);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(watcher.readApplicationPageBinding).not.toHaveBeenCalled();
    expect(watcher.performUserAction).not.toHaveBeenCalled();
  });
});

it("notices a completed sign-in again when its first continuation failed", async () => {
  const h = setup({ signedIn: true });
  h.performUserAction.mockRejectedValueOnce(
    new Error("Temporary page read failure"),
  );
  await waitFor(() => h.performUserAction.mock.calls.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 70));
  expect(h.performUserAction).toHaveBeenCalledTimes(2);
  h.dispose();
});
