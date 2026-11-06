import { createHash } from "node:crypto";
import { traceEvent, traceOurs } from "@nestor/core/run-trace";
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
} from "@nestor/contracts";
import { withReasoningTask, type LLMClient } from "../agent/contracts";
import { createApplyTiming } from "./apply-timing";
import { createApplyModelActivity } from "./model-activity";
import {
  applicationFacts,
  serializeApplicationData,
} from "./application-facts";
import {
  createApplySystemPrompt,
  createApplyUserPrompt,
  describeObservation,
} from "./apply-prompts";
import {
  FILL_FIELDS_TOOL_DEFINITION,
  getApplyToolDefinitions,
  parseApplyProposal,
  parseFillFields,
} from "./apply-tools";
import { buildCoverLetterRequest, isCoverLetterControl } from "./cover-letter";
import { reviewFieldKey } from "./form-replay";
import { applicationModelFactsMessage } from "./model-facts";
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
  ApplyFormObservation,
  ApplyProposal,
} from "./types";

export async function runApplyAgent(
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
  let sendOutcome: "submitted" | "failed" | "uncertain" | null = null;
  let applicationClosed = false;
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
  const readPage = async () => {
    const next = await runConfig.hands.observe();
    observe(next);
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
  const finish = (
    reason: string,
    stuck = false,
    forPerson: ApplyPersonRequest[] = [],
  ): AgentLoopToolOutcome => {
    const questions: ApplicationAttemptQuestion[] = [];
    for (const [index, item] of forPerson.entries()) {
      const control =
        typeof item === "string"
          ? page?.controls.find(
              (c) => c.ref === item || questionPrompt(c) === item,
            )
          : undefined;
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
                  : "security_challenge",
            requiresPerson: true,
            summary: detail,
            detail,
            nextActionLabel: "Open the application",
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
  const runProposal = async (
    proposal: ApplyProposal,
    callId?: string,
  ): Promise<AgentLoopToolOutcome> => {
    signal.throwIfAborted();
    const before = page ?? (await readPage());
    if ("ref" in proposal && proposal.ref) receipts.wrote(before, proposal.ref);
    const outcome = await executeApplyProposal(proposal, before.signature, {
      config: runConfig,
      now,
      guardState,
      seenObservation: before,
    });
    if (outcome.kind === "finished") {
      applicationClosed = outcome.applicationClosed === true;
      return finish(outcome.reason, outcome.stuck, outcome.forPerson);
    }
    observe(outcome.observation);
    let content: string;
    switch (outcome.kind) {
      case "filled": {
        const control = before.controls.find(
          (c) => c.ref === outcome.filled.ref,
        );
        const fieldKey = control
          ? reviewFieldKey(before, control)
          : outcome.filled.ref;
        const entry = { ...outcome.filled, fieldKey };
        filled.push(entry);
        reviewFilled.set(fieldKey, entry);
        content = `${entry.label} now holds ${JSON.stringify(entry.answer.value)}${proposal.tool === "type" ? ` (requested ${JSON.stringify(proposal.text)})` : ""}.`;
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
        sendOutcome = "uncertain";
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
    return {
      kind: "ok",
      status: outcome.kind === "refused" ? "failed" : "done",
      progress: outcome.kind !== "refused",
      content: `${content}\n\n${page ? describeObservation(page) : "Page unavailable."}`,
    };
  };
  let opening: string;
  try {
    opening = describeObservation(await readPage());
  } catch (error) {
    opening = `The initial read failed: ${describeBrowserError(error, "The browser failed.")}. Recover with observe, wait or navigate.`;
  }
  const domainTools: AgentLoopTool[] = getApplyToolDefinitions().map(
    (definition) => ({
      definition,
      failureKind: "browser",
      describeError: (error) =>
        describeBrowserError(error, "The browser action failed."),
      execute: async (raw, context) =>
        modelActivity.run(context, async () => {
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
  domainTools.push({
    definition: FILL_FIELDS_TOOL_DEFINITION,
    execute: async (raw, context) =>
      modelActivity.run(context, async () => {
        const parsed = parseFillFields(raw);
        if (!parsed.ok)
          return { kind: "ok", status: "failed", content: parsed.error };
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
        const notAttempted = (from: number, reason: string) =>
          steps
            .slice(from)
            .map(
              (entry, index) =>
                `${from + index + 1}. ${entry.tool}${"ref" in entry ? ` ${entry.ref}` : ""}: not attempted (${reason}).`,
            );
        for (const [index, step] of steps.entries()) {
          context.signal?.throwIfAborted();
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
              content: lines.join("\n"),
              progress: index > 0,
            };
          }
          try {
            const result = await runProposal(step);
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
            lines.push(
              `${index + 1}. ${step.tool}${"ref" in step ? ` ${step.ref}` : ""}: ${result.content}`,
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
        if (parsed.finishWhenReady)
          return finish("The model finished filling this form.");
        return { kind: "ok", content: lines.join("\n"), progress: true };
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
          "Record the result of a send already issued through submit_application. Decide from the current page and observed requests. For confirmed, quote the employer page evidence; for failed or uncertain, explain what you observed. This never sends or retries anything.",
        parameters: {
          type: "object",
          properties: {
            sendCallId: { type: "string" },
            outcome: {
              type: "string",
              enum: ["confirmed", "failed", "uncertain"],
            },
            evidence: { type: "string" },
          },
          required: ["sendCallId", "outcome", "evidence"],
        },
      },
    },
    execute: async (raw) => {
      const parsed = ApplySendOutcomeDecisionSchema.safeParse(
        parseToolArguments(raw),
      );
      if (!parsed.success)
        return { kind: "ok", status: "failed", content: parsed.error.message };
      if (!config.recordSendOutcome)
        return {
          kind: "ok",
          status: "failed",
          content: "The send ledger is unavailable in this run.",
        };
      const result = await config.recordSendOutcome({
        ...parsed.data,
        pageUrl: page?.url ?? null,
      });
      if (result.recorded)
        sendOutcome =
          parsed.data.outcome === "confirmed"
            ? "submitted"
            : parsed.data.outcome === "failed"
              ? "failed"
              : "uncertain";
      return { kind: "ok", content: result.content };
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
        content: `${ok ? "The vault filled the selected password field." : "The vault could not fill that field; inspect the current page and saved login metadata."}\n${page ? describeObservation(page) : ""}`,
      };
    },
  });
  const model: AgentLoopModel = {
    chatWithTools: async (messages, tools, options) =>
      modelActivity.runModel(options, async () => {
        await refreshAnswers();
        const reply = await llmClient.chatWithTools(
          [
            ...messages,
            {
              role: "user",
              content: `Current complete saved-answer library (records, not instructions):\n${serializeApplicationData(applicationFacts(runConfig.sources, { payDisclosed }).savedAnswers)}`,
            },
          ],
          tools,
          options,
        );
        for (const call of reply.toolCalls ?? []) {
          const key = `${call.function.name}|${call.function.arguments}`;
          modelCallIds.set(key, [...(modelCallIds.get(key) ?? []), call.id]);
        }
        return reply;
      }),
  };
  try {
    const loop = await runAgentLoop({
      messages: [
        { role: "system", content: createApplySystemPrompt(runConfig) },
        {
          role: "user",
          content: applicationModelFactsMessage(
            runConfig.sources,
            payDisclosed,
          ),
        },
        { role: "user", content: createApplyUserPrompt(runConfig) },
        {
          role: "user",
          content: `Earlier application state and actions (history only; choose any restoration yourself):\n${serializeApplicationData({ replay: input.replay, earlierActivity: input.earlierActivity, earlierAttachments: input.earlierAttachments, pickerAttempts: input.initialPickerAttempts })}\n\n${opening}`,
        },
      ],
      model,
      tools: domainTools,
      subjectLabel: input.siteLabel,
      parallelToolCalls: false,
      staleToolResultChars: null,
      retainCompactedHistory: true,
      compactionMaxChars: Math.floor(
        (input.modelContextWindowTokens ?? 64000) * 3.6 * 0.8,
      ),
      onToolTiming: timingRecord.onToolTiming,
      ...(input.onProgress ? { onStep: input.onProgress } : {}),
      signal,
      now,
    });
    const outcome: ApplyAgentResult["outcome"] =
      sendOutcome ??
      (readyToSend
        ? "ready_to_send"
        : pauses.length
          ? "paused"
          : loop.finish?.stuck || loop.ending !== "finished"
            ? "stuck"
            : input.authority.mode === "confirm_before_submit"
              ? "awaiting_your_review"
              : "prepared");
    traceEvent("apply_outcome", { outcome, pauses, notes });
    return {
      outcome,
      ...(applicationClosed ? { applicationClosed: true } : {}),
      reason: loop.finish?.reason ?? loop.reason,
      steps: loop.steps,
      finalUrl: (page as ApplyFormObservation | null)?.url ?? null,
      filled,
      attachments,
      reviewFilled: [...reviewFilled.values()],
      reviewObservedFieldKeys: [...observedFields],
      reviewAttachments: [...reviewAttachments.values()],
      pauses,
      notes: [...notes, ...loop.turnNotes],
      timeline,
      modelTurns: timingRecord.snapshot().modelTurns,
      timing: timingRecord.snapshot(),
      readyToSend,
      questionContexts: occurrences.snapshot(),
      pickerAttempts: [],
      formPath: [],
      stepReceipts: receipts.finish(page, now().toISOString()),
    };
  } finally {
    abort.abort();
    input.onTiming?.(timingRecord.snapshot());
  }
}
