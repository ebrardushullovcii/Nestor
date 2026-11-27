import {
  aiAccessStatus,
  letAiCallsThroughNow,
  onAiAccessChange,
  onAiAccessRecheck,
  onAiAccessRefused,
  type AiAccessBlock,
  type AiAccessStatus,
} from "@nestor/ai-providers";

/**
 * What work that waits on the AI account hears about it: whether calls go
 * through, when that changes, each refused call, and the periodic check
 * while it refuses.
 */
export interface AiAccessWatch {
  status(): AiAccessStatus;
  onChange(listener: (status: AiAccessStatus) => void): () => void;
  /** Every refused call, before its caller hears it. */
  onRefused(listener: (block: AiAccessBlock) => void): () => void;
  /** Return true when the check started one item of waiting work again. */
  onRecheck(recheck: () => boolean): () => void;
  /** The person started work again: its calls reach the service now. */
  letCallsThrough(): void;
}

/** The app's own: every model call reports to it. */
export const APP_AI_ACCESS: AiAccessWatch = {
  status: aiAccessStatus,
  onChange: onAiAccessChange,
  onRefused: onAiAccessRefused,
  onRecheck: onAiAccessRecheck,
  letCallsThrough: letAiCallsThroughNow,
};
