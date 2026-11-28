import { createHash, randomUUID } from "node:crypto";
import {
  traceEvent,
  traceOurs,
  withVerificationPrivacy,
  verificationIsPrivate,
  redactVerificationText,
  redactVerificationData,
} from "@nestor/core/run-trace";
import { createTabTools, signInSessionFacts } from "../tab-tools";
import {
  accountDraftFacts,
  createAccountCredentialTools,
} from "../account-credential-tool";
import {
  parseToolArguments,
  runAgentLoop,
  type AgentLoopModel,
  type AgentLoopTool,
  type AgentLoopToolOutcome,
} from "@nestor/agent-runtime";
import {
  ApplySendOutcomeDecisionSchema,
  describeBrowserError,
  type ApplicationAttemptQuestion,
  type ApplyPersonRequest,
  type ApplyFinishSendOutcome,
} from "@nestor/contracts";
import { withReasoningTask, type LLMClient } from "../agent/contracts";
import { createVisualPageTools } from "../visual-page-tools";
import { createKeyboardTools } from "../keyboard-tools";
import { createViewLedger } from "../superseded-views";
import { createApplyTiming } from "./apply-timing";
import { createApplyModelActivity } from "./model-activity";
import {
  applicationSavedAnswers,
  serializeApplicationData,
} from "./application-facts";
import {
  applyObservationView,
  createApplySystemPrompt,
  createApplyUserPrompt,
  describeObservation,
  formatApplyObservationView,
  type ApplyObservationView,
} from "./apply-prompts";
import {
  FILL_FIELDS_TOOL_DEFINITION,
  getApplyToolDefinitions,
  parseApplyProposal,
  parseFillFields,
} from "./apply-tools";
import { buildCoverLetterRequest, isCoverLetterControl } from "./cover-letter";
import { reviewFieldKey, screenKey } from "./form-replay";
import {
  applicationModelFactsMessages,
  applicationResumeFactsMessage,
} from "./model-facts";
import {
  approvedApplicationLetter,
  buildPendingQuestion,
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";
import { createQuestionOccurrences } from "./question-occurrences";
import {
  observedControlValue,
  createStepReceiptTracker,
} from "./step-receipts";
import type {
  ApplyAgentConfig,
  ApplyAgentResult,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyProposal,
} from "./types";

export async function runApplyAgent(
  input: ApplyAgentConfig,
  client: LLMClient,
): Promise<ApplyAgentResult> {
  return withVerificationPrivacy(async () =>
    redactVerificationData(await runApplyAgentPrivate(input, client)),
  );
}

async function runApplyAgentPrivate(
  input: ApplyAgentConfig,
  client: LLMClient,
): Promise<ApplyAgentResult> {
  const now = input.now ?? (() => new Date());
  const timingRecord = createApplyTiming(now);
  const abort = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, abort.signal])
    : abort.signal;
  const documentCatalog = [...input.sources.documents];
  const runConfig: ApplyAgentConfig = {
    ...input,
    signal,
    hands: timingRecord.hands(input.hands),
    sources: {
      ...input.sources,
      applicationAutomationMode: input.authority.mode,
      documents: documentCatalog,
      taskInstructions:
        input.application.instructions ?? input.sources.taskInstructions,
    },
  };
  const config = runConfig;
  const modelActivity = createApplyModelActivity(
    timingRecord.model(withReasoningTask(client, "apply")),
  );
  const llmClient = modelActivity.client;
  const guardState = createApplyGuardState();
  const occurrences = createQuestionOccurrences(input.initialQuestionContexts);
  const receipts = createStepReceiptTracker(
    input.application.resultId ?? input.application.applicationId,
  );
  const filled: ApplyAgentResult["filled"] = [],
    attachments: ApplyAgentResult["attachments"] = [],
    pauses: ApplyAgentResult["pauses"] = [];
  const reviewFilled = new Map<string, ApplyAgentResult["filled"][number]>(),
    reviewAttachments = new Map<
      string,
      ApplyAgentResult["attachments"][number]
    >();
  const fieldOwners = new Map<
    string,
    {
      formIndex: number | undefined;
      scopeKey?: string | undefined;
      frame: string;
    }
  >();
  const observedFields = new Set<string>(),
    notes: string[] = [];
  const timeline = (input.earlierActivity ?? []).map((entry) => ({
    at: entry.at,
    text: entry.detail,
    label: entry.label,
  }));
  let sendingForm: {
    url: string | undefined;
    formIndex: number | undefined;
    frame: string;
    scopeKey?: string | undefined;
  } | null = null;
  let page: ApplyFormObservation | null = null;
  let sendOutcome: "submitted" | "failed" | "uncertain" | "waiting" | null =
    null;
  const sendDecisions = new Map<
    string,
    "submitted" | "failed" | "uncertain" | "waiting"
  >();
  // Each press of a send control, by call ID: when, and the page it was on.
  const pressedSends = new Map<string, { at: string; url: string | null }>();
  const recordedSends = new Set<string>();
  const unresolvedSendsFact = (): string => {
    const open = [...pressedSends].filter(([id]) => !recordedSends.has(id));
    return open.length
      ? `Send ledger: these send calls have no outcome you recorded yet: ${open.map(([id, press]) => `sendCallId=${id} (pressed ${press.at} on ${press.url?.split(/[?#]/u)[0] ?? "an unknown page"})`).join("; ")}. Record what each one did with record_send_outcome.`
      : "";
  };
  const updateSendOutcome = (
    id: string,
    outcome: "confirmed" | "failed" | "uncertain" | "waiting",
  ) => {
    sendDecisions.set(id, outcome === "confirmed" ? "submitted" : outcome);
    sendOutcome = [...sendDecisions.values()].includes("submitted")
      ? "submitted"
      : ([...sendDecisions.values()].at(-1) ?? null);
  };
  let applicationClosed = false;
  let duplicateOfApplication: number | undefined;
  let readyToSend: ApplyAgentResult["readyToSend"] = null;
  const modelCallIds = new Map<string, string[]>();
  const payDisclosed =
    input.authority.salaryDisclosure === "answer_from_profile";
  const note = (text: string) => {
    notes.push(text);
    timeline.push({
      at: now().toISOString(),
      text,
      label: "Application activity",
    });
  };
  const observe = (next: ApplyFormObservation) => {
    page = next;
    if (next.tabs?.some((tab) => tab.active && !tab.primary)) return;
    occurrences.observe(next);
    receipts.observe(next);
    const recordsControl = (c: ApplyFormObservation["controls"][number]) =>
      !sendingForm ||
      (next.url?.split(/[?#]/u)[0] === sendingForm.url &&
        (!sendingForm.scopeKey || c.scopeKey === sendingForm.scopeKey) &&
        (sendingForm.formIndex === undefined ||
          (c.formIndex === sendingForm.formIndex &&
            JSON.stringify(c.frame) === sendingForm.frame)));
    for (const c of next.controls) {
      if (!recordsControl(c)) continue;
      fieldOwners.set(reviewFieldKey(next, c), {
        formIndex: c.formIndex,
        scopeKey: c.scopeKey,
        frame: JSON.stringify(c.frame),
      });
      if (!c.credentialRole) observedFields.add(reviewFieldKey(next, c));
    }
    for (const control of next.controls) {
      if (!recordsControl(control)) continue;
      if (
        control.credentialRole ||
        !control.answered ||
        control.kind === "file" ||
        ((control.kind === "checkbox" || control.kind === "radio") &&
          !control.checked)
      )
        continue;
      fieldOwners.set(reviewFieldKey(next, control), {
        formIndex: control.formIndex,
        scopeKey: control.scopeKey,
        frame: JSON.stringify(control.frame),
      });
      const fieldKey = reviewFieldKey(next, control),
        value = observedControlValue(control, next.controls);
      const existing = reviewFilled.get(fieldKey);
      if (existing?.answer.value === value) continue;
      reviewFilled.set(fieldKey, {
        fieldKey,
        ref: control.ref,
        label: questionPrompt(control),
        questionKind: control.questionKind,
        at: now().toISOString(),
        answer: {
          value,
          kind: control.questionKind,
          sourceId: `observed.${control.ref}`,
          sourceKind: "generated",
          provenanceLabel: "shown on the form",
          groundedIn: [],
        },
      });
    }
    for (const [index, row] of (sendingForm
      ? []
      : (next.summaryRows ?? [])
    ).entries()) {
      if (
        [...reviewFilled.values()].some(
          (f) =>
            (f.label === row.label || f.label.endsWith(` — ${row.label}`)) &&
            f.answer.value === row.value,
        )
      )
        continue;
      const fieldKey = `${next.url}|summary:${row.label}`;
      reviewFilled.set(fieldKey, {
        fieldKey,
        ref: `summary_${index}`,
        label: row.label,
        questionKind: "other",
        at: now().toISOString(),
        answer: {
          value: row.value,
          kind: "other",
          sourceId: `observed.summary_${index}`,
          sourceKind: "generated",
          provenanceLabel: "shown in the form summary",
          groundedIn: [],
        },
      });
    }
    timingRecord.setObservationChars(describeObservation(next).length);
  };
  // Every page view written into the conversation, so the loop can fold the
  // ones the model has acted past on routes that support folding.
  const views = createViewLedger();
  let appendOnlyHistory = false;
  let lastView: ApplyObservationView | undefined;
  const describeView = (page: ApplyFormObservation, full = false): string => {
    modelActivity.throwIfAborted();
    const view = applyObservationView(page);
    const previous = lastView;
    lastView = view;
    return appendOnlyHistory
      ? formatApplyObservationView(view, full ? undefined : previous)
      : views.write(formatApplyObservationView(view), page);
  };
  let lastSavedProgress = "";
  const saveProgress = (observation: ApplyFormObservation) => {
    if (
      !input.saveAttemptProgress ||
      verificationIsPrivate() ||
      observation.tabs?.some((tab) => tab.active && !tab.primary)
    )
      return;
    const url = URL.parse(observation.url ?? "");
    if (!url || !["http:", "https:"].includes(url.protocol)) return;
    const progress = {
      pageUrl: url.origin + url.pathname,
      step: observation.step,
      filledFields: [
        ...new Set(
          [...filled, ...reviewFilled.values()].map((entry) => entry.label),
        ),
      ],
      uploadedFiles: attachments.map(
        ({ controlLabel, fileName, documentId }) => ({
          field: controlLabel,
          fileName,
          documentId,
        }),
      ),
    };
    const snapshot = JSON.stringify(progress);
    if (snapshot === lastSavedProgress) return;
    input.saveAttemptProgress(progress);
    lastSavedProgress = snapshot;
  };
  const readPage = async () => {
    const next = await runConfig.hands.observe();
    observe(next);
    saveProgress(next);
    return next;
  };
  const describeDocuments = () =>
    serializeApplicationData(
      documentCatalog.map(({ id, label, fileName, mimeType, kind }) => ({
        id,
        label,
        fileName,
        mimeType,
        kind,
      })),
    );
  const isApplicationLetterOrStatement = (
    control: ApplyFormObservation["controls"][number],
  ) => isCoverLetterControl(control);
  const refreshAnswers = async () => {
    if (input.readReusableAnswers) {
      const shared = await input.readReusableAnswers([]);
      runConfig.sources.reusableAnswers = [
        ...new Map(
          [...input.sources.reusableAnswers, ...shared].map((a) => [a.id, a]),
        ).values(),
      ];
    }
  };
  // A dropdown draws its choices only while open, so the page read shows none.
  // A dropdown handed to the person carries the choices its list offers.
  const handedOptions = new Map<string, string[]>();
  const handedControl = (item: ApplyPersonRequest) =>
    typeof item === "string"
      ? page?.controls.find((c) => c.ref === item || questionPrompt(c) === item)
      : undefined;
  const readHandedOptions = async (forPerson: ApplyPersonRequest[] = []) => {
    if (!config.hands.readOptions) return;
    for (const item of forPerson) {
      const control = handedControl(item);
      if (
        !control ||
        (control.kind !== "select" && control.kind !== "combobox") ||
        control.options.some((option) => option.trim())
      )
        continue;
      const options = await config.hands
        .readOptions(control.ref)
        .catch(() => null);
      if (options?.length) handedOptions.set(control.ref, options);
    }
  };
  const finish = (
    reason: string,
    stuck = false,
    forPerson: ApplyPersonRequest[] = [],
  ): AgentLoopToolOutcome => {
    const questions: ApplicationAttemptQuestion[] = [];
    for (const [index, item] of forPerson.entries()) {
      const found = handedControl(item);
      const options = found && handedOptions.get(found.ref);
      const control = found && options ? { ...found, options } : found;
      if (
        typeof item !== "string" ||
        control?.credentialRole === "password" ||
        control?.credentialRole === "one_time_code"
      ) {
        const kind =
          typeof item !== "string"
            ? item.onPage
            : control?.credentialRole === "one_time_code"
              ? "mfa"
              : "sign_in";
        const detail =
          typeof item !== "string"
            ? item.instructions
            : "Enter the missing secret on the open website, then continue.";
        pauses.push({
          code: "page_blocked",
          summary: detail,
          question: null,
          blocker: {
            code:
              kind === "sign_in"
                ? "site_login_required"
                : kind === "mfa" || kind === "passkey"
                  ? "multi_factor_required"
                  : kind === "own_browser"
                    ? "browser_blocked"
                    : kind === "other"
                      ? "person_step_required"
                      : "security_challenge",
            requiresPerson: true,
            summary: detail,
            detail,
            nextActionLabel:
              kind === "own_browser"
                ? "Open in my browser"
                : "Open the application",
          },
        });
        continue;
      }
      if (control) {
        questions.push(
          buildPendingQuestion({
            control,
            observation: page!,
            siblings: page!.controls,
            jobId: input.application.jobId,
            detectedAt: now().toISOString(),
            suggestion: null,
            reason,
          }),
        );
        continue;
      }
      questions.push({
        id: `named_${createHash("sha256").update(`${input.application.applicationId}|${index}|${item}`).digest("hex").slice(0, 24)}`,
        prompt: item,
        kind: "other",
        answerControlType: "text",
        isRequired: true,
        detectedAt: now().toISOString(),
        answerOptions: [],
        suggestedAnswers: [],
        submittedAnswer: null,
        status: "detected",
      });
    }
    if (questions.length) {
      const pause = {
        code: "question_needs_you" as const,
        summary: reason,
        question: questions[0] ?? null,
        questions,
        blocker: null,
      };
      pauses.push(pause);
      traceOurs(
        "packages/browser-agent/src/apply/apply-agent.ts:finish",
        "asked_person",
        JSON.stringify(pause),
      );
    }
    return {
      kind: "finish",
      finish: {
        reason,
        stuck,
        needsPerson: forPerson.length > 0,
        data: { forPerson },
      },
    };
  };
  const reportFinishedSend = async (
    report: ApplyFinishSendOutcome,
    callId: string,
  ): Promise<string | null> => {
    const knownSendCallId =
      report.sendCallId ?? [...sendDecisions.keys()].at(-1);
    const sendCallId = knownSendCallId ?? callId;
    if (!config.recordSendOutcome)
      return "The send ledger is unavailable in this run.";
    const result = await config.recordSendOutcome({
      outcome: report.outcome,
      evidence: redactVerificationText(report.evidence),
      sendCallId,
      ...(knownSendCallId === undefined ? { inferSendCallId: true } : {}),
      // The destination is the page the send was pressed on, such as the
      // mailbox, not the form tab finish returns to.
      pageUrl: pressedSends.get(sendCallId)?.url ?? page?.url ?? null,
    });
    if (!result.recorded) return result.content;
    const recordedCallId = result.sendCallId ?? sendCallId;
    recordedSends.add(recordedCallId);
    updateSendOutcome(recordedCallId, report.outcome);
    note(result.content);
    return null;
  };
  const runProposal = async (
    proposal: ApplyProposal,
    callId: string = randomUUID(),
    includePage = true,
  ): Promise<AgentLoopToolOutcome> => {
    signal.throwIfAborted();
    let before = page ?? (await readPage());
    // A mailbox is transient. Finish and any on-page handoff belong to the
    // still-bound application form, including when mailbox retrieval failed.
    if (
      proposal.tool === "finish" &&
      before.tabs?.some((tab) => tab.active && !tab.primary)
    ) {
      await config.hands.closeAuxiliaryTabs?.();
      before = await readPage();
    }
    if (proposal.tool === "finish" && proposal.sendOutcome) {
      const error = await reportFinishedSend(proposal.sendOutcome, callId);
      if (error) return { kind: "ok", status: "failed", content: error };
    }
    if ("ref" in proposal && proposal.ref) receipts.wrote(before, proposal.ref);
    const outcome = await executeApplyProposal(proposal, before.signature, {
      config: runConfig,
      now,
      guardState,
      seenObservation: before,
    });
    if (outcome.kind === "finished") {
      applicationClosed = outcome.applicationClosed === true;
      duplicateOfApplication = outcome.duplicateOfApplication;
      await readHandedOptions(outcome.forPerson);
      return finish(outcome.reason, outcome.stuck, outcome.forPerson);
    }
    observe(outcome.observation);
    let content: string;
    switch (outcome.kind) {
      case "filled": {
        if (before.tabs?.some((tab) => tab.active && !tab.primary)) {
          content =
            "Updated the auxiliary tab field; its contents are not saved as application answers.";
          break;
        }
        const control = before.controls.find(
          (c) => c.ref === outcome.filled.ref,
        );
        const fieldKey = control
          ? reviewFieldKey(before, control)
          : outcome.filled.ref;
        const entry = { ...outcome.filled, fieldKey };
        filled.push(entry);
        reviewFilled.set(fieldKey, entry);
        const requested =
          proposal.tool === "type" && proposal.text !== entry.answer.value
            ? ` (requested ${JSON.stringify(proposal.text)})`
            : "";
        content = `${entry.label} now holds ${JSON.stringify(entry.answer.value)}${requested}.${outcome.stateNote ?? ""}`;
        break;
      }
      case "attached": {
        const control =
          "ref" in proposal
            ? before.controls.find((c) => c.ref === proposal.ref)
            : undefined;
        const fieldKey = control
          ? reviewFieldKey(before, control)
          : outcome.attachment.controlLabel;
        const entry = { ...outcome.attachment, fieldKey };
        attachments.push(entry);
        reviewAttachments.set(fieldKey, entry);
        content = `Attached ${entry.fileName} to ${entry.controlLabel}.`;
        break;
      }
      case "ready_to_send": {
        const sendPage = before.url?.split(/[?#]/u)[0];
        const sendControl = [...before.actions, ...before.clickables].find(
          (c) => c.ref === outcome.finalActionRef,
        );
        const inSendingForm = (key: string) => {
          if (!key.startsWith(`${sendPage}|`)) return false;
          const owner = fieldOwners.get(key);
          return (
            (!sendControl?.scopeKey ||
              owner?.scopeKey === sendControl.scopeKey) &&
            (sendControl?.formIndex === undefined ||
              !owner ||
              (owner.formIndex === sendControl.formIndex &&
                owner.frame === JSON.stringify(sendControl.frame)))
          );
        };
        for (const key of reviewFilled.keys())
          if (!inSendingForm(key)) reviewFilled.delete(key);
        for (const key of reviewAttachments.keys())
          if (!inSendingForm(key)) reviewAttachments.delete(key);
        for (const key of observedFields)
          if (!inSendingForm(key)) observedFields.delete(key);
        sendingForm = {
          url: sendPage,
          formIndex: sendControl?.formIndex,
          scopeKey: sendControl?.scopeKey,
          frame: JSON.stringify(sendControl?.frame),
        };
        const decision = {
          actionRef: outcome.finalActionRef,
          actionLabel: outcome.finalActionLabel,
          ...(callId ? { callId } : {}),
        };
        if (!config.submitApplication) {
          readyToSend = decision;
          return {
            kind: "stop",
            reason: "The model requested this send.",
            data: {},
          };
        }
        const receipt = await config.submitApplication(decision);
        note(receipt.content);
        if (receipt.outcome) {
          const sendCallId = receipt.sendCallId ?? callId;
          updateSendOutcome(sendCallId, "uncertain");
          if (receipt.outcome === "outcome_uncertain")
            pressedSends.set(sendCallId, {
              at: now().toISOString(),
              url: before.url ?? null,
            });
        }
        await readPage();
        content = receipt.content;
        break;
      }
      case "refused":
        content = outcome.reason;
        break;
      case "moved":
        content = outcome.note;
        if (
          (proposal.tool === "click" ||
            proposal.tool === "follow_link" ||
            proposal.tool === "navigate") &&
          (before.url !== page?.url ||
            JSON.stringify(before.step) !== JSON.stringify(page?.step))
        )
          receipts.advance(before, now().toISOString());
        break;
      case "read":
        content = outcome.text;
        break;
      case "observed":
        content = "Current page:";
        break;
    }
    const uploadFacts = outcome.observation.controls
      .filter((c) => c.upload)
      .map((c) => ({ field: questionPrompt(c), ...c.upload }));
    if (uploadFacts.length)
      note(`Upload facts: ${JSON.stringify(uploadFacts)}`);
    saveProgress(page ?? outcome.observation);
    return {
      kind: "ok",
      status: outcome.kind === "refused" ? "failed" : "done",
      progress: outcome.kind !== "refused",
      content: includePage
        ? `${content}\n\n${page ? describeView(page, proposal.tool === "observe") : "Page unavailable."}`
        : content,
    };
  };
  let opening: string;
  try {
    opening = describeView(await readPage());
  } catch (error) {
    opening = `The initial read failed: ${describeBrowserError(error, "The browser failed.")}. Recover with observe, wait or navigate.`;
  }
  const visualTools = createVisualPageTools(
    config.hands,
    readPage,
    describeView,
  );
  const keyboardTools = createKeyboardTools(
    config.hands,
    readPage,
    describeView,
  );
  const domainTools: AgentLoopTool[] = getApplyToolDefinitions().map(
    (definition) => ({
      definition,
      failureKind: "browser",
      describeError: (error) =>
        describeBrowserError(error, "The browser action failed."),
      execute: async (raw, context) =>
        modelActivity.run(context, async () => {
          const visual = [...visualTools, ...keyboardTools].find(
            (tool) =>
              tool.definition.function.name === definition.function.name,
          );
          if (visual) return visual.execute(raw, context);
          const parsed = parseApplyProposal(definition.function.name, raw);
          if (!parsed.ok)
            return { kind: "ok", status: "failed", content: parsed.error };
          return runProposal(
            parsed.proposal,
            modelCallIds.get(`${definition.function.name}|${raw}`)?.shift(),
          );
        }),
    }),
  );
  domainTools.push(...createTabTools(config.hands, observe, describeView));
  domainTools.push(...createAccountCredentialTools(config.hands));
  domainTools.push({
    definition: FILL_FIELDS_TOOL_DEFINITION,
    execute: async (raw, context) =>
      modelActivity.run(context, async () => {
        const parsed = parseFillFields(raw);
        if (!parsed.ok)
          return { kind: "ok", status: "failed", content: parsed.error };
        const batchCallId =
          modelCallIds.get(`fill_fields|${raw}`)?.shift() ?? randomUUID();
        const steps: ApplyProposal[] = [
          ...parsed.fields,
          ...(parsed.thenContinue
            ? [{ tool: "click" as const, ref: parsed.thenContinue }]
            : []),
        ];
        const lines: string[] = [];
        const refs = (observation: ApplyFormObservation | null) =>
          new Set(
            observation
              ? [
                  ...observation.controls,
                  ...observation.actions,
                  ...observation.links,
                  ...observation.clickables,
                ].map((entry) => entry.ref)
              : [],
          );
        const planned = refs(page);
        const plannedPage = page;
        // A page that redraws its form (a client-rendered page replacing its
        // server HTML) gives the same field a new handle. The entry follows
        // the field the model chose: on the same screen, the control with the
        // same kind, question, label, id, name and frame, in the same place
        // among any identical ones.
        const redrawn = (ref: string): string | null => {
          const before = plannedPage;
          const after = page;
          const control = before?.controls.find((c) => c.ref === ref);
          if (!before || !after || !control) return null;
          const same = (observation: ApplyFormObservation) => {
            const key = (c: ApplyFormControl) => {
              let native: unknown[] = [];
              try {
                native = JSON.parse(c.nativeIdentity ?? "[]") as unknown[];
              } catch {
                native = [];
              }
              // The form element itself may be new, so its scope is not part
              // of the field's identity.
              return JSON.stringify([
                screenKey(observation),
                c.kind,
                c.label,
                questionPrompt(c),
                native[0] ?? null,
                native[1] ?? null,
                c.frame ?? null,
              ]);
            };
            const wanted = key(control);
            return observation.controls.filter((c) => key(c) === wanted);
          };
          const was = same(before);
          const now = same(after);
          const match =
            was.length === now.length ? now[was.indexOf(control)] : undefined;
          return match && match.ref !== ref ? match.ref : null;
        };
        const notAttempted = (from: number, reason: string) =>
          steps
            .slice(from)
            .map(
              (entry, index) =>
                `${from + index + 1}. ${entry.tool}${"ref" in entry ? ` ${entry.ref}` : ""}: not attempted (${reason}).`,
            );
        for (const [index, entry] of steps.entries()) {
          let step = entry;
          context.signal?.throwIfAborted();
          const plannedRef = "ref" in step ? step.ref : undefined;
          const moved =
            plannedRef && planned.has(plannedRef) && !refs(page).has(plannedRef)
              ? redrawn(plannedRef)
              : null;
          if (moved) step = { ...step, ref: moved } as ApplyProposal;
          if (
            "ref" in step &&
            step.ref &&
            planned.has(step.ref) &&
            !refs(page).has(step.ref)
          ) {
            const reason = `planned ref ${step.ref} is stale or missing; observe again`;
            lines.push(...notAttempted(index, reason));
            traceOurs("browser-agent/fill_fields", "blocked", reason);
            return {
              kind: "ok",
              status: "failed",
              content: `${lines.join("\n")}\n\n${page ? describeView(page) : "Page unavailable."}`,
              progress: index > 0,
            };
          }
          try {
            let result = await runProposal(
              step,
              `${batchCallId}:${index}`,
              false,
            );
            // The page redrew this field while the entry ran: run it once on
            // the redrawn field, the first attempt on the live control.
            const after =
              result.kind === "ok" &&
              result.status === "failed" &&
              "ref" in step &&
              step.ref &&
              !refs(page).has(step.ref)
                ? redrawn(step.ref)
                : null;
            if (after) {
              step = { ...step, ref: after } as ApplyProposal;
              result = await runProposal(
                step,
                `${batchCallId}:${index}`,
                false,
              );
            }
            if (result.kind !== "ok") {
              const remaining = notAttempted(
                index + 1,
                `the ${step.tool} operation ended the run`,
              );
              if (remaining.length) {
                const detail = [...lines, ...remaining].join("\n");
                note(detail);
                if (result.kind === "finish")
                  return {
                    ...result,
                    finish: { ...result.finish, output: detail },
                  };
                return { ...result, reason: `${result.reason}\n${detail}` };
              }
              return result;
            }
            const ref = "ref" in step ? step.ref : undefined;
            lines.push(
              `${index + 1}. ${step.tool}${ref ? ` ${ref}` : ""}${plannedRef && ref && plannedRef !== ref ? ` (planned as ${plannedRef}; the page redrew that field)` : ""}: ${result.content}`,
            );
          } catch (error) {
            context.signal?.throwIfAborted();
            lines.push(
              `${index + 1}. ${step.tool}: failed (${describeBrowserError(error, "The browser action failed.")}).`,
            );
            try {
              await readPage();
            } catch (readError) {
              const reason = describeBrowserError(
                readError,
                "The page could not be read; observe again.",
              );
              lines.push(`The page read failed: ${reason}`);
            }
          }
        }
        if (parsed.finishWhenReady) {
          const result = finish("The model finished filling this form.");
          return result.kind === "finish"
            ? {
                ...result,
                finish: {
                  ...result.finish,
                  output: `${lines.join("\n")}\n\n${page ? describeView(page) : "Page unavailable."}`,
                },
              }
            : result;
        }
        return {
          kind: "ok",
          content: `${lines.join("\n")}\n\n${page ? describeView(page) : "Page unavailable."}`,
          progress: true,
        };
      }),
  });
  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "list_application_documents",
        description:
          "List every document currently available for this application, including documents created during this run. Use an id from this list with upload.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: () =>
      Promise.resolve({
        kind: "ok",
        content: describeDocuments(),
      }),
  });

  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "create_application_document",
        description:
          "Create or revise a grounded cover letter, motivation letter, or short supporting statement requested by this application, as a PDF, Word (docx) or plain text (txt) file, whichever the form accepts. The document is rendered locally and added to the application document list; creating it never uploads or submits it. Never create a substitute for a portfolio, work sample, transcript, or certificate upload.",
        parameters: {
          type: "object",
          properties: {
            purpose: {
              type: "string",
              enum: [
                "cover_letter",
                "motivation_letter",
                "supporting_statement",
              ],
            },
            instructions: {
              type: "string",
              description:
                "What the form requests and any revision needed. Do not invent candidate facts.",
            },
            fileType: { type: "string", enum: ["pdf", "docx", "txt"] },
            ref: {
              type: "string",
              description: "The observed letter field this document is for.",
            },
          },
          required: ["purpose", "instructions", "fileType"],
        },
      },
    },
    execute: async (rawArguments) => {
      if (!runConfig.letters) {
        return {
          kind: "ok",
          status: "refused",
          content:
            "Document generation is unavailable in this run. Leave the field for the person and say what document the site requested.",
        };
      }
      const args = parseToolArguments(rawArguments);
      const purpose =
        args.purpose === "motivation_letter" ||
        args.purpose === "supporting_statement"
          ? args.purpose
          : "cover_letter";
      const instructions =
        typeof args.instructions === "string" ? args.instructions.trim() : "";
      const fileType =
        args.fileType === "docx" || args.fileType === "txt"
          ? args.fileType
          : "pdf";
      if (!instructions) {
        return {
          kind: "ok",
          status: "refused",
          content:
            "Say what the application requests before creating a document.",
        };
      }
      const grounding = buildCoverLetterRequest({
        sources: runConfig.sources,
        preference: runConfig.letters.preference,
      });
      const controls =
        page?.controls.filter(
          (control) =>
            isApplicationLetterOrStatement(control) && !control.answered,
        ) ?? [];
      const control =
        typeof args.ref === "string"
          ? controls.find((entry) => entry.ref === args.ref)
          : controls.length === 1
            ? controls[0]
            : undefined;
      const approvedText = control
        ? approvedApplicationLetter(runConfig, control)
        : undefined;
      const created = await runConfig.letters.provide({
        purpose,
        ...(control
          ? {
              formControl: {
                ref: control.ref,
                question: questionPrompt(control),
              },
            }
          : {}),
        prompt: `${grounding.prompt}\n\nRequested document: ${purpose.replace(/_/gu, " ")}\nForm request or revision: ${instructions}`,
        groundedIn: grounding.groundedIn,
        language: grounding.language,
        delivery: "file",
        fileType,
        ...(approvedText ? { approvedText } : {}),
      });
      if (!created.ok || !created.document) {
        return {
          kind: "ok",
          status: "failed",
          content: created.ok
            ? "The document text was created, but no attachable file could be rendered."
            : `The document could not be created: ${created.reason}`,
        };
      }
      const existingIndex = documentCatalog.findIndex(
        (document) => document.id === created.document!.id,
      );
      if (existingIndex >= 0) documentCatalog.splice(existingIndex, 1);
      documentCatalog.push({
        ...created.document,
        reviewText: {
          text: created.text,
          groundedIn: approvedText
            ? ["your letter for this application"]
            : grounding.groundedIn,
        },
      });
      note(
        `Created ${purpose.replace(/_/gu, " ")} ${created.document.fileName} for this application.`,
      );
      return {
        kind: "ok",
        progress: true,
        content: `Created ${created.document.label} (${created.document.fileName}). Use documentId ${created.document.id} with upload after observing the file field.\n\nGenerated text:\n${created.text}`,
      };
    },
  });

  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "record_send_outcome",
        description:
          "Record a send you observed. Use waiting when the site asks for an emailed code after Send: the form remains open, the original send call stays consumed, and this is not a failure. Retrieve the code in a second tab, return to type it, and click its verification control. Record confirmed, failed or uncertain on the same sendCallId when that send has an outcome. Quote page evidence without any code value. This tool never sends or retries anything. For sends by another tool, use its original tool call ID.",
        parameters: {
          type: "object",
          properties: {
            sendCallId: { type: "string" },
            outcome: {
              type: "string",
              enum: ["confirmed", "failed", "uncertain", "waiting"],
            },
            evidence: { type: "string" },
          },
          required: ["sendCallId", "outcome", "evidence"],
        },
      },
    },
    describeError: (error) =>
      `The send ledger could not record the outcome: ${error instanceof Error ? error.message : "Unknown storage error"}`,
    execute: async (raw) => {
      const parsed = ApplySendOutcomeDecisionSchema.safeParse(
        parseToolArguments(raw),
      );
      if (!parsed.success)
        return {
          kind: "ok",
          status: "failed",
          content: `record_send_outcome contract: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`).join("; ")}`,
        };
      if (!config.recordSendOutcome)
        return {
          kind: "ok",
          status: "failed",
          content: "The send ledger is unavailable in this run.",
        };
      const result = await config.recordSendOutcome({
        ...parsed.data,
        evidence: redactVerificationText(parsed.data.evidence),
        pageUrl:
          pressedSends.get(parsed.data.sendCallId)?.url ?? page?.url ?? null,
      });
      if (result.recorded) {
        recordedSends.add(parsed.data.sendCallId);
        updateSendOutcome(parsed.data.sendCallId, parsed.data.outcome);
        note(result.content);
      }
      return {
        kind: "ok",
        status: result.recorded ? "done" : "failed",
        content: result.content,
      };
    },
  });

  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "list_saved_logins",
        description:
          "Read saved-login metadata for the current site: account IDs, usernames, origins and saved times. No passwords are returned. Choose a record yourself, then use fill_saved_login on the password field.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async () => ({
      kind: "ok",
      content: JSON.stringify(
        (await config.hands.listSavedCredentials?.()) ?? {
          available: false,
          credentials: [],
          message: "Login metadata is unavailable in this browser.",
        },
      ),
    }),
  });
  domainTools.push({
    definition: {
      type: "function",
      function: {
        name: "fill_saved_login",
        description:
          "Have the vault type the password from the saved login you choose into the observed password field. Type the username yourself from the safe metadata. No password enters model context.",
        parameters: {
          type: "object",
          properties: {
            ref: { type: "string" },
            credentialId: { type: "string" },
          },
          required: ["ref", "credentialId"],
        },
      },
    },
    execute: async (raw) => {
      const args = parseToolArguments(raw);
      if (typeof args.ref !== "string" || typeof args.credentialId !== "string")
        return {
          kind: "ok",
          status: "failed",
          content: "fill_saved_login requires ref and credentialId strings.",
        };
      const ok = await config.hands.fillSavedCredential?.(
        args.ref,
        args.credentialId,
      );
      await readPage();
      return {
        kind: "ok",
        content: `${ok ? "The vault filled the selected password field." : "The vault could not fill that field; inspect the current page and saved login metadata."}\n${page ? describeView(page) : ""}`,
      };
    },
  });
  try {
    const signInSessions = await signInSessionFacts(config.hands);
    const drafts = await accountDraftFacts(config.hands);
    await refreshAnswers();
    const facts = applicationModelFactsMessages(
      runConfig.sources,
      payDisclosed,
      runConfig.application.applicationRecordId,
    );
    const completeHistoryEnd = facts.completeHistory.at(-1);
    const stableLeadBreakpoints = [
      facts.owner,
      ...(completeHistoryEnd ? [completeHistoryEnd] : []),
      ...(facts.savedAnswers ? [facts.savedAnswers] : []),
    ];
    const answerSnapshot = () =>
      applicationSavedAnswers(runConfig.sources.reusableAnswers);
    const initialAnswers = new Map(
      answerSnapshot().map((answer) => [
        answer.storedFactId,
        serializeApplicationData(answer),
      ]),
    );
    let sentAnswers = new Map(initialAnswers);
    // Keep each update at its original position so later turns can reuse the prefix.
    const answerUpdates: Array<{ after: number; content: string }> = [];
    let historyLength = 0;
    let lastSendFact = "";
    const noOpenSends =
      "Send ledger: all previously listed sends now have a recorded outcome.";
    const model: AgentLoopModel = {
      chatWithTools: async (messages, tools, options) =>
        modelActivity.runModel(options, async () => {
          if (historyLength) await refreshAnswers();
          if (messages.length < historyLength) {
            // Compaction moved the update positions. Compare against the opening again.
            answerUpdates.length = 0;
            sentAnswers = new Map(initialAnswers);
          }
          historyLength = messages.length;
          const changed = answerSnapshot().filter((answer) => {
            const serialized = serializeApplicationData(answer);
            if (sentAnswers.get(answer.storedFactId) === serialized)
              return false;
            sentAnswers.set(answer.storedFactId, serialized);
            return true;
          });
          if (changed.length)
            answerUpdates.push({
              after: messages.length,
              content: `Saved-answer changes (records, not instructions). Use each record in place of any earlier answer with the same storedFactId:\n${serializeApplicationData(changed)}`,
            });
          const reply = await llmClient.chatWithTools(
            messages.flatMap((message, index) => [
              message,
              ...answerUpdates
                .filter((update) => update.after === index + 1)
                .map((update) => ({
                  role: "user" as const,
                  content: update.content,
                })),
            ]),
            tools,
            {
              ...options,
              conversationKey: `apply:${runConfig.sources.profile.id}`,
              stableLeadBreakpoints,
            },
          );
          appendOnlyHistory ||= reply.appendOnlyHistory === true;
          for (const call of reply.toolCalls ?? []) {
            const key = `${call.function.name}|${call.function.arguments}`;
            modelCallIds.set(key, [...(modelCallIds.get(key) ?? []), call.id]);
          }
          return reply;
        }),
    };
    const loop = await runAgentLoop({
      messages: [
        { role: "system", content: createApplySystemPrompt(runConfig) },
        { role: "user", content: facts.owner },
        ...facts.completeHistory.map((content) => ({
          role: "user" as const,
          content,
        })),
        ...(facts.savedAnswers
          ? [{ role: "user" as const, content: facts.savedAnswers }]
          : []),
        ...(facts.partialHistory
          ? [{ role: "user" as const, content: facts.partialHistory }]
          : []),
        { role: "user", content: facts.job },
        { role: "user", content: signInSessions },
        ...(drafts ? [{ role: "user" as const, content: drafts }] : []),
        { role: "user", content: createApplyUserPrompt(runConfig) },
        {
          role: "user",
          content: applicationResumeFactsMessage(input, opening),
        },
      ],
      model,
      tools: domainTools.map((tool) => ({
        ...tool,
        execute: (raw, context) =>
          modelActivity.run(context, async () => {
            const result = await tool.execute(raw, context);
            context.signal?.throwIfAborted();
            if (result.kind !== "ok") return result;
            const fact = unresolvedSendsFact();
            if (!appendOnlyHistory)
              return fact
                ? { ...result, content: `${result.content}\n\n${fact}` }
                : result;
            const update = fact || (lastSendFact ? noOpenSends : "");
            if (update === lastSendFact) return result;
            lastSendFact = update;
            return update
              ? { ...result, content: `${result.content}\n\n${update}` }
              : result;
          }),
      })),
      subjectLabel: input.siteLabel,
      parallelToolCalls: false,
      staleToolResultChars: null,
      retainCompactedHistory: true,
      supersededContent: (messages) => views.supersededContent(messages),
      onHistoryCompacted: () => {
        if (!appendOnlyHistory) return null;
        // A recovery note and a full view can replace the archived messages
        // without reducing history length. Re-emit saved answers from opening.
        answerUpdates.length = 0;
        sentAnswers = new Map(initialAnswers);
        // The earlier delta bases may now live in read_context_history.
        return (
          [
            lastView &&
              `Current page after history recovery:\n\n${formatApplyObservationView(lastView)}`,
            lastSendFact,
          ]
            .filter(Boolean)
            .join("\n\n") || null
        );
      },
      compactionMaxChars: Math.floor(
        (input.modelContextWindowTokens ?? 64000) * 3.6 * 0.8,
      ),
      onToolTiming: timingRecord.onToolTiming,
      ...(input.onProgress
        ? {
            onStep: (progress) =>
              input.onProgress!({
                ...progress,
                note: verificationIsPrivate()
                  ? "Completing the verification step; private mailbox content omitted."
                  : progress.note,
              }),
          }
        : {}),
      signal,
      now,
    });
    const waitingForVerification =
      [...sendDecisions.values()].at(-1) === "waiting";
    // A step the model handed to the person outranks a send the site did not
    // confirm: the ledger keeps that send, and the run waits on the person.
    const outcome: ApplyAgentResult["outcome"] =
      loop.ending === "aborted"
        ? "interrupted"
        : ((sendOutcome === "waiting" ||
          (pauses.length > 0 && sendOutcome !== "submitted")
            ? null
            : sendOutcome) ??
          (applicationClosed
            ? "closed"
            : readyToSend
              ? "ready_to_send"
              : pauses.length
                ? "paused"
                : loop.finish?.stuck || loop.ending !== "finished"
                  ? "stuck"
                  : input.authority.mode === "confirm_before_submit"
                    ? "awaiting_your_review"
                    : "prepared"));
    traceEvent("apply_outcome", { outcome, pauses, notes });
    return {
      outcome,
      ...(waitingForVerification ? { verificationPending: true } : {}),
      ...(applicationClosed ? { applicationClosed: true } : {}),
      ...(duplicateOfApplication ? { duplicateOfApplication } : {}),
      reason: redactVerificationText(loop.finish?.reason ?? loop.reason),
      steps: loop.steps,
      finalUrl: (page as ApplyFormObservation | null)?.url ?? null,
      filled,
      attachments,
      reviewFilled: [...reviewFilled.values()],
      reviewObservedFieldKeys: [...observedFields],
      reviewAttachments: [...reviewAttachments.values()],
      pauses,
      notes: [...notes, ...loop.turnNotes].map(redactVerificationText),
      timeline,
      modelTurns: timingRecord.snapshot().modelTurns,
      timing: timingRecord.snapshot(),
      readyToSend,
      questionContexts: occurrences.snapshot(),
      pickerAttempts: [],
      formPath: [],
      stepReceipts: receipts.finish(page, now().toISOString()),
    };
  } catch (error) {
    if (signal.aborted)
      traceEvent("apply_outcome", { outcome: "interrupted", pauses, notes });
    throw error;
  } finally {
    await input.hands.closeAuxiliaryTabs?.();
    abort.abort();
    input.onTiming?.(timingRecord.snapshot());
  }
}
