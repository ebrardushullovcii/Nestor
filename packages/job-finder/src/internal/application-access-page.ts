import { buildApplyFormObservation } from "@nestor/browser-agent";
import type { BrowserSessionRuntime } from "@nestor/browser-runtime";
import type { UserActionRequest } from "@nestor/contracts";

/**
 * Blockers that still need the person on an application page. A page that
 * shows none of them, and no password field, is past its sign-in wall.
 */
const PERSON_OWNED_ACCESS_BLOCKER_CODES = new Set([
  "site_login_required",
  "account_creation_required",
  "multi_factor_required",
]);

export type ApplicationAccessPageState =
  | "verified"
  | "still_blocked"
  | "unavailable";

/**
 * Reads the exact page retained for an application's sign-in hand-off and says
 * whether its sign-in wall is gone.
 *
 * Application sign-in is checked on the bound page itself, never by origin:
 * replica and ATS hosts often have several tabs on one origin, and the page
 * after sign-in (an application step) rarely shows an account menu. The
 * continuation re-pauses if a wall is still there, so absence of the wall is
 * the right test. `unavailable` means the bound page cannot be read (no
 * binding, closed tab, or no reader on this runtime); callers fall back to
 * their older path instead of guessing from URLs.
 */
export async function inspectApplicationAccessPage(input: {
  browserRuntime: Pick<BrowserSessionRuntime, "readApplicationPageBinding">;
  request: UserActionRequest;
}): Promise<ApplicationAccessPageState> {
  const { request } = input;
  if (
    request.scope.type !== "application" ||
    !request.scope.resultId ||
    !input.browserRuntime.readApplicationPageBinding
  ) {
    return "unavailable";
  }

  let raw: Awaited<
    ReturnType<NonNullable<BrowserSessionRuntime["readApplicationPageBinding"]>>
  >;
  try {
    raw = await input.browserRuntime.readApplicationPageBinding(
      request.scope.source,
      request.scope.resultId,
    );
  } catch {
    return "unavailable";
  }

  const observation = buildApplyFormObservation(raw, new Date().toISOString());
  if (observation.loading) return "still_blocked";
  if (
    observation.controls.some(
      (control) => control.visible && control.credentialRole === "password",
    )
  ) {
    return "still_blocked";
  }
  const blocker = observation.blocker;
  if (
    blocker &&
    (PERSON_OWNED_ACCESS_BLOCKER_CODES.has(blocker.code) ||
      (blocker.code === "security_challenge" && blocker.requiresPerson))
  ) {
    return "still_blocked";
  }
  return "verified";
}
