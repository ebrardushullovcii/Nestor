import {
  classifyFailure,
  FAILURE_SENTENCES,
  getJobFinderErrorDetail,
} from "./describe-failure";

export {
  classifyFailure,
  describeFailure,
  FAILURE_SENTENCES,
  getJobFinderErrorDetail,
  TECHNICAL_DETAILS_LABEL,
} from "./describe-failure";

/**
 * Text that proves the thrown message was written for a developer: Electron's
 * transport wrapper, a stored identifier, a database or socket code, a stack
 * frame, a JavaScript runtime error, or a model vendor's own payload.
 *
 * These are the exact shapes RC-02 caught reaching people: `Apply run
 * '<uuid>' is already executing.`, `Unable to find bullet '<id>'.`,
 * `Unsupported resume patch operation: <name>`, "Both resume import
 * extraction branches failed." on the first screen a new user sees, the
 * literal `Error invoking remote method 'job-finder:…'`, and — through
 * `openai-compatible-transport` — the provider's own error text.
 */
const INTERNAL_DETAIL_PATTERNS = [
  /Error invoking remote method/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
  /\b(?:apply_run|discovery_run|job|draft|record|result|target)_[0-9a-f]{6,}\b/i,
  /\bSQLITE_[A-Z]+\b/,
  /\bE(?:NOTFOUND|CONNREFUSED|CONNRESET|TIMEDOUT|AI_AGAIN|NOENT|ACCES|PERM)\b/,
  /\bat [\w$.[\]]+ \([^)]*:\d+:\d+\)/,
  /\b(?:undefined is not|cannot read propert(?:y|ies)|is not a function)\b/i,
  /\bModel returned (?:a non-JSON response|invalid JSON)\b/i,
  /\bUnsupported resume patch operation\b/i,
  /\bUnable to find bullet\b/i,
  /\bextraction branches failed\b/i,
  /\btiming summary was not retained\b/i,
  // A schema rejection: the validator's own JSON report of issue codes and
  // field paths, which reached people as a raw blob in a toast and a dialog.
  /"code"\s*:\s*"[a-z_]+"/i,
  /"path"\s*:\s*\[/i,
];

/**
 * Turn a thrown value into the copy a person reads.
 *
 * This used to be a pure pass-through: it stripped Electron's `Error invoking
 * remote method '…':` wrapper and returned the rest of the thrown message
 * unchanged, so a UUID, a bullet id, an internal operation name or a model
 * vendor's error text could land in a toast (RC-02). It was also used at only
 * 3 of the ~40 error render sites, so most sites could show that literal
 * wrapper string.
 *
 * It now **classifies**: any failure whose text proves it was written for a
 * developer is replaced by one member of {@link FAILURE_SENTENCES} — a plain
 * sentence that says what happened and what the person can do. Internal text
 * can no longer reach a screen through this function.
 *
 * ## Staged, not finished
 *
 * The residual branch still returns the stripped message, because some
 * packages throw text that is genuinely good copy for the person ("Unlock the
 * 'Summary' section before applying this change.") and this function cannot
 * tell, from a string, which screen it is about to appear on. Deciding that
 * per site is the adoption work each zone package owns: replace the call with
 * {@link describeFailure}, which never passes anything through, and put the
 * raw text behind a `TECHNICAL_DETAILS_LABEL` disclosure.
 *
 * Until then the residual branch is quarantined: `user-copy.test.ts` forbids
 * `getJobFinderErrorMessage(` outside its `PENDING_ADOPTION` allowlist, and
 * that allowlist must be empty when the last zone package lands. **Do not add
 * a new call site.** New code uses {@link describeFailure}.
 *
 * For the raw text itself — feeding another classifier, or filling a
 * disclosure — use {@link getJobFinderErrorDetail}, which is named for being
 * technical detail rather than copy.
 *
 * @param fallbackMessage the sentence for this specific action, used when
 * there is no readable failure text at all. Write it as a full sentence
 * saying what did not happen.
 */
export function getJobFinderErrorMessage(
  error: unknown,
  fallbackMessage: string,
): string {
  const detail = getJobFinderErrorDetail(error);

  if (detail === null) {
    return fallbackMessage;
  }

  if (INTERNAL_DETAIL_PATTERNS.some((pattern) => pattern.test(detail))) {
    const kind = classifyFailure(error);

    return kind === "unknown"
      ? FAILURE_SENTENCES.unknown
      : FAILURE_SENTENCES[kind];
  }

  return detail;
}
