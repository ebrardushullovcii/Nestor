/**
 * One error voice for Job Finder.
 *
 * Round-nine review (RC-02) found ~40 render sites printing a thrown
 * `Error.message` verbatim as the app's error copy. What reached people that
 * way included `Apply run '<uuid>' is already executing.`, `Unable to find
 * bullet '<id>'.`, "Both resume import extraction branches failed." on the
 * first screen a new user sees, the literal string `Error invoking remote
 * method 'job-finder:…'`, and — through the provider transport — a model
 * vendor's own error text, provider name and key hints.
 *
 * The rule this module exists to enforce: **the renderer never renders a
 * thrown message.** A failure is classified into one of a small, closed set of
 * plain sentences ({@link FAILURE_SENTENCES}); the raw text goes only into a
 * Technical details disclosure, if anywhere.
 *
 * The set is closed on purpose. A new failure family is a decision about what
 * to tell a person and what they can do about it — it is added here, once,
 * with its sentence, rather than invented at a call site by forwarding
 * whatever a package happened to throw.
 */

/**
 * The failure families Job Finder distinguishes. Anything unrecognised is
 * `unknown` and gets the caller's own sentence, never the thrown text.
 */
export type FailureKind =
  | "offline"
  | "timed_out"
  | "busy"
  | "changed_elsewhere"
  | "not_found"
  | "site_blocked"
  | "assistant_unavailable"
  | "invalid_details"
  | "unusable_resume"
  | "paused"
  | "unknown";

/**
 * The closed set. Each sentence says what happened and what the person can do
 * next. No jargon, no "failed to", no stored identifier, no error code.
 *
 * `unknown` is the only entry a caller may override, by passing its own
 * action-specific sentence to {@link describeFailure}.
 */
export const FAILURE_SENTENCES = {
  offline:
    "Job Finder could not reach the internet. Check your connection and try again.",
  timed_out: "This took too long and stopped on its own. Try it again.",
  busy: "Something else is already doing this. Wait for it to finish, then try again.",
  changed_elsewhere:
    "This changed somewhere else while you were working on it. Reload it and make your change again.",
  not_found: "This is no longer here. Go back and choose it again.",
  site_blocked:
    "The job site would not let Job Finder continue. Finish this step yourself in the browser.",
  assistant_unavailable:
    "The writing assistant did not answer. Try again in a few minutes.",
  invalid_details:
    "Some details were missing or did not fit, so nothing was saved. Check the fields you just changed and try again.",
  paused:
    "Background work is paused, so nothing new can start. Press Resume background work on the Job Finder Home screen, then try again.",
  unknown: "Something went wrong and this did not finish. Try again.",
  unusable_resume:
    "No resume details were found in this file. Choose another file.",
} as const satisfies Record<FailureKind, string>;

/**
 * One name for the place raw failure text is allowed to appear. Anything
 * technical lives behind a disclosure carrying exactly this label, so a person
 * always meets the plain sentence first.
 */
export const TECHNICAL_DETAILS_LABEL = "Technical details";

export type FailureDescription = {
  /** The recognised family, for tone and for choosing a recovery control. */
  kind: FailureKind;
  /**
   * What Job Finder was doing, as a sentence: `Could not save your profile.`
   * Null when the caller named no action.
   */
  headline: string | null;
  /** One member of {@link FAILURE_SENTENCES}, or the caller's own sentence. */
  sentence: string;
  /**
   * The complete user-visible copy: headline then sentence. Deliberately not
   * called `message`, so it can never be mistaken for `Error.message` by a
   * reader or by the guard in `user-copy.test.ts`.
   */
  userMessage: string;
  /**
   * The raw text, for a {@link TECHNICAL_DETAILS_LABEL} disclosure only. Null
   * when there was nothing readable to show. Never render this as the failure
   * copy itself.
   */
  technicalDetails: string | null;
};

export type DescribeFailureOptions = {
  /**
   * What the person was doing, as a bare verb phrase in second person:
   * `"save your profile"`, `"open the application"`. Used as
   * `Could not <action>.`
   */
  action?: string | null;
  /**
   * The sentence to use when the failure is not one of the recognised
   * families. Lets a screen say something more specific than the generic
   * `unknown` sentence — but it is still copy the app wrote, not thrown text.
   */
  unknownSentence?: string | null;
};

const REMOTE_METHOD_ERROR_RE =
  /^Error invoking remote method '[^']+': (?:(?:[A-Za-z]*Error): )?(.*)$/s;

/**
 * The raw failure text with Electron's `Error invoking remote method '…':`
 * transport wrapper removed, or null when there was nothing readable.
 *
 * This is **technical detail, not copy**. It belongs behind a
 * {@link TECHNICAL_DETAILS_LABEL} disclosure, or as input to another
 * classifier. Rendering it as the failure sentence is the RC-02 defect.
 */
export function getJobFinderErrorDetail(error: unknown): string | null {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof error === "object" && error !== null
          ? (error as { message?: unknown }).message
          : null;

  if (typeof message !== "string") {
    return null;
  }

  const remoteMethodMatch = REMOTE_METHOD_ERROR_RE.exec(message);
  return remoteMethodMatch?.[1]?.trim() || message.trim() || null;
}

const OFFLINE_PATTERNS = [
  /\bfetch failed\b/i,
  /\boffline\b/i,
  /\bENOTFOUND\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bEAI_AGAIN\b/,
  /\bnetwork (?:error|request failed)\b/i,
  /\bfailed to fetch\b/i,
];

const TIMEOUT_PATTERNS = [
  /\btimed? ?out\b/i,
  /\btimeout\b/i,
  /\bETIMEDOUT\b/,
  /\bdeadline exceeded\b/i,
];

const BUSY_PATTERNS = [
  /\balready (?:executing|running|in progress)\b/i,
  /\bSQLITE_BUSY\b/,
  /\bis locked\b/i,
  /\banother .* is (?:already )?running\b/i,
];

const CHANGED_ELSEWHERE_PATTERNS = [
  /\bchanged (?:elsewhere|after it was saved|since)\b/i,
  /\bstale\b/i,
  /\brevision (?:mismatch|conflict)\b/i,
  /\bconcurrent (?:modification|update)\b/i,
  /\bout of date\b/i,
];

const NOT_FOUND_PATTERNS = [
  /\bunknown Job Finder\b/i,
  /\bnot found\b/i,
  /\bno longer exists\b/i,
  /\bunable to find\b/i,
  /\bmissing (?:job|record|draft|document)\b/i,
];

const SITE_BLOCKED_PATTERNS = [
  /\bsite login required\b/i,
  /\bblocked by the site\b/i,
  /\bservice worker\b/i,
  /\bnavigation was blocked\b/i,
  /\bCAPTCHA\b/i,
];

const ASSISTANT_UNAVAILABLE_PATTERNS = [
  /\bmodel returned\b/i,
  /\bprovider\b.*\b(?:unavailable|error|refused)\b/i,
  /\bno usable candidates\b/i,
  /\bextraction branches failed\b/i,
  /\brate limit\b/i,
  /\b(?:401|403|429|5\d\d)\b.*\bstatus\b/i,
];

/**
 * A schema rejection. The thrown text is the validator's own JSON report of
 * issue codes and field paths — never copy, and what reached a person as
 * `A compensation currency awaiting clarification must remain unset.`
 */
const INVALID_DETAILS_PATTERNS = [
  /"code"\s*:\s*"[a-z_]+"/i,
  /"path"\s*:\s*\[/i,
  /\bvalidation (?:error|failed)\b/i,
  /\binvalid (?:input|type|enum value|literal value|union)\b/i,
];

const PAUSED_PATTERNS: readonly RegExp[] = [
  /activity is paused/i,
  /resume background work/i,
];

const KIND_PATTERNS: readonly (readonly [
  Exclude<FailureKind, "unknown">,
  readonly RegExp[],
])[] = [
  // Ordered most specific first: "already executing" is busy even though the
  // same string may also contain a job id that looks like a missing record.
  ["paused", PAUSED_PATTERNS],
  ["busy", BUSY_PATTERNS],
  ["changed_elsewhere", CHANGED_ELSEWHERE_PATTERNS],
  ["site_blocked", SITE_BLOCKED_PATTERNS],
  ["timed_out", TIMEOUT_PATTERNS],
  ["offline", OFFLINE_PATTERNS],
  ["not_found", NOT_FOUND_PATTERNS],
  ["assistant_unavailable", ASSISTANT_UNAVAILABLE_PATTERNS],
  ["unusable_resume", [/No resume details were found in this file/i]],
  ["invalid_details", INVALID_DETAILS_PATTERNS],
];

/**
 * Classify a thrown value into one of {@link FAILURE_SENTENCES}. Exported so a
 * screen can pick a recovery control from the family without re-deriving it
 * from the sentence text.
 */
export function classifyFailure(error: unknown): FailureKind {
  const detail = getJobFinderErrorDetail(error);

  if (detail === null) {
    return "unknown";
  }

  for (const [kind, patterns] of KIND_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(detail))) {
      return kind;
    }
  }

  return "unknown";
}

/**
 * The one way a Job Finder screen turns a thrown value into copy.
 *
 * Returns a plain sentence from the closed set and keeps the raw text in
 * {@link FailureDescription.technicalDetails}, for a
 * {@link TECHNICAL_DETAILS_LABEL} disclosure. It never returns thrown text as
 * the visible sentence, whatever the thrown value contained.
 */
export function describeFailure(
  error: unknown,
  options: DescribeFailureOptions = {},
): FailureDescription {
  const kind = classifyFailure(error);
  const action = options.action?.trim();
  const headline = action ? `Could not ${action}.` : null;
  const sentence =
    kind === "unknown"
      ? (options.unknownSentence?.trim() ?? "") || FAILURE_SENTENCES.unknown
      : FAILURE_SENTENCES[kind];

  return {
    kind,
    headline,
    sentence,
    userMessage: headline ? `${headline} ${sentence}` : sentence,
    technicalDetails: getJobFinderErrorDetail(error),
  };
}

/**
 * The runtime deliberately records exactly what a page tried to do when it was
 * blocked ("Blocked: xhr POST https://example.test/cdn-cgi/rum?..."), and that
 * fact is worth keeping. Appending it to the sentence a person is meant to act
 * on is not: it turned a human instruction on Needs you into a request log.
 *
 * Splits that recorded line off the end so the plain sentence leads and the
 * technical line goes behind a {@link TECHNICAL_DETAILS_LABEL} disclosure.
 * Text without such a line comes back unchanged with no details.
 */
const BLOCKED_ATTEMPT_NOTE_PATTERN = /\s*(Blocked:\s\S.*)$/i;

const INTERNAL_NO_PROGRESS_MESSAGE =
  /the page did not expose a new form state after the previous safe advance\. the runtime stopped instead of repeating a control or guessing at page behavior\.?/i;
export const NO_PROGRESS_MESSAGE =
  "This page did not change after Job Finder moved forward, so it stopped to avoid repeating the same action.";

/** Rewrites known recorded runtime language before it reaches any screen. */
export function plainRecordedJobFinderText(value: string): string {
  return value.replace(INTERNAL_NO_PROGRESS_MESSAGE, NO_PROGRESS_MESSAGE);
}

export function splitBlockedAttemptNote(value: string | null | undefined): {
  message: string;
  technicalDetails: string | null;
} {
  const text = plainRecordedJobFinderText(value?.trim() ?? "");
  const match = BLOCKED_ATTEMPT_NOTE_PATTERN.exec(text);

  if (!match?.[1]) {
    return { message: text, technicalDetails: null };
  }

  const message = text.slice(0, match.index).trim();

  // A note with no sentence in front of it stays visible: hiding the only
  // thing that was recorded would leave an empty card.
  if (!message) {
    return { message: text, technicalDetails: null };
  }

  return { message, technicalDetails: match[1].trim() };
}

/** Restore errors use a closed set of recovery instructions, never thrown copy. */
export function describeWorkspaceRestoreFailure(
  error: unknown,
): FailureDescription {
  const failure = describeFailure(error, {
    action: "restore your workspace",
    unknownSentence: "Choose the export again and try once more.",
  });
  const detail = failure.technicalDetails ?? "";
  const sentences: readonly [string, string][] = [
    [
      "version Nestor cannot restore",
      "This export uses a version Nestor cannot restore. Your workspace was kept.",
    ],
    [
      "older export does not contain",
      "This older export does not contain the full workspace needed to restore it. Make a new export from the original workspace. Your current workspace was kept.",
    ],
    [
      "not a Nestor workspace export",
      "This file is not a Nestor workspace export. Choose an export made in Settings.",
    ],
    [
      "incomplete or damaged",
      "This export is incomplete or damaged. Your workspace was kept.",
    ],
    [
      "unsafe or damaged document",
      "This export contains an unsafe or damaged document. Your workspace was kept.",
    ],
    [
      "conflicting",
      "This export contains conflicting information. Your workspace was kept. Choose another export.",
    ],
    [
      "missing a document folder",
      "This export is missing documents needed to restore it. Your workspace was kept.",
    ],
    [
      "could not fully undo",
      "Restore stopped and could not fully undo the changes. Restore the safety export saved in Documents.",
    ],
    [
      "current work to finish",
      "Wait for Job Finder's current work to finish or stop it before restoring. Your workspace was kept.",
    ],
    ["Choose the export again", "Choose the export again before restoring."],
  ];
  const sentence = sentences.find(([match]) => detail.includes(match))?.[1];
  return sentence ? { ...failure, sentence, userMessage: sentence } : failure;
}

// These are service-authored recovery messages, not provider or transport text.
const LISTING_READ_MESSAGES = new Set([
  "The listing could not be read from this page. Open the listing and try again.",
  "The fit assessment could not be completed. Your previous assessment was kept. Try again.",
  "The listing could not be assessed. Your previous assessment was kept.",
  "This job is not in the saved or pending list. Use Assess next 1 listing in Find jobs to assess the search results.",
  "The AI is unavailable. Try again.",
  "The linked listing names a different role. Open the listing and choose the role you want.",
  "Only a short excerpt could be read. Open the listing to check the requirements.",
  "The site asked Job Finder to slow down (HTTP 429). The listing is read again on the next search.",
]);

/** Preserve the service's recovery advice, while removing IPC wrappers. */
export function describeListingReadFailure(
  error: unknown,
  options: { listingUrl?: string; online?: boolean } = {},
): string {
  const online =
    options.online ??
    (typeof navigator === "undefined" || navigator.onLine !== false);
  if (!online) return FAILURE_SENTENCES.offline;
  if (classifyFailure(error) === "offline") {
    let host: string | null = null;
    try {
      host = options.listingUrl ? new URL(options.listingUrl).hostname : null;
    } catch {
      /* No usable site address. */
    }
    return host
      ? `Job Finder could not reach ${host}. Open the listing in the browser and try again.`
      : "Job Finder could not reach this job site. Open the listing in the browser and try again.";
  }
  const detail = getJobFinderErrorDetail(error);
  if (detail && LISTING_READ_MESSAGES.has(detail)) return detail;
  if (detail?.startsWith("The page answered "))
    return "The job site could not provide this listing. Open it in the browser and try again.";
  return describeFailure(error, {
    unknownSentence: "Could not assess this listing. Try again.",
  }).userMessage;
}

const BROWSER_JOB_MESSAGES = new Set([
  "Open a job listing on a website first.",
  "Wait for this page to finish loading, then try again.",
  "No job listing was found on this page. Open the job's own listing and try again.",
  "This job could not be saved. Try again.",
]);
export function describeBrowserJobFailure(error: unknown): string {
  const detail = getJobFinderErrorDetail(error);
  if (detail && BROWSER_JOB_MESSAGES.has(detail)) return detail;
  return describeFailure(error, {
    unknownSentence: "Could not save this job. Try again.",
  }).userMessage;
}
