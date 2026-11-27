import { useAiAccountRefusals } from "./use-ai-account-needs";

/**
 * Nestor's bundled AI key is refused: nothing for the person to do. Work
 * that needs the AI waits with its queue kept and continues by itself.
 */
export function AiServicePausedLine() {
  const paused = useAiAccountRefusals().some(
    (refusal) => refusal.owner === "nestor",
  );
  if (!paused) return null;
  return (
    <p
      className="rounded-(--radius-panel) border border-(--surface-panel-border) px-3 py-2 text-sm text-foreground-soft"
      data-ai-service-paused
      role="status"
    >
      Nestor&apos;s AI service is paused. Your work continues by itself when it
      is back.
    </p>
  );
}
