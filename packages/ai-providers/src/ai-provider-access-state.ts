import { createHash } from "node:crypto";

/**
 * Whether the AI account behind Nestor's model calls lets them through.
 *
 * A 402 (out of credit), 401 (key not accepted) or 403 (no access to the
 * model) is a step only the account holder can take, so it reaches the
 * person once, in Needs you, with the provider's own words and link. Work
 * that failed for it waits here and is picked up again when a later call
 * succeeds. An outage (429, 5xx, a timeout) is not an access failure and
 * stays an ordinary retry.
 */
export type AiAccessReason = "funding" | "authentication" | "permission";

export interface AiAccessBlock {
  /** Stable for one endpoint and key; never the key itself. */
  readonly id: string;
  /** The AI service's origin, for example `https://opencode.ai`. */
  readonly provider: string;
  readonly reason: AiAccessReason;
  /** What failed work records: plain, and the same for every call. */
  readonly message: string;
  /** The service's own words, when it gave any. */
  readonly providerMessage: string | null;
  /** The first web link in the service's words: its top-up or key page. */
  readonly actionUrl: string | null;
  readonly since: string;
}

export type AiAccessStatus = "unknown" | "available" | "blocked";

/** What happened and the step only the account holder can take. */
export const AI_ACCESS_STEPS: Readonly<Record<AiAccessReason, string>> = {
  funding:
    "Your AI account has run out of credit, so the AI could not do this and nothing was changed. Top it up from Needs you.",
  authentication:
    "The AI service did not accept Nestor's API key, so the AI could not do this and nothing was changed. Fix the key from Needs you.",
  permission:
    "The AI service refused this API key access to the model, so the AI could not do this and nothing was changed. Give the key access from Needs you.",
};

/** The sentence failed work records for each reason. */
export const AI_ACCESS_MESSAGES: Readonly<Record<AiAccessReason, string>> = {
  funding: `${AI_ACCESS_STEPS.funding} Nestor picks this up again by itself once the AI answers.`,
  authentication: `${AI_ACCESS_STEPS.authentication} Nestor picks this up again by itself once the AI answers.`,
  permission: `${AI_ACCESS_STEPS.permission} Nestor picks this up again by itself once the AI answers.`,
};

/**
 * What earlier versions recorded for the same failures. Work saved with it
 * is still waiting on the account and is picked up the same way.
 */
const EARLIER_ACCESS_MESSAGES = [
  "The AI service is unavailable right now. Nothing was changed. Try again after the service is restored.",
];

/** True when failed work recorded an AI account failure, now or earlier. */
export function isAiProviderAccessMessage(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  const value = text.trim();
  return (
    Object.values(AI_ACCESS_MESSAGES).includes(value) ||
    EARLIER_ACCESS_MESSAGES.includes(value)
  );
}

/**
 * The service's words for an account with no credit or allowance left.
 * These are account refusals, not a busy provider: the transport does not
 * retry them, and they are the funding step whatever status carried them
 * (some services send 401 or 429 for an empty balance).
 */
export const ACCOUNT_REFUSAL_PATTERN =
  /insufficient[_ ](?:quota|balance|credits?|funds)|(?:plan|monthly quota|account quota|allowance|credits|balance).{0,80}(?:exhausted|used up|insufficient)|(?:exhausted|used up).{0,80}(?:plan|allowance|credits)|quota.{0,80}next month|credit balance is too low/i;

/** How a status and the service's words read as an account failure, or null. */
export function describeAiAccessFailure(
  status: number,
  providerMessage: string,
): Omit<AiAccessBlock, "id" | "provider" | "since"> | null {
  const outOfCredit = ACCOUNT_REFUSAL_PATTERN.test(providerMessage);
  const reason: AiAccessReason | null =
    status === 402 ||
    ((status === 401 || status === 403 || status === 429) && outOfCredit)
      ? "funding"
      : status === 401
        ? "authentication"
        : status === 403
          ? "permission"
          : null;
  if (!reason) return null;
  const words = providerWords(providerMessage);
  return {
    reason,
    message: AI_ACCESS_MESSAGES[reason],
    providerMessage: words,
    actionUrl: words ? firstWebLink(words) : null,
  };
}

function providerWords(message: string): string | null {
  const text = message.replace(/^\[insufficient_quota\]\s*/u, "").trim();
  // The transport's own sentence when the service sent no words.
  if (!text || /^Model request failed with status \d+$/u.test(text))
    return null;
  return text.length > 2_000 ? `${text.slice(0, 1_999)}…` : text;
}

function firstWebLink(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
    const candidate = match[0].replace(/[).,;:!?\]]+$/u, "");
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" || url.protocol === "http:")
        return url.href;
    } catch {
      // Not a link after all; look for the next one.
    }
  }
  return null;
}

/** How long a refused account waits between checks when nothing else calls. */
export const AI_ACCESS_RECHECK_MS = 5 * 60_000;

type Listener = (status: AiAccessStatus) => void;
type Recheck = () => boolean;
type RefusalListener = (block: AiAccessBlock) => void;

let status: AiAccessStatus = "unknown";
const blocks = new Map<string, AiAccessBlock & { retryAt: number }>();
const listeners = new Set<Listener>();
const refusalListeners = new Set<RefusalListener>();
const rechecks: Recheck[] = [];
let lastAttemptAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener(status);
    } catch {
      /* One listener's failure never stops the others hearing it. */
    }
  }
}

/** A refusal as callers see it, without the transport's own timing. */
function publicBlock(block: AiAccessBlock): AiAccessBlock {
  return {
    id: block.id,
    provider: block.provider,
    reason: block.reason,
    message: block.message,
    providerMessage: block.providerMessage,
    actionUrl: block.actionUrl,
    since: block.since,
  };
}

function blockId(credentials: string): string {
  return createHash("sha256").update(credentials).digest("hex").slice(0, 16);
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  // Nothing waits on the account: nothing to check.
  if (status !== "blocked" || rechecks.length === 0) return;
  const earliestRetry = Math.min(
    ...[...blocks.values()].map((block) => block.retryAt),
  );
  const at = Math.max(
    earliestRetry + 1_000,
    lastAttemptAt + AI_ACCESS_RECHECK_MS,
    Date.now() + 1_000,
  );
  timer = setTimeout(() => {
    timer = null;
    runAiAccessRechecks();
  }, at - Date.now());
  timer.unref?.();
}

/**
 * Asks the work that waits on the account to try one item again. The first
 * one that starts something is the check; its success or refusal says the
 * rest.
 */
export function runAiAccessRechecks(): boolean {
  lastAttemptAt = Date.now();
  let started = false;
  for (const recheck of [...rechecks]) {
    try {
      if (recheck()) {
        started = true;
        break;
      }
    } catch {
      /* A failing check hands over to the next one. */
    }
  }
  schedule();
  return started;
}

/** A model call the account refused. `retryAt` is when the transport tries it again. */
export function noteAiProviderAccessFailure(input: {
  credentials: string;
  provider: string;
  status: number;
  providerMessage: string;
  retryAt: number;
}): void {
  const failure = describeAiAccessFailure(input.status, input.providerMessage);
  if (!failure) return;
  const existing = blocks.get(input.credentials);
  const next = {
    id: blockId(input.credentials),
    provider: input.provider,
    ...failure,
    // A refusal answered from the transport's memory carries no new words.
    providerMessage:
      failure.providerMessage ?? existing?.providerMessage ?? null,
    actionUrl: failure.providerMessage
      ? failure.actionUrl
      : (existing?.actionUrl ?? null),
    since: existing?.since ?? new Date().toISOString(),
    retryAt: Math.max(input.retryAt, existing?.retryAt ?? 0),
  };
  const changed =
    status !== "blocked" ||
    !existing ||
    existing.reason !== next.reason ||
    existing.providerMessage !== next.providerMessage;
  if (!existing || input.retryAt > existing.retryAt)
    lastAttemptAt = Math.max(lastAttemptAt, Date.now());
  blocks.set(input.credentials, next);
  status = "blocked";
  schedule();
  if (changed) emit();
  // Every refusal, before the caller hears it: work that leases more
  // (a search) stops taking new items at the first one.
  const block = publicBlock(next);
  for (const listener of [...refusalListeners]) {
    try {
      listener({ ...block });
    } catch {
      /* One listener's failure never stops the others hearing it. */
    }
  }
}

/** A model call that went through: the account behind it lets calls through. */
export function noteAiProviderRequestSucceeded(credentials: string): void {
  const hadBlock = blocks.delete(credentials);
  if (blocks.size > 0) {
    if (hadBlock) emit();
    return;
  }
  if (status === "available") return;
  status = "available";
  schedule();
  emit();
}

export function aiAccessStatus(): AiAccessStatus {
  return status;
}

/** The accounts refusing calls now, oldest first. */
export function aiAccessBlocks(): AiAccessBlock[] {
  return [...blocks.values()]
    .sort((a, b) => a.since.localeCompare(b.since))
    .map(publicBlock);
}

/** Hears every change of status, and changes to the refusals while blocked. */
export function onAiAccessChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Hears every refused call, synchronously, before its caller does. */
export function onAiAccessRefused(listener: RefusalListener): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/**
 * Registers waiting work for the periodic check while the account refuses
 * calls: return true when it started one item again.
 */
export function onAiAccessRecheck(recheck: Recheck): () => void {
  rechecks.push(recheck);
  schedule();
  return () => {
    const index = rechecks.indexOf(recheck);
    if (index >= 0) rechecks.splice(index, 1);
    schedule();
  };
}

/** Test seam: forget what calls reported. */
export function resetAiAccessState(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  status = "unknown";
  blocks.clear();
  listeners.clear();
  refusalListeners.clear();
  rechecks.length = 0;
  lastAttemptAt = 0;
}
