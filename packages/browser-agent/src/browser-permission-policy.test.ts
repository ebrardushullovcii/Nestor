import {
  BrowserAgentPermissionsSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import {
  buildApplyFormObservation,
  createApplyPageHands,
} from "./apply/page-hands";
import type { ApplyPageHands } from "./apply/types";
import {
  browserInteractionKind,
  browserStepReadyForAgent,
  googleIdentityContext,
  withBrowserPermissions,
} from "./browser-permission-policy";
import { createPageTools } from "./page-tools";

function control(label: string, inputType: string, index = 0): RawApplyControl {
  return {
    index,
    tagName: "input",
    inputType,
    role: "",
    id: `field${index}`,
    name: `field${index}`,
    label,
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
}
function setup(kind: "signIn" | "createAccounts" | "solveCaptchas") {
  const label =
    kind === "signIn"
      ? "Sign in"
      : kind === "createAccounts"
        ? "Create account"
        : "Verify you are human";
  const raw: RawApplyPage = {
    url: "https://fixture.test/login",
    title: label,
    bodyText: label,
    controls:
      kind === "solveCaptchas"
        ? [control("I am not a robot", "checkbox")]
        : [
            control("Email", "email"),
            {
              ...control("Password", "password", 1),
              value: "synthetic-password",
            },
          ],
    actions: [
      {
        index: 0,
        label,
        visible: true,
        disabled: false,
        submitsForm: kind !== "solveCaptchas",
        formMethod: "POST",
        formAction: "https://fixture.test/session",
      },
    ],
    links: [],
    headings: [],
    clickables: [],
    openedTabs: [],
    loading: false,
    validationErrors: [],
    stepLabel: null,
  };
  const write = () =>
    Promise.resolve({ ok: true as const, observedValue: "done" });
  const hands: ApplyPageHands = {
    observe: () =>
      Promise.resolve(
        buildApplyFormObservation(raw, "2026-10-29T10:00:00.000Z"),
      ),
    navigate: vi.fn((url: string) =>
      Promise.resolve({ ok: true as const, url }),
    ),
    goBack: () =>
      Promise.resolve({
        ok: true,
        url: raw.url ?? "https://fixture.test/login",
      }),
    clickElement: vi.fn(write),
    clickAction: vi.fn(write),
    clickAuthorizedFormAction: vi.fn(write),
    fillText: vi.fn(write),
    setToggle: vi.fn(write),
    chooseOption: vi.fn(write),
    pressKey: vi.fn(write),
    scroll: vi.fn(write),
    wait: async () => {},
    uploadFile: vi.fn(write),
    readText: () => Promise.resolve(raw.bodyText),
    followLink: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        url: raw.url ?? "https://fixture.test/login",
      }),
    ),
  };
  return { raw, hands };
}

describe("Google preference at a mixed sign-in wall", () => {
  function mixed() {
    const result = setup("signIn");
    result.raw.controls[1].value = "";
    result.raw.actions.push({
      index: 1,
      label: "Sign in with Google",
      visible: true,
      disabled: false,
      submitsForm: false,
    });
    return result;
  }
  test("does not prepare or type site credentials while Google is enabled", async () => {
    const { raw, hands } = mixed();
    const prepare = vi.fn(() => Promise.resolve(false));
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        signIn: true,
        googleSignIn: true,
      }),
      prepareBrowserCredentials: prepare,
    });
    await guarded.observe();
    expect(prepare).not.toHaveBeenCalled();
    expect(
      await guarded.fillText("c0", "synthetic@example.test"),
    ).toMatchObject({ ok: false });
    raw.controls[1].value = "synthetic-password";
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.fillText).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: true });
  });
  test("Google revocation allows the separately enabled saved-password route", async () => {
    const { raw, hands } = mixed();
    let googleSignIn = true;
    const prepare = vi.fn(() => {
      raw.controls[1].value = "synthetic-password";
      return Promise.resolve(true);
    });
    const guarded = withBrowserPermissions(hands, {
      readBrowserPermissions: () =>
        BrowserAgentPermissionsSchema.parse({ signIn: true, googleSignIn }),
      prepareBrowserCredentials: prepare,
    });
    await guarded.observe();
    expect(prepare).not.toHaveBeenCalled();
    googleSignIn = false;
    await guarded.observe();
    expect(prepare).toHaveBeenCalledOnce();
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: false });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
  });
});

describe("Google with no Profile email", () => {
  function chooser(accounts: string[]) {
    const { raw, hands } = setup("signIn");
    raw.url = "https://accounts.google.com/v3/signin/accountchooser";
    raw.controls = [];
    raw.actions = accounts.map((email, index) => ({
      index,
      label: email,
      visible: true,
      disabled: false,
      submitsForm: false,
    }));
    hands.readAccountFlowEntry = () =>
      Promise.resolve([
        "https://accounts.google.com/o/oauth2/v2/auth?scope=openid+email+profile",
      ]);
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
      readIntendedAccountEmail: () => null,
    });
    return { raw, hands, guarded };
  }
  test("selects the sole account and confirms only that identity", async () => {
    const { raw, hands, guarded } = chooser(["sole@example.test"]);
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
    expect(await googleIdentityContext({}, { ...guarded })).toMatchObject({
      selectedEmail: "sole@example.test",
    });
    raw.url = "https://accounts.google.com/signin/oauth/consent";
    raw.bodyText = "sole@example.test · Share your name and email";
    raw.actions = [
      {
        index: 0,
        label: "Continue",
        visible: true,
        disabled: false,
        submitsForm: false,
      },
    ];
    expect((await guarded.observe()).blocker?.requiresPerson).not.toBe(true);
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
    expect(hands.clickElement).toHaveBeenCalledTimes(2);
  });
  test("does not choose between two accounts or use another account without an email", async () => {
    const { raw, hands, guarded } = chooser([
      "one@example.test",
      "two@example.test",
      "Use another account",
    ]);
    for (const ref of ["a0", "a1", "a2"])
      expect(await guarded.clickElement(ref)).toMatchObject({ ok: false });
    raw.actions = [raw.actions[2]];
    expect(await guarded.clickElement("a2")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
  });
  test("a sole account never overrides a known nonmatching Profile email", async () => {
    const { hands } = chooser(["other@example.test"]);
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
      readIntendedAccountEmail: () => "profile@example.test",
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
  });
  test("a changed confirmation identity is handed off", async () => {
    const { raw, hands, guarded } = chooser(["sole@example.test"]);
    await guarded.clickElement("a0");
    raw.url = "https://accounts.google.com/signin/oauth/consent";
    raw.bodyText = "other@example.test";
    raw.actions = [
      { index: 0, label: "Continue", visible: true, disabled: false },
    ];
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).toHaveBeenCalledTimes(1);
  });
  test("a sole signed-out account is not treated as an existing session", async () => {
    const { hands, guarded } = chooser(["sole@example.test Signed out"]);
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
  });
});

test("a native saved-password POST uses its exact form action instead of the JS-only login window", async () => {
  const { hands } = setup("signIn");
  const jsPress = vi.fn(() =>
    Promise.resolve({ ok: true as const, observedValue: "clicked" }),
  );
  const guarded = withBrowserPermissions(
    { ...hands, clickAuthorizedLoginAction: jsPress },
    {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
      prepareBrowserCredentials: () => Promise.resolve(true),
    },
  );
  expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
  expect(hands.clickAuthorizedFormAction).toHaveBeenCalledExactlyOnceWith("a0");
  expect(jsPress).not.toHaveBeenCalled();
});

test.each(["GET", "button"])(
  "host-completed saved login uses the bounded JS press for %s",
  async (method) => {
    const { hands, raw } = setup("signIn");
    raw.controls[1].autocomplete = "current-password";
    raw.actions[0].inForm = true;
    raw.actions[0].formMethod = "GET";
    raw.actions[0].submitsForm = method === "GET";
    const press = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "pressed",
      }),
    );
    Object.assign(hands, { clickAuthorizedLoginAction: press });
    const prepare = vi.fn(() => Promise.resolve(true));
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
      prepareBrowserCredentials: prepare,
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(raw.url);
    expect(press).toHaveBeenCalledExactlyOnceWith({ ref: "a0", frame: null });
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(press).toHaveBeenCalledOnce();
  },
);

test.each(["host_refused", "changed", "permission_off", "create"])(
  "JS login refuses %s",
  async (failure) => {
    const { hands, raw } = setup(
      failure === "create" ? "createAccounts" : "signIn",
    );
    raw.actions[0].formMethod = "GET";
    const press = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "pressed",
      }),
    );
    Object.assign(hands, { clickAuthorizedLoginAction: press });
    let allowed = true;
    const guarded = withBrowserPermissions(hands, {
      readBrowserPermissions: () =>
        BrowserAgentPermissionsSchema.parse({ signIn: allowed }),
      prepareBrowserCredentials: () => {
        if (failure === "changed") raw.actions[0].label = "Create account";
        if (failure === "permission_off") allowed = false;
        return Promise.resolve(failure !== "host_refused");
      },
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(press).not.toHaveBeenCalled();
  },
);

describe("ref-bound Google account windows", () => {
  test("page hands carry the typed grant and account observation through unchanged", async () => {
    const { raw, hands } = setup("signIn");
    raw.accountWindow = {
      origin: "https://accounts.google.com",
      pathname: "/v3/signin/accountchooser",
      actionsLeft: 1,
    };
    const grant = {
      ref: "a0",
      frame: null,
      writeOrigins: ["https://accounts.google.com"],
    };
    const open = vi.fn<
      NonNullable<ApplyPageHands["clickOpeningAccountWindow"]>
    >(() =>
      Promise.resolve({
        kind: "opened",
        url: "https://accounts.google.com/v3/signin/accountchooser",
      }),
    );
    const mapped = createApplyPageHands({
      ...hands,
      pressKey: (ref, key) => hands.pressKey!(ref, key),
      readPage: () => Promise.resolve(raw),
      clickOpeningAccountWindow: open,
    });
    expect((await mapped.observe()).accountWindow).toEqual(raw.accountWindow);
    expect(await mapped.clickOpeningAccountWindow?.(grant)).toMatchObject({
      kind: "opened",
    });
    expect(open).toHaveBeenCalledExactlyOnceWith(grant);
  });
  test("page tools preserve the claimed surface without adoption or move review", async () => {
    const { raw, hands } = setup("signIn");
    const original = await hands.observe();
    const adopt = vi.fn();
    hands.adoptOpenedTab = adopt;
    hands.clickElement = () => {
      raw.url = "https://accounts.google.com/v3/signin/accountchooser";
      raw.accountWindow = {
        origin: "https://accounts.google.com",
        pathname: "/v3/signin/accountchooser",
        actionsLeft: 1,
      };
      raw.openedTabs = [
        { index: 0, url: "https://accounts.google.com/extra", title: "Extra" },
      ];
      return Promise.resolve({ ok: true, observedValue: "opened" });
    };
    const allowUrl = vi.fn(() => "Outside the application");
    const reviewMove = vi.fn(() =>
      Promise.resolve({ allowed: false, verdict: "Unrelated move" }),
    );
    const goBack = vi.spyOn(hands, "goBack");
    const tools = createPageTools(hands, { allowUrl, reviewMove });
    await tools.observe();
    const tool = tools.tools.find(
      (entry) => entry.definition.function.name === "click",
    )!;
    expect(
      (await tool.execute(JSON.stringify({ ref: "a0" }), { step: 1 })).kind,
    ).toBe("ok");
    expect(adopt).not.toHaveBeenCalled();
    expect(allowUrl).not.toHaveBeenCalled();
    expect(reviewMove).not.toHaveBeenCalled();
    expect(goBack).not.toHaveBeenCalled();
    const active = await hands.observe();
    expect(active.accountWindow).toEqual(raw.accountWindow);
    expect(active.signature).not.toBe(original.signature);
    raw.accountWindow!.actionsLeft = 0;
    expect((await hands.observe()).signature).not.toBe(active.signature);
  });
  test.each(["opened", "no_window", "refused"] as const)(
    "one provider grant maps the runtime result: %s",
    async (kind) => {
      const { raw, hands } = setup("signIn");
      raw.controls[1].value = "";
      raw.actions = [];
      raw.clickables = [
        {
          index: 0,
          ref: "f0e0",
          label: "Sign in with Google",
          role: "button",
          tagName: "button",
          visible: true,
          disabled: false,
          topOffset: 0,
          frame: {
            origin: "https://accounts.google.com",
            pathname: "/gsi/button",
          },
        },
      ];
      const grant = vi.fn<
        NonNullable<ApplyPageHands["clickOpeningAccountWindow"]>
      >(() =>
        Promise.resolve(
          kind === "refused"
            ? { kind, reason: "not_claimed", detail: "Synthetic refusal" }
            : {
                kind,
                url: "https://accounts.google.com/v3/signin/accountchooser",
              },
        ),
      );
      hands.clickOpeningAccountWindow = grant;
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          googleSignIn: true,
        }),
      });
      const result = await guarded.clickElement("f0e0");
      expect(result.ok).toBe(kind !== "refused");
      if (!result.ok)
        expect(result.error).toContain("Finish Google sign-in yourself");
      expect(grant).toHaveBeenCalledExactlyOnceWith({
        ref: "f0e0",
        frame: {
          origin: "https://accounts.google.com",
          pathname: "/gsi/button",
        },
        writeOrigins: ["https://accounts.google.com"],
        maxActions: 4,
        disclosableValues: [],
      });
      expect(hands.clickElement).not.toHaveBeenCalled();
      expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
      expect((await guarded.clickElement("f0e0")).ok).toBe(false);
      expect(grant).toHaveBeenCalledTimes(1);
      expect((await guarded.fillText("c1", "anything")).ok).toBe(false);
      expect(hands.fillText).not.toHaveBeenCalled();
    },
  );

  test.each(["off", "changed"])(
    "no grant when Google is %s",
    async (condition) => {
      const { raw, hands } = setup("signIn");
      raw.controls = [];
      raw.actions = [
        {
          index: 0,
          label: "Continue with Google",
          visible: true,
          disabled: false,
        },
      ];
      const grant = vi.fn<
        NonNullable<ApplyPageHands["clickOpeningAccountWindow"]>
      >(() => Promise.resolve({ kind: "no_window", url: raw.url! }));
      hands.clickOpeningAccountWindow = grant;
      if (condition === "changed") {
        const read = hands.observe;
        let reads = 0;
        hands.observe = async () => {
          const observed = await read();
          if (++reads === 1)
            raw.actions[0].label = "Create a different account";
          return observed;
        };
      }
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          googleSignIn: condition !== "off",
        }),
      });
      expect((await guarded.clickElement("a0")).ok).toBe(false);
      expect(grant).not.toHaveBeenCalled();
      expect(hands.clickElement).not.toHaveBeenCalled();
    },
  );

  test("a sole chooser submit uses the child's click and records selection once", async () => {
    const { raw, hands } = setup("signIn");
    raw.url = "https://accounts.google.com/v3/signin/accountchooser";
    raw.controls = [];
    raw.actions = [
      {
        index: 0,
        label: "Synthetic CHOICE@Example.test",
        visible: true,
        disabled: false,
        submitsForm: true,
        formMethod: "POST",
        formAction: "https://accounts.google.com/select",
      },
    ];
    raw.accountWindow = {
      origin: "https://accounts.google.com",
      pathname: "/v3/signin/accountchooser",
      actionsLeft: 1,
    };
    const grant = vi.fn();
    hands.clickOpeningAccountWindow = grant;
    const selected = vi.fn();
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
      readIntendedAccountEmail: () => "choice@example.test",
      onGoogleAccountSelected: selected,
    });
    expect((await guarded.clickElement("a0")).ok).toBe(true);
    expect(hands.clickElement).toHaveBeenCalledExactlyOnceWith("a0");
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledExactlyOnceWith("choice@example.test");
    expect((await guarded.clickElement("a0")).ok).toBe(false);
    expect(selected).toHaveBeenCalledTimes(1);
  });

  test.each(["second_window", "other_origin", "permission_off"])(
    "account child hands off on %s, even with password sign-in enabled",
    async (condition) => {
      const { raw, hands } = setup("signIn");
      raw.url = "https://accounts.google.com/v3/signin/accountchooser";
      raw.controls = [];
      raw.actions = [
        {
          index: 0,
          label: "choice@example.test",
          visible: true,
          disabled: false,
        },
      ];
      raw.accountWindow = {
        origin:
          condition === "other_origin"
            ? "https://other.example.test"
            : "https://accounts.google.com",
        pathname: "/v3/signin/accountchooser",
        actionsLeft: condition === "exhausted" ? 0 : 1,
        ...(condition === "second_window"
          ? {
              refusal: {
                reason: "second_window" as const,
                detail: "Extra window",
              },
            }
          : {}),
      };
      const permissions = BrowserAgentPermissionsSchema.parse({
        googleSignIn: condition !== "permission_off",
        signIn: true,
      });
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: permissions,
      });
      expect((await guarded.observe()).blocker?.requiresPerson).toBe(true);
      expect(browserStepReadyForAgent(await hands.observe(), permissions)).toBe(
        false,
      );
      expect((await guarded.clickElement("a0")).ok).toBe(false);
      expect(hands.clickElement).not.toHaveBeenCalled();
    },
  );
});

test.each(["refused", "changed", "followed"])(
  "Google selection activity follows the actual authorized action: %s",
  async (outcome) => {
    const { raw, hands } = setup("signIn");
    raw.url = "https://accounts.google.com/o/oauth2/v2/auth/oauthchooseaccount";
    raw.controls = [];
    raw.actions = [];
    raw.links = [
      {
        index: 0,
        label: "Choice CHOICE@Example.test",
        href: "https://accounts.google.com/next",
        target: "",
        visible: true,
        topOffset: 0,
      },
    ];
    const activity = vi.fn();
    const read = hands.observe;
    let reads = 0;
    hands.observe = async () => {
      const result = await read();
      if (++reads === 1 && outcome === "changed")
        raw.links[0].label = "other@example.test";
      return { ...result, signature: "unchanged-signature" };
    };
    hands.followLink = vi.fn(() =>
      Promise.resolve(
        outcome === "refused"
          ? {
              ok: false as const,
              error: "The selected account did not respond.",
            }
          : { ok: true as const, url: "https://accounts.google.com/next" },
      ),
    );
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
      readIntendedAccountEmail: () => "choice@example.test",
      onGoogleAccountSelected: activity,
    });
    const result = await guarded.followLink("l0");
    expect(result.ok).toBe(outcome === "followed");
    if (outcome === "followed")
      expect(activity).toHaveBeenCalledExactlyOnceWith("choice@example.test");
    else expect(activity).not.toHaveBeenCalled();
    if (outcome === "changed") expect(hands.followLink).not.toHaveBeenCalled();
  },
);

describe("browser permissions at the action boundary", () => {
  test("a separate Sign In can reveal providers beside an empty registration form", async () => {
    const { hands, raw } = setup("createAccounts");
    raw.controls[1].value = "";
    raw.actions.push({
      index: 1,
      label: "Sign In",
      visible: true,
      disabled: false,
    });
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    expect((await guarded.observe()).blocker?.code).toBe(
      "account_creation_required",
    );
    expect(
      browserStepReadyForAgent(
        await guarded.observe(),
        BrowserAgentPermissionsSchema.parse({
          signIn: true,
          googleSignIn: true,
        }),
      ),
    ).toBe(true);
    expect(
      browserStepReadyForAgent(
        await guarded.observe(),
        BrowserAgentPermissionsSchema.parse({ signIn: true }),
      ),
    ).toBe(true);
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: true });
    expect(hands.clickElement).toHaveBeenCalledExactlyOnceWith("a1");
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(await guarded.fillText("c1", "never-enter-this")).toMatchObject({
      ok: false,
    });
    expect(hands.fillText).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: false });
  });

  test("a Google-only Sign In entry reveals providers without granting credential or Google authority to password-only mode", async () => {
    const { hands, raw } = setup("signIn");
    raw.controls[1].value = "";
    raw.actions.push({
      index: 1,
      label: "Sign In",
      visible: true,
      disabled: false,
    });
    raw.actions.push({
      index: 2,
      label: "Sign in with Google",
      visible: true,
      disabled: false,
    });
    const googleOnly = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(await googleOnly.clickElement("a1")).toMatchObject({ ok: true });
    expect(
      await googleOnly.fillText("c0", "synthetic@example.test"),
    ).toMatchObject({ ok: false });
    expect(hands.fillText).not.toHaveBeenCalled();
    expect(await googleOnly.clickElement("a1")).toMatchObject({ ok: false });
    const passwordOnly = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    expect(await passwordOnly.clickElement("a2")).toMatchObject({ ok: false });
    expect(await passwordOnly.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).toHaveBeenCalledExactlyOnceWith("a1");
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test("a Sign In entry that becomes a credential submit is refused before the press", async () => {
    const { hands, raw } = setup("signIn");
    raw.controls[1].value = "";
    raw.actions.push({
      index: 1,
      label: "Sign In",
      visible: true,
      disabled: false,
    });
    const read = hands.observe;
    let reads = 0;
    hands.observe = async () => {
      const page = await read();
      if (++reads === 1) raw.actions[1] = { ...raw.actions[0], index: 1 };
      return page;
    };
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test.each(["layout-group", "link"] as const)(
    "existing-account %s navigation needs only sign-in permission beside registration",
    async (kind) => {
      const { hands, raw } = setup("createAccounts");
      raw.controls[1].value = "";
      if (kind === "layout-group")
        raw.actions.push({
          index: 1,
          label: "Sign In",
          visible: true,
          disabled: false,
          inForm: true,
          section: "Already have an account?",
        });
      else
        raw.links.push({
          index: 0,
          label: "Sign In",
          href: "https://fixture.test/login",
          target: "",
          visible: true,
          topOffset: 0,
        });
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
        }),
      });
      const observed = await guarded.observe();
      expect(observed.blocker).toMatchObject({
        code: "account_creation_required",
        requiresPerson: false,
      });
      expect(
        browserStepReadyForAgent(
          observed,
          BrowserAgentPermissionsSchema.parse({ signIn: true }),
        ),
      ).toBe(true);
      const ref = kind === "layout-group" ? "a1" : "l0";
      expect(await guarded.clickElement(ref)).toMatchObject({ ok: true });
      expect(hands.clickElement).toHaveBeenCalledExactlyOnceWith(ref);
      expect(await guarded.clickElement(ref)).toMatchObject({ ok: false });
      expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
      expect(
        await guarded.fillText("c1", "never-type-a-password"),
      ).toMatchObject({ ok: false });
      expect(hands.fillText).not.toHaveBeenCalled();
      expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    },
  );

  test.each(["href", "frame", "hidden"] as const)(
    "a Sign In link changed at %s is refused before navigation",
    async (change) => {
      const { hands, raw } = setup("createAccounts");
      raw.controls[1].value = "";
      raw.links.push({
        index: 0,
        label: "Sign In",
        href: "https://fixture.test/login",
        target: "",
        visible: true,
        topOffset: 0,
      });
      const read = hands.observe;
      let reads = 0;
      hands.observe = async () => {
        const observed = await read();
        if (++reads === 1) {
          if (change === "href")
            raw.links[0].href = "https://fixture.test/changed";
          if (change === "frame")
            raw.links[0].frame = {
              origin: "https://fixture.test",
              pathname: "/changed",
            };
          if (change === "hidden") raw.links[0].visible = false;
        }
        return observed;
      };
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
        }),
      });
      expect(await guarded.followLink("l0")).toMatchObject({ ok: false });
      expect(hands.followLink).not.toHaveBeenCalled();
    },
  );

  test("an unclassified Sign In inside credential fields is not navigation merely because native form metadata is absent", async () => {
    const { hands, raw } = setup("createAccounts");
    raw.controls[1].value = "";
    raw.actions.push({
      index: 1,
      label: "Sign In",
      visible: true,
      disabled: false,
      inForm: true,
      section: "Sign In",
    });
    const permissions = BrowserAgentPermissionsSchema.parse({
      signIn: true,
      googleSignIn: true,
    });
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: permissions,
    });
    expect(browserStepReadyForAgent(await guarded.observe(), permissions)).toBe(
      false,
    );
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test.each(["GET", "button"])(
    "a login %s beside Create Account permits its identifier but hands off the sign-in press",
    async (variant) => {
      const { hands, raw } = setup("signIn");
      raw.title = "Create Account / Sign In";
      raw.bodyText = "Sign In. New here? Create an account.";
      raw.actions[0] = {
        ...raw.actions[0],
        inForm: true,
        submitsForm: variant === "GET",
        formMethod: "GET",
        formAction: variant === "GET" ? (raw.url ?? undefined) : undefined,
      };
      raw.actions.push({
        index: 1,
        label: "Create Account",
        visible: true,
        disabled: false,
        submitsForm: false,
      });
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
        }),
      });
      const page = await guarded.observe();
      const email = page.controls.find(
        (entry) => entry.credentialRole === "identifier",
      )!;
      expect(page.blocker?.code).toBe("site_login_required");
      expect(browserInteractionKind(page, "a0")).toBe("signIn");
      expect(browserInteractionKind(page, email.ref)).toBe("signIn");
      expect(
        await guarded.fillText(email.ref, "synthetic@example.test"),
      ).toMatchObject({ ok: true });
      const result = await guarded.clickElement("a0");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("exact form action");
      expect(hands.clickElement).not.toHaveBeenCalled();
      expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
      expect((await guarded.observe()).blocker).toMatchObject({
        code: "site_login_required",
        requiresPerson: true,
      });
    },
  );

  test.each([false, true])(
    "registration copy delegates saved-login detection to the host (login found=%s)",
    async (login) => {
      const { hands, raw } = setup("createAccounts");
      raw.controls[1].value = "";
      const prepare = vi.fn(() => {
        if (login) raw.controls[1].value = "synthetic-host-only-value";
        return Promise.resolve(login);
      });
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
        }),
        prepareBrowserCredentials: prepare,
      });
      const observed = await guarded.observe();
      expect(prepare).toHaveBeenCalledExactlyOnceWith(raw.url);
      expect(
        observed.controls.find((entry) => entry.ref === "c1")?.answered,
      ).toBe(login);
      expect(hands.fillText).not.toHaveBeenCalled();
      expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    },
  );

  test.each(["Continue with Google", "Sign up with Google", "Google"])(
    "%s has its own opt-in and ignores an unrelated empty password form",
    async (label) => {
      const { hands, raw } = setup("createAccounts");
      raw.bodyText = "Create an account to continue";
      raw.actions[0].label = label;
      raw.actions[0].submitsForm = false;
      raw.controls[1].value = "";
      const off = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
          createAccounts: true,
        }),
      });
      expect(await off.clickElement("a0")).toMatchObject({ ok: false });
      expect(hands.clickElement).not.toHaveBeenCalled();
      const permissions = BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      });
      const on = withBrowserPermissions(hands, {
        browserPermissions: permissions,
      });
      const page = await on.observe();
      expect(page.blocker?.requiresPerson).toBe(false);
      expect(browserStepReadyForAgent(page, permissions)).toBe(true);
      expect(await on.clickElement("a0")).toMatchObject({ ok: true });
      expect(hands.clickElement).toHaveBeenCalledExactlyOnceWith("a0");
      expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
      expect(await on.clickElement("a0")).toMatchObject({ ok: false });
    },
  );

  test("an SSO-only wall resumes, and turning Google off blocks the next action", async () => {
    const { hands, raw } = setup("createAccounts");
    raw.bodyText = "Create an account to continue";
    raw.controls = [];
    raw.actions[0].label = "Continue with Google";
    raw.actions[0].submitsForm = false;
    let googleSignIn = true;
    const on = withBrowserPermissions(hands, {
      readBrowserPermissions: () =>
        BrowserAgentPermissionsSchema.parse({ googleSignIn }),
    });
    const page = await on.observe();
    expect(
      browserStepReadyForAgent(
        page,
        BrowserAgentPermissionsSchema.parse({ googleSignIn: true }),
      ),
    ).toBe(true);
    googleSignIn = false;
    expect(await on.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
  });

  test("Google opt-in can select one existing account, but not several", async () => {
    const { hands, raw } = setup("signIn");
    raw.url = "https://accounts.google.com/v3/signin/accountchooser";
    raw.headings = [{ level: 1, text: "Choose an account" }];
    raw.controls = [];
    raw.actions[0].label = "Jamie synthetic@example.test";
    raw.actions[0].submitsForm = false;
    const guarded = withBrowserPermissions(hands, {
      readIntendedAccountEmail: () => "synthetic@example.test",
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
    raw.actions.push({
      ...raw.actions[0],
      index: 1,
      label: "Other other@example.test",
    });
    expect((await guarded.observe()).blocker?.requiresPerson).toBe(true);
    expect(await guarded.clickElement("a1")).toMatchObject({ ok: false });
    expect(hands.clickElement).toHaveBeenCalledTimes(1);
  });

  test("direct navigation cannot bypass the Google opt-in, including a site's provider link", async () => {
    const { hands, raw } = setup("signIn");
    raw.links = [
      {
        index: 0,
        label: "Continue with Google",
        href: "https://fixture.test/oauth",
        target: "",
        visible: true,
        topOffset: 0,
      },
    ];
    const guarded = withBrowserPermissions(hands, {});
    expect(
      await guarded.navigate("https://accounts.google.com/o/oauth2/v2/auth"),
    ).toMatchObject({ ok: false });
    expect(
      await guarded.navigate("http://accounts.google.com/o/oauth2/v2/auth"),
    ).toMatchObject({ ok: false });
    expect(await guarded.navigate("https://fixture.test/oauth")).toMatchObject({
      ok: false,
    });
    expect(hands.navigate).not.toHaveBeenCalled();
  });

  test("a changing Google button cannot become a consent or application action", async () => {
    const { hands, raw } = setup("createAccounts");
    raw.controls = [];
    raw.actions[0].label = "Continue with Google";
    raw.actions[0].submitsForm = false;
    const read = hands.observe;
    let reads = 0;
    hands.observe = async () => {
      const page = await read();
      if (++reads === 1) {
        raw.url = "https://accounts.google.com/signin/oauth/consent";
        raw.actions[0].label = "Allow";
      }
      return page;
    };
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test.each(["Allow", "Continue", "Create account"])(
    "Google's %s stays with the person even with every account permission",
    async (label) => {
      const { hands, raw } = setup("createAccounts");
      raw.url = "https://accounts.google.com/signin/oauth/consent";
      raw.title = "Google access request";
      raw.controls = [];
      raw.actions[0].label = label;
      raw.actions[0].submitsForm = false;
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          signIn: true,
          createAccounts: true,
          googleSignIn: true,
        }),
      });
      expect((await guarded.observe()).blocker?.requiresPerson).toBe(true);
      expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
      expect(await guarded.followLink("a0")).toMatchObject({ ok: false });
      expect(hands.clickElement).not.toHaveBeenCalled();
      expect(hands.followLink).not.toHaveBeenCalled();
    },
  );

  test.each(["signIn", "createAccounts", "solveCaptchas"] as const)(
    "%s resumes only an enabled step with enough on-site input",
    async (kind) => {
      const { hands, raw } = setup(kind);
      const off = BrowserAgentPermissionsSchema.parse({});
      const on = BrowserAgentPermissionsSchema.parse({ [kind]: true });
      expect(browserStepReadyForAgent(await hands.observe(), off)).toBe(false);
      expect(browserStepReadyForAgent(await hands.observe(), on)).toBe(true);
      if (kind !== "solveCaptchas") {
        raw.controls[1].value = "";
        expect(browserStepReadyForAgent(await hands.observe(), on)).toBe(false);
      }
    },
  );
  test.each(["signIn", "createAccounts", "solveCaptchas"] as const)(
    "%s is off by default, including direct clicks",
    async (kind) => {
      const { hands } = setup(kind);
      const guarded = withBrowserPermissions(hands, {});
      const result =
        kind === "solveCaptchas"
          ? await guarded.setToggle("c0", true)
          : await guarded.clickElement("a0");
      expect(result).toMatchObject({ ok: false });
      expect(hands.setToggle).not.toHaveBeenCalled();
      expect(hands.clickElement).not.toHaveBeenCalled();
      expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    },
  );

  test.each(["signIn", "createAccounts"] as const)(
    "%s opens only its exact account action with an already entered password",
    async (kind) => {
      const { hands } = setup(kind);
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          [kind]: true,
        }),
      });
      expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
      expect(hands.clickAuthorizedFormAction).toHaveBeenCalledExactlyOnceWith(
        "a0",
      );
      expect(hands.clickElement).not.toHaveBeenCalled();
      expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
      expect(hands.clickAuthorizedFormAction).toHaveBeenCalledTimes(1);
    },
  );

  test("sign-in opt-in never grants account creation", async () => {
    const { hands } = setup("createAccounts");
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test("a provider button on a registration page still needs account-creation permission", async () => {
    const { hands, raw } = setup("createAccounts");
    raw.controls = [];
    raw.actions[0].label = "Continue with Google";
    raw.actions[0].submitsForm = false;
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickElement).not.toHaveBeenCalled();
  });

  test("a missing password stays with the person even when account steps are enabled", async () => {
    const { hands, raw } = setup("signIn");
    raw.controls[1].value = "";
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({ signIn: true }),
    });
    const click = await guarded.clickElement("a0");
    expect(click.ok).toBe(false);
    if (!click.ok) expect(click.error).toContain("password");
    expect(await guarded.fillText("c1", "do-not-use")).toMatchObject({
      ok: false,
    });
    expect(hands.fillText).not.toHaveBeenCalled();
    expect(await guarded.pressKey?.("c1", "a")).toMatchObject({ ok: false });
    expect(hands.pressKey).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test("an account label never authorizes disclosing an attached document", async () => {
    const { hands, raw } = setup("createAccounts");
    raw.controls.push({
      ...control("Resume", "file", 2),
      value: "synthetic.pdf",
    });
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        createAccounts: true,
      }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test("MFA remains person-owned even with all three permissions", async () => {
    const { hands, raw } = setup("signIn");
    raw.bodyText = "Enter the verification code we sent";
    raw.controls = [control("Verification code", "text")];
    raw.actions[0].label = "Continue";
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: {
        signIn: true,
        googleSignIn: true,
        createAccounts: true,
        solveCaptchas: true,
      },
    });
    expect((await guarded.observe()).blocker?.requiresPerson).toBe(true);
    expect(await guarded.fillText("c0", "123456")).toMatchObject({ ok: false });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.fillText).not.toHaveBeenCalled();
  });

  test("CAPTCHA permission allows its checkbox and revocation takes effect before the next action", async () => {
    const { hands } = setup("solveCaptchas");
    let permissions = BrowserAgentPermissionsSchema.parse({
      solveCaptchas: true,
    });
    const guarded = withBrowserPermissions(hands, {
      readBrowserPermissions: () => permissions,
    });
    expect((await guarded.observe()).blocker?.requiresPerson).toBe(false);
    expect(await guarded.setToggle("c0", true)).toMatchObject({ ok: true });
    permissions = BrowserAgentPermissionsSchema.parse({});
    expect(await guarded.clickElement("c0")).toMatchObject({ ok: false });
    expect(await guarded.pressKey?.("c0", "Space")).toMatchObject({
      ok: false,
    });
    expect(hands.setToggle).toHaveBeenCalledTimes(1);
    expect(hands.clickElement).not.toHaveBeenCalled();
    expect(hands.pressKey).not.toHaveBeenCalled();
  });

  test("a verification label cannot grant a write of an application form", async () => {
    const { hands, raw } = setup("solveCaptchas");
    raw.controls.push(control("Cover letter", "text", 1));
    raw.actions[0].submitsForm = true;
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        solveCaptchas: true,
      }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test("the search page tools cannot bypass the permission through Enter or a generic click", async () => {
    const { hands } = setup("signIn");
    const tools = createPageTools(withBrowserPermissions(hands, {}));
    await tools.observe();
    for (const [name, args] of [
      ["click", { ref: "a0" }],
      ["press_key", { key: "Enter" }],
    ] as const) {
      const tool = tools.tools.find(
        (entry) => entry.definition.function.name === name,
      )!;
      const result = await tool.execute(JSON.stringify(args), { step: 1 });
      expect(result.kind).toBe("ok");
    }
    expect(hands.clickElement).not.toHaveBeenCalled();
    expect(hands.clickAuthorizedFormAction).not.toHaveBeenCalled();
    expect(hands.pressKey).not.toHaveBeenCalled();
  });
});

describe("D7 ref binding and Google navigation", () => {
  function gis() {
    const state = setup("signIn");
    state.raw.controls[1].value = "";
    state.raw.actions = [];
    state.raw.clickables = [
      {
        index: 0,
        ref: "f0e0",
        label: "Continuer en tant que Jamie",
        role: "button",
        tagName: "div",
        visible: true,
        disabled: false,
        topOffset: 0,
        frame: {
          origin: "https://accounts.google.com",
          pathname: "/gsi/button",
        },
      },
    ];
    return state;
  }
  test("localized GIS authority comes from its owner despite the employer password form", async () => {
    const { raw, hands } = gis();
    const on = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(
      browserStepReadyForAgent(
        await on.observe(),
        BrowserAgentPermissionsSchema.parse({ googleSignIn: true }),
      ),
    ).toBe(true);
    const off = withBrowserPermissions(hands, {});
    const denied = await off.clickElement("f0e0");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toContain("off in Settings");
    expect(await on.clickElement("f0e0")).toMatchObject({ ok: true });
    expect(hands.clickElement).toHaveBeenCalledExactlyOnceWith("f0e0");
    expect(raw.controls[1].value).toBe("");
  });
  test.each(["label", "origin", "pathname", "hidden", "disabled", "top-owner"])(
    "a changed %s behind an unchanged ref/signature prevents the click",
    async (change) => {
      const { raw, hands } = gis();
      const read = hands.observe;
      const initial = await read();
      let reads = 0;
      hands.observe = async () => {
        const observed = await read();
        if (++reads === 1) {
          const entry = raw.clickables[0];
          if (change === "label") entry.label = "Continue as another person";
          if (change === "origin")
            entry.frame!.origin = "https://other.example.test";
          if (change === "pathname")
            entry.frame!.pathname = "/gsi/iframe/select";
          if (change === "hidden") entry.visible = false;
          if (change === "disabled") entry.disabled = true;
          if (change === "top-owner") delete entry.frame;
        }
        // Deliberately hold the page signature constant: frame/clickable edits
        // are not in the signature, so the per-ref binding must catch these.
        return { ...observed, signature: initial.signature };
      };
      const guarded = withBrowserPermissions(hands, {
        browserPermissions: BrowserAgentPermissionsSchema.parse({
          googleSignIn: true,
        }),
      });
      const denied = await guarded.clickElement("f0e0");
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error).toContain("account step changed");
      expect(hands.clickElement).not.toHaveBeenCalled();
    },
  );
  test("a changed normalized chooser account with the same ref/signature prevents a link follow", async () => {
    const { raw, hands } = setup("signIn");
    raw.url = "https://accounts.google.com/v3/signin/accountchooser";
    raw.controls = [];
    raw.actions = [];
    raw.links = [
      {
        index: 0,
        label: "one@example.test",
        href: "https://accounts.google.com/next",
        target: "",
        visible: true,
        topOffset: 0,
      },
    ];
    const read = hands.observe;
    let reads = 0;
    hands.observe = async () => {
      const observed = await read();
      if (++reads === 1) raw.links[0].label = "two@example.test";
      return { ...observed, signature: "same" };
    };
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(await guarded.followLink("l0")).toMatchObject({ ok: false });
    expect(hands.followLink).not.toHaveBeenCalled();
  });
  test("an unchanged chooser hands off and cannot retry under a duplicate ref", async () => {
    const { raw, hands } = setup("signIn");
    raw.url = "https://accounts.google.com/v3/signin/accountchooser";
    raw.controls = [];
    raw.actions[0].label = "Jamie synthetic@example.test";
    raw.actions[0].submitsForm = false;
    const duplicate = [
      {
        index: 0,
        label: "Jamie synthetic@example.test",
        role: "option",
        tagName: "div",
        visible: true,
        disabled: false,
        topOffset: 0,
      },
    ];
    const guarded = withBrowserPermissions(hands, {
      readIntendedAccountEmail: () => "synthetic@example.test",
      browserPermissions: BrowserAgentPermissionsSchema.parse({
        googleSignIn: true,
      }),
    });
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
    raw.clickables = duplicate;
    expect((await guarded.observe()).blocker?.requiresPerson).toBe(true);
    expect(await guarded.clickElement("e0")).toMatchObject({ ok: false });
    expect(hands.clickElement).toHaveBeenCalledTimes(1);
    raw.url = "https://accounts.google.com/v3/signin/identifier";
    raw.controls = [control("Email", "email")];
    raw.actions[0].label = "Next";
    expect((await guarded.observe()).blocker?.requiresPerson).not.toBe(true);
    expect(
      await guarded.fillText("c0", "synthetic@example.test"),
    ).toMatchObject({ ok: true });
    expect(hands.fillText).toHaveBeenCalledExactlyOnceWith(
      "c0",
      "synthetic@example.test",
    );
  });
  test("Google-only navigation readiness does not enable identifier typing", async () => {
    const { raw, hands } = setup("signIn");
    raw.controls[1].value = "";
    raw.actions = [
      { index: 0, label: "Sign in", visible: true, disabled: false },
    ];
    const permissions = BrowserAgentPermissionsSchema.parse({
      googleSignIn: true,
    });
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: permissions,
    });
    expect(browserStepReadyForAgent(await guarded.observe(), permissions)).toBe(
      true,
    );
    expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
    expect(
      await guarded.fillText("c0", "synthetic@example.test"),
    ).toMatchObject({ ok: false });
    expect(hands.fillText).not.toHaveBeenCalled();
  });
});

test("Google revocation between the initial and fresh ref checks prevents the click", async () => {
  const { raw, hands } = setup("signIn");
  raw.controls = [];
  raw.actions[0].label = "Continue with Google";
  raw.actions[0].submitsForm = false;
  let checks = 0;
  const guarded = withBrowserPermissions(hands, {
    readBrowserPermissions: () =>
      BrowserAgentPermissionsSchema.parse({ googleSignIn: ++checks === 1 }),
  });
  const denied = await guarded.clickElement("a0");
  expect(denied.ok).toBe(false);
  if (!denied.ok) expect(denied.error).toContain("turned off");
  expect(hands.clickElement).not.toHaveBeenCalled();
});

describe("Profile-bound Google actions", () => {
  const basic =
    "https://accounts.google.com/o/oauth2/v2/auth?scope=openid+email+profile&state=synthetic-private-state";
  const fixture = () => {
    const f = setup("signIn");
    f.raw.url =
      "https://accounts.google.com/v3/signin/accountchooser?state=synthetic-private-state";
    f.raw.controls = [];
    f.raw.actions = [
      { index: 0, label: "other@example.test", visible: true, disabled: false },
      {
        index: 1,
        label: "target@example.test",
        visible: true,
        disabled: false,
      },
    ];
    f.hands.readAccountFlowEntry = () => Promise.resolve([basic]);
    return f;
  };
  const enabled = BrowserAgentPermissionsSchema.parse({ googleSignIn: true });
  test("matching second account records attempted selection, confirmation records attempted completion, neither is verified sign-in", async () => {
    const { raw, hands } = fixture();
    const chosen = vi.fn(),
      confirmed = vi.fn();
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: enabled,
      readIntendedAccountEmail: () => "target@example.test",
      onGoogleAccountSelected: chosen,
      onGoogleSignInConfirmed: confirmed,
    });
    expect((await guarded.observe()).url).not.toContain("state=");
    expect((await guarded.clickElement("a0")).ok).toBe(false);
    expect((await guarded.clickElement("a1")).ok).toBe(true);
    expect(chosen).toHaveBeenCalledExactlyOnceWith("target@example.test");
    raw.url = "https://accounts.google.com/signin/oauth/consent";
    raw.bodyText = "target@example.test";
    raw.actions = [
      { index: 0, label: "Continue", visible: true, disabled: false },
    ];
    expect((await guarded.clickElement("a0")).ok).toBe(true);
    expect(confirmed).toHaveBeenCalledExactlyOnceWith("target@example.test");
    expect((await guarded.clickElement("a0")).ok).toBe(false);
    expect(confirmed).toHaveBeenCalledTimes(1);
  });
  test("identifier uses only canonical Profile text and Next requires its retained value", async () => {
    const { raw, hands } = fixture();
    raw.url = "https://accounts.google.com/v3/signin/identifier";
    raw.controls = [control("Email", "email")];
    raw.actions = [{ index: 0, label: "Next", visible: true, disabled: false }];
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: enabled,
      readIntendedAccountEmail: () => "Target@Example.test",
    });
    expect((await guarded.fillText("c0", "wrong@example.test")).ok).toBe(false);
    expect((await guarded.clickElement("a0")).ok).toBe(false);
    expect((await guarded.fillText("c0", "target@example.test")).ok).toBe(true);
    expect(hands.fillText).toHaveBeenCalledExactlyOnceWith(
      "c0",
      "Target@Example.test",
    );
    raw.controls[0].value = "Target@Example.test";
    expect((await guarded.clickElement("a0")).ok).toBe(true);
  });
  test.each(["email", "permission", "label", "frame", "scope"])(
    "fresh %s change refuses without a write",
    async (change) => {
      const { raw, hands } = fixture();
      let reads = 0,
        emails = 0,
        permissions = 0,
        entries = 0;
      const observe = hands.observe;
      hands.observe = async () => {
        if (++reads === 2) {
          if (change === "label") raw.actions[1].label = "Other action";
          if (change === "frame")
            raw.actions[1].frame = {
              origin: "https://accounts.google.com",
              pathname: "/accountchooser",
            };
        }
        return { ...(await observe()), signature: "stable-signature" };
      };
      hands.readAccountFlowEntry = () =>
        Promise.resolve(
          change === "scope" && ++entries > 1
            ? [
                basic,
                "https://accounts.google.com/o/oauth2/v2/auth?scope=drive",
              ]
            : [basic],
        );
      const guarded = withBrowserPermissions(hands, {
        readBrowserPermissions: () =>
          BrowserAgentPermissionsSchema.parse({
            googleSignIn: change !== "permission" || ++permissions === 1,
          }),
        readIntendedAccountEmail: () =>
          change === "email" && ++emails > 1
            ? "other@example.test"
            : "target@example.test",
      });
      expect((await guarded.clickElement("a1")).ok).toBe(false);
      expect(hands.clickElement).not.toHaveBeenCalled();
    },
  );
  test("wrapping twice shares receipts and a later stricter policy cannot be bypassed", async () => {
    const { hands } = fixture();
    const permissive = {
      browserPermissions: enabled,
      readIntendedAccountEmail: () => "target@example.test",
    };
    const once = withBrowserPermissions(hands, permissive);
    expect(withBrowserPermissions(once, permissive)).toBe(once);
    const strict = withBrowserPermissions(once, {
      browserPermissions: BrowserAgentPermissionsSchema.parse({}),
    });
    expect(strict).toBe(once);
    expect((await strict.clickElement("a1")).ok).toBe(false);
    expect(hands.clickElement).not.toHaveBeenCalled();
  });
  test("Use another account is attempted once for the known target, with no unknown identity selected", async () => {
    const { raw, hands } = fixture();
    raw.actions = [
      { index: 0, label: "other@example.test", visible: true, disabled: false },
      {
        index: 1,
        label: "Use another account",
        visible: true,
        disabled: false,
      },
    ];
    const guarded = withBrowserPermissions(hands, {
      browserPermissions: enabled,
      readIntendedAccountEmail: () => "target@example.test",
    });
    expect((await guarded.clickElement("a1")).ok).toBe(true);
    raw.url = "https://accounts.google.com/AccountChooser";
    expect((await guarded.clickElement("a1")).ok).toBe(false);
    expect(hands.clickElement).toHaveBeenCalledTimes(1);
  });
});

test("a second permission wrapper does not duplicate the original selection receipt callback", async () => {
  const { raw, hands } = setup("signIn");
  raw.url = "https://accounts.google.com/accountchooser";
  raw.controls = [];
  raw.actions = [
    { index: 0, label: "target@example.test", visible: true, disabled: false },
  ];
  const receipt = vi.fn();
  const permissions = BrowserAgentPermissionsSchema.parse({
    googleSignIn: true,
  });
  const first = withBrowserPermissions(hands, {
    browserPermissions: permissions,
    readIntendedAccountEmail: () => "target@example.test",
    onGoogleAccountSelected: (account) => {
      receipt(account);
    },
  });
  const second = withBrowserPermissions(first, {
    browserPermissions: permissions,
    onGoogleAccountSelected: receipt,
  });
  expect((await second.clickElement("a0")).ok).toBe(true);
  expect(receipt).toHaveBeenCalledExactlyOnceWith("target@example.test");
});

test("an ordinary Continue with saved details is not a sign-in permission", async () => {
  const { raw, hands } = setup("signIn");
  raw.url = "https://fixture.test/application";
  raw.title = "Application";
  raw.bodyText = "Application section 1";
  raw.controls = [{ ...control("Full name", "text"), value: "Robin Ashford" }];
  raw.actions = [
    {
      index: 0,
      label: "Continue with saved details",
      visible: true,
      disabled: false,
      inForm: true,
      submitsForm: false,
    },
  ];
  const guarded = withBrowserPermissions(hands, {});
  expect(browserInteractionKind(await guarded.observe(), "a0")).toBeNull();
  expect(await guarded.clickElement("a0")).toMatchObject({ ok: true });
  expect(hands.clickElement).toHaveBeenCalledOnce();
  raw.actions[0].label = "Continue with Example ID";
  expect(browserInteractionKind(await guarded.observe(), "a0")).toBe("signIn");
  expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
  raw.actions[0].label = "Continue with saved details";
  raw.title = "Sign in";
  raw.bodyText = "Sign in to your account";
  raw.controls.push(control("Password", "password", 1));
  expect(browserInteractionKind(await guarded.observe(), "a0")).toBe("signIn");
  expect(await guarded.clickElement("a0")).toMatchObject({ ok: false });
  expect(hands.clickElement).toHaveBeenCalledOnce();
});
