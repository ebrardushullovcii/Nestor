import { Button } from "@renderer/components/ui/button";

/** The message under an IPC failure, without Electron's channel prefix. */
export function readErrorText(error: string): string {
  return error.replace(
    /^Error invoking remote method '[^']+': (Error: )?/u,
    "",
  );
}

/**
 * A list that could not be read says so and offers the one way on: read it
 * again, with the tab, filter, sort and ticks kept. With no rows yet it
 * stands where the rows (or the empty message) would be; over loaded rows
 * (more could not be read, or a refresh failed) it is one line above them,
 * so the rows already shown stay usable.
 */
export function ListReadError(props: {
  /** What could not be read, e.g. "Found jobs". */
  what: string;
  error: string;
  onRetry: () => void;
  /** Rows are on screen: a single line instead of the full state. */
  inline?: boolean;
  /** What stays as it was; the list's filter and sort by default. */
  kept?: string | null;
  /** The inline line's words; "the rows below may be out of date" by default. */
  inlineText?: string;
}) {
  const detail = readErrorText(props.error).replace(/[.\s]+$/u, "");
  if (props.inline)
    return (
      <div
        className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--surface-panel-border) bg-(--warning-surface) px-3 py-1.5 text-(length:--text-small) text-foreground"
        data-list-read-error
        role="alert"
      >
        <span className="min-w-0 flex-1">
          {props.inlineText ??
            `Couldn’t read the latest ${props.what.toLowerCase()}. The rows below may be out of date.`}
        </span>
        <Button
          onClick={props.onRetry}
          size="toolbar"
          type="button"
          variant="outline"
        >
          Try again
        </Button>
      </div>
    );
  return (
    <div
      className="grid justify-items-center gap-3 text-center text-(length:--text-description) text-foreground-soft"
      data-list-read-error
      role="alert"
    >
      <p className="font-medium text-foreground">
        Couldn’t read {props.what.toLowerCase()}
      </p>
      <p className="max-w-[60ch]">
        {[
          detail ? `${detail}.` : null,
          "Nothing was changed.",
          props.kept === undefined
            ? "Your filter and sort are kept."
            : props.kept,
        ]
          .filter(Boolean)
          .join(" ")}
      </p>
      <Button onClick={props.onRetry} size="sm" type="button" variant="outline">
        Try again
      </Button>
    </div>
  );
}
