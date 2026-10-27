import { normalizeSignal } from "./control-classification";
import type {
  ApplyBlocker,
  ApplyFormAction,
  ApplyFormControl,
  ApplyPageLink,
  ApplyFormObservation,
} from "./types";

/**
 * Things on a page that stop an application and need the person.
 *
 * Every one of these is user-owned by decision, not by limitation: signing in,
 * creating an account, a security check, and a second factor stay with the
 * person (ADR 0012). The copy says what the page is showing and what to do,
 * never why the automation failed.
 */

const SIGN_IN_SIGNALS = [
  "sign in to continue",
  "log in to continue",
  "please sign in",
  "please log in",
  "you must be signed in",
  "you must be logged in",
  "sign in to apply",
  "log in to apply",
];

const ACCOUNT_SIGNALS = [
  "create an account",
  "create your account",
  "register to apply",
  "sign up to apply",
  "create a candidate account",
  "create profile to continue",
];

/**
 * Interstitials a site shows while it checks the browser on its own. Nothing
 * on them is for a person to do; they finish by themselves, often after a
 * minute. Telling the model these were "a security check it never answers"
 * made it give up on a page that would have loaded had it waited.
 */
const AUTOMATIC_CHECK_SIGNALS = [
  "just a moment",
  "checking your browser",
  "checking if the site connection is secure",
  "performing security verification",
  "verification successful",
  "waiting for",
  "please wait while we verify",
  "ddos protection",
  "needs to review the security of your connection",
];

const CHALLENGE_SIGNALS = [
  "verify you are human",
  "verify you are a human",
  "i am not a robot",
  "security check",
  "unusual traffic",
  "complete the challenge",
  "prove you are not a robot",
];

/** A model may describe a challenge read in a child frame but omit the
 * structured needsPerson flag. Preserve that explicit handoff; the mere
 * presence of an invisible CAPTCHA script is not a challenge. */
export function reportedSecurityChallenge(reason: string): ApplyBlocker | null {
  const text = normalizeSignal(reason);
  const challenge = "(?:h ?captcha|re ?captcha|captcha)";
  const asksForPerson = new RegExp(
    `(?:review|solve|complete|finish|retry) (?:the |a )?${challenge}\\b|\\b${challenge}\\b.{0,140}(?:please try again|needs (?:you|a person)|requires (?:human|manual)|waiting for (?:you|a person))`,
    "u",
  ).test(text);
  if (!asksForPerson) return null;
  return {
    code: "security_challenge",
    requiresPerson: true,
    summary: "The site asks you to complete a CAPTCHA.",
    detail:
      "Complete the security check in the browser, then continue this application.",
    nextActionLabel: "Open the browser and complete the security check",
  };
}

const SECOND_FACTOR_SIGNALS = [
  "verification code",
  "two factor",
  "two step verification",
  "one time code",
  "authentication code",
  "enter the code we sent",
];

const CLOSED_SIGNALS = [
  "no longer accepting applications",
  "this job is closed",
  "position has been filled",
  "posting is closed",
  "applications are closed",
  "this posting is no longer available",
];

function hasPasswordControl(controls: readonly ApplyFormControl[]): boolean {
  return controls.some(
    (control) =>
      control.visible &&
      /\bpassword\b/u.test(
        normalizeSignal(`${control.label} ${control.placeholder}`),
      ),
  );
}

function hasAnsweredPasswordControl(
  controls: readonly ApplyFormControl[],
): boolean {
  return controls.some(
    (control) =>
      control.visible &&
      control.answered &&
      /\bpassword\b/u.test(
        normalizeSignal(`${control.label} ${control.placeholder}`),
      ),
  );
}

function hasSignInAction(actions: readonly ApplyFormAction[]): boolean {
  return actions.some((action) => {
    const signal = normalizeSignal(action.label);
    return (
      action.visible &&
      (signal === "sign in" || signal === "log in" || signal === "login")
    );
  });
}

function hasAccountCreationAction(
  actions: readonly ApplyFormAction[],
): boolean {
  return actions.some((action) => {
    const signal = normalizeSignal(action.label);
    return (
      action.visible &&
      /^(?:create (?:an? )?account|register|sign up)(?:\b|$)/u.test(signal)
    );
  });
}

function isExactLink(link: ApplyPageLink, pattern: RegExp): boolean {
  return link.visible && pattern.test(normalizeSignal(link.label));
}

function isAccountChoiceWall(input: {
  controls: readonly ApplyFormControl[];
  links: readonly ApplyPageLink[];
}): boolean {
  const visibleControls = input.controls.filter((control) => control.visible);
  const hasSignIn = input.links.some((link) =>
    isExactLink(link, /^(?:sign in|log in|login)$/u),
  );
  const hasCreateAccount = input.links.some((link) =>
    isExactLink(link, /^(?:create (?:an? )?account|register|sign up)$/u),
  );
  const hasApplicationEntry = input.links.some((link) =>
    isExactLink(link, /^(?:apply|apply now|continue application)$/u),
  );
  return (
    visibleControls.length === 0 &&
    hasSignIn &&
    hasCreateAccount &&
    !hasApplicationEntry
  );
}

/**
 * A control that belongs to a security check ("I am not a robot", "verify you
 * are human"). Only the person answers these; Job Finder never touches them,
 * and must not undo an answer the person already gave.
 */
export function isSecurityChallengeControl(
  control: Pick<ApplyFormControl, "label" | "groupLabel" | "placeholder">,
): boolean {
  const signal = normalizeSignal(
    `${control.label} ${control.groupLabel} ${control.placeholder}`,
  );
  return contains(signal, CHALLENGE_SIGNALS);
}

function hasResolvedChallengeControl(
  controls: readonly ApplyFormControl[],
): boolean {
  const challengeControls = controls.filter((control) => {
    const signal = normalizeSignal(
      `${control.label} ${control.groupLabel} ${control.placeholder}`,
    );
    return control.visible && contains(signal, CHALLENGE_SIGNALS);
  });
  return (
    challengeControls.length > 0 &&
    challengeControls.every(
      (control) =>
        control.checked ||
        (control.answered && control.value.trim().length > 0),
    )
  );
}

function contains(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** Address shapes a site uses for the page that takes an account, not a job. */
const SIGN_IN_PATH_PATTERN =
  /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|registration|auth|oauth|sso|session|account\/(?:login|signin))(?:\/|$)/iu;

/** The words a field asks for when it wants an account rather than an answer. */
const CREDENTIAL_FIELD_PATTERN =
  /\b(?:password|passcode|username|user name|user id|email|e mail|remember me)\b/u;

/**
 * Whether this page is a way into an account rather than an application.
 *
 * A sign-in page has fields and a button like any form, so anything that only
 * counts controls will call it an application and start filling it in. It is
 * read the way a person reads it: a password field, an address that says so,
 * the page's own words, or a form whose every field is a credential.
 *
 * The person's sign-in stays theirs (ADR 0012), so this is never something to
 * work around — it is something to hand back with the page it happened on.
 */
export function looksLikeSignInPage(input: {
  url: string | null;
  bodyText: string;
  controls: readonly ApplyFormControl[];
  actions: readonly ApplyFormAction[];
}): boolean {
  if (hasPasswordControl(input.controls)) {
    return true;
  }
  if (contains(normalizeSignal(input.bodyText), SIGN_IN_SIGNALS)) {
    return true;
  }

  const answerable = input.controls.filter(
    (control) => control.visible && !control.disabled && !control.readOnly,
  );
  const everyFieldIsACredential =
    answerable.length > 0 &&
    answerable.every((control) =>
      CREDENTIAL_FIELD_PATTERN.test(
        normalizeSignal(
          `${control.label} ${control.groupLabel} ${control.placeholder}`,
        ),
      ),
    );
  if (everyFieldIsACredential && hasSignInAction(input.actions)) {
    return true;
  }

  let path = "";
  try {
    path = input.url ? new URL(input.url).pathname : "";
  } catch {
    path = "";
  }
  return SIGN_IN_PATH_PATTERN.test(path) && answerable.length > 0;
}

/**
 * The page wants an account before it will take the application.
 *
 * Shared, because a page can say so in its own words and a listing can say so
 * by offering nothing but a sign-in link where the apply control should be.
 * The person's sign-in stays theirs either way (ADR 0012).
 */
export function siteLoginRequiredBlocker(requiresPerson = true): ApplyBlocker {
  return {
    code: "site_login_required",
    requiresPerson,
    summary: "The site wants you signed in first.",
    detail:
      "Your sign-in stays yours. Sign in on this site and Job Finder can pick the application back up.",
    nextActionLabel: "Sign in on the site",
  };
}

export function detectApplyBlocker(input: {
  bodyText: string;
  controls: readonly ApplyFormControl[];
  actions: readonly ApplyFormAction[];
  links?: readonly ApplyPageLink[];
}): ApplyBlocker | null {
  const text = normalizeSignal(input.bodyText);

  // A refusal is terminal for this browser; an automatic interstitial is not.
  if (
    !input.controls.some(
      (control) => control.visible && !isSecurityChallengeControl(control),
    ) &&
    /\b(?:access denied|you have been blocked|your (?:browser|request|ip(?: address)?) (?:has been|is) blocked|this browser is (?:blocked|not supported)|automated (?:access|requests|browsers) (?:are |is )?(?:blocked|not allowed))\b/u.test(
      text,
    )
  ) {
    return {
      code: "browser_blocked",
      requiresPerson: true,
      summary: "The site refused this browser.",
      detail:
        "This application is blocked. Open the job in your browser to apply by hand. Job Finder will not retry or try to get around the block.",
      nextActionLabel: "Open in my browser",
    };
  }

  if (
    contains(text, AUTOMATIC_CHECK_SIGNALS) &&
    !contains(text, ["captcha", "i am not a robot", "verify you are human"])
  ) {
    return {
      code: "security_challenge",
      requiresPerson: false,
      summary: "The site is checking the browser by itself.",
      detail:
        "This kind of page usually finishes on its own. Wait 20 to 30 seconds and look again, and keep doing that for up to two minutes, before reporting it. Only a page that asks you to tick a box or solve a puzzle needs the person.",
      nextActionLabel: "Open the page and let the check finish",
    };
  }

  if (
    contains(text, CHALLENGE_SIGNALS) &&
    !hasResolvedChallengeControl(input.controls)
  ) {
    return {
      code: "security_challenge",
      requiresPerson: true,
      summary: "The site is running a security check.",
      detail:
        "The page asked to confirm a person is here. Job Finder never answers those, so it stopped and left the page as it found it.",
      nextActionLabel: "Open the page and finish it yourself",
    };
  }

  if (
    contains(text, SECOND_FACTOR_SIGNALS) &&
    (!hasPasswordControl(input.controls) ||
      input.controls.some(
        (control) =>
          control.visible &&
          ["text", "long_text", "other"].includes(control.kind) &&
          contains(
            normalizeSignal(`${control.label} ${control.placeholder}`),
            SECOND_FACTOR_SIGNALS,
          ),
      ))
  ) {
    return {
      code: "multi_factor_required",
      requiresPerson: true,
      summary: "The site asked for a code sent to you.",
      detail:
        "Only you have that code, so Job Finder stopped here without entering anything.",
      nextActionLabel: "Open the page and enter your code",
    };
  }

  if (
    (contains(text, ACCOUNT_SIGNALS) &&
      (hasPasswordControl(input.controls) ||
        hasAccountCreationAction(input.actions))) ||
    (hasPasswordControl(input.controls) &&
      hasAccountCreationAction(input.actions))
  ) {
    return {
      code: "account_creation_required",
      requiresPerson: true,
      summary: "The site wants an account before you can apply.",
      detail:
        "Job Finder never creates accounts for you. Make the account once and it can carry on from there.",
      nextActionLabel: "Create the account yourself",
    };
  }

  if (
    contains(text, SIGN_IN_SIGNALS) ||
    (hasPasswordControl(input.controls) && hasSignInAction(input.actions)) ||
    isAccountChoiceWall({
      controls: input.controls,
      links: input.links ?? [],
    })
  ) {
    return siteLoginRequiredBlocker(
      !hasAnsweredPasswordControl(input.controls),
    );
  }

  if (contains(text, CLOSED_SIGNALS)) {
    return {
      code: "application_closed",
      requiresPerson: false,
      summary: "This job is no longer taking applications.",
      detail: "The page says the posting is closed, so nothing was filled in.",
      nextActionLabel: "Mark this job closed",
    };
  }

  return null;
}

const CONFIRMATION_SIGNALS = [
  "application submitted",
  "thank you for applying",
  "thanks for applying",
  "we have received your application",
  "your application has been received",
  "application received",
  "successfully applied",
  "application complete",
];

/**
 * Whether the page is showing the words a site uses after it takes an
 * application.
 *
 * This is an observation, never proof. A site can show these words and still
 * lose the application, and plenty of sites that did receive one say nothing
 * at all. It exists so a person can be told what was actually on screen after
 * Job Finder pressed send, rather than being left with nothing.
 */
export function hasSubmissionConfirmationText(pageText: string): boolean {
  const haystack = normalizeSignal(pageText);
  return CONFIRMATION_SIGNALS.some((signal) => haystack.includes(signal));
}

/** An absent wall is insufficient: a blank/error/auth callback page cannot resume Apply. */
export function canContinueApplicationAfterAccess(
  page: ApplyFormObservation,
): boolean {
  if (
    page.loading ||
    page.blocker ||
    page.controls.some(
      (control) => control.visible && control.credentialRole === "password",
    )
  )
    return false;
  return (
    page.controls.some(
      (control) =>
        control.visible &&
        !control.disabled &&
        !control.credentialRole &&
        !isSecurityChallengeControl(control),
    ) ||
    [...page.links, ...page.actions].some(
      (action) =>
        action.visible &&
        /^(?:continue (?:application|to application))$/u.test(
          normalizeSignal(action.label),
        ),
    )
  );
}
