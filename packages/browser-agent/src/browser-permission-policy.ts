import {
  BrowserAgentPermissionsSchema,
  type BrowserAgentPermissions,
} from "@nestor/contracts";
import { isSecurityChallengeControl } from "./apply/blockers";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";
import {
  googleSignInInteraction,
  hasGoogleSignInAction,
  isGoogleAccountPage,
} from "./google-sign-in";

export interface BrowserPermissionPolicy {
  browserPermissions?: BrowserAgentPermissions;
  /** Read before each interaction, so turning a permission off takes effect now. */
  readBrowserPermissions?: () =>
    | BrowserAgentPermissions
    | Promise<BrowserAgentPermissions>;
  /** Host-only autofill: no secret, credential id or vault tool enters a model turn. */
  prepareBrowserCredentials?: (url: string) => Promise<boolean>;
}

export const SIGN_IN_ACTION =
  /^(?:(?:sign|log)\s?in|login|continue with\s|sign in with\s|log in with\s)/iu;
export const CREATE_ACCOUNT_ACTION =
  /^(?:create (?:an? |your |candidate )?account|create profile|register|sign\s?up)(?:\b|$)/iu;
const FINAL_APPLICATION_ACTION =
  /\b(?:submit|send|complete|finish)\b.{0,24}\bapplication\b|\bapply now\b/iu;
const CHALLENGE_ACTION =
  /^(?:verify|check|confirm|submit answer|next challenge|try again|start puzzle)(?:\b|$)/iu;

export type BrowserInteractionKind =
  | keyof BrowserAgentPermissions
  | "google_handoff"
  | "mfa"
  | "password";

export function browserInteractionKind(
  page: ApplyFormObservation,
  ref: string | undefined,
): BrowserInteractionKind | null {
  const control = page.controls.find((entry) => entry.ref === ref);
  if (page.blocker?.code === "multi_factor_required") return "mfa";
  if (control?.credentialRole === "one_time_code") return "mfa";
  if (control?.credentialRole === "password") return "password";
  if (control && isSecurityChallengeControl(control)) return "solveCaptchas";
  const item =
    page.actions.find((entry) => entry.ref === ref) ??
    page.links.find((entry) => entry.ref === ref) ??
    page.clickables.find((entry) => entry.ref === ref);
  const label = item?.label.trim() ?? "";
  if (/\bgoogle\b/iu.test(label) || isGoogleAccountPage(page)) {
    const google = googleSignInInteraction(page, ref);
    if (google) return google;
  }
  if (FINAL_APPLICATION_ACTION.test(label)) return null;
  if (CREATE_ACCOUNT_ACTION.test(label)) return "createAccounts";
  if (SIGN_IN_ACTION.test(label)) {
    // An SSO button on a registration page creates an account, even if its
    // label happens to say Sign in with Google.
    return page.blocker?.code === "account_creation_required" ||
      CREATE_ACCOUNT_ACTION.test(page.title ?? "") ||
      page.headings.some((heading) => CREATE_ACCOUNT_ACTION.test(heading.text))
      ? "createAccounts"
      : "signIn";
  }
  if (
    page.blocker?.code === "security_challenge" &&
    CHALLENGE_ACTION.test(label)
  )
    return "solveCaptchas";
  if (
    page.blocker?.code === "security_challenge" &&
    page.blocker.requiresPerson &&
    item &&
    (/(?:captcha|challenge|verify.*human)/iu.test(
      ("section" in item ? item.section : "") ?? "",
    ) ||
      !page.controls.some(
        (entry) => entry.visible && !isSecurityChallengeControl(entry),
      ))
  )
    return "solveCaptchas";
  if (control || /^(?:continue|next)$/iu.test(label)) {
    if (page.blocker?.code === "account_creation_required")
      return "createAccounts";
    if (page.blocker?.code === "site_login_required") return "signIn";
  }
  return null;
}

export async function currentBrowserPermissions(
  policy: BrowserPermissionPolicy,
): Promise<BrowserAgentPermissions> {
  return BrowserAgentPermissionsSchema.parse(
    policy.readBrowserPermissions
      ? await policy.readBrowserPermissions()
      : (policy.browserPermissions ?? {}),
  );
}

/** Whether a previously handed-over step now has enough input for an agent. */
export function browserStepReadyForAgent(
  page: ApplyFormObservation,
  permissions: BrowserAgentPermissions,
): boolean {
  if (page.loading || page.blocker?.code === "multi_factor_required")
    return false;
  const controls = page.controls.filter(
    (entry) => entry.visible && !entry.disabled,
  );
  if (controls.some((entry) => entry.credentialRole === "one_time_code"))
    return false;
  if (page.blocker?.code === "security_challenge")
    return (
      permissions.solveCaptchas && controls.some(isSecurityChallengeControl)
    );
  const enabled =
    page.blocker?.code === "account_creation_required"
      ? permissions.createAccounts
      : page.blocker?.code === "site_login_required" && permissions.signIn;
  const passwords = controls.filter(
    (entry) => entry.credentialRole === "password",
  );
  if (permissions.googleSignIn && hasGoogleSignInAction(page)) return true;
  if (isGoogleAccountPage(page)) return false;
  return Boolean(
    enabled && passwords.length && passwords.every((entry) => entry.answered),
  );
}

export function describeBrowserPermissions(
  policy: BrowserPermissionPolicy,
): string {
  const permissions = BrowserAgentPermissionsSchema.parse(
    policy.browserPermissions ?? {},
  );
  return [
    `Browser permissions: CAPTCHA ${permissions.solveCaptchas ? "ON" : "OFF"}; website sign-in ${permissions.signIn ? "ON" : "OFF"}; Google sign-in/sign-up ${permissions.googleSignIn ? "ON" : "OFF"}; account creation ${permissions.createAccounts ? "ON" : "OFF"}.`,
    ...(permissions.googleSignIn
      ? [
          "Google: use its button or sole signed-in account, even beside an empty password form. This may register a site account. Hand off Google login, multiple accounts and access requests; never create Google accounts.",
        ]
      : []),
    "Use visible controls for enabled steps; hand off others. Reuse sessions or host-filled saved logins. Never request or type passwords or MFA codes; the person enters missing credentials on-site. Sending and extra consent stay separate. Check results; never repeat an uncertain account action.",
  ].join("\n");
}

/** Enforcement shared by search, source checks and Apply, below all their tools. */
export function withBrowserPermissions(
  hands: ApplyPageHands,
  policy: BrowserPermissionPolicy,
): ApplyPageHands {
  const attemptedAccountActions = new Set<string>();
  const prepareCredentials =
    policy.prepareBrowserCredentials ?? hands.prepareBrowserCredentials;
  const refusal = async (
    ref: string | undefined,
    secretWrite = false,
    observed?: ApplyFormObservation,
  ): Promise<string | null> => {
    const page = observed ?? (await hands.observe());
    const kind = browserInteractionKind(page, ref);
    if (kind === "mfa")
      return "Enter the verification code yourself on the website, then continue.";
    if (kind === "google_handoff")
      return "Complete Google's account selection, sign-in or access request yourself on the website, then continue.";
    if (kind === "password")
      return secretWrite
        ? "Enter passwords yourself on the website. They are never given to the agent."
        : null;
    if (!kind) return null;
    const allowed = await currentBrowserPermissions(policy);
    return allowed[kind]
      ? null
      : `${kind === "solveCaptchas" ? "Solving CAPTCHAs" : kind === "googleSignIn" ? "Google sign-in/sign-up" : kind === "signIn" ? "Signing in" : "Creating accounts"} is off in Settings. Leave this step to the person.`;
  };
  const click = async (ref: string) => {
    const page = await hands.observe();
    const denied = await refusal(ref, false, page);
    if (denied) return { ok: false as const, error: denied };
    const kind = browserInteractionKind(page, ref);
    const action = page.actions.find((entry) => entry.ref === ref);
    if (kind === "googleSignIn") {
      const fresh = await hands.observe();
      if (
        fresh.url !== page.url ||
        fresh.signature !== page.signature ||
        browserInteractionKind(fresh, ref) !== "googleSignIn"
      )
        return {
          ok: false as const,
          error:
            "The Google step changed. Inspect the page again before continuing.",
        };
      if (!(await currentBrowserPermissions(policy)).googleSignIn)
        return {
          ok: false as const,
          error: "Google sign-in/sign-up was turned off before this action.",
        };
    }
    if (
      kind === "signIn" ||
      kind === "createAccounts" ||
      kind === "googleSignIn"
    ) {
      if (
        kind !== "googleSignIn" &&
        page.controls.some(
          (entry) =>
            entry.visible &&
            entry.credentialRole === "password" &&
            !entry.answered,
        )
      )
        return {
          ok: false as const,
          error: "Enter the password on the website, then continue this task.",
        };
      const key = `${page.url}|${page.signature}|${kind}|${ref}`;
      if (attemptedAccountActions.has(key))
        return {
          ok: false as const,
          error:
            "That account action was already attempted on this page. Check its result on the website before retrying.",
        };
      attemptedAccountActions.add(key);
    }
    if (
      (kind === "signIn" ||
        kind === "createAccounts" ||
        kind === "googleSignIn" ||
        kind === "solveCaptchas") &&
      action?.submitsForm
    ) {
      if (
        !hands.clickAuthorizedFormAction ||
        action.formMethod?.toUpperCase() !== "POST" ||
        !action.formAction
      )
        return {
          ok: false as const,
          error:
            "This account or verification action cannot be sent through an exact form action. Complete this step on the website.",
        };
      // A page containing an application send control is never an account
      // submission, even when it also has sign-in or verification copy.
      if (
        page.actions.some((entry) =>
          FINAL_APPLICATION_ACTION.test(entry.label),
        ) ||
        page.controls.some((entry) => entry.kind === "file" && entry.answered)
      )
        return {
          ok: false as const,
          error:
            "This form also contains an application send action. Use the application's separate send flow.",
        };
      if (
        kind === "solveCaptchas" &&
        page.controls.some(
          (entry) =>
            entry.visible &&
            !entry.disabled &&
            !isSecurityChallengeControl(entry),
        )
      )
        return {
          ok: false as const,
          error:
            "This verification button shares a page with other form answers. Complete the verification on the website; it cannot authorize sending those answers.",
        };
      if (!(await currentBrowserPermissions(policy))[kind])
        return {
          ok: false as const,
          error: "The browser permission was turned off before this action.",
        };
      return hands.clickAuthorizedFormAction(ref);
    }
    return hands.clickElement(ref);
  };
  return {
    ...hands,
    navigate: async (url) => {
      const page = await hands.observe();
      const link = page.links.find((entry) => entry.href === url);
      if (
        isGoogleAccountPage({ url }) &&
        !(await currentBrowserPermissions(policy)).googleSignIn
      )
        return {
          ok: false,
          error:
            "Google sign-in/sign-up is off in Settings. Leave this step to the person.",
        };
      if (link) {
        const denied = await refusal(link.ref, false, page);
        if (denied) return { ok: false, error: denied };
      }
      return hands.navigate(url);
    },
    observe: async () => {
      let page = await hands.observe();
      const permissions = await currentBrowserPermissions(policy);
      if (
        isGoogleAccountPage(page) &&
        !(permissions.googleSignIn && hasGoogleSignInAction(page))
      )
        return {
          ...page,
          blocker: {
            code: "site_login_required",
            requiresPerson: true,
            summary: "Google needs you to finish this step.",
            detail:
              "Choose your Google account, sign in or review the access request on the website. The agent cannot create Google accounts or approve Google permissions.",
            nextActionLabel: "Finish the Google step in the browser",
          },
        };
      if (
        permissions.signIn &&
        prepareCredentials &&
        page.url &&
        page.blocker?.code === "site_login_required" &&
        page.controls.some(
          (entry) =>
            entry.visible &&
            entry.credentialRole === "password" &&
            !entry.answered,
        )
      ) {
        if (await prepareCredentials(page.url)) page = await hands.observe();
      }
      const key =
        page.blocker?.code === "security_challenge"
          ? "solveCaptchas"
          : page.blocker?.code === "site_login_required"
            ? "signIn"
            : page.blocker?.code === "account_creation_required"
              ? "createAccounts"
              : null;
      if (!key || !page.blocker) return page;
      const googleReady =
        (key === "signIn" || key === "createAccounts") &&
        permissions.googleSignIn &&
        hasGoogleSignInAction(page);
      if (!permissions[key] && !googleReady) {
        if (key === "solveCaptchas" && !page.blocker.requiresPerson)
          return page;
        return { ...page, blocker: { ...page.blocker, requiresPerson: true } };
      }
      return {
        ...page,
        blocker: {
          ...page.blocker,
          requiresPerson: false,
          detail:
            "This browser step is enabled in Settings. Use the visible controls; ask the person for passwords, MFA or any step you cannot complete.",
        },
      };
    },
    clickElement: click,
    clickAction: click,
    fillText: async (ref, value) => {
      const denied = await refusal(ref, true);
      return denied ? { ok: false, error: denied } : hands.fillText(ref, value);
    },
    chooseOption: async (ref, option) => {
      const denied = await refusal(ref);
      return denied
        ? { ok: false, error: denied }
        : hands.chooseOption(ref, option);
    },
    setToggle: async (ref, checked) => {
      const denied = await refusal(ref);
      return denied
        ? { ok: false, error: denied }
        : hands.setToggle(ref, checked);
    },
    pressKey: async (ref, key) => {
      // Enter/Space can submit a credential form without naming its button.
      // Require the observed action path for a gated page instead.
      const page = await hands.observe();
      if (
        /^(?:Enter|Space| )$/u.test(key) &&
        (page.blocker || browserInteractionKind(page, ref))
      )
        return {
          ok: false,
          error:
            "Use the visible account or verification button instead of a keyboard submit.",
        };
      const denied = await refusal(ref, true);
      return denied
        ? { ok: false, error: denied }
        : hands.pressKey
          ? hands.pressKey(ref, key)
          : { ok: false, error: "Keyboard actions are unavailable." };
    },
    followLink: async (ref) => {
      const denied = await refusal(ref);
      return denied ? { ok: false, error: denied } : hands.followLink(ref);
    },
  };
}
