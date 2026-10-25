import type { ApplyWriteResult } from "@nestor/contracts";

import { normalizeSignal } from "./control-classification";
import type { ApplyFormObservation, ApplyPageHands } from "./types";

export interface TaskLocalCredentialReference {
  /** Opaque command identity. It never contains an account identifier. */
  reference: string;
  load: () => { identifier: string; password: string };
}

async function runCredentialMechanic<T>(
  operation: () => Promise<T>,
  safeFailure: string,
): Promise<T> {
  try {
    return await operation();
  } catch {
    // Playwright locator errors can repeat the typed value in their call log.
    // Never let an error from a credential-bearing operation cross this
    // boundary into a report, model message, or persisted result.
    throw new Error(safeFailure);
  }
}

function visibleCredentialControls(
  observation: ApplyFormObservation,
  role: "identifier" | "password",
) {
  return observation.controls.filter(
    (control) =>
      control.visible &&
      !control.disabled &&
      !control.readOnly &&
      control.credentialRole === role,
  );
}

/** The only native form action that may be opened for an existing-account handoff. */
export function selectObservedSignInAction(
  observation: ApplyFormObservation,
): {
  ref: string;
  label: string;
  formAction: string;
  formMethod: "POST";
} | null {
  if (observation.blocker?.code !== "site_login_required") return null;
  const identifiers = visibleCredentialControls(observation, "identifier");
  const passwords = visibleCredentialControls(observation, "password");
  const actions = observation.actions.filter((action) => {
    const label = normalizeSignal(action.label);
    return (
      action.visible &&
      !action.disabled &&
      (label === "sign in" || label === "log in" || label === "login")
    );
  });
  const action = actions[0];
  if (
    identifiers.length !== 1 ||
    passwords.length !== 1 ||
    actions.length !== 1 ||
    !action?.formAction ||
    action.formMethod?.toUpperCase() !== "POST"
  )
    return null;
  return {
    ref: action.ref,
    label: action.label,
    formAction: action.formAction,
    formMethod: "POST",
  };
}

/**
 * Uses credentials the person supplied for one exact task. This policy lives
 * beside the application agent, while the browser runtime only supplies page
 * mechanics. The secret is loaded only after the page is proven to be a
 * sign-in form and is never returned in observations or errors.
 */
export async function completeTaskLocalSignIn(input: {
  hands: ApplyPageHands;
  clickAuthorizedFormAction: (ref: string) => Promise<ApplyWriteResult>;
  credential: TaskLocalCredentialReference;
}): Promise<void> {
  const hands = input.hands;
  const before = await hands.observe();
  if (before.blocker?.code === "account_creation_required") {
    throw new Error(
      "Task-local credentials cannot create an account. Complete account creation yourself.",
    );
  }
  if (before.blocker?.code === "multi_factor_required") {
    throw new Error(
      "Task-local credentials cannot complete multi-factor authentication.",
    );
  }
  if (before.blocker?.code === "security_challenge") {
    throw new Error(
      "Task-local credentials cannot complete a human-verification challenge.",
    );
  }
  if (before.blocker?.code !== "site_login_required") {
    throw new Error(
      "The exact application page is not an observed sign-in form, so the one-use credentials were not used.",
    );
  }

  const identifierControl = visibleCredentialControls(before, "identifier")[0];
  const passwordControl = visibleCredentialControls(before, "password")[0];
  const signInAction = selectObservedSignInAction(before);
  if (!identifierControl || !passwordControl || !signInAction) {
    throw new Error(
      "The exact sign-in page did not expose one identifier, one password, and one safe POST sign-in action, so the one-use credentials were not used.",
    );
  }

  const credential = input.credential.load();
  const identifierResult = await runCredentialMechanic(
    () => hands.fillText(identifierControl.ref, credential.identifier),
    "The sign-in identifier could not be entered.",
  );
  if (!identifierResult.ok) {
    throw new Error("The sign-in identifier could not be entered.");
  }
  const passwordResult = await runCredentialMechanic(
    () => hands.fillText(passwordControl.ref, credential.password),
    "The sign-in password could not be entered.",
  );
  if (!passwordResult.ok) {
    throw new Error("The sign-in password could not be entered.");
  }
  const signInResult = await runCredentialMechanic(
    () => input.clickAuthorizedFormAction(signInAction.ref),
    "The sign-in action could not be completed.",
  );
  if (!signInResult.ok) {
    throw new Error("The sign-in action could not be completed.");
  }
  await runCredentialMechanic(
    () => hands.wait(250),
    "The sign-in result could not be checked.",
  );

  const after = await runCredentialMechanic(
    () => hands.observe(),
    "The sign-in result could not be checked.",
  );
  if (
    after.blocker?.code === "site_login_required" ||
    after.blocker?.code === "account_creation_required"
  ) {
    throw new Error(
      "The site still requires account access after the one-use sign-in attempt.",
    );
  }
}
