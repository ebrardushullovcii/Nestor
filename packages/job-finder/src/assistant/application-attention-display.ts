import type { JobFinderRendererWorkspaceSnapshot } from "@nordri/contracts";
type ApplyResult =
  | JobFinderRendererWorkspaceSnapshot["applyJobResults"][number]
  | null;
// Existing application display rules, shared without changing their meaning.

/**
 * The question a run paused on, exactly as the site asks it. The runtime
 * writes it into the stop sentence in quotes; the panel shows the question
 * rather than a paragraph about the pause.
 */
export function getPausedQuestionText(result: ApplyResult): string | null {
  const corpus = result
    ? `${result.blockerSummary ?? ""} ${result.detail ?? ""} ${result.summary ?? ""}`
    : "";
  const quoted = corpus.match(/["“‘']([^"”’']{6,300})["”’']/);
  const question = quoted?.[1]?.trim();
  return question && !["(unknown)", "unknown"].includes(question.toLowerCase())
    ? formatQuestionPrompt(question)
    : null;
}

/**
 * The question as a person should read it. The runtime stores a field's label
 * and its description joined by an em dash, and a field whose description is
 * just its label again came out as "Phone — Phone".
 */
export function formatQuestionPrompt(prompt: string): string {
  const halves = prompt.split(/\s+[—–-]\s+/);
  const kept: string[] = [];
  for (const half of halves) {
    const text = half.trim();
    if (!text) {
      continue;
    }
    if (kept.some((seen) => seen.toLowerCase() === text.toLowerCase())) {
      continue;
    }
    kept.push(text);
  }

  return kept.join(" — ") || prompt.trim();
}

/** True when the run stopped because the form asked something it cannot answer. */
export function applyResultPausedOnQuestion(result: ApplyResult): boolean {
  return (
    result?.blockerReason === "question_grounding_failed" ||
    result?.blockerReason === "required_human_input" ||
    result?.blockerReason === "field_interpretation_failed"
  );
}

/**
 * True when the run actually handed back something to answer. A run that got
 * stuck, or lost its model, carries the same blocker reason with no question
 * behind it, and that is a run to try again, not a question to answer.
 */
export function applyResultHasQuestionForPerson(
  result: ApplyResult,
  pendingQuestionCount: number | null | undefined,
  pausedQuestion?: string | null,
): boolean {
  if (!applyResultPausedOnQuestion(result)) return false;
  return (
    (pendingQuestionCount ?? 0) > 0 ||
    (result?.latestQuestionCount ?? 0) > 0 ||
    Boolean(
      pausedQuestion?.trim() &&
      !["unknown", "(unknown)"].includes(pausedQuestion.trim().toLowerCase()),
    ) ||
    getPausedQuestionText(result) !== null
  );
}

/** Older CAPTCHA handoffs used the generic human-input code, without a question. */
export function applyResultNeedsSecurityCheck(result: ApplyResult): boolean {
  if (result?.state !== "awaiting_review" && result?.state !== "blocked")
    return false;
  return (
    result.blockerReason === "site_protection" ||
    (result.blockerReason === "required_human_input" &&
      /\b(?:captcha|verify (?:that )?you are human|security check)\b/i.test(
        readReasonCorpus(result),
      ))
  );
}

/**
 * True when the site is asking for an account rather than a sign-in. Same
 * shape of answer — the person does it themselves in the browser — but the
 * sentence and the row label say "account" rather than "sign in".
 */
export function looksLikeAccountWall(input: {
  blockerCode?: string | null;
  text?: string | null;
}): boolean {
  const { blockerCode, text } = input;

  if (
    blockerCode === "account_required" ||
    blockerCode === "site_account_required" ||
    blockerCode === "signup_consent_required"
  ) {
    return true;
  }

  return Boolean(text && ACCOUNT_WALL_PATTERN.test(text));
}

/** Words a page uses when it wants an account created before it shows a form. */
const ACCOUNT_WALL_PATTERN =
  /\b(?:wants an account|requires? (?:you to )?(?:create|register)|create an account|sign ?up (?:is )?required|register(?:ed)? before applying|account before you can apply)\b/i;

/** Words a page uses when it is asking for a sign-in before it will show a form. */
const LOGIN_WALL_PATTERN =
  /\b(?:sign[- ]?in wall|log[- ]?in wall|paywall of a login|sign[- ]?in (?:is )?required|log ?in (?:is )?required|requires? (?:a )?(?:login|sign[- ]?in|account)|must (?:log|sign) ?in|need(?:s|ing)? to (?:log|sign) ?in|(?:login|sign[- ]?in) before applying|create an account before applying)\b/i;

/** A URL the run finished on that is plainly a sign-in page rather than a form. */
const LOGIN_URL_PATTERN =
  /(?:^|[/.])(?:login|log-in|signin|sign-in|sign_in|auth|oauth|sso|account\/login)(?:[/?#]|$)/i;

/**
 * True when this stop is a site asking the person to sign in, whether the run
 * recorded that as a blocker code, said it in its own sentence, or simply ended
 * on the site's login page.
 */
export function looksLikeSignInWall(input: {
  blockerCode?: string | null;
  destinationUrl?: string | null;
  text?: string | null;
}): boolean {
  const { blockerCode, destinationUrl, text } = input;

  if (
    blockerCode === "site_login_required" ||
    blockerCode === "auth_required" ||
    blockerCode === "account_required" ||
    blockerCode === "site_account_required" ||
    blockerCode === "signup_consent_required"
  ) {
    return true;
  }

  if (text && LOGIN_WALL_PATTERN.test(text)) {
    return true;
  }

  if (!destinationUrl) {
    return false;
  }

  try {
    return LOGIN_URL_PATTERN.test(new URL(destinationUrl).pathname);
  } catch {
    return LOGIN_URL_PATTERN.test(destinationUrl);
  }
}

function readReasonCorpus(result: ApplyResult): string {
  if (!result) {
    return "";
  }

  return `${result.detail ?? ""} ${result.blockerSummary ?? ""} ${result.summary ?? ""}`;
}
