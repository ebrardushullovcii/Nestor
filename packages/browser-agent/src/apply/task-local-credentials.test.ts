import { describe, expect, test, vi } from "vitest";

import {
  completeTaskLocalSignIn,
  selectObservedSignInAction,
} from "./task-local-credentials";
import type {
  ApplyBlocker,
  ApplyFormObservation,
  ApplyPageHands,
} from "./types";

function observation(blocker: ApplyBlocker | null): ApplyFormObservation {
  return {
    observedAt: "2026-09-22T10:00:00.000Z",
    signature: "sign-in-v1",
    url: "https://fixture.example/sign-in",
    origin: "https://fixture.example",
    title: "Sign in",
    step: { label: null, index: null, total: null },
    bodyTextExcerpt: "Sign in to continue",
    headings: [],
    controls: [
      {
        ref: "identifier",
        kind: "text",
        label: "Email",
        groupLabel: "",
        placeholder: "",
        required: true,
        disabled: false,
        readOnly: false,
        visible: true,
        value: "",
        credentialRole: "identifier",
        checked: false,
        options: [],
        selectedOptionLabel: "",
        invalid: false,
        validationMessage: "",
        questionKind: "personal_info",
        answerControlType: "text",
        answered: false,
      },
      {
        ref: "password",
        kind: "other",
        label: "Password",
        groupLabel: "",
        placeholder: "",
        required: true,
        disabled: false,
        readOnly: false,
        visible: true,
        value: "",
        credentialRole: "password",
        checked: false,
        options: [],
        selectedOptionLabel: "",
        invalid: false,
        validationMessage: "",
        questionKind: "other",
        answerControlType: "text",
        answered: false,
      },
    ],
    actions: [
      {
        ref: "sign-in",
        label: "Sign in",
        kind: "advance",
        visible: true,
        disabled: false,
        formAction: "https://fixture.example/session",
        formMethod: "POST",
      },
    ],
    links: [],
    clickables: [],
    openedTabs: [],
    validationErrors: [],
    loading: false,
    blocker,
  };
}

function blocker(code: ApplyBlocker["code"]): ApplyBlocker {
  return {
    code,
    requiresPerson: true,
    summary: "Person-owned step",
    detail: "Complete this step yourself.",
    nextActionLabel: "Open page",
  };
}

function createHands(
  observations: readonly ApplyFormObservation[],
): ApplyPageHands {
  let observationIndex = 0;
  return {
    observe: vi.fn(() => {
      const next =
        observations[Math.min(observationIndex, observations.length - 1)];
      observationIndex += 1;
      if (!next)
        return Promise.reject(new Error("Missing observation fixture."));
      return Promise.resolve(next);
    }),
    navigate: vi.fn((url: string) =>
      Promise.resolve({ ok: true as const, url }),
    ),
    clickElement: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    pressKey: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    scroll: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    wait: vi.fn(() => Promise.resolve(undefined)),
    goBack: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        url: "https://fixture.example/sign-in",
      }),
    ),
    readText: vi.fn(() => Promise.resolve("")),
    fillText: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    chooseOption: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "",
      }),
    ),
    setToggle: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    uploadFile: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    clickAction: vi.fn(() =>
      Promise.resolve({ ok: true as const, observedValue: "" }),
    ),
    followLink: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        url: "https://fixture.example/sign-in",
      }),
    ),
  };
}

describe("completeTaskLocalSignIn", () => {
  test("selects only one observed existing-account POST action", () => {
    const valid = observation(blocker("site_login_required"));
    expect(selectObservedSignInAction(valid)).toEqual({
      ref: "sign-in",
      label: "Sign in",
      formAction: "https://fixture.example/session",
      formMethod: "POST",
    });
    expect(selectObservedSignInAction({ ...valid, blocker: null })).toBeNull();
    expect(
      selectObservedSignInAction({
        ...valid,
        blocker: blocker("account_creation_required"),
      }),
    ).toBeNull();
    expect(
      selectObservedSignInAction({
        ...valid,
        actions: [...valid.actions, { ...valid.actions[0], ref: "other" }],
      }),
    ).toBeNull();
    expect(
      selectObservedSignInAction({
        ...valid,
        actions: [{ ...valid.actions[0], formMethod: "GET" }],
      }),
    ).toBeNull();
    expect(
      selectObservedSignInAction({
        ...valid,
        controls: [
          ...valid.controls,
          { ...valid.controls[1], ref: "password-2" },
        ],
      }),
    ).toBeNull();
  });
  test("uses an explicitly supplied credential only on an exact observed sign-in form", async () => {
    const hands = createHands([
      observation(blocker("site_login_required")),
      observation(null),
    ]);
    const load = vi.fn(() => ({
      identifier: "fixture-person@example.test",
      password: "test-password",
    }));
    const clickAuthorizedFormAction = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "clicked",
      }),
    );

    await completeTaskLocalSignIn({
      hands,
      clickAuthorizedFormAction,
      credential: { reference: "command-1", load },
    });

    expect(load).toHaveBeenCalledOnce();
    expect(hands.fillText).toHaveBeenNthCalledWith(
      1,
      "identifier",
      "fixture-person@example.test",
    );
    expect(hands.fillText).toHaveBeenNthCalledWith(
      2,
      "password",
      "test-password",
    );
    expect(clickAuthorizedFormAction).toHaveBeenCalledWith("sign-in");
    expect(hands.clickAction).not.toHaveBeenCalled();
  });

  test.each([
    "account_creation_required",
    "multi_factor_required",
    "security_challenge",
  ] as const)(
    "refuses %s before loading or filling credentials",
    async (code) => {
      const hands = createHands([observation(blocker(code))]);
      const load = vi.fn(() => ({ identifier: "unused", password: "unused" }));
      const clickAuthorizedFormAction = vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          observedValue: "clicked",
        }),
      );

      await expect(
        completeTaskLocalSignIn({
          hands,
          clickAuthorizedFormAction,
          credential: { reference: "command-refused", load },
        }),
      ).rejects.toThrow();

      expect(load).not.toHaveBeenCalled();
      expect(hands.fillText).not.toHaveBeenCalled();
      expect(clickAuthorizedFormAction).not.toHaveBeenCalled();
    },
  );

  test("refuses a wrong or stale page binding before loading credentials", async () => {
    const hands = createHands([observation(null)]);
    const load = vi.fn(() => ({ identifier: "unused", password: "unused" }));
    const clickAuthorizedFormAction = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "clicked",
      }),
    );

    await expect(
      completeTaskLocalSignIn({
        hands,
        clickAuthorizedFormAction,
        credential: { reference: "command-wrong-page", load },
      }),
    ).rejects.toThrow(/not an observed sign-in form/i);
    expect(load).not.toHaveBeenCalled();
    expect(hands.fillText).not.toHaveBeenCalled();
  });

  test("refuses a GET sign-in form before loading or filling credentials", async () => {
    const unsafe = observation(blocker("site_login_required"));
    unsafe.actions[0].formMethod = "GET";
    const hands = createHands([unsafe]);
    const load = vi.fn(() => ({ identifier: "unused", password: "unused" }));
    const clickAuthorizedFormAction = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        observedValue: "clicked",
      }),
    );

    await expect(
      completeTaskLocalSignIn({
        hands,
        clickAuthorizedFormAction,
        credential: { reference: "unsafe-get", load },
      }),
    ).rejects.toThrow(/safe POST sign-in action/i);

    expect(load).not.toHaveBeenCalled();
    expect(hands.fillText).not.toHaveBeenCalled();
    expect(clickAuthorizedFormAction).not.toHaveBeenCalled();
  });

  test("sanitizes a browser failure that echoes the supplied password", async () => {
    const suppliedPassword = "test-secret-value";
    const hands = createHands([observation(blocker("site_login_required"))]);
    vi.mocked(hands.fillText)
      .mockResolvedValueOnce({ ok: true, observedValue: "" })
      .mockRejectedValueOnce(
        new Error(`locator.fill(${suppliedPassword}) timed out`),
      );

    let failure: unknown;
    try {
      await completeTaskLocalSignIn({
        hands,
        clickAuthorizedFormAction: vi.fn(() =>
          Promise.resolve({
            ok: true as const,
            observedValue: "clicked",
          }),
        ),
        credential: {
          reference: "command-error",
          load: () => ({
            identifier: "fixture-person@example.test",
            password: suppliedPassword,
          }),
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(failure)).not.toContain(suppliedPassword);
    expect((failure as Error).message).toBe(
      "The sign-in password could not be entered.",
    );
  });
});
