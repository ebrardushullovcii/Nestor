import type { ApplyQueue } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";

import {
  describeApplyQueue,
  type ApplyQueueControlAction,
  type ApplyQueueResult,
  type ApplyQueueViewButton,
} from "../lib/apply-queue-view";

/**
 * The Apply queue in one line with its two controls (ADR 0058): what it is
 * doing, Pause or Continue (or Raise the limit while it waits for
 * tomorrow), and Stop. A finished queue offers Dismiss.
 */
export function ApplyQueueStrip(props: {
  queue: ApplyQueue | null | undefined;
  dailyLimit: number | null;
  results?: readonly ApplyQueueResult[] | null;
  pending?: boolean;
  onControl: (action: ApplyQueueControlAction) => void;
  onRaiseLimit: () => void;
}) {
  const view = describeApplyQueue(props.queue, {
    dailyLimit: props.dailyLimit,
    results: props.results ?? null,
  });
  if (!view) return null;
  const press = (button: ApplyQueueViewButton) =>
    button.action === "raise_limit"
      ? props.onRaiseLimit()
      : props.onControl(button.action);
  return (
    <section
      aria-label="Apply queue"
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-4 py-2.5"
      data-testid="apply-queue-strip"
    >
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-sm font-medium text-(--text-headline)">
          <span
            aria-hidden="true"
            className={cn(
              "mr-2 inline-block size-2 rounded-full align-middle",
              view.active ? "animate-pulse bg-primary" : "bg-foreground-muted",
            )}
          />
          {view.title}
        </p>
        <p className="min-w-0 break-words text-xs text-foreground-muted">
          {view.detail}
        </p>
        {props.queue?.skipped.length ? (
          <details className="mt-1 text-xs text-foreground-muted">
            <summary className="cursor-pointer">See jobs not applied</summary>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {props.queue.skipped.map((entry) => (
                <li className="break-words" key={entry.jobId}>
                  {entry.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {view.primary ? (
          <Button
            disabled={props.pending}
            onClick={() => view.primary && press(view.primary)}
            size="xs"
            type="button"
            variant="outline"
          >
            {view.primary.label}
          </Button>
        ) : null}
        {view.secondary ? (
          <Button
            disabled={props.pending}
            onClick={() => view.secondary && press(view.secondary)}
            size="xs"
            type="button"
            variant="ghost"
          >
            {view.secondary.label}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
