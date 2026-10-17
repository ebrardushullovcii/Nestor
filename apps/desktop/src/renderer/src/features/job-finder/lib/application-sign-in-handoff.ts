import type { UserActionRequest } from "@nestor/contracts";
import { JOB_FINDER_BROWSER_NAME } from "./job-finder-browser-handoff-copy";

const SIGN_IN_KINDS = new Set<UserActionRequest["kind"]>([
  "login",
  "signup",
  "mfa",
  "email_verification",
]);

/**
 * True for an application's sign-in step that Job Finder watches on the exact
 * page it kept: once the sign-in wall is gone from that page the application
 * carries on by itself, so the person is never asked to press a "check" after
 * signing in.
 */
export function applicationSignInContinuesOnItsOwn(
  request: Pick<UserActionRequest, "kind" | "scope" | "verification">,
): boolean {
  return (
    request.scope.type === "application" &&
    Boolean(request.scope.resultId) &&
    SIGN_IN_KINDS.has(request.kind) &&
    request.verification.type === "source_access"
  );
}

/** Said beside the open action instead of a check button. */
export const APPLICATION_SIGN_IN_CONTINUES_NOTE = `Sign in on the page in ${JOB_FINDER_BROWSER_NAME}. Job Finder carries on with this application by itself once you're in.`;

/** The one place a file question is answered. */
export const OPEN_PROFILE_FILES_ACTION = "Choose a file in Profile › Files";

/** Said on a waiting file question instead of "attach it and check". */
export const APPLICATION_FILE_CONTINUES_NOTE =
  "Add or restore the file in Profile › Files. Job Finder attaches it and carries on with this application by itself.";
