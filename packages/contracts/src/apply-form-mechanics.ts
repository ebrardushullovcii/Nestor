/**
 * The raw shape of an application form, before any product meaning.
 *
 * These types are the seam between the browser layer, which can read and write
 * a page, and the workflow layer, which decides what any of it means. The
 * browser layer implements `ApplyRawPageHands`; nothing below that layer ever
 * needs to know what a resume field or a consent checkbox is.
 *
 * Nothing here crosses preload or IPC, so these are plain types rather than
 * schemas: the values are transient page reads, not persisted state.
 */

export interface RawApplyControl {
  /** Stable handle supplied by the browser when the control is inside a frame. */
  ref?: string;
  /** Position among the form controls on the page. Refs are built from this. */
  index: number;
  tagName: string;
  inputType: string;
  /** Native field constraints, without interpreting the question. */
  accept?: string;
  min?: string;
  max?: string;
  step?: string;
  maxLength?: number;
  role: string;
  id: string;
  name: string;
  /** Transient identity of the containing form/root within this page read. */
  scopeKey?: string;
  label: string;
  /** Help text beside the field, besides its label. */
  hint?: string;
  groupLabel: string;
  placeholder: string;
  autocomplete: string;
  required: boolean;
  invalid: boolean;
  validationMessage: string;
  disabled: boolean;
  readOnly: boolean;
  visible: boolean;
  value: string;
  checked: boolean;
  multiple: boolean;
  options: string[];
  selectedOptionLabel: string;
}

export interface RawApplyAction {
  ref?: string;
  index: number;
  label: string;
  visible: boolean;
  disabled: boolean;
  /** Resolved destination of the form this action would submit, if any. */
  formAction?: string;
  /** HTTP method of the form this action would submit, if any. */
  formMethod?: string;
}

/**
 * One link on the page, as the browser resolved it.
 *
 * A job listing and the form it leads to are usually two different pages, so
 * the workflow layer has to be able to see the way through. Nothing here says
 * which link matters; that is a reading of the words, and it happens above.
 */
export interface RawApplyLink {
  ref?: string;
  /** Position among the page's links. Refs are built from this. */
  index: number;
  label: string;
  /** Absolute for a web address; the raw attribute for any other scheme. */
  href: string;
  /** The anchor's own target attribute, empty when it has none. */
  target: string;
  visible: boolean;
  /** Distance from the top of the document in CSS pixels, for ranking only. */
  topOffset: number;
}

/**
 * Anything on the page a person could click that is not a form control, a
 * button, or a link.
 *
 * Sites are built out of divs with click handlers, cards, tiles, and custom
 * widgets. A harness that can only press `<button>` cannot use the web, so
 * everything clickable is reported and the model decides what it is.
 */
export interface RawApplyClickable {
  ref?: string;
  index: number;
  /** The element's visible text, trimmed and bounded. */
  label: string;
  role: string;
  tagName: string;
  visible: boolean;
  topOffset: number;
}

/** One heading, so the model can see how the page is organised. */
export interface RawApplyHeading {
  level: number;
  text: string;
}

/** A tab or window the page opened for itself. */
export interface RawApplyOpenedTab {
  index: number;
  url: string;
  title: string;
}

export interface RawApplyPage {
  url: string | null;
  title: string | null;
  bodyText: string;
  headings: RawApplyHeading[];
  controls: RawApplyControl[];
  actions: RawApplyAction[];
  links: RawApplyLink[];
  clickables: RawApplyClickable[];
  /** Tabs or windows the page opened while the run was on it. */
  openedTabs: RawApplyOpenedTab[];
  validationErrors: string[];
  stepLabel: string | null;
  /** True when the page is still loading; the model may wait and look again. */
  loading: boolean;
}

/** Exact retained form control chosen by browser-agent for a human handoff. */
export interface ApplicationFormActionHandoff {
  pageBindingKey: string;
  pageUrl: string;
  ref: string;
  label: string;
  formAction: string;
  formMethod: "POST";
}

export type ApplyWriteResult =
  | { ok: true; observedValue: string }
  | {
      ok: false;
      error: string;
      reason?: "option_not_offered";
      offeredOptions?: string[];
    };

/** Where following a link left the browser. */
export type ApplyNavigationResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

/** One file, already verified by whoever owns it, on its way into a form. */
export interface ApplyUploadFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Reading and writing one open application page.
 *
 * Implemented by the browser layer over its own page handle, which never
 * leaves that layer. Every method is a mechanic: none of them chooses a
 * control, an answer, or whether a write is allowed.
 */
export interface ApplyRawPageHands {
  readPage: () => Promise<RawApplyPage>;
  fillText: (ref: string, value: string) => Promise<ApplyWriteResult>;
  chooseOption: (ref: string, optionLabel: string) => Promise<ApplyWriteResult>;
  setToggle: (ref: string, checked: boolean) => Promise<ApplyWriteResult>;
  uploadFile: (ref: string, file: ApplyUploadFile) => Promise<ApplyWriteResult>;
  clickAction: (ref: string) => Promise<ApplyWriteResult>;
  /** Scroll to an action and report obstruction without pressing it. */
  checkAction?: (ref: string) => Promise<ApplyWriteResult>;
  /**
   * Opens what one of the page's links points at, in the same tab.
   *
   * Following a link is a read: it asks the site for a page it already
   * publishes and writes nothing. A link that would normally open a new tab
   * is followed in place, because a harness that loses the page it was working
   * on cannot finish the job.
   */
  followLink: (ref: string) => Promise<ApplyNavigationResult>;
  /** Goes to an address directly. */
  navigate: (url: string) => Promise<ApplyNavigationResult>;
  /** Presses anything on the page, whatever it is made of. */
  clickElement: (ref: string) => Promise<ApplyWriteResult>;
  /** Presses a keyboard key on one element, or on the active page. */
  pressKey: (ref: string | undefined, key: string) => Promise<ApplyWriteResult>;
  /** Moves the page, so content that loads on scroll can be seen. */
  scroll: (
    direction: "down" | "up" | "top" | "bottom",
  ) => Promise<ApplyWriteResult>;
  /** Waits, for a page that is still settling. */
  wait: (milliseconds: number) => Promise<void>;
  goBack: () => Promise<ApplyNavigationResult>;
  /** Reads one element's text, or the page's, in full rather than excerpted. */
  readText: (ref?: string) => Promise<string>;
  /** Visible text with inline link destinations and semantic item boundaries. */
  readLinkedText?: () => Promise<string>;
  /**
   * Brings a tab the page opened into this one: the working tab goes to the
   * tab's address and the extra tab is closed. A run works in one tab; a
   * site that opens the form in a new one has moved the work, not blocked it.
   */
  adoptOpenedTab?: (index: number) => Promise<ApplyNavigationResult>;
}

/**
 * An attempt the prepare-only guard stopped.
 *
 * During a run that may only fill a form in, nothing may be transmitted. When
 * the page tries anyway, the guard blocks it and records this. Some of these
 * are the page's own background noise; one of them can be the site saving an
 * answer that was just typed, which is a reason to stop and tell the person.
 */
export interface ApplyBlockedAttempt {
  kind:
    | "dom_submit"
    | "form_submit"
    | "form_request_submit"
    | "send_beacon"
    | "fetch"
    | "xhr"
    | "websocket"
    | "webtransport"
    | "eventsource"
    | "window_open"
    | "network_request"
    | "popup_open"
    | "download";
  method: string;
  url: string | null;
  at: string;
  /**
   * Whether the attempt carried a value that was in a form field when it was
   * blocked. Set by the page guard, which can see the form; absent for
   * network-layer blocks, which are then treated as if they might have.
   */
  carriedPreparedValue?: boolean;
}

/** A service worker that could influence the application origin. */
export interface ApplyServiceWorkerFinding {
  reason: string;
  summary: string;
  detail: string;
}

/**
 * One open application page, with the safety mechanics that go with it.
 *
 * The browser layer owns the page and implements this. The workflow layer
 * reads and writes through it and asks it, after every write, whether the
 * guard stopped something. Neither layer can skip the other: there is no way
 * to reach the page except through these operations.
 */
export interface ApplyPageSession extends ApplyRawPageHands {
  /**
   * Installs the guard that stops a prepare-only run from transmitting
   * anything. Called once, before the first read.
   */
  installPrepareOnlyGuard: (input: {
    attachmentUploadsAuthorized?: boolean;
    intermediateMutationsAuthorized: boolean;
    allowedOrigins: readonly string[];
  }) => Promise<void>;
  /** The most recent attempt the guard stopped, or null. */
  readBlockedAttempt: () => Promise<ApplyBlockedAttempt | null>;
  /**
   * Tells the guard that this exact value is now in a form field, so it can
   * tell a request that carries it from one that does not.
   */
  registerPreparedValue: (value: string) => Promise<void>;
  /**
   * Opens the short, same-origin window in which the site may save the field
   * that was just filled, when the person authorized that. Throws when the
   * current origin is outside that authority.
   */
  openIntermediateWriteWindow: () => Promise<void>;
  closeIntermediateWriteWindow: () => Promise<void>;
  /**
   * Presses one exact form action through a short, single-request guard
   * window. The workflow layer must first prove that the action is an
   * explicitly authorized non-application action, such as signing in with
   * credentials the person supplied for this task.
   */
  clickAuthorizedFormAction: (ref: string) => Promise<ApplyWriteResult>;
  /** How many intermediate writes the guard has let through so far. */
  readIntermediateWriteCount: () => number;
  /**
   * Rechecks whether a service worker can influence this origin. Called
   * before any click that advances the form.
   */
  checkServiceWorker: () => Promise<ApplyServiceWorkerFinding | null>;
}
