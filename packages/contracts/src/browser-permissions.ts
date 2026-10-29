import { z } from "zod";

/**
 * What the agent may do on its own in the in-app browser, during a search,
 * an application or any other browser work. Each is a separate opt-in and
 * every one is off until the person turns it on in Settings › AI behavior.
 * Off means the agent stops and hands the page to the person, as before.
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
