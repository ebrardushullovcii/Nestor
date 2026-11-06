import type { LLMClient } from "../agent/contracts";
import type {
  ApplyAgentConfig,
  ApplyAttachedDocument,
  ApplyFilledControl,
} from "./types";
import { isCoverLetterControl } from "./cover-letter";
import {
  createApplyGuardState,
  executeApplyProposal,
  questionPrompt,
} from "./policy-executor";

/** Replace only the recorded letter fields on the current retained page. Never navigate or send. */
export async function replaceApprovedApplicationLetter(input: {
  config: ApplyAgentConfig;
  client: LLMClient;
  fields: readonly string[];
}): Promise<{
  filled: ApplyFilledControl[];
  attachments: ApplyAttachedDocument[];
} | null> {
  const { config } = input;
  const observation = await config.hands.observe();
  const fields = [...new Set(input.fields)];
  if (!fields.length || observation.blocker) return null;
  const controls = fields.map((field) =>
    observation.controls.filter(
      (control) =>
        questionPrompt(control) === field &&
        isCoverLetterControl(control) &&
        !control.disabled &&
        !control.readOnly &&
        (control.visible || control.kind === "file"),
    ),
  );
  // Missing or ambiguous fields require a fresh preparation, not a guessed write.
  if (controls.some((matches) => matches.length !== 1)) return null;
  const deps = {
    config,
    now: config.now ?? (() => new Date()),
    guardState: createApplyGuardState(),
  };
  const filled: ApplyFilledControl[] = [];
  const attachments: ApplyAttachedDocument[] = [];
  let signature = observation.signature;
  for (const [control] of controls) {
    if (!control) return null;
    const result = await executeApplyProposal(
      control.kind === "file"
        ? {
            tool: "upload",
            ref: control.ref,
            documentId: "approved_application_letter",
          }
        : {
            tool: "type",
            ref: control.ref,
            text: config.sources.approvedLetterText ?? "",
          },
      signature,
      deps,
    );
    if (result.kind === "filled") filled.push(result.filled);
    else if (result.kind === "attached") attachments.push(result.attachment);
    else return null;
    signature = result.observation.signature;
  }
  return { filled, attachments };
}
