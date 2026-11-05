import {
  BrowserAgentPermissionsSchema,
  type ApplyRawPageHands,
  type BrowserAgentPermissions,
} from "@nestor/contracts";
import {
  hasExistingAccountLoginForm,
  isSecurityChallengeControl,
} from "./apply/blockers";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";
import {
  GOOGLE_ACCOUNT_WINDOW_ORIGINS,
  googleAccountWindowReady,
  googleSignInInteraction,
  googleChooserAccount,
  hasGoogleSignInAction,
  isGoogleAccountPage,
  googleFlowEntry,
  googleIdentifierStep,
  googleBasicConfirmation,
  googleUseAnotherAccount,
  googleEntryShape,
  normalizeGoogleEmail,
  type GoogleIdentityContext,
} from "./google-sign-in";

export interface BrowserPermissionPolicy {
  browserPermissions?: BrowserAgentPermissions;
  /** Read before each interaction, so turning a permission off takes effect now. */
  readBrowserPermissions?: () =>
    | BrowserAgentPermissions
    | Promise<BrowserAgentPermissions>;
  readIntendedAccountEmail?: () => string | null | Promise<string | null>;
  onGoogleSignInConfirmed?: (account: string) => void | Promise<void>;
  googleSignInAlreadyConfirmed?: (account: string) => boolean;
  /** Host validates one login form before autofill; no secret or vault tool enters a model turn. */
  prepareBrowserCredentials?: (url: string) => Promise<boolean>;
  /** Local activity only: the authorized chooser click succeeded, not sign-in. */
  onGoogleAccountSelected?: (account: string) => void | Promise<void>;
  /** Existing activity for this application prevents an uncertain repeat. */
  googleAccountAlreadySelected?: (account: string) => boolean;
}

export const SIGN_IN_ACTION =
  /^(?:(?:sign|log)\s?in|login|continue with\s|sign in with\s|log in with\s)/iu;
export const CREATE_ACCOUNT_ACTION =
  /^(?:create (?:an? |your |candidate )?account|create profile|register|sign\s?up)(?:\b|$)/iu;
const FINAL_APPLICATION_ACTION =
  /\b(?:submit|send|complete|finish)\b.{0,24}\bapplication\b|\bapply now\b/iu;
const CHALLENGE_ACTION =
  /^(?:verify|check|confirm|submit answer|next challenge|try again|start puzzle)(?:\b|$)/iu;
const EXISTING_ACCOUNT_CONTEXT =
  /\b(?:already\s+have\s+(?:an?\s+)?account|already\s+registered|existing\s+account|returning\s+(?:user|applicant))\b/iu;
const EXACT_SIGN_IN_ACTION = /^(?:sign\s?in|log\s?in|login)$/iu;

/** Existing-account navigation, never a credential submit. Layout groups are not native form ownership. */
export function isSignInEntryAction(
  action:
    | ApplyFormObservation["actions"][number]
    | ApplyFormObservation["links"][number],
): boolean {
  return (
    action.visible &&
    !("disabled" in action && action.disabled) &&
    EXACT_SIGN_IN_ACTION.test(action.label.trim()) &&
    ("href" in action
      ? action.destination === "page"
      : action.kind !== "final" &&
        action.submitsForm !== true &&
        (!action.formAction || action.submitsForm === false) &&
        (!action.inForm ||
          action.submitsForm === false ||
          EXISTING_ACCOUNT_CONTEXT.test(action.section ?? "")))
  );
}

export function signInEntryActions(page: ApplyFormObservation) {
  const loginForm = hasExistingAccountLoginForm(page);
  return [...page.actions, ...page.links].filter(
    (action) =>
      isSignInEntryAction(action) &&
      (!loginForm ||
        "href" in action ||
        !action.inForm ||
        EXISTING_ACCOUNT_CONTEXT.test(action.section ?? "")),
  );
}

function hasExactSignInSubmit(page: ApplyFormObservation): boolean {
  return page.actions.some(
    (action) =>
      action.visible &&
      !action.disabled &&
      EXACT_SIGN_IN_ACTION.test(action.label.trim()) &&
      action.submitsForm === true &&
      action.formMethod?.toUpperCase() === "POST" &&
      Boolean(action.formAction),
  );
}

function scriptLoginAction(page: ApplyFormObservation, ref?: string) {
  if (!hasExistingAccountLoginForm(page)) return undefined;
  const passwords = page.controls.filter(
    (item) =>
      item.visible && !item.disabled && item.credentialRole === "password",
  );
  if (passwords.length !== 1) return undefined;
  return page.actions.find(
    (item) =>
      (!ref || item.ref === ref) &&
      item.visible &&
      !item.disabled &&
      EXACT_SIGN_IN_ACTION.test(item.label.trim()) &&
      JSON.stringify(item.frame ?? null) ===
        JSON.stringify(passwords[0]?.frame ?? null) &&
      (!item.formAction ||
        (() => {
          try {
            return (
              new URL(item.formAction, page.url!).origin ===
              new URL(page.url!).origin
            );
          } catch {
            return false;
          }
        })()),
  );
}

function signInEntryBinding(
  entry:
    | ApplyFormObservation["actions"][number]
    | ApplyFormObservation["links"][number],
): string {
  return JSON.stringify(
    "href" in entry
      ? ["link", entry.href, entry.opensNewWindow]
      : ["action", entry.formAction, entry.formMethod, entry.submitsForm],
  );
}

export type BrowserInteractionKind =
  | keyof BrowserAgentPermissions
  | "google_handoff"
  | "mfa"
  | "password";

function controlIsSiteCredential(page: ApplyFormObservation, ref?: string) {
  return page.controls.some(
    (control) => control.ref === ref && !!control.credentialRole,
  );
}

export function browserInteractionKind(
  page: ApplyFormObservation,
  ref: string | undefined,
  context?: GoogleIdentityContext,
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
  const google = googleSignInInteraction(page, ref, context);
  if (google) return google;
  if (FINAL_APPLICATION_ACTION.test(label)) return null;
  if (signInEntryActions(page).some((entry) => entry.ref === ref))
    return "signIn";
  if (CREATE_ACCOUNT_ACTION.test(label)) return "createAccounts";
  if (SIGN_IN_ACTION.test(label)) {
    // "Continue with ..." is also ordinary application progression. A bound
    // advance beside applicant fields, with no account surface, is not SSO.
    // Google/provider entry and account walls retain their checks above/below.
    if (
      /^continue with (?:the )?(?:saved|entered|current|these|your) (?:details|answers|information|application|profile)\b/iu.test(
        label,
      ) &&
      item &&
      "kind" in item &&
      item.kind === "advance" &&
      item.inForm === true &&
      !page.blocker &&
      !hasExistingAccountLoginForm(page) &&
      ![page.title ?? "", ...page.headings.map((heading) => heading.text)].some(
        (text) => SIGN_IN_ACTION.test(text) || CREATE_ACCOUNT_ACTION.test(text),
      ) &&
      page.controls.some((field) => field.visible && !field.credentialRole)
    )
      return null;
    if (EXACT_SIGN_IN_ACTION.test(label) && hasExistingAccountLoginForm(page))
      return "signIn";
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
  context?: GoogleIdentityContext,
): boolean {
  if (
    page.accountWindow &&
    (!permissions.googleSignIn || !googleAccountWindowReady(page, context))
  )
    return false;
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
  if (permissions.googleSignIn && hasGoogleSignInAction(page, context))
    return true;
  if (isGoogleAccountPage(page)) return false;
  if (
    (permissions.signIn || permissions.googleSignIn) &&
    signInEntryActions(page).length
  )
    return true;
  return Boolean(
    enabled &&
    passwords.length &&
    passwords.every((entry) => entry.answered) &&
    (!hasExistingAccountLoginForm(page) ||
      hasExactSignInSubmit(page) ||
      !!scriptLoginAction(page)),
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
          "Google: use its visible button before email/password, even beside an empty password form. If only email/password is shown, an enabled Sign In button outside that form may open provider choices: inspect it once before handing off missing credentials. This may register a site account. Choose the Google account matching the Profile email; if Profile has no email, choose only a sole offered signed-in account. Type only the Profile email if Google asks for an identifier, and press Google’s basic sign-in confirmation. Use another account only to reach the identifier for that same Profile email. Decline an optional Google offer, such as creating a passkey, with its own Not now or Skip. Hand off passwords, MFA, ambiguous accounts and any request for more access; never create Google accounts. Never repeat a Google attempt whose result is uncertain.",
        ]
      : []),
    "Use visible controls for enabled steps; hand off others. Reuse sessions or host-filled saved logins. Never request or type passwords or MFA codes; the person enters missing credentials on-site. Sending and extra consent stay separate. Check results; never repeat an uncertain account action.",
  ].join("\n");
}

/** Raw authorization entries are transient policy input, never model observation. */
export async function googleIdentityContext(
  policy: BrowserPermissionPolicy,
  hands: ApplyPageHands,
): Promise<GoogleIdentityContext> {
  const intendedEmail =
    (await policy.readIntendedAccountEmail?.())?.trim() || null;
  return {
    intendedEmail:
      intendedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(intendedEmail)
        ? intendedEmail
        : null,
    selectedEmail: (hands as WrappedHands)[WRAPPED]?.selectedEmail ?? null,
    entry: googleFlowEntry(
      (await hands.readAccountFlowEntry?.(GOOGLE_ACCOUNT_WINDOW_ORIGINS)) ??
        null,
    ),
    fenced: !!hands.clickOpeningAccountWindow,
  };
}
const WRAPPED = Symbol("browser-permission-policy");
type PermissionState = {
  policies: BrowserPermissionPolicy[];
  selectedEmail: string | null;
};
type WrappedHands = ApplyPageHands & { [WRAPPED]?: PermissionState };
const redactedGoogleUrl = (url: string | null): string | null => {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    return isGoogleAccountPage({ url }) ||
      ["code", "state", "id_token", "access_token", "refresh_token"].some(
        (key) =>
          parsed.searchParams.has(key) ||
          new URLSearchParams(parsed.hash.slice(1)).has(key),
      )
      ? parsed.origin + parsed.pathname
      : url;
  } catch {
    return null;
  }
};
const redactAccountText = (text: string): string =>
  text.replace(
    /https?:\/\/[^\s"'<>]+/gu,
    (url) => redactedGoogleUrl(url) ?? "[account page]",
  );
const googleConsentPath = (page: Pick<ApplyFormObservation, "url">) => {
  try {
    return /^\/(?:signin\/oauth\/|gsi\/)/u.test(
      new URL(page.url ?? "https://accounts.google.com").pathname,
    );
  } catch {
    return false;
  }
};
function googleHandoff(
  page: ApplyFormObservation,
  ctx: GoogleIdentityContext,
  entryShape?: string,
): string {
  if (
    page.controls.some(
      (control) => control.visible && control.credentialRole === "password",
    )
  )
    return "Enter your Google password yourself on the website, then continue.";
  if (page.accountWindow?.refusal) return page.accountWindow.refusal.detail;
  if (page.accountWindow && page.accountWindow.actionsLeft <= 0)
    return "Nestor's allowance for this Google step ran out before it finished. Finish the Google step yourself, then continue.";
  if (ctx.entry !== "basic" && googleConsentPath(page))
    return `Nestor cannot prove this request is limited to your name, email and profile picture. Review the Google access request yourself.${entryShape ? ` Recorded entry: ${entryShape}.` : ""}`;
  if (!ctx.intendedEmail && !ctx.selectedEmail)
    return "Choose your Google account on the website. Profile has no email and Google is not offering one unambiguous signed-in account.";
  return `Google isn't offering one unambiguous action for ${ctx.intendedEmail ?? ctx.selectedEmail}. Check that account on the website.`;
}
/** Enforcement shared by search, source checks and Apply, below all their tools. */
export function withBrowserPermissions(
  hands: ApplyPageHands & Pick<ApplyRawPageHands, "clickAuthorizedLoginAction">,
  requested: BrowserPermissionPolicy,
): ApplyPageHands {
  const inherited = (hands as WrappedHands)[WRAPPED];
  if (inherited) {
    // A second wrapper shares attempt receipts, but a later stricter policy is
    // still enforced. Returning an old wrapper must never discard revocation.
    if (!inherited.policies.includes(requested))
      inherited.policies.push(requested);
    return hands;
  }
  const state: PermissionState = { policies: [requested], selectedEmail: null };
  const notify = async (
    name: "onGoogleAccountSelected" | "onGoogleSignInConfirmed",
    account: string,
  ) => {
    // The original observer owns the receipt. Later wrappers narrow policy,
    // rather than registering the original callback a second time.
    await state.policies.find((policy) => policy[name])?.[name]?.(account);
  };
  const policy: BrowserPermissionPolicy = {
    readBrowserPermissions: async () => {
      const permissions = await Promise.all(
        state.policies.map(currentBrowserPermissions),
      );
      return BrowserAgentPermissionsSchema.parse(
        Object.fromEntries(
          Object.keys(
            permissions[0] ?? BrowserAgentPermissionsSchema.parse({}),
          ).map((key) => [
            key,
            permissions.every(
              (item) => item[key as keyof BrowserAgentPermissions],
            ),
          ]),
        ),
      );
    },
    readIntendedAccountEmail: async () => {
      const readers = [
        ...new Set(
          state.policies.flatMap((item) =>
            item.readIntendedAccountEmail
              ? [item.readIntendedAccountEmail]
              : [],
          ),
        ),
      ];
      const values = await Promise.all(
        readers.map((read) => Promise.resolve(read())),
      );
      const target = values[0] ?? null;
      return values.every(
        (value) => normalizeGoogleEmail(value) === normalizeGoogleEmail(target),
      )
        ? target
        : null;
    },
    googleAccountAlreadySelected: (account) =>
      state.policies.some((item) =>
        item.googleAccountAlreadySelected?.(account),
      ),
    googleSignInAlreadyConfirmed: (account) =>
      state.policies.some((item) =>
        item.googleSignInAlreadyConfirmed?.(account),
      ),
  };
  const attemptedAccountActions = new Set<string>();
  const reobservedEntries = new Set<string>();
  /** What a person would call the same Google step, without budget counters. */
  const stepShape = (page: ApplyFormObservation) =>
    JSON.stringify([
      page.url,
      page.headings.map((heading) => heading.text),
      [...page.actions, ...page.links, ...page.clickables].map(
        (item) => item.label,
      ),
      page.controls.map((control) => [
        control.label,
        control.credentialRole ?? null,
      ]),
      page.bodyTextExcerpt,
    ]);
  /**
   * A Google action moved the flow forward: the same intended account, still
   * proven basic access, Google sign-in still on, and a different step on the
   * same live surface. Only then does the surface get a fresh deadline; the
   * runtime separately requires a new document. An unchanged page (an
   * uncertain result) is never renewed.
   */
  const renewAfterProgress = async (
    before: ApplyFormObservation,
    ctx: GoogleIdentityContext,
  ) => {
    if (!hands.renewAccountWindow) return;
    const after = await hands.observe();
    const surface = after.accountWindow;
    if (
      !surface ||
      surface.refusal ||
      surface.actionsLeft <= 0 ||
      stepShape(after) === stepShape(before)
    )
      return;
    const fresh = await context();
    if (
      normalizeGoogleEmail(fresh.intendedEmail) !==
        normalizeGoogleEmail(ctx.intendedEmail) ||
      ctx.entry !== "basic" ||
      fresh.entry !== "basic" ||
      !(await currentBrowserPermissions(policy)).googleSignIn
    )
      return;
    await hands.renewAccountWindow({
      origin: surface.origin,
      pathname: surface.pathname,
    });
  };
  const attemptedChooserPages = new Set<string>();
  const attemptedSelections = new Set<string>();
  const attemptedConfirmations = new Set<string>();
  const usedAnotherAccounts = new Set<string>();
  const prepareCredentials =
    requested.prepareBrowserCredentials ?? hands.prepareBrowserCredentials;
  const context = async (): Promise<GoogleIdentityContext> => ({
    ...(await googleIdentityContext(policy, hands)),
    selectedEmail: state.selectedEmail,
  });
  const refusal = async (
    ref: string | undefined,
    secretWrite = false,
    observed?: ApplyFormObservation,
    ctx?: GoogleIdentityContext,
  ): Promise<string | null> => {
    const page = observed ?? (await hands.observe());
    ctx ??= await context();
    const kind = browserInteractionKind(page, ref, ctx);
    const allowed = await currentBrowserPermissions(policy);
    if (
      allowed.googleSignIn &&
      !isGoogleAccountPage(page) &&
      hasGoogleSignInAction(page, ctx) &&
      (controlIsSiteCredential(page, ref) ||
        (kind === "signIn" &&
          !signInEntryActions(page).some((entry) => entry.ref === ref)) ||
        kind === "createAccounts")
    )
      return "Google sign-in is enabled and offered here. Use its visible button before email and password.";
    if (kind === "mfa")
      return "Enter the verification code yourself on the website, then continue.";
    if (kind === "google_handoff") return googleHandoff(page, ctx);
    if (kind === "password")
      return secretWrite
        ? "Enter passwords yourself on the website. They are never given to the agent."
        : null;
    if (!kind) return null;
    if (
      !secretWrite &&
      kind === "signIn" &&
      allowed.googleSignIn &&
      signInEntryActions(page).some((action) => action.ref === ref)
    )
      return null;
    return allowed[kind]
      ? null
      : `${kind === "solveCaptchas" ? "Solving CAPTCHAs" : kind === "googleSignIn" ? "Google sign-in/sign-up" : kind === "signIn" ? "Signing in" : "Creating accounts"} is off in Settings. Leave this step to the person.`;
  };
  const accountActionRefusal = async (
    page: ApplyFormObservation,
    ref: string,
    ctx: GoogleIdentityContext,
    typing = false,
  ) => {
    const kind = browserInteractionKind(page, ref, ctx);
    const action = [...page.actions, ...page.links].find(
      (entry) => entry.ref === ref,
    );
    const signInEntry =
      kind === "signIn" &&
      signInEntryActions(page).some((entry) => entry.ref === ref);
    const scriptLogin = kind === "signIn" && !!scriptLoginAction(page, ref);
    if (kind === "googleSignIn" || signInEntry || scriptLogin) {
      const fresh = await hands.observe();
      const freshContext = await context();
      if (
        normalizeGoogleEmail(ctx.intendedEmail) !==
          normalizeGoogleEmail(freshContext.intendedEmail) ||
        normalizeGoogleEmail(ctx.selectedEmail) !==
          normalizeGoogleEmail(freshContext.selectedEmail)
      )
        return "Your Profile email changed. Look at the page again.";
      const all = (seen: ApplyFormObservation) => [
        ...seen.actions,
        ...seen.links,
        ...seen.clickables,
        ...seen.controls,
      ];
      const item = all(page).find((entry) => entry.ref === ref);
      const freshItem = all(fresh).find((entry) => entry.ref === ref);
      const freshAction = [...fresh.actions, ...fresh.links].find(
        (entry) => entry.ref === ref,
      );
      if (
        fresh.url !== page.url ||
        fresh.signature !== page.signature ||
        ctx.entry !== freshContext.entry ||
        browserInteractionKind(fresh, ref, freshContext) !== kind ||
        !item ||
        !freshItem ||
        item.label !== freshItem.label ||
        item.frame?.origin !== freshItem.frame?.origin ||
        item.frame?.pathname !== freshItem.frame?.pathname ||
        !freshItem.visible ||
        ("disabled" in freshItem && freshItem.disabled) ||
        googleChooserAccount(page, ref, ctx) !==
          googleChooserAccount(fresh, ref, freshContext) ||
        googleBasicConfirmation(page, ref, ctx) !==
          googleBasicConfirmation(fresh, ref, freshContext) ||
        (scriptLogin &&
          (!scriptLoginAction(fresh, ref) ||
            !freshAction ||
            !action ||
            signInEntryBinding(action) !== signInEntryBinding(freshAction))) ||
        (signInEntry &&
          (!action ||
            !freshAction ||
            !signInEntryActions(fresh).some((entry) => entry.ref === ref) ||
            signInEntryBinding(action) !== signInEntryBinding(freshAction)))
      )
        return "The account step changed. Inspect the page again before continuing.";
      const allowed = await currentBrowserPermissions(policy);
      if (!allowed[kind] && !(signInEntry && allowed.googleSignIn))
        return "The browser permission was turned off before this action.";
    }
    if (
      kind === "signIn" ||
      kind === "createAccounts" ||
      kind === "googleSignIn"
    ) {
      if (
        kind !== "googleSignIn" &&
        !signInEntry &&
        page.controls.some(
          (entry) =>
            entry.visible &&
            entry.credentialRole === "password" &&
            !entry.answered,
        )
      )
        return "Enter the password on the website, then continue this task.";
      if (typing) return null;
      const key = `${page.url}|${page.signature}|${kind}|${ref}`;
      const chooserKey = `${page.url}|${page.signature}`;
      const selected = googleChooserAccount(page, ref, ctx);
      const confirmed = googleBasicConfirmation(page, ref, ctx);
      const another = googleUseAnotherAccount(page, ref, ctx);
      if (
        attemptedAccountActions.has(key) ||
        (selected &&
          (attemptedSelections.has(selected) ||
            attemptedChooserPages.has(chooserKey) ||
            policy.googleAccountAlreadySelected?.(selected))) ||
        (confirmed &&
          (attemptedConfirmations.has(confirmed) ||
            policy.googleSignInAlreadyConfirmed?.(confirmed))) ||
        (another &&
          usedAnotherAccounts.has(normalizeGoogleEmail(ctx.intendedEmail)))
      )
        return "That account action was already attempted. Check its result on the website before retrying.";
      attemptedAccountActions.add(key);
      if (selected) {
        attemptedChooserPages.add(chooserKey);
        attemptedSelections.add(selected);
      }
      if (confirmed) attemptedConfirmations.add(confirmed);
      if (another)
        usedAnotherAccounts.add(normalizeGoogleEmail(ctx.intendedEmail));
    }
    return null;
  };
  const click = async (
    ref: string,
    following = false,
    observed?: ApplyFormObservation,
    identity?: GoogleIdentityContext,
  ) => {
    const page = observed ?? (await hands.observe());
    const ctx = identity ?? (await context());
    const denied =
      (await refusal(ref, false, page, ctx)) ??
      (await accountActionRefusal(page, ref, ctx));
    if (denied) return { ok: false as const, error: denied };
    const account = googleChooserAccount(page, ref, ctx);
    const confirmation = googleBasicConfirmation(page, ref, ctx);
    const selected = async <T extends { ok: boolean }>(
      result: T,
    ): Promise<T> => {
      if (result.ok && account) {
        state.selectedEmail = account;
        await notify("onGoogleAccountSelected", account);
      }
      if (result.ok && confirmation)
        await notify("onGoogleSignInConfirmed", confirmation);
      return !result.ok && "error" in result && typeof result.error === "string"
        ? { ...result, error: redactAccountText(result.error) }
        : result;
    };
    const kind = browserInteractionKind(page, ref, ctx);
    const action = page.actions.find((entry) => entry.ref === ref);
    const scriptLogin = kind === "signIn" && scriptLoginAction(page, ref);
    if (
      scriptLogin &&
      !(
        action?.submitsForm &&
        action.formMethod?.toUpperCase() === "POST" &&
        action.formAction
      ) &&
      hands.clickAuthorizedLoginAction &&
      prepareCredentials
    ) {
      // Only the host can resolve and fill one saved exact-origin account.
      // A masked password readback alone is never proof of host autofill.
      if (!(await prepareCredentials(page.url!)))
        return {
          ok: false as const,
          error:
            "The saved account could not be filled safely. Finish sign-in on the website.",
        };
      const fresh = await hands.observe();
      const freshAction = scriptLoginAction(fresh, ref);
      if (
        !(await currentBrowserPermissions(policy)).signIn ||
        !freshAction ||
        fresh.url !== page.url ||
        fresh.signature !== page.signature ||
        freshAction.label !== scriptLogin.label ||
        signInEntryBinding(freshAction) !== signInEntryBinding(scriptLogin) ||
        JSON.stringify(freshAction.frame ?? null) !==
          JSON.stringify(scriptLogin.frame ?? null) ||
        !fresh.controls
          .filter((item) => item.visible && item.credentialRole === "password")
          .every((item) => item.answered)
      )
        return {
          ok: false as const,
          error: "The saved sign-in surface changed. Inspect it again.",
        };
      return hands.clickAuthorizedLoginAction({
        ref,
        frame: freshAction.frame ?? null,
        ...(ctx.intendedEmail ? { identifier: ctx.intendedEmail } : {}),
      });
    }
    if (
      (kind === "signIn" || kind === "createAccounts") &&
      !signInEntryActions(page).some((entry) => entry.ref === ref) &&
      page.controls.some(
        (entry) => entry.visible && entry.credentialRole === "password",
      ) &&
      !action?.submitsForm
    )
      return {
        ok: false as const,
        error:
          "This account or verification action cannot be sent through an exact form action. Complete this step on the website.",
      };
    if (kind === "googleSignIn" && page.accountWindow) {
      const result = await selected(await hands.clickElement(ref));
      if (result.ok) await renewAfterProgress(page, ctx);
      return result;
    }
    if (
      kind === "googleSignIn" &&
      !isGoogleAccountPage(page) &&
      !action?.submitsForm &&
      hands.clickOpeningAccountWindow
    ) {
      const item = [...page.actions, ...page.links, ...page.clickables].find(
        (entry) => entry.ref === ref,
      );
      const result = await hands.clickOpeningAccountWindow({
        ref,
        frame: item?.frame ?? null,
        writeOrigins: GOOGLE_ACCOUNT_WINDOW_ORIGINS,
        maxActions: 4,
        disclosableValues: ctx.intendedEmail
          ? [
              ...new Set([
                ctx.intendedEmail,
                normalizeGoogleEmail(ctx.intendedEmail),
              ]),
            ]
          : [],
      });
      return result.kind === "refused"
        ? {
            ok: false as const,
            error:
              "Google opened a window Nestor could not keep safely. Finish Google sign-in yourself, then continue.",
          }
        : {
            ok: true as const,
            observedValue: redactedGoogleUrl(result.url) ?? "",
          };
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
      return selected(await hands.clickAuthorizedFormAction(ref));
    }
    if (following) {
      const result = await hands.followLink(ref);
      return selected(
        result.ok
          ? {
              ok: true as const,
              observedValue: redactedGoogleUrl(result.url) ?? "",
            }
          : result,
      );
    }
    return selected(await hands.clickElement(ref));
  };
  const wrapped: WrappedHands = {
    ...hands,
    [WRAPPED]: state,
    readText: async (ref) => redactAccountText(await hands.readText(ref)),
    ...(hands.readLinkedText
      ? {
          readLinkedText: async () =>
            redactAccountText(await hands.readLinkedText!()),
        }
      : {}),
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
      if (
        link &&
        browserInteractionKind(page, link.ref, await context()) ===
          "googleSignIn"
      ) {
        const result = await click(link.ref);
        return result.ok ? { ok: true, url: redactedGoogleUrl(url)! } : result;
      }
      const denied = link ? await refusal(link.ref, false, page) : null;
      return denied ? { ok: false, error: denied } : hands.navigate(url);
    },
    observe: async () => {
      const redacted = (seen: ApplyFormObservation): ApplyFormObservation => ({
        ...seen,
        url: redactedGoogleUrl(seen.url),
        actions: seen.actions.map((action) => ({
          ...action,
          ...(action.formAction
            ? { formAction: redactedGoogleUrl(action.formAction) ?? "" }
            : {}),
        })),
        links: seen.links.map((link) => ({
          ...link,
          href: redactedGoogleUrl(link.href) ?? "",
        })),
        openedTabs: seen.openedTabs.map((tab) => ({
          ...tab,
          url: redactedGoogleUrl(tab.url) ?? "",
        })),
      });
      let page = await hands.observe();
      let chooserAttempted = attemptedChooserPages.has(
        `${page.url}|${page.signature}`,
      );
      page = redacted(page);
      const permissions = await currentBrowserPermissions(policy);
      let ctx = await context();
      let entryShape: string | undefined;
      if (
        isGoogleAccountPage(page) &&
        googleConsentPath(page) &&
        ctx.entry !== "basic"
      ) {
        // An unproven entry gets one more look, without any click, in case
        // the recorder saw its hop late. Then it is handed off with only its
        // host, path and parameter names.
        const key = `${page.url}|${page.signature}`;
        if (!reobservedEntries.has(key)) {
          reobservedEntries.add(key);
          await hands.wait(750);
          const again = await hands.observe();
          chooserAttempted ||= attemptedChooserPages.has(
            `${again.url}|${again.signature}`,
          );
          page = redacted(again);
          ctx = await context();
        }
        if (ctx.entry !== "basic")
          entryShape = googleEntryShape(
            (await hands.readAccountFlowEntry?.(
              GOOGLE_ACCOUNT_WINDOW_ORIGINS,
            )) ?? null,
          );
      }
      const repeated = [
        ...page.actions,
        ...page.links,
        ...page.clickables,
      ].some((item) => {
        const chosen = googleChooserAccount(page, item.ref, ctx),
          confirmed = googleBasicConfirmation(page, item.ref, ctx);
        return (
          (chosen &&
            (attemptedSelections.has(chosen) ||
              policy.googleAccountAlreadySelected?.(chosen))) ||
          (confirmed &&
            (attemptedConfirmations.has(confirmed) ||
              policy.googleSignInAlreadyConfirmed?.(confirmed)))
        );
      });
      if (
        (isGoogleAccountPage(page) || page.accountWindow) &&
        (repeated ||
          chooserAttempted ||
          !googleAccountWindowReady(page, ctx) ||
          !(permissions.googleSignIn && hasGoogleSignInAction(page, ctx)))
      )
        return {
          ...page,
          blocker: {
            code: "site_login_required",
            requiresPerson: true,
            summary: "Google needs you to finish this step.",
            detail: repeated
              ? "Nestor already attempted this Google account step. Check its result on the website before continuing."
              : googleHandoff(page, ctx, entryShape),
            nextActionLabel: "Finish the Google step in the browser",
          },
        };
      if (
        permissions.signIn &&
        !(permissions.googleSignIn && hasGoogleSignInAction(page, ctx)) &&
        prepareCredentials &&
        page.url &&
        (page.blocker?.code === "site_login_required" ||
          page.blocker?.code === "account_creation_required") &&
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
      const navigation =
        (key === "signIn" || key === "createAccounts") &&
        ((permissions.googleSignIn && hasGoogleSignInAction(page, ctx)) ||
          (!isGoogleAccountPage(page) &&
            (permissions.signIn || permissions.googleSignIn) &&
            signInEntryActions(page).length > 0));
      if (!permissions[key] && !navigation)
        return key === "solveCaptchas" && !page.blocker.requiresPerson
          ? page
          : { ...page, blocker: { ...page.blocker, requiresPerson: true } };
      const manual =
        key === "signIn" &&
        hasExistingAccountLoginForm(page) &&
        !hasExactSignInSubmit(page) &&
        !(
          hands.clickAuthorizedLoginAction &&
          prepareCredentials &&
          scriptLoginAction(page)
        ) &&
        !navigation;
      return {
        ...page,
        blocker: {
          ...page.blocker,
          requiresPerson: manual,
          detail: manual
            ? "Sign in on the website, then continue this application. This form does not expose an exact sign-in action."
            : "This browser step is enabled in Settings. Use the visible controls; ask the person for passwords, MFA or any step you cannot complete.",
        },
      };
    },
    clickElement: (ref) => click(ref),
    clickAction: (ref) => click(ref),
    ...(hands.clickBoundAction
      ? {
          // A bound step press is never an account or verification action.
          clickBoundAction: async (expected) => {
            const page = await hands.observe();
            if (browserInteractionKind(page, expected.ref, await context()))
              return {
                ok: false as const,
                error:
                  "This control is an account or verification step. Use its own flow.",
                reason: "binding_changed" as const,
              };
            return hands.clickBoundAction!(expected);
          },
        }
      : {}),
    fillText: async (ref, value) => {
      const page = await hands.observe();
      const ctx = await context();
      const denied = await refusal(ref, true, page, ctx);
      if (denied) return { ok: false, error: denied };
      if (isGoogleAccountPage(page)) {
        if (
          !googleIdentifierStep(page, ref, ctx) ||
          normalizeGoogleEmail(value) !==
            normalizeGoogleEmail(ctx.intendedEmail)
        )
          return {
            ok: false,
            error: "Use only the email in Profile for this Google identifier.",
          };
        const changed = await accountActionRefusal(page, ref, ctx, true);
        return changed
          ? { ok: false, error: changed }
          : hands.fillText(ref, ctx.intendedEmail!);
      }
      return hands.fillText(ref, value);
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
      const page = await hands.observe();
      if (
        /^(?:Enter|Space| )$/u.test(key) &&
        (page.blocker || browserInteractionKind(page, ref, await context()))
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
      const page = await hands.observe();
      const ctx = await context();
      if (browserInteractionKind(page, ref, ctx) === "googleSignIn") {
        const result = await click(ref, true, page, ctx);
        return result.ok
          ? {
              ok: true,
              url: redactedGoogleUrl((await hands.observe()).url) ?? "",
            }
          : result;
      }
      const denied =
        (await refusal(ref, false, page, ctx)) ??
        (await accountActionRefusal(page, ref, ctx));
      return denied ? { ok: false, error: denied } : hands.followLink(ref);
    },
  };
  return wrapped;
}
