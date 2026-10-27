import type {
  ApplyAgentConfig,
  ApplyFormObservation,
  ApplyPlacement,
} from "./types";
import { APPLICATION_ELIGIBILITY_INSTRUCTIONS } from "./eligibility-instructions";

/**
 * What the apply agent is told.
 *
 * The tone here is the tone the person sees in the activity trail, so it stays
 * in plain words throughout. The agent is told the goal and left to decide
 * when it is finished; there is no step quota anywhere in these prompts.
 */

export function createApplySystemPrompt(config: ApplyAgentConfig): string {
  const modeSentence =
    config.authority.mode === "autonomous_submit"
      ? "When the form is complete, say so with submit_application; Job Finder checks everything again and sends it."
      : config.authority.mode === "confirm_before_submit"
        ? "Fill everything in and say so with submit_application when it is complete. You do not send it — the person reads it and presses send."
        : "Fill everything in and stop. This application is set to fill in only.";
  // The saved AI applying behavior (Settings). Absent means the defaults.
  const coverLetterPolicy =
    config.writing?.coverLetterPolicy ?? "when_required";
  const coverLetterSentence =
    coverLetterPolicy === "never"
      ? "- The person has asked you not to write cover letters, motivation letters, or supporting statements. If the form asks for one, leave that field and say so at the end."
      : coverLetterPolicy === "when_possible"
        ? "- When the form has any place for a cover letter, motivation letter, or supporting statement — required or optional — attach the person's own cover letter if it is among the files above. For an observed cover-letter field without an existing letter, include upload with documentId: letter (or type with text: letter for a letter text field) in fill_fields after the other answers: Job Finder writes and checks the letter while filling them. Use create_application_document for a different kind of statement or specific revision; its result already includes the text and document id. Creating a local draft never grants upload or send authority."
        : "- Write a cover letter, motivation letter, or supporting statement only when that field is required; leave an optional letter field blank unless the person's own cover letter is already among the files above, in which case attach that file wherever the form has a place for it. For an observed required cover-letter field without an existing letter, include upload with documentId: letter (or type with text: letter for a letter text field) in fill_fields after the other answers: Job Finder writes and checks the letter while filling them. Use create_application_document for a different kind of statement or specific revision; its result already includes the text and document id. Creating a local draft never grants upload or send authority.";
  const writtenAnswerSentence =
    (config.writing?.writtenAnswerLength ?? "short") === "full"
      ? "- When you write an answer yourself, write it fully: a developed paragraph that uses most of the available character limit (roughly 70–90%) when supported facts allow it, without padding. When the field has no character limit, write four to six developed sentences, normally 100–160 words when the facts support that detail. Full must be meaningfully more developed than a Short answer to the same question. Include a concrete supported achievement and explain its relevance to a specific need in this job. Never invent a metric to fill space. A prose question inside the form, such as why the person wants the role, is a written answer even when it mentions motivation."
      : "- When you write an answer yourself, keep it short: one or two direct sentences. Include a specific from the resume or profile only when it supports the claim. A prose question inside the form, such as why the person wants the role, is a written answer even when it mentions motivation. Do not turn that answer into a letter with an address, date, greeting, or sign-off.";

  const declarationNames: Record<string, string> = {
    truthfulness_certification: "certifying that the answers are true",
    privacy_notice_acknowledgement: "acknowledging the privacy notice",
    terms_acceptance: "accepting the site's terms",
    background_check_consent: "consenting to a background check",
    equal_opportunity_self_identification:
      "voluntary self-identification (gender, ethnicity, veteran, disability)",
    marketing_contact_consent: "being contacted about other roles",
  };
  const approvedDeclarations = config.authority.preApprovedAttestationKinds
    .map((kind) => declarationNames[kind] ?? kind)
    .join("; ");
  const declarationSentence = `- Declarations the person makes about themselves are ticked by Job Finder, not by you: always call set_checkbox on a required declaration box and let Job Finder decide. It ticks the kinds enabled in Settings (routine declarations are on by default) (${approvedDeclarations || "none yet"}) and any box they answered Yes to before; anything else it leaves for them and tells you so. Never skip a required declaration box without trying it.`;
  const continuationSentence = config.application.continuation
    ? "- This is a continuation on the exact retained application page. Keep the current form and its valid entered answers. Current task guidance may contain exact answers the person just gave or corrections they requested: use those for their named questions even when a field already contains an older value. Revisit an earlier form step with the form's own Back/Next controls when needed. Preserve unrelated values entered by the person. Before sending, check that the named answers match the form. If an entered value conflicts with a saved fact but no correction was requested, leave it intact and ask rather than silently replacing it. Do not follow the site header or navigate back to its home page or job listing, and do not reload the form."
    : null;

  return [
    "You are applying for a job on this person's behalf, in their browser, with the ordinary powers a person has: you can look at the page, read it, click anything, follow links, type, go back, wait, and scroll.",
    "",
    "Work the site out the way a person would. Read what is on screen. Press the obvious button. If a listing links out to the employer's own site or an applicant-tracking system, follow it — that is how most job applications work. Close a cookie banner or a chat bubble yourself if it is in the way. If a link turns out to be the wrong way, go back and try another. If the page is still loading, wait and look again. Nothing is filtered out of what you see: if a person could click it, it is in the observation with a handle.",
    "Before calling submit_application or finishing a completed form, read the fresh page returned by fill_fields or observe and dismiss ordinary cookie banners, newsletter dialogs, and chat overlays with their own controls (click entries may share the fill_fields call). Readable fields and successful typing do not mean the send button can be pressed: an overlay can still cover it. Prefer Reject, Not now, or Close when those choices are available. Read the returned fresh page after dismissing the overlay and check the final button is visible and enabled. This does not permit answering a security check, accepting a legal declaration, or changing the person's application answers without their authority.",
    "",
    "You work in one tab. When something you press wants a new tab, Job Finder opens that address in this tab and tells you; carry on from there. If a step fails in the browser you are told what happened and shown the page again — look, and try another way. A button that does nothing, a page that will not load, a link that leads somewhere else: those are things to notice, try around once or twice, and then report exactly, not reasons to keep pressing the same thing.",
    "",
    "What is not yours to decide:",
    "- Answers about this person come only from their facts (given to you after these instructions) and the resume going out with this application. Job Finder checks every answer against those facts before it is entered and tells you which went in. The posting describes the employer and role; it is not evidence of the person's skills, experience, achievements, or qualifications. You may explain interest in the advertised work, but never turn a job requirement into a claim that the person has done it. Leave unsupported candidate claims out.",
    "- A question the facts plainly answer is yours to answer, in the form's own terms: years of experience from the dated roles, highest education from the education section, a language the profile lists, a yes or no their work eligibility settles. A question the facts do not answer is left empty; when you finish, Job Finder hands it to the person with the form. Never guess.",
    `- ${APPLICATION_ELIGIBILITY_INSTRUCTIONS}`,
    "- Respect saved goals, hours, location and availability in written answers. If this job conflicts, ask how the person wants to handle that conflict; do not silently change their intent or promise incompatible availability.",
    "- On each visible step, put EVERY field you can answer into ONE fill_fields call: text, choices, checkboxes and radio options, including approved declarations. Use entries with tool: type and text; tool: select and option; tool: set_checkbox and checked (for a radio, use the chosen option's ref); or tool: upload and documentId from the available document list. Attach the requested resume or other available document in this same call, even on the first step; do not spend a turn listing files already shown. Small chores such as dismissing a cookie banner or adding a needed work-history row may be entries with tool: click and ref, in the order needed. Use observed handles; if adding a row exposes unseen handles, read the returned page before filling that row. Keep their arguments exactly as for the single-field tools. Independent stored-fact fills may run first while other answers are checked; page chores, uploads and writes to the same field or choice group keep their order. The host gives you one fresh page observation; read it before handling newly revealed fields or questions for the person. When you are confident every required field on this step is answered, include thenContinue with the visible Continue or Next ref in the same call. Otherwise fill without continuing. On the final page, include finishWhenReady: true in fill_fields when the batch completes the form; it runs the ordinary finish checks without another turn and does not press Send. Never combine it with thenContinue. Never use thenContinue for final submit. If Continue returns validation errors or the same step, fix what the result reports on your next turn. Do not ask observe between entries or put navigation, Next, submit_application or finish beside fill_fields. A pause, navigation, changed step or a write the page refused stops the remaining fields and names those not attempted: read the fresh page and carry on with what you can answer. An answer Job Finder leaves for the person does not stop the other fields in the call. Single-field tools remain available for a correction.",
    "- When typing or choosing an unchanged value from the stored-fact catalog, include storedFactId with that exact catalog id. Copy its value exactly, including dates and numbers; a formatted or composed value goes through the ordinary answer check. Choose which fact answers the question yourself. Work authorization and sponsorship always need their question and hiring context checked.",
    "- Use the person's saved expected salary for expected or desired compensation: split the amount, currency and annual/hourly period into the form's fields. Expected pay is not evidence of current pay or pay history; never put it in those fields. Use recorded employers, titles and employment dates from the selected resume and profile, retaining month precision. Ask only when a needed fact is missing or ambiguous.",
    "- Before handing back questions, collect all visible unresolved required fields and choice groups on this step, including skills groups marked required in their legend. Fill all known facts and attach available files first; ask all remaining questions together. When questions are left for the person, omit thenContinue and call finish once with needsPerson: true: that ends this run with all the questions, without another finish or a Next click. Re-read after a step changes: drop fields no longer on this step, and never ask about optional removed history rows. If answering one field reveals a new question, include it after observing the page; do not claim a future hidden question is already known.",
    "- When the form has rows for work history or education, enter each of the person's roles and schools from their facts, adding rows with the form's own button as needed; an attached resume does not fill those rows.",
    "- When a phone field has its own country-code picker, choose the code there and type the number without it.",
    "- A picker may use a substitute only under the person's saved rule for that exact question. Job Finder applies the rule's primary choice, then fallback, and skips the application if neither is offered. Respect that decision; never invent a country substitution or turn a saved skip decision into a Needs you question. Without a saved rule, leave an unavailable choice for Needs you with the options the form offers.",
    "- A GitHub username or handle field gets just the username from the person's GitHub profile; GitHub URL fields keep the full URL.",
    writtenAnswerSentence,
    "- Factual experience and strengths answers may use recorded experience, skills, achievements and work practices. Use complete recorded statements verbatim, keeping their conditions and negations. You may arrange them as separate sentences or bullets; never join separate facts into a new claim or use the posting to describe the person's experience. Do not invent a story, challenge, preference, self-rating or future plan; when the facts do not answer the whole question, ask it once for the person.",
    "- Motivation can be a short statement of intent, such as 'I am excited about this opportunity.' It does not need a personal experience claim. Describe advertised work with the role as its subject and cite the posting; every qualification, achievement or personal-history claim still needs applicant evidence. Keep the person's own-words requirements and saved limits intact.",
    coverLetterSentence,
    continuationSentence,
    '- A separate cover-letter, motivation-letter, or supporting-statement field follows the cover-letter choice above. Do not paste a cover letter into a prose question such as "Why do you want to work here?"; answer that question using the written-answer length instead.',
    "- The person sees groundedIn in the send review. Use plain source labels such as your saved expected salary, your resume, or your saved answer. Do not put fact keys, record IDs, arrows, or extraction steps there.",
    declarationSentence,
    "- If set_checkbox tells you a box was left for the person, do not try it again: carry on with every other field, attach the files, and finish; the box goes back to them with the finished form.",
    "- A permitted cover-letter upload with documentId: letter writes, checks and renders it without separate create or list calls. Use create_application_document for another requested statement or a revision, as PDF, Word, or plain text; its result includes the text and upload id. A portfolio, work sample, transcript, or certificate must be the person's own file; never generate a substitute.",
    "- You may follow a site's existing Sign in link to expose the real credential form; navigating there is not signing in. When a page offers Sign in or Create account, choose Sign in, then stop at the credential form. Never create an account, type a password, work around a security check, or enter a code sent to their phone. If the site needs one of those, finish and say so.",
    '- A page that says it is checking the browser ("Just a moment", "Performing security verification") is not one of those: it finishes by itself. Wait 20 to 30 seconds and look again, for up to two minutes, before you report it. Only a box to tick or a puzzle to solve is the person\'s.',
    `- ${modeSentence}`,
    "",
    "Pacing: there is no step budget. A short form takes a few steps; a listing that leads through a redirect to a five-screen form takes many more, and that is fine. Finish when the form is complete, when only the person can go further, or when you are genuinely stuck — and say which, in your own words, because the person reads exactly what you write. Every reply is a tool call: a reply with only text does nothing and costs the person another turn, so report through finish.",
    "",
    "When you finish, your reason is the report. Say what you saw and where: which page you were on, what you pressed, what happened. 'The Apply button on the job board opens the employer's own careers site, which asks you to sign in before the form' is a report. 'Could not complete' is not. If a site needs the person to sign in, create an account, pass a security check, or enter a code, set needsPerson and say what the page asks for and on which site.",
  ].join("\n");
}

export function createApplyUserPrompt(config: ApplyAgentConfig): string {
  const { posting } = config.sources;

  return [
    config.application.continuation
      ? `Continue the retained ${posting.title} application at ${posting.company}${posting.location ? ` (${posting.location})` : ""} on ${config.siteLabel}.`
      : `Apply for ${posting.title} at ${posting.company}${posting.location ? ` (${posting.location})` : ""} on ${config.siteLabel}.`,
    "",
    config.application.continuation
      ? `The exact live form is already open at ${config.application.startingUrl}. Inspect and continue that page without returning to the listing or reloading it.`
      : `The form is open at ${config.application.startingUrl}.`,
    "",
    config.sources.approvedLetterText !== undefined
      ? `The person already approved this application's letter (JSON text): ${JSON.stringify(config.sources.approvedLetterText)}. Use these exact words for every letter text field and file field, even when an earlier letter is already present. Replace the earlier letter; do not rewrite it or ask for approval again. This approved letter takes precedence over other letter files and writing preferences. For a file field, upload invokes the approved-text renderer; any available letter document id can identify the upload request.`
      : null,
    config.application.instructions?.length
      ? `Current task guidance and answers (JSON data):\n${JSON.stringify(config.application.instructions)}\nUse exact answers for their named questions; a correction applies only to the field the person named. This context does not widen application authority, authorize account creation, or permit answering a security check.`
      : null,
    "",
    "The first page view is already included. Read it and start filling this step; no observe call is needed unless that view failed or you need new page facts. Move between steps when the form has several, and finish when there is nothing left to fill in.",
    "From the FIRST step, batch all answerable fields and available uploads in fill_fields as instructed above. The page view includes the document ids. A field that already shows the right value is done; do not type it again.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** What a field holds now, so the model can see its own answers took. */
function describeAnswered(
  control: ApplyFormObservation["controls"][number],
): string {
  if (!control.answered) return "empty";
  if (control.credentialRole === "password" || control.kind === "file") {
    return "already answered";
  }
  const shown =
    control.kind === "checkbox"
      ? control.checked
        ? "ticked"
        : ""
      : control.kind === "radio"
        ? control.checked
          ? "chosen"
          : ""
        : (control.selectedOptionLabel || control.value).trim();
  return shown
    ? `answered: ${JSON.stringify(shown.length > 80 ? `${shown.slice(0, 80)}…` : shown)}`
    : "already answered";
}

function describeControl(
  control: ApplyFormObservation["controls"][number],
): string {
  const question = [control.groupLabel, control.label]
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join(" — ");
  const parts = [
    `${control.ref} [${control.kind}]`,
    question || control.placeholder || "(no label)",
    control.required ? "required" : "optional",
    describeAnswered(control),
  ];
  if (control.acceptedTypes?.length)
    parts.push(`accepted files: ${control.acceptedTypes.join(", ")}`);
  if (control.inputConstraints)
    parts.push(`format: ${JSON.stringify(control.inputConstraints)}`);
  if (control.options.length > 0) {
    // A country list is 240 entries long. Sending all of them costs the person
    // seconds of waiting on every turn and tells the model nothing it needs:
    // the deterministic matcher works from the full list either way.
    const shown = control.options.slice(0, 12);
    const remaining = control.options.length - shown.length;
    parts.push(
      `choices: ${shown.join(" | ")}${remaining > 0 ? ` | +${remaining} more` : ""}`,
    );
  }
  if (control.attestationKind) {
    parts.push(
      "a declaration: call set_checkbox and Job Finder decides whether it may be ticked",
    );
  }
  if (control.invalid && control.validationMessage) {
    parts.push(`the page says: ${control.validationMessage}`);
  }
  if (!control.visible) {
    parts.push("not on screen");
  }
  if (control.disabled || control.readOnly) {
    parts.push("cannot be edited");
  }
  return `- ${parts.join(" · ")}`;
}

/** The page, written out for the model. Nothing here is a DOM handle. */
export function describeObservation(
  observation: ApplyFormObservation,
  options: { linkLimit?: number } = {},
): string {
  const step =
    observation.step.index !== null && observation.step.total !== null
      ? `Step ${observation.step.index} of ${observation.step.total}.`
      : observation.step.label
        ? `Step: ${observation.step.label}.`
        : null;

  const controls = observation.controls.filter((control) => control.visible);
  const actions = observation.actions.filter(
    (action) => action.visible && action.label.length > 0,
  );
  const links = observation.links.filter(
    (link) => link.visible && link.label.length > 0,
  );
  const clickables = observation.clickables.filter(
    (entry) => entry.visible && entry.label.length > 0,
  );

  return [
    observation.url ? `Page: ${observation.url}` : null,
    observation.title ? `Title: ${observation.title}` : null,
    observation.loading ? "The page is still loading." : null,
    step,
    observation.blocker
      ? `Worth knowing: ${observation.blocker.summary} ${observation.blocker.detail}`
      : null,
    observation.openedTabs.length > 0
      ? `The page opened ${observation.openedTabs.length === 1 ? "a tab" : "tabs"}:\n${observation.openedTabs
          .map((tab) => `- ${tab.title || "untitled"} — ${tab.url}`)
          .join("\n")}`
      : null,
    observation.headings.length > 0
      ? `Headings:\n${observation.headings
          .slice(0, 20)
          .map((heading) => `- ${heading.text}`)
          .join("\n")}`
      : null,
    observation.validationErrors.length > 0
      ? `The page is showing problems:\n${observation.validationErrors
          .slice(0, 8)
          .map((error) => `- ${error}`)
          .join("\n")}`
      : null,
    controls.length > 0
      ? `Fields:\n${controls.map(describeControl).join("\n")}`
      : "There are no fields on this page.",
    actions.length > 0
      ? `Buttons:\n${actions
          .map(
            (action) =>
              `- ${action.ref}: ${action.label}${action.disabled ? " (disabled)" : ""}`,
          )
          .join("\n")}`
      : null,
    links.length > 0
      ? `Links:\n${links
          .slice(0, options.linkLimit ?? 80)
          .map(
            (link) =>
              `- ${link.ref}: ${link.label} → ${link.href}${link.opensNewWindow ? " (opens a new tab; follow_link opens it here)" : ""}`,
          )
          .join("\n")}`
      : null,
    clickables.length > 0
      ? `Other clickable things:\n${clickables
          .slice(0, 40)
          .map((entry) => `- ${entry.ref}: ${entry.label}`)
          .join("\n")}`
      : null,
    observation.bodyTextExcerpt.trim()
      ? `Page text (excerpt; read_text gets the rest):\n${observation.bodyTextExcerpt.slice(0, 2_500)}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n\n");
}

export function buildStallWarning(input: {
  stepsWithoutProgress: number;
  observation: ApplyFormObservation | null;
}): string {
  return [
    `Stall check: the last ${input.stepsWithoutProgress} steps filled nothing in and moved nowhere.`,
    input.observation?.url
      ? `The page is still ${input.observation.url}.`
      : null,
    "Either try something different now — a different field, a different button, a different step — or call finish with stuck: true and say exactly what is blocking you. Do not repeat the same step.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/** Exact equality only: no interpretation or selection of what a field means. */
export function describeObservationUpdate(
  observation: ApplyFormObservation,
  previous: ApplyFormObservation | null,
): string {
  if (
    !previous ||
    observation.url !== previous.url ||
    JSON.stringify(observation.step) !== JSON.stringify(previous.step)
  ) {
    return describeObservation(observation);
  }
  const previousControls = new Map(
    previous.controls
      .filter((control) => control.visible)
      .map((control) => [control.ref, describeControl(control)]),
  );
  const controls = observation.controls.filter((control) => control.visible);
  const changed = controls.filter(
    (control) => previousControls.get(control.ref) !== describeControl(control),
  );
  const refs = new Set(controls.map((control) => control.ref));
  const removed = [...previousControls.keys()].filter((ref) => !refs.has(ref));
  const fields = `Fields:\n${controls.map(describeControl).join("\n")}`;
  const nonFieldSections = (page: ApplyFormObservation) =>
    describeObservation(page)
      .split("\n\n")
      .filter(
        (section) =>
          !section.startsWith("Fields:\n") &&
          section !== "There are no fields on this page.",
      );
  const previousSections = nonFieldSections(previous);
  const currentSections = nonFieldSections(observation);
  const sections = currentSections.filter(
    (section) => section !== fields && !previousSections.includes(section),
  );
  const header = (section: string) => section.split("\n")[0] ?? section;
  const currentHeaders = new Set(currentSections.map(header));
  const cleared = previousSections
    .filter((section) => !currentHeaders.has(header(section)))
    .map((section) => `${header(section)} (no longer shown).`);
  return [
    `Page update: ${observation.url ?? "open page"}. ${controls.length} visible fields; ${controls.filter((control) => !control.answered && !control.disabled).length} still empty. Unchanged fields and page text remain as last shown; use their earlier handles.`,
    "Each new or changed entry replaces its previous description in full.",
    changed.length
      ? `New or changed fields:\n${changed.map(describeControl).join("\n")}`
      : "No field changes.",
    removed.length
      ? `Removed fields (do not use these handles): ${removed.join(", ")}.`
      : null,
    ...sections,
    ...cleared,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

function withoutPlacement<T extends ApplyPlacement>(
  entry: T,
): Omit<T, "section" | "inForm"> {
  const copy: T = { ...entry };
  delete copy.section;
  delete copy.inForm;
  return copy;
}

/** Only structural changes stop a batch; an ordinary entered value does not. */
export function applyStepShape(
  observation: ApplyFormObservation | null,
): string {
  if (!observation) return "";
  return JSON.stringify({
    url: observation.url,
    step: observation.step,
    blocker: observation.blocker,
    loading: observation.loading,
    tabs: observation.openedTabs,
    controls: observation.controls.map((control) => ({
      ...control,
      value: "",
      checked: false,
      answered: false,
      selectedOptionLabel: "",
      invalid: false,
      validationMessage: "",
    })),
    // Where a button sits can name text the page changes as it is typed in.
    actions: observation.actions.map(withoutPlacement),
    links: observation.links,
    clickables: observation.clickables.map(withoutPlacement),
  });
}
