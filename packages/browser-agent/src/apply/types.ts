import type {
  ApplyAgentTiming,
  ApplyPickerAttempt,
  StoredApplyPickerAttempt,
} from "@nestor/contracts";
import type {
  ApplicationAttemptQuestion,
  ApplyAnswerTags,
  ApplyBlockedAttempt,
  CoverLetterPreference,
  AiApplyingBehavior,
  ApplyNavigationResult,
  ApplyServiceWorkerFinding,
  ApplyWriteResult,
  ApplicationAttestationKind,
  ApplicationAutomationMode,
  ApplicationQuestionControlType,
  ApplicationQuestionKind,
  ApplicationSalaryDisclosureRule,
  CandidateProfile,
  CandidateAssetKind,
  CandidateReusableAnswer,
  JobSearchPreferences,
  RawApplyUpload,
} from "@nestor/contracts";

/**
 * Shapes for the agent that fills in an employer's application form.
 *
 * The agent never touches a page directly. It proposes one bounded action at a
 * time; a deterministic executor binds that proposal to the page as it is right
 * now, to the saved authority document, and to the answers Job Finder can
 * actually prove before anything is written. See ADR 0012 and ADR 0021.
 */

/** What a form control is, in terms the rest of the loop reasons about. */
export type ApplyControlKind =
  | "text"
  | "long_text"
  | "select"
  | "combobox"
  | "checkbox"
  | "radio"
  | "file"
  | "date"
  | "other";

/** What a button on the form does. */
export type ApplyActionKind = "advance" | "back" | "final" | "other";

export interface ApplyFormControl {
  /** Stable handle for this control within one observation. */
  ref: string;
  kind: ApplyControlKind;
  /** Native date precision, retained so month inputs receive YYYY-MM. */
  dateInputType?: "date" | "month";
  inputConstraints?: {
    type: "number" | "date" | "month";
    min?: string;
    max?: string;
    step?: string;
  };
  acceptedTypes?: string[];
  label: string;
  /** Help text beside the field, such as the format it asks for. */
  hint?: string;
  groupLabel: string;
  /** A repeated question whose section did not distinguish two form steps. */
  repeatedQuestion?: { prompt: string; step: string };
  /** Stable identity shared by controls that belong to one choice group. */
  choiceGroupKey?: string;
  placeholder: string;
  required: boolean;
  /**
   * What the page itself says, before the model's reading of the label may
   * mark the question required. Only the page's word can make a saved rule
   * skip a whole application.
   */
  requiredOnPage?: boolean;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  value: string;
  /** Credential meaning without exposing the secret value to the model. */
  credentialRole?: "identifier" | "password" | null;
  checked: boolean;
  options: string[];
  selectedOptionLabel: string;
  invalid: boolean;
  validationMessage: string;
  /** What a file input's own field shows about its upload, when the page said. */
  upload?: RawApplyUpload;
  /** What the question is about, so an answer can be sourced for it. */
  questionKind: ApplicationQuestionKind;
  /** Model reading bound to the observed instructions and current source catalog. */
  answerTags?: ApplyAnswerTags | null;
  /** Model reading of current pay versus the person's saved expected pay. */
  asksCurrentPay?: boolean;
  /** Model reading: this asks for this application's hiring country. */
  asksHiringCountry?: boolean;
  answerControlType: ApplicationQuestionControlType;
  /** Set when the control asks the person to declare something themselves. */
  attestationKind: ApplicationAttestationKind | null;
  /** True when the control already carries an answer. */
  answered: boolean;
}

/** Where an action or clickable sits on the page; see `RawApplyPlacement`. */
export interface ApplyPlacement {
  /** The part of the page holding it: legend, dialog or section name, or nearby words. */
  section?: string;
  /** Inside a form, a fieldset or a group of fields. */
  inForm?: boolean;
}

export interface ApplyFormAction extends ApplyPlacement {
  ref: string;
  label: string;
  kind: ApplyActionKind;
  visible: boolean;
  disabled: boolean;
  formAction?: string;
  formMethod?: string;
}

/** What a link on the page opens, read from the address itself. */
export type ApplyLinkDestination = "page" | "email" | "document" | "other";

/**
 * A link on the page the run landed on.
 *
 * A listing and the form it leads to are usually two pages. These are how the
 * run finds the way through; nothing here is specific to any site.
 */
export interface ApplyPageLink {
  /** Stable handle for this link within one observation. */
  ref: string;
  label: string;
  href: string;
  origin: string | null;
  destination: ApplyLinkDestination;
  /** True when the link opens a window of its own rather than this one. */
  opensNewWindow: boolean;
  visible: boolean;
  /** Distance from the top of the page, used only to rank candidates. */
  topOffset: number;
}

/** Where the person is in a form that runs over several screens. */
export interface ApplyStepPosition {
  label: string | null;
  index: number | null;
  total: number | null;
}

export type ApplyBlockerCode =
  | "site_login_required"
  | "account_creation_required"
  | "security_challenge"
  | "multi_factor_required"
  | "application_closed"
  | "application_page_unreachable"
  /** The form saves each answer to the site as it is typed. */
  | "site_saves_as_you_go";

export interface ApplyBlocker {
  code: ApplyBlockerCode;
  /** True when this page cannot progress until the person completes the step. */
  requiresPerson?: boolean;
  /** One plain sentence about what the page is showing. */
  summary: string;
  detail: string;
  nextActionLabel: string;
  /**
   * The site the page was trying to reach, when the next action is about one.
   * It is what a one-click "allow saving on this site" would be granted for.
   */
  host?: string | null;
}

/** Anything clickable that is not a control, a button, or a link. */
export interface ApplyClickable extends ApplyPlacement {
  ref: string;
  label: string;
  role: string;
  tagName: string;
  visible: boolean;
}

export interface ApplyHeading {
  level: number;
  text: string;
}

export interface ApplyOpenedTab {
  index: number;
  url: string;
  title: string;
}

/**
 * The whole page, as the model sees it.
 *
 * Nothing here is filtered by a phrase list or a guess about what matters. A
 * page that shows an Apply button shows it here, whatever it is made of and
 * whatever it is called, and the model decides what to do with it. Filtering
 * the observation is how a harness ends up unable to see a button a person can
 * see plainly.
 */
export interface ApplyFormObservation {
  observedAt: string;
  /** Changes whenever the page changes; a write proposed against an older one is retried. */
  signature: string;
  url: string | null;
  origin: string | null;
  title: string | null;
  step: ApplyStepPosition;
  /** A bounded excerpt of what the page says. `read_text` gets the rest. */
  bodyTextExcerpt: string;
  /** Read from the full observed page before its model excerpt is shortened. */
  ownWordsRequired?: boolean;
  headings: ApplyHeading[];
  controls: ApplyFormControl[];
  actions: ApplyFormAction[];
  links: ApplyPageLink[];
  clickables: ApplyClickable[];
  /** Tabs the page opened for itself. Going to one is the model's choice. */
  openedTabs: ApplyOpenedTab[];
  validationErrors: string[];
  /** True while the page is still loading. The model may wait and look again. */
  loading: boolean;
  /**
   * Something only the person can do. Reported as a fact the model can act on
   * or work around; it never ends the run on its own.
   */
  blocker: ApplyBlocker | null;
}

/** A file Job Finder already holds for this application. */
export interface ApplyDocument {
  id: string;
  fileName: string;
  mimeType: string;
  /** What the file is, in the person's words ("Your CV", "Cover letter"). */
  label: string;
  kind: CandidateAssetKind;
  loadBytes: () => Promise<Uint8Array>;
  reviewText?: { text: string; groundedIn: string[] };
}

/**
 * The only way the loop reaches a page.
 *
 * Everything here is a browser mechanic. Nothing here decides what to write or
 * whether writing is allowed; that is the executor's job.
 */
export interface ApplyPageHands {
  observe: () => Promise<ApplyFormObservation>;
  navigate: (url: string) => Promise<ApplyNavigationResult>;
  clickElement: (ref: string) => Promise<ApplyWriteResult>;
  /** Presses a keyboard key on one element, or on the active page. */
  pressKey?: (
    ref: string | undefined,
    key: string,
  ) => Promise<ApplyWriteResult>;
  scroll: (
    direction: "down" | "up" | "top" | "bottom",
  ) => Promise<ApplyWriteResult>;
  wait: (milliseconds: number) => Promise<void>;
  goBack: () => Promise<ApplyNavigationResult>;
  readText: (ref?: string) => Promise<string>;
  readLinkedText?: () => Promise<string>;
  fillText: (ref: string, value: string) => Promise<ApplyWriteResult>;
  chooseOption: (ref: string, optionLabel: string) => Promise<ApplyWriteResult>;
  setToggle: (ref: string, checked: boolean) => Promise<ApplyWriteResult>;
  uploadFile: (
    ref: string,
    file: { name: string; mimeType: string; bytes: Uint8Array },
  ) => Promise<ApplyWriteResult>;
  clickAction: (ref: string) => Promise<ApplyWriteResult>;
  /** Report whether an intended action is reachable, without clicking it. */
  checkAction?: (ref: string) => Promise<ApplyWriteResult>;
  /** Opens what a link points at, in the same page. A read, never a write. */
  followLink: (ref: string) => Promise<ApplyNavigationResult>;
  /** Moves the run into a tab the page opened, closing that tab. */
  adoptOpenedTab?: (index: number) => Promise<ApplyNavigationResult>;
}

/** Where an answer came from. Every written answer carries one. */
export type ApplyAnswerSourceKind =
  | "profile"
  | "resume"
  | "posting"
  | "answer_library"
  | "generated"
  | "document";

export interface ApplyAnswer {
  value: string;
  kind: ApplicationQuestionKind;
  sourceKind: ApplyAnswerSourceKind;
  sourceId: string;
  /** One short phrase shown to the person: "from your profile". */
  provenanceLabel: string;
  /** What a written answer was built from. Always filled for generated text. */
  groundedIn: string[];
}

export interface ApplyAnswerSources {
  listingDiscovery?: { label: string; url: string };
  profile: CandidateProfile;
  preferences?: JobSearchPreferences | undefined;
  /** Plain text of the resume that goes with this application, when there is one. */
  resumeText: string | null;
  posting: {
    title: string;
    company: string;
    location: string;
    description: string;
  };
  /** Latest letter approved in this application's document library. */
  approvedLetterText?: string;
  reusableAnswers: readonly CandidateReusableAnswer[];
  documents: readonly ApplyDocument[];
}

/**
 * The saved permissions this run works inside.
 *
 * Job Finder derives every field before the run starts. Nothing the model says
 * can widen it.
 */
export interface ApplyAuthority {
  mode: ApplicationAutomationMode;
  /** Only ever true when the saved document covers this exact application. */
  submitAuthorized: boolean;
  preApprovedAttestationKinds: readonly ApplicationAttestationKind[];
  salaryDisclosure: ApplicationSalaryDisclosureRule;
  /** Exact origins where the final application may be sent. */
  allowedOrigins: readonly string[];
}

/**
 * The safety mechanics that belong to the open page.
 *
 * Supplied by whoever owns the browser. Omitting them is only ever right in a
 * test: a real run installs the guard before it reads anything.
 */
export interface ApplySafetyHooks {
  /** The most recent thing the prepare-only guard stopped, or null. */
  readBlockedAttempt: () => Promise<ApplyBlockedAttempt | null>;
  /** Tells the guard an exact value is now in a field. */
  registerPreparedValue: (value: string) => Promise<void>;
  /** Opens the short window in which the site may save the field just filled. */
  openIntermediateWriteWindow: () => Promise<void>;
  closeIntermediateWriteWindow: () => Promise<void>;
  /**
   * Lets an upload on its way finish, then shuts the attachment window.
   * Called before every press that is not a field write.
   */
  closeUploadWindow?: () => Promise<void>;
  /** Rechecks for a background worker that could change the page. */
  checkServiceWorker: () => Promise<ApplyServiceWorkerFinding | null>;
}

/**
 * The one letter this application sends.
 *
 * Whoever owns documents provides it: generated once, rendered when a form
 * wants a file, and the same words when a form wants it typed into a box.
 */
export interface ApplyLetterProvider {
  preference: CoverLetterPreference;
  provide: (request: {
    /** The kind of application document being written. */
    purpose?: "cover_letter" | "motivation_letter" | "supporting_statement";
    /** The actual field being answered; prompt below is drafting instructions. */
    formControl?: { ref: string; question: string };
    prompt: string;
    groundedIn: string[];
    language: string | null;
    delivery: "file" | "text";
    /** Exact text the person approved for this application; render without rewriting. */
    approvedText?: string;
    /** A file type the form insists on, when it named one. */
    fileType: "pdf" | "docx" | "txt" | null;
    /** Cancel local drafting when this form run ends or the person stops it. */
    signal?: AbortSignal;
  }) => Promise<
    | { ok: true; text: string; document: ApplyDocument | null }
    | { ok: false; reason: string; draftText?: string }
  >;
}

export type ApplyPauseCode =
  | "question_needs_you"
  | "declaration_needs_you"
  | "document_needs_you"
  | "page_blocked"
  | "site_tried_to_send";

export interface ApplyPause {
  reviewDraft?: { text: string; reason: string; groundedIn: string[] };
  code: ApplyPauseCode;
  /** One plain sentence for the Needs you list. */
  summary: string;
  /**
   * The first question this pause is about, kept so everything that read one
   * question still works.
   */
  question: ApplicationAttemptQuestion | null;
  /**
   * Every question the run could not answer, in the order they appear on the
   * page. A form is worked to the end before it stops, so the person answers
   * once rather than once per field.
   */
  questions?: ApplicationAttemptQuestion[];
  blocker: ApplyBlocker | null;
}

export interface ApplyFilledControl {
  fieldKey?: string;
  ref: string;
  label: string;
  questionKind: ApplicationQuestionKind;
  answer: ApplyAnswer;
  at: string;
}

export interface ApplyAttachedDocument {
  fieldKey?: string;
  documentId: string;
  fileName: string;
  label: string;
  controlLabel: string;
  at: string;
  reviewText?: { text: string; groundedIn: string[] };
}

export type ApplyAgentOutcome =
  | "prepared"
  /** Complete, with the send button identified. Nobody has pressed it. */
  | "ready_to_send"
  | "awaiting_your_review"
  | "paused"
  | "stuck";

export interface ApplyAgentResult {
  skipReason?: string;
  questionContexts?: Array<{ prompt: string; step: string }>;
  /** Choices pickers on this application refused, for the next run. */
  pickerAttempts?: ApplyPickerAttempt[];
  timing?: ApplyAgentTiming;
  outcome: ApplyAgentOutcome;
  /** One plain sentence about how the run ended. Shown to the person as-is. */
  reason: string;
  steps: number;
  finalUrl: string | null;
  filled: ApplyFilledControl[];
  attachments: ApplyAttachedDocument[];
  reviewFilled?: ApplyFilledControl[];
  reviewObservedFieldKeys?: string[];
  reviewAttachments?: ApplyAttachedDocument[];
  pauses: ApplyPause[];
  /** Plain-sentence trail of what happened, oldest first. */
  notes: string[];
  /** The same trail with the moment each line was written. */
  timeline: { at: string; text: string }[];
  /** How many times the model was asked. Zero means no model was used. */
  modelTurns: number;
  /**
   * The button that sends this application, once the form is complete and the
   * checks passed. Null whenever the application is not ready to go.
   */
  readyToSend: { actionRef: string; actionLabel: string } | null;
}

/**
 * One thing the model asked to do.
 *
 * These are the ordinary powers a person has in a browser. The executor binds
 * each one to the page as it is now and to what the person allowed, but it
 * does not second-guess which of them is appropriate: that is the model's job.
 */
export type ApplyProposal =
  | { tool: "observe" }
  | { tool: "read_text"; ref?: string }
  | { tool: "navigate"; url: string; reason?: string }
  | { tool: "follow_link"; ref: string; reason?: string }
  | { tool: "click"; ref: string; reason?: string }
  | {
      tool: "type";
      ref: string;
      text: string;
      groundedIn?: string[];
      storedFactId?: string;
    }
  | { tool: "select"; ref: string; option: string; storedFactId?: string }
  | {
      tool: "set_checkbox";
      ref: string;
      checked: boolean;
      storedFactId?: string;
    }
  | { tool: "upload"; ref: string; documentId: string }
  | { tool: "scroll"; direction: "down" | "up" | "top" | "bottom" }
  | { tool: "wait"; milliseconds: number }
  | { tool: "go_back" }
  | { tool: "submit_application"; ref: string }
  | {
      tool: "finish";
      reason: string;
      stuck?: boolean;
      needsPerson?: boolean;
    };

export interface ApplyAgentConfig {
  initialQuestionContexts?: ReadonlyArray<{ prompt: string; step: string }>;
  /** What earlier runs of this application learned about its pickers. */
  initialPickerAttempts?: readonly StoredApplyPickerAttempt[];
  initialUnansweredPickerQuestions?: ReadonlyArray<{
    prompt: string;
    options: readonly string[];
  }>;
  hands: ApplyPageHands;
  /**
   * The model classifies each page's questions (ADR 0041): which ask about
   * pay and which are declarations. Off in scripted tests, where the keyword
   * classification on the observation stands.
   */
  modelQuestionClassification?: boolean;
  /** Reuse complete, identical model question reads within this AI client. */
  questionReadCacheScope?: object;
  /** Latest saved answers while other applications in this batch are open. */
  readReusableAnswers?: (
    questions: readonly Pick<
      ApplicationAttemptQuestion,
      | "prompt"
      | "kind"
      | "answerControlType"
      | "answerOptions"
      | "inputConstraints"
      | "repeatedAtDifferentStep"
    >[],
  ) => Promise<readonly CandidateReusableAnswer[]>;
  /**
   * The file fields the person said are attached on the page they held, for
   * this attempt only. Settles page and field text about those uploads; a
   * server refusal still counts.
   */
  uploadsConfirmedByPerson?: readonly string[];
  /** How long an upload may stay in progress before the person gets it. */
  uploadWaitMs?: number;
  /** The guard and worker checks for this page. Absent only in tests. */
  safety?: ApplySafetyHooks;
  /** Writes and renders the letter this application sends, when it needs one. */
  letters?: ApplyLetterProvider;
  /**
   * Whether the person authorized the site to save fields as they are filled.
   * When false, nothing is transmitted at all.
   */
  intermediateWritesAuthorized?: boolean;
  /**
   * Whether the run may press the form's own buttons (Next, Save and
   * continue). Send for me may; Fill in for me presses only parts of a field
   * and leaves every form button to the person, even where the site may save
   * fields as they are filled. Defaults to `intermediateWritesAuthorized`.
   */
  pressesFormButtons?: boolean;
  /** Whether this exact run may enter an account-creation flow. */
  accountCreationAuthorized?: boolean;
  authority: ApplyAuthority;
  sources: ApplyAnswerSources;
  /** Identity of the application record every write is bound to. */
  application: {
    jobId: string;
    applicationId: string;
    resultId?: string;
    applicationRecordId?: string;
    startingUrl: string;
    /** Current application guidance and the person's exact answers on resumption. */
    instructions?: readonly string[];
    /** The live page belongs to a paused application that is being continued. */
    continuation?: { sourceUrls: readonly string[] };
  };
  /** Site name in the person's words, used in the copy: "Greenhouse", "the careers site". */
  siteLabel: string;
  /**
   * The saved AI applying behavior (Settings): when to write a letter and how
   * long written answers run. Shapes the writing, never the permissions.
   */
  writing?: AiApplyingBehavior;
  /** Safety ceilings only. The agent decides when it is done. */
  runControl?: {
    maxSteps?: number;
    timeBudgetMs?: number;
    noProgressStepLimit?: number;
    /** How many pages the run may follow to reach the form. */
    applyEntryMaxHops?: number;
    /** How long the walk from a listing to the form may take. */
    applyEntryTimeBudgetMs?: number;
  };
  /** Emitted even if a provider or tool throws. */
  onTiming?: (timing: ApplyAgentTiming) => void;
  onProgress?: (progress: {
    step: number;
    note: string;
    progressSteps: number;
    elapsedMs: number;
  }) => void | Promise<void>;
  /**
   * The second judgement on leaving the listing's site. Given the address,
   * the model's stated reason, and where the run is; allows or refuses.
   * Without it, a move to another site is reported but not judged.
   */
  reviewMove?: (move: {
    url: string;
    reason: string;
    fromUrl: string | null;
  }) => Promise<{ allowed: boolean; verdict: string }>;
  now?: () => Date;
  signal?: AbortSignal;
}
