import type { ProfileSetupState } from "@nestor/contracts";

/**
 * First run used to open Home: one card, one button, and a "what happens next"
 * trio that the setup entry screen then repeated verbatim. The user paid a
 * screen to be told what the next screen would tell them, so a workspace that
 * has not started setup opens guided setup directly instead.
 *
 * The redirect happens at most once per session. Home stays reachable from the
 * sidebar and from guided setup's own "Back to Home" control: taking either
 * path marks the redirect as spent, so Home never bounces the user back.
 */
let guidedSetupAutoOpenSpent = false;

export function shouldAutoOpenGuidedSetup(
  profileSetupState: Pick<ProfileSetupState, "status"> | null | undefined,
): boolean {
  return (
    !guidedSetupAutoOpenSpent &&
    (profileSetupState?.status ?? "not_started") === "not_started"
  );
}

export function markGuidedSetupAutoOpenSpent(): void {
  guidedSetupAutoOpenSpent = true;
}

/** Test-only reset so one session's redirect cannot leak into the next case. */
export function resetGuidedSetupAutoOpenForTests(): void {
  guidedSetupAutoOpenSpent = false;
}
