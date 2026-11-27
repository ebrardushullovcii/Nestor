import { z } from "zod";

/**
 * What the agent may do on its own in the in-app browser, during a search,
 * an application or any other browser work. A new profile starts with every
 * one on (`NEW_PROFILE_BROWSER_PERMISSIONS`), shown with a switch each in
 * Guided setup and Settings › AI behavior. Off means the agent stops and
 * hands the page to the person. A workspace saved before these existed has
 * no value and reads as off.
 *
 * None of these is the send choice: whether an application is sent stays
 * `applicationAutomationMode`.
 */
export const BrowserAgentPermissionsSchema = z
  .object({
    /** Work through CAPTCHA and bot checks a page puts up. */
    solveCaptchas: z.boolean().default(false),
    /**
     * Sign in with what the in-app browser already has (a kept session, a
     * provider sign-in or an exact-site saved login). Otherwise the person
     * enters the password on the website.
     */
    signIn: z.boolean().default(false),
    /** Use an existing Google session to sign in or register on a website. */
    googleSignIn: z.boolean().default(false),
    /** Create an account when a site needs one to continue. */
    createAccounts: z.boolean().default(false),
  })
  .strict();
export type BrowserAgentPermissions = z.infer<
  typeof BrowserAgentPermissionsSchema
>;

/** What a profile created from now on starts with: full access. */
export const NEW_PROFILE_BROWSER_PERMISSIONS: BrowserAgentPermissions = {
  solveCaptchas: true,
  signIn: true,
  googleSignIn: true,
  createAccounts: true,
};

/**
 * The saved browser permissions, defaulted: a workspace saved before they
 * existed, or no settings at all, reads as all off.
 */
export function browserAgentPermissionsOf(
  settings:
    | {
        aiBehavior?:
          | { browserPermissions?: Partial<BrowserAgentPermissions> }
          | undefined;
      }
    | null
    | undefined,
): BrowserAgentPermissions {
  return BrowserAgentPermissionsSchema.parse(
    settings?.aiBehavior?.browserPermissions ?? {},
  );
}
