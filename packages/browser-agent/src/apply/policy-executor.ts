import type {
  ApplyPersonRequest,
  ApplicationAttemptQuestion,
  StoredApplyPickerAttempt,
  ApplyWriteResult,
} from "@nestor/contracts";
import { meaningHash, meaningTargetHash } from "./answer-meaning";
import { normalizeSignal } from "./control-classification";
import { questionPrompt } from "./question-text";
import { formWritingInstructions } from "./own-words";
import {
  buildCoverLetterRequest,
  coverLetterDeliveryFor,
  requiredLetterFileType,
} from "./cover-letter";
import type {
  ApplyAgentConfig,
  ApplyAnswer,
  ApplyAttachedDocument,
  ApplyDocument,
  ApplyFilledControl,
  ApplyFormControl,
  ApplyFormObservation,
  ApplyProposal,
} from "./types";
export { questionPrompt } from "./question-text";

/** State records actions; it never decides whether the model may act. */
export interface ApplyGuardState {
  hasWritten: boolean;
  lastFieldLabel: string | null;
  notes: string[];
}
export function createApplyGuardState(
  _earlier: readonly StoredApplyPickerAttempt[] = [],
): ApplyGuardState {
  void _earlier;
  return { hasWritten: false, lastFieldLabel: null, notes: [] };
}
export interface ApplyExecutorDeps {
  seenObservation?: ApplyFormObservation;
  config: ApplyAgentConfig;
  now: () => Date;
  guardState: ApplyGuardState;
}
export type ApplyExecutionOutcome =
  | { kind: "observed"; observation: ApplyFormObservation }
  | { kind: "read"; text: string; observation: ApplyFormObservation }
  | {
      kind: "filled";
      filled: ApplyFilledControl;
      observation: ApplyFormObservation;
    }
  | {
      kind: "attached";
      attachment: ApplyAttachedDocument;
      observation: ApplyFormObservation;
    }
  | {
      kind: "moved";
      note: string;
      observation: ApplyFormObservation;
      progress: boolean;
    }
  | {
      kind: "refused";
      reason: string;
      observation: ApplyFormObservation;
      uploadFailed?: boolean;
    }
  | {
      kind: "ready_to_send";
      finalActionRef: string;
      finalActionLabel: string;
      observation: ApplyFormObservation;
    }
  | {
      kind: "finished";
      reason: string;
      stuck: boolean;
      needsPerson: boolean;
      forPerson?: ApplyPersonRequest[];
    };

function questionIdFor(
  control: ApplyFormControl,
  jobId: string,
  siblings: readonly ApplyFormControl[] = [],
): string {
  const identity = (candidate: ApplyFormControl): string =>
    candidate.kind === "radio" && candidate.choiceGroupKey
      ? `radio|${candidate.choiceGroupKey}`
      : `${normalizeSignal(candidate.groupLabel)}|${normalizeSignal(candidate.label)}|${candidate.kind}`;
  const digest = (value: string): string => {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.codePointAt(0) ?? 0;
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  const semanticIdentity =
    control.kind === "radio"
      ? `${control.groupLabel || "choice"} ${control.kind}`
      : `${control.groupLabel} ${control.label} ${control.kind}`;
  const slug = semanticIdentity
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 60);
  const same = siblings.filter(
    (candidate) => identity(candidate) === identity(control),
  );
  const ordinal = same.findIndex((candidate) => candidate.ref === control.ref);
  const choiceSuffix =
    (control.kind === "radio" ||
      control.answerControlType === "multi_choice") &&
    control.choiceGroupKey
      ? `_${digest(control.choiceGroupKey)}`
      : "";
  const suffix =
    (control.repeatedQuestion
      ? `_repeat_${digest(control.repeatedQuestion.step)}`
      : "") +
    (choiceSuffix || (same.length > 1 && ordinal > 0 ? `_${ordinal + 1}` : ""));
  return `question_${jobId}_${slug || "field"}${suffix}`;
}

export function buildPendingQuestion(input: {
  control: ApplyFormControl;
  observation?: ApplyFormObservation;
  jobId: string;
  detectedAt: string;
  suggestion: ApplyAnswer | null;
  siblings?: readonly ApplyFormControl[];
  /** Why stored answers did not settle it, said beside the question. */
  reason?: string | null;
  askReason?: ApplicationAttemptQuestion["askReason"];
}): ApplicationAttemptQuestion {
  const { control, suggestion } = input;
  const note = input.reason?.trim() || null;
  const radioSiblings =
    control.kind === "radio" && control.choiceGroupKey
      ? (input.siblings ?? []).filter(
          (candidate) =>
            candidate.kind === "radio" &&
            candidate.choiceGroupKey === control.choiceGroupKey,
        )
      : [];
  const answerOptions =
    radioSiblings.length > 0
      ? radioSiblings.map((candidate) => candidate.label || candidate.value)
      : control.options;
  return {
    ...(input.observation?.url
      ? {
          currentFieldBinding: {
            pageUrl: input.observation.url,
            targetHash: meaningTargetHash(
              control,
              input.siblings ?? input.observation.controls,
            ),
            instructionsHash: meaningHash(
              formWritingInstructions(input.observation),
            ),
          },
        }
      : {}),
    id: questionIdFor(control, input.jobId, input.siblings ?? []),
    askReason:
      input.askReason ??
      (note
        ? {
            kind: "no_source",
            detail: note.slice(0, 4000),
          }
        : {
            kind: "no_source",
            detail:
              "No applicable saved answer or Profile fact answered this question.",
          }),
    prompt: questionPrompt(control),
    ...(control.repeatedQuestion ? { repeatedAtDifferentStep: true } : {}),
    kind: control.questionKind,
    answerControlType: control.answerControlType,
    ...(control.inputConstraints
      ? { inputConstraints: control.inputConstraints }
      : {}),
    isRequired: control.required,
    detectedAt: input.detectedAt,
    // A list's blank first choice is not an answer anyone could give.
    answerOptions: answerOptions.filter((option) => option.trim().length > 0),
    suggestedAnswers: suggestion
      ? [
          {
            id: `${questionIdFor(control, input.jobId, input.siblings ?? [])}_suggestion`,
            text: suggestion.value,
            sourceKind:
              suggestion.sourceKind === "answer_library"
                ? "user"
                : suggestion.sourceKind === "generated"
                  ? "prior_answer"
                  : "profile",
            sourceId: suggestion.sourceId,
            confidenceLabel: null,
            provenance: [
              {
                id: `${questionIdFor(control, input.jobId, input.siblings ?? [])}_source`,
                sourceKind:
                  suggestion.sourceKind === "answer_library"
                    ? "user"
                    : suggestion.sourceKind === "generated"
                      ? "prior_answer"
                      : "profile",
                sourceId: suggestion.sourceId,
                label: suggestion.provenanceLabel,
                snippet: null,
              },
            ],
          },
        ]
      : [],
    ...(note ? { note } : {}),
    submittedAnswer: null,
    status: "detected",
  };
}

export function approvedApplicationLetter(
  config: ApplyAgentConfig,
  _control: ApplyFormControl,
): string | undefined {
  void _control;
  return config.sources.approvedLetterText;
}
type LetterOutcome =
  | {
      kind: "ok";
      letter: {
        text: string;
        document: ApplyDocument | null;
        groundedIn: string[];
      };
    }
  | { kind: "stop"; outcome: ApplyExecutionOutcome };

/**
 * Gets the one letter for this application.
 *
 * Written once and handed back unchanged after that, so a form that asks for a
 * file and a form that asks for a box never end up with two different letters.
 */
async function provideApplicationLetter(
  deps: ApplyExecutorDeps,
  control: ApplyFormControl,
): Promise<LetterOutcome> {
  const { config } = deps;
  const letters = config.letters;
  const approvedText = approvedApplicationLetter(config, control);

  if (!letters && approvedText && control.kind !== "file") {
    return {
      kind: "ok",
      letter: {
        text: approvedText,
        document: null,
        groundedIn: ["your letter for this application"],
      },
    };
  }
  if (!letters) {
    return {
      kind: "stop",
      outcome: {
        kind: "refused",
        reason: "Job Finder has no letter for this application.",
        observation: await config.hands.observe(),
      },
    };
  }

  const request = applicationLetterRequest(config, control);
  const produced = await letters.provide(request);

  if (!produced.ok)
    return {
      kind: "stop",
      outcome: {
        kind: "refused",
        reason: produced.reason,
        observation: await config.hands.observe(),
      },
    };

  return {
    kind: "ok",
    letter: {
      text: produced.text,
      document: produced.document,
      groundedIn: approvedText
        ? ["your letter for this application"]
        : request.groundedIn,
    },
  };
}

/** The same local draft request is used while filling and at the guarded write. */
export function applicationLetterRequest(
  config: ApplyAgentConfig,
  control: ApplyFormControl,
): Parameters<NonNullable<ApplyAgentConfig["letters"]>["provide"]>[0] {
  const approvedText = approvedApplicationLetter(config, control);
  return {
    ...buildCoverLetterRequest({
      sources: config.sources,
      preference: config.letters!.preference,
    }),
    purpose: "cover_letter",
    formControl: { ref: control.ref, question: questionPrompt(control) },
    delivery: coverLetterDeliveryFor(control),
    fileType: requiredLetterFileType(control),
    ...(config.signal ? { signal: config.signal } : {}),
    ...(approvedText ? { approvedText } : {}),
  };
}

/** Execute the model's call and return the browser result, in every apply mode. */
export async function executeApplyProposal(
  proposal: ApplyProposal,
  _seenSignature: string,
  deps: ApplyExecutorDeps,
): Promise<ApplyExecutionOutcome> {
  const { config } = deps;
  config.signal?.throwIfAborted();
  if (proposal.tool === "finish")
    return {
      kind: "finished",
      reason: proposal.reason,
      stuck: proposal.stuck === true,
      needsPerson: proposal.needsPerson === true,
      forPerson: proposal.forPerson ?? [],
    };
  const observation = await config.hands.observe();
  const failed = (
    reason: string,
    uploadFailed = false,
  ): Extract<ApplyExecutionOutcome, { kind: "refused" }> => ({
    kind: "refused",
    reason,
    observation,
    ...(uploadFailed ? { uploadFailed } : {}),
  });
  const control =
    "ref" in proposal
      ? (observation.controls.find((c) => c.ref === proposal.ref) ??
        deps.seenObservation?.controls.find((c) => c.ref === proposal.ref))
      : undefined;
  const at = deps.now().toISOString();
  if (proposal.tool === "observe") return { kind: "observed", observation };
  if (proposal.tool === "read_text")
    return {
      kind: "read",
      text: await config.hands.readText(proposal.ref),
      observation,
    };
  if (proposal.tool === "submit_application")
    return {
      kind: "ready_to_send",
      finalActionRef: proposal.ref,
      finalActionLabel:
        [
          ...observation.actions,
          ...observation.clickables,
          ...observation.links,
        ].find((c) => c.ref === proposal.ref)?.label ?? proposal.ref,
      observation,
    };
  if (
    proposal.tool === "type" ||
    proposal.tool === "select" ||
    proposal.tool === "set_checkbox" ||
    proposal.tool === "upload"
  ) {
    // A ref can name a live control exposed as a clickable (for example a
    // closed-root checkbox). Its browser result decides whether the call works.
    if (!control) {
      let result: ApplyWriteResult;
      if (proposal.tool === "upload") {
        const document = config.sources.documents.find(
          (item) => item.id === proposal.documentId,
        );
        if (!document)
          return failed(
            `No document with id ${proposal.documentId} is available. Inspect list_application_documents or create a document.`,
            true,
          );
        const bytes = await document.loadBytes();
        config.signal?.throwIfAborted();
        result = await config.hands.uploadFile(proposal.ref, {
          name: document.fileName,
          mimeType: document.mimeType,
          bytes,
          ...(proposal.method ? { method: proposal.method } : {}),
        });
      } else {
        config.signal?.throwIfAborted();
        result =
          proposal.tool === "type"
            ? await config.hands.fillText(proposal.ref, proposal.text)
            : proposal.tool === "select"
              ? await config.hands.chooseOption(proposal.ref, proposal.option)
              : await config.hands.setToggle(proposal.ref, proposal.checked);
      }
      const after = await config.hands.observe();
      if (!result.ok)
        return {
          ...failed(
            result.error +
              (result.offeredOptions?.length
                ? ` Offered options: ${JSON.stringify(result.offeredOptions)}.`
                : ""),
            proposal.tool === "upload",
          ),
          observation: after,
        };
      deps.guardState.hasWritten = true;
      return {
        kind: "moved",
        note: `Completed ${proposal.tool}: ${result.observedValue}.`,
        observation: after,
        progress: observation.signature !== after.signature,
      };
    }
    if (
      control.credentialRole === "password" ||
      control.credentialRole === "one_time_code"
    )
      return failed(
        "Use the vault for saved secrets. A missing secret must be entered on the open page; never include it in a model tool call.",
      );
    let document: ApplyDocument | undefined;
    let value =
      proposal.tool === "type"
        ? proposal.text
        : proposal.tool === "select"
          ? proposal.option
          : proposal.tool === "set_checkbox"
            ? control.kind === "radio"
              ? control.label || control.value
              : proposal.checked
                ? "Yes"
                : "No"
            : "";
    if (
      (proposal.tool === "type" && proposal.text === "letter") ||
      (proposal.tool === "upload" &&
        (proposal.documentId === "letter" ||
          proposal.documentId === "approved_application_letter"))
    ) {
      const produced = await provideApplicationLetter(deps, control);
      if (produced.kind !== "ok") return produced.outcome;
      value = produced.letter.text;
      document = produced.letter.document
        ? {
            ...produced.letter.document,
            reviewText: {
              text: produced.letter.text,
              groundedIn: produced.letter.groundedIn,
            },
          }
        : undefined;
    }
    if (proposal.tool === "upload") {
      document ??= config.sources.documents.find(
        (d) => d.id === proposal.documentId,
      );
      if (!document)
        return failed(
          `No document with id ${proposal.documentId} is available. Inspect list_application_documents or create a document.`,
          true,
        );
      const bytes = await document.loadBytes();
      config.signal?.throwIfAborted();
      const result = await config.hands.uploadFile(proposal.ref, {
        name: document.fileName,
        mimeType: document.mimeType,
        bytes,
        ...(proposal.method ? { method: proposal.method } : {}),
      });
      const after = await config.hands.observe();
      if (!result.ok)
        return { ...failed(result.error, true), observation: after };
      deps.guardState.hasWritten = true;
      return {
        kind: "attached",
        attachment: {
          documentId: document.id,
          fileName: document.fileName,
          label: document.label,
          controlLabel: questionPrompt(control),
          at,
          ...(document.reviewText ? { reviewText: document.reviewText } : {}),
        },
        observation: after,
      };
    }
    config.signal?.throwIfAborted();
    const result =
      proposal.tool === "type"
        ? await config.hands.fillText(proposal.ref, value)
        : proposal.tool === "select"
          ? await config.hands.chooseOption(proposal.ref, value)
          : await config.hands.setToggle(proposal.ref, proposal.checked);
    const after = await config.hands.observe();
    if (!result.ok)
      return {
        ...failed(
          result.error +
            (result.offeredOptions?.length
              ? ` Offered options: ${JSON.stringify(result.offeredOptions)}.`
              : ""),
        ),
        observation: after,
      };
    deps.guardState.hasWritten = true;
    deps.guardState.lastFieldLabel = questionPrompt(control);
    const sourceId = proposal.storedFactId ?? `chosen.${control.ref}`;
    const saved = config.sources.reusableAnswers.find(
      (a) => `answerLibrary.${a.id}` === sourceId,
    );
    const answer: ApplyAnswer = {
      value,
      kind: control.questionKind,
      sourceId,
      sourceKind: saved
        ? "answer_library"
        : sourceId.startsWith("profile.")
          ? "profile"
          : "generated",
      provenanceLabel: saved
        ? `your saved answer "${saved.question}"`
        : "chosen for this application",
      groundedIn: proposal.tool === "type" ? (proposal.groundedIn ?? []) : [],
    };
    return {
      kind: "filled",
      filled: {
        ref: control.ref,
        label: questionPrompt(control),
        questionKind: control.questionKind,
        answer,
        at,
      },
      observation: after,
    };
  }
  if (proposal.tool === "wait") await config.hands.wait(proposal.milliseconds);
  else if (proposal.tool === "scroll")
    await config.hands.scroll(proposal.direction);
  else {
    const result =
      proposal.tool === "click"
        ? await config.hands.clickElement(proposal.ref)
        : proposal.tool === "follow_link"
          ? await config.hands.followLink(proposal.ref)
          : proposal.tool === "navigate"
            ? await config.hands.navigate(proposal.url)
            : await config.hands.goBack();
    if (!result.ok)
      return {
        ...failed(result.error),
        observation: await config.hands.observe(),
      };
  }
  let after = await config.hands.observe();
  const newest = after.openedTabs.at(-1);
  let tabNote = "";
  if (!after.accountWindow && newest && config.hands.adoptOpenedTab) {
    const adopted = await config.hands.adoptOpenedTab(newest.index);
    tabNote = adopted.ok
      ? ` Opened tab adopted: ${adopted.url}.`
      : ` Tab adoption failed: ${adopted.error}.`;
    after = await config.hands.observe();
  }
  return {
    kind: "moved",
    note: `Completed ${proposal.tool}.${tabNote}`,
    observation: after,
    progress: observation.signature !== after.signature,
  };
}
