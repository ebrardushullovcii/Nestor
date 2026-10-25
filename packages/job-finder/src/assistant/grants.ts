import type {
  AssistantContextReference,
  AssistantGrantAction,
  AssistantInstructionGrant,
  AssistantMessage,
  AssistantResultSet,
  ApplicationAutomationMode,
} from "@nestor/contracts";

/**
 * Written instructions authorize (ADR 0039).
 *
 * A grant binds one message the person typed in the sidebar to an action and
 * a frozen list of jobs. Only deterministic code here decides whether a
 * target is covered; the model proposes, main checks.
 */

export interface GrantTargetCheck {
  accepted: string[];
  rejected: string[];
}

/** Every job id the person could have meant when they sent this message. */
export function jobIdsReachableFromContext(
  context: AssistantContextReference | null,
): Set<string> {
  const ids = new Set<string>();
  if (!context) return ids;
  if (
    context.focus &&
    (context.focus.kind === "job" || context.focus.kind === "application")
  ) {
    ids.add(context.focus.id);
  }
  if (context.editor?.editor === "resume") ids.add(context.editor.jobId);
  for (const mention of context.mentions) {
    if (mention.kind === "job" || mention.kind === "application")
      ids.add(mention.id);
  }
  if (context.list) {
    for (const id of context.list.selectedIds) ids.add(id);
    for (const id of context.list.displayedIds) ids.add(id);
    for (const id of context.list.filteredIds) ids.add(id);
  }
  return ids;
}

/**
 * Targets are accepted only when they come from the authorizing message's
 * context or from result sets this conversation produced since that
 * message. A page, a tool output or an old message cannot add a target.
 */
export function checkGrantTargets(input: {
  requestedJobIds: readonly string[];
  authorizingMessage: AssistantMessage;
  resultSets: readonly AssistantResultSet[];
  /** Jobs the application records map to (an application id names its job). */
  jobIdForApplication?: (id: string) => string | null;
}): GrantTargetCheck {
  const reachable = jobIdsReachableFromContext(
    input.authorizingMessage.context,
  );
  // Result sets shown before the message count too: the person saw them and
  // "those" can point back at them.
  for (const resultSet of input.resultSets) {
    if (resultSet.kind === "jobs" || resultSet.kind === "page_jobs") {
      for (const id of resultSet.itemIds) reachable.add(id);
    }
  }
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const raw of input.requestedJobIds) {
    const id = input.jobIdForApplication?.(raw) ?? raw;
    if (reachable.has(raw) || reachable.has(id)) accepted.push(id);
    else rejected.push(raw);
  }
  return { accepted: [...new Set(accepted)], rejected };
}

export type DispatchAction = "prepare" | "send";

export interface GrantDecision {
  jobId: string;
  allowed: boolean;
  /** The mode an application start uses for this job under the grant. */
  mode: ApplicationAutomationMode | null;
  grantId: string | null;
  reason: string | null;
}

function isLive(grant: AssistantInstructionGrant): boolean {
  return grant.status === "active" || grant.status === "narrowed";
}

/**
 * Rechecked at dispatch, just before anything leaves the app. The newest
 * live grant naming a job decides for it, so a later "don't send yet"
 * narrows an earlier "send them".
 */
export function decideUnderGrants(input: {
  grants: readonly AssistantInstructionGrant[];
  jobIds: readonly string[];
  action: DispatchAction;
  savedMode: ApplicationAutomationMode;
}): GrantDecision[] {
  const live = [...input.grants]
    .reverse()
    .filter(isLive)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const revoked = input.grants.filter((grant) => grant.status === "revoked");
  return input.jobIds.map((jobId) => {
    const grant = live.find((candidate) => candidate.jobIds.includes(jobId));
    if (!grant) {
      const wasRevoked = revoked.some((candidate) =>
        candidate.jobIds.includes(jobId),
      );
      return {
        jobId,
        allowed: false,
        mode: null,
        grantId: null,
        reason: wasRevoked
          ? "The person withdrew the instruction that covered this job."
          : "No message from the person covers this job yet. Record their instruction first, quoting what they asked.",
      };
    }
    const mode = modeForGrant(grant.action, input.savedMode);
    if (input.action === "send") {
      if (grant.action === "prepare") {
        return {
          jobId,
          allowed: false,
          mode,
          grantId: grant.id,
          reason:
            "The person asked for this application to be prepared only; they will send it themselves.",
        };
      }
      if (
        grant.action === "apply_saved_mode" &&
        input.savedMode !== "autonomous_submit"
      ) {
        return {
          jobId,
          allowed: false,
          mode,
          grantId: grant.id,
          reason:
            "The person did not ask to send, and the saved apply mode is Fill in for me.",
        };
      }
    }
    return { jobId, allowed: true, mode, grantId: grant.id, reason: null };
  });
}

export function modeForGrant(
  action: AssistantGrantAction,
  savedMode: ApplicationAutomationMode,
): ApplicationAutomationMode {
  if (action === "prepare") return "prepare_only";
  if (action === "prepare_and_send") return "autonomous_submit";
  return savedMode;
}

/** Narrows a grant to fewer jobs or a weaker action, recording why. */
export function narrowGrant(
  grant: AssistantInstructionGrant,
  change: {
    removeJobIds?: readonly string[];
    action?: AssistantGrantAction;
    revoke?: boolean;
    messageId: string;
    description: string;
    at: string;
  },
): AssistantInstructionGrant {
  const remaining = grant.jobIds.filter(
    (id) => !(change.removeJobIds ?? []).includes(id),
  );
  const weaker =
    change.action === undefined
      ? grant.action
      : strength(change.action) <= strength(grant.action)
        ? change.action
        : grant.action;
  return {
    ...grant,
    jobIds: remaining.length > 0 ? remaining : grant.jobIds,
    action: weaker,
    status: change.revoke || remaining.length === 0 ? "revoked" : "narrowed",
    history: [
      ...grant.history,
      {
        at: change.at,
        messageId: change.messageId,
        change: change.description,
      },
    ].slice(-40),
    updatedAt: change.at,
  };
}

function strength(action: AssistantGrantAction): number {
  return action === "prepare" ? 0 : action === "apply_saved_mode" ? 1 : 2;
}
