import {
  BrowserAgentPermissionsSchema,
  type RawApplyControl,
  type RawApplyPage,
} from "@nestor/contracts";
import { describe, expect, test, vi } from "vitest";
import { buildApplyFormObservation } from "./apply/page-hands";
import type { ApplyPageHands } from "./apply/types";
import {
  browserStepReadyForAgent,
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
    navigate: vi.fn((url: string) => Promise.resolve({ ok: true as const, url })),
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

describe("browser permissions at the action boundary", () => {
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
