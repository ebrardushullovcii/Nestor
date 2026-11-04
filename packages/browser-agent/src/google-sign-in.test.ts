import { describe, expect, test } from "vitest";
import type { ApplyFormAction, ApplyFormObservation } from "./apply/types";
import {
  googleChooserAccount,
  googleFlowEntry,
  googleBasicConfirmation,
  googleIdentifierStep,
  googleIdentifierNext,
  googleUseAnotherAccount,
  googleOptionalOfferDecline,
  googleEntryShape,
  type GoogleIdentityContext,
  googleSignInInteraction,
  hasGoogleSignInAction,
  isGoogleAccountPage,
} from "./google-sign-in";

const identity: GoogleIdentityContext = {
  intendedEmail: "synthetic@example.test",
  entry: "basic",
  fenced: false,
};
const action = (
  label: string,
  patch: Partial<ApplyFormAction> = {},
): ApplyFormAction => ({
  ref: "a0",
  label,
  kind: "other",
  visible: true,
  disabled: false,
  submitsForm: false,
  ...patch,
});
const page = (
  patch: Partial<ApplyFormObservation> = {},
): ApplyFormObservation => ({
  observedAt: "2026-11-03T05:30:00Z",
  signature: "synthetic",
  url: "https://employer.example/login",
  origin: "https://employer.example",
  title: "Sign in",
  step: { label: null, index: null, total: null },
  bodyTextExcerpt: "",
  headings: [],
  controls: [],
  actions: [],
  links: [],
  clickables: [],
  openedTabs: [],
  validationErrors: [],
  loading: false,
  blocker: null,
  ...patch,
});
const credential = (
  role: "identifier" | "password" | "one_time_code",
): ApplyFormObservation["controls"][number] => ({
  ref: "c0",
  kind: "text",
  label: "Credential",
  groupLabel: "",
  placeholder: "",
  required: true,
  disabled: false,
  readOnly: false,
  visible: true,
  value: "",
  credentialRole: role,
  checked: false,
  options: [],
  selectedOptionLabel: "",
  invalid: false,
  validationMessage: "",
  questionKind: "other",
  answerControlType: "text",
  attestationKind: null,
  answered: false,
});

describe("observed Google provider controls", () => {
  test.each([
    "Google",
    "Google account",
    "Continue with Google",
    "Sign up with Google",
    "Sign in with Google, opens in new tab",
    "Google — Sign in",
    "Continue as Jamie — Google account",
    "Register using Google (new window)",
  ])("recognizes explicit provider wording: %s", (label) => {
    const observation = page({ actions: [action(label)] });
    expect(googleSignInInteraction(observation, "a0")).toBe("googleSignIn");
    expect(hasGoogleSignInAction(observation)).toBe(true);
  });

  test.each([
    "Continue as Jamie",
    "Continue as synthetic@example.test",
    "Google jobs",
    "Googleish sign in",
    "Open Google",
  ])("does not invent provider evidence for %s", (label) => {
    expect(
      googleSignInInteraction(page({ actions: [action(label)] }), "a0"),
    ).toBeNull();
  });

  test("an unrelated empty password form does not block the explicit Google route", () => {
    expect(
      googleSignInInteraction(
        page({
          actions: [action("Continue with Google")],
          controls: [credential("password")],
        }),
        "a0",
      ),
    ).toBe("googleSignIn");
  });

  test.each([
    { visible: false },
    { disabled: true },
    { kind: "final" as const },
  ])("rejects an unavailable or final action: %j", (patch) => {
    const observation = page({
      actions: [action("Continue with Google", patch)],
    });
    expect(googleSignInInteraction(observation, "a0")).toBeNull();
    expect(hasGoogleSignInAction(observation)).toBe(false);
  });

  test("supports observed links and clickables but not unknown/hidden refs", () => {
    const observation = page({
      links: [
        {
          ref: "l0",
          label: "Google: sign in",
          href: "https://accounts.google.com/o/oauth2/v2/auth",
          origin: "https://accounts.google.com",
          destination: "page",
          opensNewWindow: true,
          visible: true,
          topOffset: 0,
        },
      ],
      clickables: [
        {
          ref: "e0",
          label: "Continue with Google (opens window)",
          role: "button",
          tagName: "div",
          disabled: false,
          visible: true,
        },
        {
          ref: "e1",
          label: "Continue with Google",
          role: "button",
          tagName: "div",
          disabled: false,
          visible: false,
        },
      ],
    });
    expect(googleSignInInteraction(observation, "l0")).toBe("googleSignIn");
    expect(googleSignInInteraction(observation, "e0")).toBe("googleSignIn");
    expect(googleSignInInteraction(observation, "e1")).toBeNull();
    expect(googleSignInInteraction(observation, "absent")).toBeNull();
  });

  test("a loading page does not offer an action from an unstable observation", () => {
    expect(
      hasGoogleSignInAction(
        page({ loading: true, actions: [action("Google")] }),
      ),
    ).toBe(false);
  });
});

describe("personalized GIS button evidence", () => {
  test("the button page's exact secure GIS URL supports personalized extra text", () => {
    expect(
      googleSignInInteraction(
        page({
          url: "https://accounts.google.com/gsi/button?client_id=synthetic",
          actions: [action("Continue as Jamie, opens in a new window")],
        }),
        "a0",
      ),
    ).toBe("googleSignIn");
  });

  test.each([
    "https://accounts.google.com/gsi/client",
    "https://accounts.google.com/gsi/button-evil",
    "https://accounts.google.com/signin/oauth/consent",
    "https://accounts.google.com/v3/signin/identifier",
  ])("a nearby Google route is not the GIS button: %s", (url) => {
    expect(
      googleSignInInteraction(
        page({ url, actions: [action("Continue as Jamie")] }),
        "a0",
      ),
    ).toBe("google_handoff");
  });

  test("a flattened frame ref/section cannot prove a personalized button belongs to Google", () => {
    expect(
      googleSignInInteraction(
        page({
          actions: [
            action("Continue as Jamie", { ref: "f1a0", section: "Google" }),
          ],
        }),
        "f1a0",
      ),
    ).toBeNull();
  });

  test.each(["identifier", "password", "one_time_code"] as const)(
    "credentials remain a handoff: %s",
    (role) => {
      expect(
        googleSignInInteraction(
          page({
            url: "https://accounts.google.com/gsi/button",
            actions: [action("Continue as Jamie")],
            controls: [credential(role)],
          }),
          "a0",
        ),
      ).toBe("google_handoff");
    },
  );
});

describe("account and consent boundaries", () => {
  test.each([
    "https://accounts.google.com/v3/signin/accountchooser",
    "https://accounts.google.com/AccountChooser",
  ])(
    "duplicate intended entries remain ambiguous despite localized headings on %s",
    (url) => {
      const observation = page({
        url,
        headings: [{ level: 1, text: "Konto auswählen" }],
        actions: [
          action("Jamie Synthetic@Example.test", { ref: "a0" }),
          action("Jamie synthetic@example.test", { ref: "a1" }),
        ],
      });
      expect(googleSignInInteraction(observation, "a0", identity)).toBe(
        "google_handoff",
      );
      expect(googleChooserAccount(observation, "a1", identity)).toBeNull();
      expect(hasGoogleSignInAction(observation, identity)).toBe(false);
    },
  );

  test("two distinct accounts stay with the person", () => {
    const observation = page({
      url: "https://accounts.google.com/v3/signin/accountchooser",
      actions: [
        action("one@example.test"),
        action("two@example.test", { ref: "a1" }),
      ],
    });
    expect(hasGoogleSignInAction(observation)).toBe(false);
  });

  test.each([
    "https://accounts.google.com/signin/oauth/consent",
    "https://accounts.google.com/o/oauth2/v2/auth",
  ])(
    "an account email plus a chooser heading cannot authorize consent on %s",
    (url) => {
      expect(
        googleSignInInteraction(
          page({
            url,
            headings: [{ level: 1, text: "Choose an account" }],
            actions: [action("Jamie synthetic@example.test")],
          }),
          "a0",
        ),
      ).toBe("google_handoff");
    },
  );

  test("a login form containing a known email is not a signed-in account selector", () => {
    expect(
      googleSignInInteraction(
        page({
          url: "https://accounts.google.com/v3/signin/accountchooser",
          headings: [{ level: 1, text: "Choose an account" }],
          controls: [credential("identifier")],
          actions: [action("Jamie synthetic@example.test")],
        }),
        "a0",
      ),
    ).toBe("google_handoff");
  });

  test.each([
    "http://accounts.google.com/gsi/button",
    "https://accounts.google.com:444/gsi/button",
    "https://user@accounts.google.com/gsi/button",
    "https://accounts.google.com.evil.test/gsi/button",
    "https://evil.test/?next=https://accounts.google.com/gsi/button",
    "not a URL",
  ])("does not trust a lookalike or insecure Google origin: %s", (url) => {
    const observation = page({ url, actions: [action("Continue as Jamie")] });
    expect(googleSignInInteraction(observation, "a0")).not.toBe("googleSignIn");
  });

  test("insecure Google hosts retain the permission boundary without authorizing a click", () => {
    const observation = page({
      url: "http://accounts.google.com/gsi/button",
      actions: [action("Continue with Google")],
    });
    expect(isGoogleAccountPage(observation)).toBe(true);
    expect(googleSignInInteraction(observation, "a0")).toBe("google_handoff");
    expect(
      isGoogleAccountPage(
        page({ url: "https://accounts.google.com.evil.test" }),
      ),
    ).toBe(false);
    expect(
      isGoogleAccountPage(
        page({ url: "https://evil.test/?next=https://accounts.google.com" }),
      ),
    ).toBe(false);
    expect(isGoogleAccountPage(page({ url: "not a URL" }))).toBe(false);
  });

  test("MFA cannot be cleared by personalized GIS wording", () => {
    expect(
      googleSignInInteraction(
        page({
          url: "https://accounts.google.com/gsi/button",
          actions: [action("Continue as Jamie")],
          blocker: {
            code: "multi_factor_required",
            summary: "Verification",
            detail: "Synthetic",
            nextActionLabel: "Continue",
          },
        }),
        "a0",
      ),
    ).toBe("google_handoff");
  });
});

describe("ref-bound GIS and chooser structure", () => {
  const frame = {
    origin: "https://accounts.google.com",
    pathname: "/gsi/button",
  };
  test("localized GIS frame wins over an employer password form without reading the label", () => {
    const observation = page({
      controls: [credential("password")],
      actions: [action("Continuer en tant que Jamie", { frame })],
    });
    expect(googleSignInInteraction(observation, "a0")).toBe("googleSignIn");
  });
  test.each([
    ["http://accounts.google.com", "/gsi/button", "google_handoff"],
    ["https://accounts.google.com:8443", "/gsi/button", "google_handoff"],
    ["https://accounts.google.com.evil.test", "/gsi/button", null],
    ["https://accounts.google.com", "/gsi/iframe/select", "google_handoff"],
  ])("rejects owner %s %s", (origin, pathname, expected) => {
    expect(
      googleSignInInteraction(
        page({
          actions: [
            action("Continuer en tant que Jamie", {
              frame: { origin, pathname },
            }),
          ],
        }),
        "a0",
      ),
    ).toBe(expected);
  });
  test.each([{ disabled: true }, { visible: false }])(
    "unavailable GIS clickable remains classified for handoff: %j",
    (patch) => {
      expect(
        googleSignInInteraction(
          page({
            clickables: [
              {
                ref: "e0",
                label: "Continuer",
                role: "button",
                tagName: "div",
                visible: true,
                disabled: false,
                frame,
                ...patch,
              },
            ],
          }),
          "e0",
        ),
      ).toBe("google_handoff");
    },
  );
  test("a credential field in the GIS owner blocks it", () => {
    expect(
      googleSignInInteraction(
        page({
          actions: [action("Continuer", { frame })],
          controls: [{ ...credential("identifier"), frame }],
        }),
        "a0",
      ),
    ).toBe("google_handoff");
  });
  test("duplicate intended entries across links and clickables remain ambiguous", () => {
    const observation = page({
      url: "https://accounts.google.com/signin/oauthchooseaccount",
      links: [
        {
          ref: "l0",
          label: "  Jamie SYNTHETIC@example.test  ",
          href: "https://accounts.google.com/next",
          origin: "https://accounts.google.com",
          destination: "page",
          opensNewWindow: false,
          visible: true,
          topOffset: 0,
        },
      ],
      clickables: [
        {
          ref: "e0",
          label: "Jamie synthetic@example.test",
          role: "option",
          tagName: "div",
          visible: true,
          disabled: false,
        },
      ],
      actions: [action("Use another account")],
    });
    expect(googleChooserAccount(observation, "l0", identity)).toBeNull();
    expect(googleChooserAccount(observation, "e0", identity)).toBeNull();
    expect(googleSignInInteraction(observation, "a0")).toBe("google_handoff");
  });
  test("scope toggles and account rows with multiple addresses are handoffs", () => {
    const observation = page({
      url: "https://accounts.google.com/accountchooser",
      actions: [action("Jamie synthetic@example.test")],
    });
    expect(
      googleSignInInteraction(
        {
          ...observation,
          controls: [
            {
              ...credential("identifier"),
              kind: "checkbox",
              credentialRole: null,
            },
          ],
        },
        "a0",
      ),
    ).toBe("google_handoff");
    expect(
      googleChooserAccount(
        {
          ...observation,
          actions: [action("one@example.test two@example.test")],
        },
        "a0",
      ),
    ).toBeNull();
  });
});

test.each(["identifier", "password", "one_time_code"] as const)(
  "chooser credential %s hands off even with one offered account",
  (role) => {
    const observation = page({
      url: "https://accounts.google.com/accountchooser",
      actions: [action("Jamie synthetic@example.test")],
      controls: [credential(role)],
    });
    expect(googleChooserAccount(observation, "a0")).toBeNull();
    expect(googleSignInInteraction(observation, "a0")).toBe("google_handoff");
  },
);
test.each([
  { headings: [] },
  { headings: [{ level: 1, text: "Choisissez un compte" }] },
])("chooser headings do not affect authority: %j", ({ headings }) => {
  expect(
    googleChooserAccount(
      page({
        url: "https://accounts.google.com/accountchooser",
        headings,
        actions: [action("synthetic@example.test")],
      }),
      "a0",
      identity,
    ),
  ).toBe("synthetic@example.test");
});
test("MFA on the chooser cannot be bypassed by the account label", () => {
  expect(
    googleChooserAccount(
      page({
        url: "https://accounts.google.com/accountchooser",
        actions: [action("synthetic@example.test")],
        blocker: {
          code: "multi_factor_required",
          summary: "Verify",
          detail: "Synthetic",
          nextActionLabel: "Continue",
        },
      }),
      "a0",
    ),
  ).toBeNull();
});

describe("intended Google identity and transient authorization", () => {
  const chooser = (labels: string[]) =>
    page({
      url: "https://accounts.google.com/v3/signin/accountchooser",
      actions: labels.map((label, index) =>
        action(label, { ref: `a${index}` }),
      ),
    });
  test("chooses the unique matching second account, never a sole wrong account or a duplicate", () => {
    const seen = chooser([
      "other@example.test",
      "Synthetic SYNTHETIC@example.test",
    ]);
    expect(googleChooserAccount(seen, "a1", identity)).toBe(
      "synthetic@example.test",
    );
    expect(googleChooserAccount(seen, "a0", identity)).toBeNull();
    for (const labels of [
      ["other@example.test"],
      ["synthetic@example.test", "synthetic@example.test"],
      ["synthetic@example.test other@example.test"],
    ])
      expect(hasGoogleSignInAction(chooser(labels), identity)).toBe(false);
    expect(hasGoogleSignInAction(chooser(["synthetic@example.test"]))).toBe(
      false,
    );
    expect(
      hasGoogleSignInAction(seen, { ...identity, intendedEmail: null }),
    ).toBe(false);
  });
  test("Use another account only navigates once a known target is absent, never through ambiguity", () => {
    expect(
      googleUseAnotherAccount(
        chooser(["other@example.test", "Use another account"]),
        "a1",
        identity,
      ),
    ).toBe(true);
    expect(
      googleUseAnotherAccount(
        chooser(["synthetic@example.test", "Use another account"]),
        "a1",
        identity,
      ),
    ).toBe(false);
    expect(
      googleUseAnotherAccount(chooser(["Use another account"]), "a0", {
        ...identity,
        intendedEmail: null,
      }),
    ).toBe(false);
  });
  test.each([
    [
      "https://accounts.google.com/o/oauth2/v2/auth?scope=openid+email+profile",
      "basic",
    ],
    [
      "https://accounts.google.com/o/oauth2/auth?scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email",
      "basic",
    ],
    [
      "https://accounts.google.com/gsi/select?client_id=synthetic&response_type=id_token",
      "basic",
    ],
    ["https://accounts.google.com/gsi/select", "unproven"],
    [
      "https://accounts.google.com/gsi/arbitrary?client_id=synthetic&response_type=id_token",
      "unproven",
    ],
    [
      "https://accounts.google.com/gsi/select?client_id=synthetic&response_type=id_token&scope=drive",
      "unproven",
    ],
    [
      "https://accounts.google.com/gsi/select?client_id=synthetic&response_type=id_token&access_type=offline",
      "unproven",
    ],
    [
      "https://accounts.google.com/o/oauth2/v2/auth?scope=openid+https://www.googleapis.com/auth/drive",
      "unproven",
    ],
    [
      "https://accounts.google.com/o/oauth2/v2/auth?scope=openid&access_type=offline",
      "unproven",
    ],
    [
      "https://accounts.google.com/o/oauth2/v2/auth?scope=openid&include_granted_scopes=true",
      "unproven",
    ],
    [
      "https://accounts.google.com/o/oauth2/v2/auth?scope=openid&scope=drive",
      "unproven",
    ],
    ["https://accounts.google.com/signin/oauth/consent", "unproven"],
    ["http://accounts.google.com/o/oauth2/v2/auth?scope=openid", "unproven"],
    [
      "https://accounts.google.com.evil.test/o/oauth2/v2/auth?scope=openid",
      "unproven",
    ],
  ])("authorization input %s is %s", (url, result) =>
    expect(googleFlowEntry(url)).toBe(result),
  );
  test("a later wider authorization invalidates earlier basic GIS proof; ordinary account paths do not supply proof", () => {
    const basic =
      "https://accounts.google.com/gsi/select?client_id=synthetic&response_type=id_token";
    const intermediate = "https://accounts.google.com/v3/signin/accountchooser";
    expect(googleFlowEntry([basic, intermediate])).toBe("basic");
    expect(
      googleFlowEntry([
        basic,
        intermediate,
        "https://accounts.google.com/o/oauth2/v2/auth?scope=openid+drive",
      ]),
    ).toBe("unproven");
    expect(googleFlowEntry([intermediate])).toBe("unproven");
  });
  test.each([
    "checkbox",
    "wrong_email",
    "second_email",
    "two_buttons",
    "frame",
    "loading",
    "unproven",
    "unfenced",
    "mfa",
  ])("basic confirmation refuses %s", (kind) => {
    const seen = page({
      url: "https://accounts.google.com/signin/oauth/consent",
      bodyTextExcerpt:
        kind === "wrong_email"
          ? "other@example.test"
          : "synthetic@example.test",
      actions: [action("Continue")],
    });
    if (kind === "checkbox")
      seen.controls = [
        { ...credential("identifier"), kind: "checkbox", credentialRole: null },
      ];
    if (kind === "second_email") seen.bodyTextExcerpt += " other@example.test";
    if (kind === "two_buttons")
      seen.actions.push(action("Allow", { ref: "a1" }));
    if (kind === "frame")
      seen.actions[0].frame = {
        origin: "https://accounts.google.com",
        pathname: "/signin/oauth/consent",
      };
    if (kind === "loading") seen.loading = true;
    if (kind === "mfa")
      seen.blocker = {
        code: "multi_factor_required",
        summary: "MFA",
        detail: "Verification",
        nextActionLabel: "Verify",
      };
    expect(
      googleBasicConfirmation(seen, "a0", {
        ...identity,
        entry: kind === "unproven" ? "unproven" : "basic",
        fenced: kind === "unfenced",
      }),
    ).toBeNull();
  });
  test.each([
    "/signup/email",
    "/lifecycle/steps/signup/email",
    "/unknown/identifier",
  ])(
    "identifier entry refuses Google account creation or unknown route %s",
    (pathname) => {
      const seen = page({
        url: `https://accounts.google.com${pathname}`,
        title: "Create your Google Account",
        controls: [
          {
            ...credential("identifier"),
            value: identity.intendedEmail!,
            answered: true,
          },
        ],
        actions: [action("Next")],
        blocker: {
          code: "account_creation_required",
          summary: "Create an account",
          detail: "Create your Google Account",
          nextActionLabel: "Next",
        },
      });
      expect(googleIdentifierStep(seen, "c0", identity)).toBe(false);
      expect(googleIdentifierNext(seen, "a0", identity)).toBe(false);
      expect(googleSignInInteraction(seen, "c0", identity)).toBe(
        "google_handoff",
      );
      expect(googleSignInInteraction(seen, "a0", identity)).toBe(
        "google_handoff",
      );
    },
  );
  test.each([
    "/v3/signin/identifier",
    "/signin/v2/identifier",
    "/signin/identifier",
  ])("identifier entry keeps an existing-account route %s", (pathname) => {
    const seen = page({
      url: `https://accounts.google.com${pathname}`,
      controls: [credential("identifier")],
      actions: [action("Next"), action("Create account", { ref: "a1" })],
    });
    expect(googleIdentifierStep(seen, "c0", identity)).toBe(true);
    seen.controls[0].value = identity.intendedEmail!;
    seen.controls[0].answered = true;
    expect(googleIdentifierNext(seen, "a0", identity)).toBe(true);
  });
  test("a basic confirmation is an allowed step, while identifier Next needs actual retained canonical value", () => {
    expect(
      googleBasicConfirmation(
        page({
          url: "https://accounts.google.com/signin/oauth/consent",
          bodyTextExcerpt: "synthetic@example.test",
          actions: [action("Continue")],
        }),
        "a0",
        identity,
      ),
    ).toBe("synthetic@example.test");
    const seen = page({
      url: "https://accounts.google.com/v3/signin/identifier",
      controls: [credential("identifier")],
      actions: [action("Next")],
    });
    expect(googleIdentifierStep(seen, "c0", identity)).toBe(true);
    expect(googleIdentifierNext(seen, "a0", identity)).toBe(false);
    seen.controls[0].value = "Synthetic@Example.test";
    seen.controls[0].answered = true;
    expect(googleIdentifierNext(seen, "a0", identity)).toBe(true);
    seen.controls.push({ ...credential("password"), ref: "c1" });
    expect(googleIdentifierStep(seen, "c0", identity)).toBe(false);
  });
});

describe("optional Google offers", () => {
  const offer = (patch: Partial<ApplyFormObservation> = {}) =>
    page({
      url: "https://accounts.google.com/v3/signin/speedbump/passkeyenrollment",
      origin: "https://accounts.google.com",
      title: "Sign in faster",
      bodyTextExcerpt: "Sign in faster with a passkey synthetic@example.test",
      actions: [
        action("Create a passkey", { ref: "a0" }),
        action("Not now", { ref: "a1" }),
      ],
      ...patch,
    });
  test("only the offer's own Not now is a decline; creating a passkey stays human", () => {
    expect(googleOptionalOfferDecline(offer(), "a1", identity)).toBe(true);
    expect(googleOptionalOfferDecline(offer(), "a0", identity)).toBe(false);
    expect(googleSignInInteraction(offer(), "a1", identity)).toBe(
      "googleSignIn",
    );
    expect(googleSignInInteraction(offer(), "a0", identity)).toBe(
      "google_handoff",
    );
  });
  test.each([
    [
      "a passkey sign-in challenge",
      offer({
        url: "https://accounts.google.com/v3/signin/challenge/pk",
        actions: [
          action("Try another way", { ref: "a0" }),
          action("Not now", { ref: "a1" }),
        ],
      }),
    ],
    [
      "a consent page",
      offer({ url: "https://accounts.google.com/signin/oauth/consent" }),
    ],
    [
      "an identifier page",
      offer({ url: "https://accounts.google.com/v3/signin/identifier" }),
    ],
    [
      "another identity shown",
      offer({ bodyTextExcerpt: "other@example.test is signed in" }),
    ],
    ["a visible field", offer({ controls: [credential("one_time_code")] })],
    [
      "two declines",
      offer({
        actions: [
          action("Not now", { ref: "a1" }),
          action("Skip", { ref: "a2" }),
        ],
      }),
    ],
    ["a page still loading", offer({ loading: true })],
    [
      "an MFA blocker",
      offer({
        blocker: {
          code: "multi_factor_required",
          requiresPerson: true,
          summary: "Code",
          detail: "Code",
          nextActionLabel: "Enter the code",
        },
      }),
    ],
    ["a missing Profile email", offer()],
  ] as const)("%s is never declined around", (name, observed) => {
    expect(
      googleOptionalOfferDecline(
        observed,
        "a1",
        name === "a missing Profile email"
          ? { ...identity, intendedEmail: null }
          : identity,
      ),
    ).toBe(false);
  });
  test("an unproven entry shape names host, path and parameter names only", () => {
    const shape = googleEntryShape([
      "https://accounts.google.com/o/oauth2/v2/auth?scope=openid%20drive&state=hidden-state&client_id=123.apps",
      "https://accounts.google.com/gsi/select/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789?nonce=n",
      "https://accounts.google.com/v3/signin/accountchooser?flow=x",
      "https://accounts.google.com/signin/oauth/consent?flow=x",
      "not a url",
    ]);
    expect(shape).toBe(
      "accounts.google.com/o/oauth2/v2/auth (client_id, scope, state); accounts.google.com/gsi/select/:id (nonce); an entry that could not be recorded",
    );
    for (const value of [
      "drive",
      "openid",
      "hidden-state",
      "123.apps",
      "AbCdEf",
    ])
      expect(shape).not.toContain(value);
    expect(googleEntryShape([])).toBe("no Google authorization entry");
    // Ordinary account pages alone are not an authorization entry.
    expect(
      googleEntryShape([
        "https://accounts.google.com/v3/signin/accountchooser?flow=x",
      ]),
    ).toBe("no Google authorization entry");
  });
});
