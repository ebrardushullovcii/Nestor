export type ModelTurnStreamEvent =
  | { type: "attempt_started"; attempt: number }
  | { type: "provider_wait"; delayMs: number }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_started"; index: number; name: string }
  | { type: "tool_call_delta"; index: number };

export const DEFAULT_MODEL_IDLE_TIMEOUT_MS = 180_000;

export class ModelTurnTimeoutError extends Error {
  constructor(readonly kind: "idle") {
    super("The AI connection stopped responding. Try again to continue.");
    this.name = "ModelTurnTimeoutError";
  }
}

/** A live stream may run indefinitely; silence and Stop still end the wait. */
export async function runModelTurn<T>(
  call: (options: {
    signal: AbortSignal;
    onStreamEvent: (event: ModelTurnStreamEvent) => void;
  }) => Promise<T>,
  options: {
    signal?: AbortSignal | undefined;
    idleTimeoutMs?: number | undefined;
    onStreamEvent?: ((event: ModelTurnStreamEvent) => void) | undefined;
  },
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort: (() => void) | undefined;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MODEL_IDLE_TIMEOUT_MS;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    if (!controller.signal.aborted && Number.isFinite(idleTimeoutMs))
      idleTimer = setTimeout(
        () => controller.abort(new ModelTurnTimeoutError("idle")),
        Math.max(1, idleTimeoutMs),
      );
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    controller.signal.throwIfAborted();
    resetIdle();
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => {
        const reason: unknown = controller.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new DOMException("Aborted", "AbortError"),
        );
      };
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    });
    return await Promise.race([
      call({
        signal: controller.signal,
        onStreamEvent: (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "provider_wait") clearTimeout(idleTimer);
          else resetIdle();
          options.onStreamEvent?.(event);
        },
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", cancel);
    if (rejectAbort)
      controller.signal.removeEventListener("abort", rejectAbort);
  }
}
