import type {
  ApplicationAnswerSourceKind,
  ApplicationBlockerCode,
  ApplicationQuestionStatus,
  ApplyRunMode,
  ApplyRunState,
  BrowserSessionStatus,
  CandidateAssetConsentScope,
  CandidateAssetKind,
  CandidateAssetRetention,
  ResumeDraftPatchOperation,
  ResumeExtractionStatus,
  DiscoveryRunState,
  WorkMode,
} from "@nestor/contracts";

/** Where a job search stands, without exposing the stored run-state names. */
export const DISCOVERY_RUN_STATE_LABELS = {
  idle: "Not started",
  running: "Searching",
  completed: "Completed",
  cancelled: "Stopped",
  failed: "Stopped with a problem",
} as const satisfies Record<DiscoveryRunState, string>;

export const DISCOVERY_STOPPING_LABEL = "Stopping";

/**
 * What a search that never answered Stop is called.
 *
 * The app cannot see inside a search it has lost hold of, so it says so
 * instead of counting "Stopping" upward forever. Everything the stop request
 * was holding disabled is released at the same moment.
 */
export const DISCOVERY_STOP_UNACKNOWLEDGED_LABEL =
  "Stopped, some work may have finished in the background";

/**
 * One status vocabulary for Job Finder.
 *
 * Round-nine review (RC-03) found that the app had no status vocabulary at
 * all — only `formatStatusLabel`, a generic `_`-to-space title-caser called 53
 * times across 23 files, plus ~20 bare `replaceAll("_", " ")` sites. The
 * result was stored enum values printed as user copy: "Required human input",
 * "Site login required", "Awaiting Review", "awaiting user", "prepare only",
 * and — as the heading of every Assistant proposal card, directly above a
 * well-written plain-English summary — "replace section bullets".
 *
 * Every table here is an exhaustive `Record<Enum, string>` written with
 * `satisfies`, so adding a variant to the contract enum fails typecheck at
 * this file rather than silently reaching a user as a title-cased identifier.
 * A `Partial<Record<…>>` with a `?? formatStatusLabel(value)` fallback is the
 * shape this module replaces: it type-checks forever while leaking every new
 * variant straight to the screen.
 *
 * Voice rules these tables follow:
 *
 * - say what it means for the person, not what the system recorded;
 * - no stored identifier, no snake_case, no internal noun (envelope, run,
 *   revision, digest, snapshot, IPC, renderer);
 * - a state that needs the user says so, and says what they can do;
 * - nothing here implies Job Finder submits an application. It opens the
 *   employer's form and fills what it can; the person reviews and sends it.
 *
 * `job-finder-browser-handoff-copy.ts` is the module this one generalises — the
 * same pattern, applied to the enums that reach a screen.
 *
 * Deliberately not covered here, because their render sites belong to zone
 * packages that own the surrounding copy and will add their table beside their
 * screen: manual action request state and kind (Needs you), the CRM stage and
 * timeline-entry kinds (Applications tracker), authority envelope status
 * (Settings), outcome-analytics keys (Outcomes), source-intelligence method
 * and availability enums (Discovery), and safeguard dismissal kinds
 * (Safeguards).
 */

/**
 * What stopped an application, in the words of the person it stopped.
 *
 * Read as the value of "What stopped progress", so each entry is a sentence
 * fragment about the application rather than a status name.
 */
export const APPLICATION_BLOCKER_LABELS = {
  missing_candidate_answer: "The form asks something you have not answered yet",
  requires_manual_review: "This step needs a decision from you",
  application_closed: "The listing is no longer accepting applications",
  unsupported_apply_path: "This employer's form is one Job Finder cannot fill",
  missing_resume: "This job has no approved resume yet",
  missing_consent: "You have not agreed to share a file this form asks for",
  external_redirect: "The application continues on another site",
  site_login_required: "The job site wants you to sign in first",
  application_page_unreachable: "The application page did not open",
  site_saves_as_you_go:
    "This site saves your answers as you type; run it again and Job Finder will let it",
  unknown: "Job Finder stopped and could not say why",
} as const satisfies Record<ApplicationBlockerCode, string>;

/**
 * Where a preparation attempt stands. "Run" is an internal noun and appears in
 * none of these: the person prepared an application, not a run.
 */
export const APPLY_RUN_STATE_LABELS = {
  draft: "Not started yet",
  awaiting_submit_approval: "Waiting for your go-ahead",
  running: "Filling the application",
  paused_for_user_review: "Paused for your review",
  paused_for_consent: "Paused until you decide what to share",
  completed: "Filled and ready for you to check",
  cancelled: "You stopped this",
  failed: "Stopped before it was ready",
} as const satisfies Record<ApplyRunState, string>;

/**
 * How the preparation was started. The stored names say "auto", which reads as
 * "applies for me"; the app only ever opens the form and fills it in.
 */
export const APPLY_RUN_MODE_LABELS = {
  copilot: "Preparation",
  single_job_auto: "Automatic preparation",
  queue_auto: "Automatic preparation, several jobs",
} as const satisfies Record<ApplyRunMode, string>;

/** Where one question on the employer's form stands. */
export const APPLICATION_QUESTION_STATUS_LABELS = {
  detected: "Found on the form",
  answered: "Filled in",
  submitted: "Sent with the application",
  skipped: "Left blank",
} as const satisfies Record<ApplicationQuestionStatus, string>;

/** Where an answer came from, so the person can judge whether to trust it. */
export const APPLICATION_ANSWER_SOURCE_LABELS = {
  profile: "From your profile",
  proof_bank: "From your saved answers",
  resume: "From your resume",
  job: "From the job posting",
  prior_answer: "From an earlier application",
  source_debug: "From a check of the job site",
  user: "You wrote this",
} as const satisfies Record<ApplicationAnswerSourceKind, string>;

/**
 * Work modes are stored lowercase ("remote"), so any surface printing them raw
 * shows a lowercase word beside sentence-case siblings.
 */
export const WORK_MODE_LABELS = {
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "On-site",
  flexible: "Flexible",
} as const satisfies Record<WorkMode, string>;

/**
 * The separate browser window Job Finder drives. Its name comes from
 * {@link ../lib/job-finder-browser-handoff-copy}; these say only what state it
 * is in.
 */
export const BROWSER_SESSION_STATUS_LABELS = {
  unknown: "Not checked yet",
  ready: "Open and ready",
  login_required: "Waiting for you to sign in",
  blocked: "The site blocked it",
} as const satisfies Record<BrowserSessionStatus, string>;

/**
 * How far Job Finder got reading the resume the person imported. This is the
 * first screen a new user sees, so "failed" never appears as a bare word.
 */
export const RESUME_EXTRACTION_STATUS_LABELS = {
  not_started: "Not read yet",
  needs_text: "Needs you to paste the text",
  ready: "Read and ready",
  failed: "Could not be read",
} as const satisfies Record<ResumeExtractionStatus, string>;

/** What a saved file is, in the words used to ask for it. */
export const CANDIDATE_ASSET_KIND_LABELS = {
  resume: "Resume",
  cover_letter: "Cover letter",
  application_response: "Written answer",
  portfolio: "Portfolio",
  work_sample: "Work sample",
  transcript: "Transcript",
  certificate: "Certificate",
  image: "Image",
  other: "Other file",
} as const satisfies Record<CandidateAssetKind, string>;

/** What the person agreed this file may be used for. */
export const CANDIDATE_ASSET_CONSENT_LABELS = {
  private_storage_only: "Kept on this device only",
  job_application_attachment: "May be attached to an application",
  assistant_context: "May be read by the writing assistant",
} as const satisfies Record<CandidateAssetConsentScope, string>;

/** How long the file is kept, stated as a duration rather than a policy id. */
export const CANDIDATE_ASSET_RETENTION_LABELS = {
  until_deleted: "Kept until you delete it",
  "30_days": "Deleted after 30 days",
  "90_days": "Deleted after 90 days",
} as const satisfies Record<CandidateAssetRetention, string>;

/**
 * The heading of an Assistant proposal card. These were the stored operation
 * names — "replace section bullets", "reset entry order" — printed directly
 * above a plain-English summary of the same change.
 */
export const RESUME_PATCH_OPERATION_LABELS = {
  replace_section_text: "Rewrite this section",
  replace_entry_summary: "Rewrite this summary",
  replace_entry_date_range: "Change date wording",
  insert_bullet: "Add a bullet",
  update_bullet: "Reword a bullet",
  remove_bullet: "Remove a bullet",
  move_bullet: "Move a bullet",
  move_entry: "Move this entry",
  reset_entry_order: "Put entries back in their original order",
  toggle_include: "Show or hide this entry",
  set_lock: "Lock this entry so edits leave it alone",
  replace_section_bullets: "Rewrite the bullets in this section",
} as const satisfies Record<ResumeDraftPatchOperation, string>;

/**
 * Every table in this module, so a guard can assert the set is exhaustive and
 * that no entry has drifted back into a stored identifier.
 */
export const STATUS_COPY_TABLES = {
  DISCOVERY_RUN_STATE_LABELS,
  APPLICATION_BLOCKER_LABELS,
  APPLY_RUN_STATE_LABELS,
  APPLY_RUN_MODE_LABELS,
  APPLICATION_QUESTION_STATUS_LABELS,
  APPLICATION_ANSWER_SOURCE_LABELS,
  WORK_MODE_LABELS,
  BROWSER_SESSION_STATUS_LABELS,
  RESUME_EXTRACTION_STATUS_LABELS,
  CANDIDATE_ASSET_KIND_LABELS,
  CANDIDATE_ASSET_CONSENT_LABELS,
  CANDIDATE_ASSET_RETENTION_LABELS,
  RESUME_PATCH_OPERATION_LABELS,
} as const;
