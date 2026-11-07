import {
  BrowserAgentPermissionsSchema,
  type BrowserAgentPermissions,
} from "@nestor/contracts";
import type { ApplyFormObservation, ApplyPageHands } from "./apply/types";
type GoogleIdentityContext = {
  intendedEmail: string | null;
  entry: "basic" | "unproven";
  fenced: boolean;
};
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

export async function currentBrowserPermissions(
  policy: BrowserPermissionPolicy,
): Promise<BrowserAgentPermissions> {
  return BrowserAgentPermissionsSchema.parse(
    policy.readBrowserPermissions
      ? await policy.readBrowserPermissions()
      : (policy.browserPermissions ?? {}),
  );
}
/** Readiness is decided by the application model after the page returns. */
export function browserStepReadyForAgent(
  page: ApplyFormObservation,
  _permissions: BrowserAgentPermissions,
  _context?: GoogleIdentityContext,
): boolean {
  void _permissions;
  void _context;
  return !page.loading;
}
export function describeBrowserPermissions(
  policy: BrowserPermissionPolicy,
): string {
  const permissions = BrowserAgentPermissionsSchema.parse(
    policy.browserPermissions ?? {},
  );
  return `Browser settings (instructions from the person): CAPTCHA ${permissions.solveCaptchas ? "ON" : "OFF"}; website sign-in ${permissions.signIn ? "ON" : "OFF"}; Google sign-in/sign-up ${permissions.googleSignIn ? "ON" : "OFF"}; account creation ${permissions.createAccounts ? "ON" : "OFF"}. All tools remain available. Use screenshot to see the page or a named frame and pointer to click, drag or hold at its viewport coordinates. With CAPTCHA ON, solve a challenge yourself as a person would: look at the puzzle image, choose, press, look again, and retry a new puzzle if needed. Hand off on the open page only after real attempts fail. A browser checking itself (Just a moment) can need 20 to 30 seconds of waiting at a time while it progresses. Choose a route from the page facts; a failed Google route does not prevent using saved website credentials. Use the available vault tools for saved logins. Passwords, tokens and MFA codes never belong in model context.`;
}

/** The wrapper preserves secret isolation. Settings and navigation are model instructions. */
export function withBrowserPermissions(
  hands: ApplyPageHands,
  _policy: BrowserPermissionPolicy,
): ApplyPageHands {
  return {
    ...hands,
    prepareBrowserCredentials:
      _policy.prepareBrowserCredentials ?? hands.prepareBrowserCredentials,
    fillText: async (ref, value) => {
      const page = await hands.observe();
      const control = page.controls.find((c) => c.ref === ref);
      if (
        control?.credentialRole === "password" ||
        control?.credentialRole === "one_time_code"
      )
        return {
          ok: false,
          error:
            "Use the vault for saved secrets; enter missing secrets only on the open website.",
        };
      return hands.fillText(ref, value);
    },
  };
}
