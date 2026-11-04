import type { ActionNeeded } from "./action-needed";

/**
 * The handoff's lead line: plain body text, its label in bold so it is the
 * first thing read. One paragraph that wraps; no banner, no new colour.
 */
export function ActionNeededLine(props: { line: ActionNeeded }) {
  const { line } = props;
  return (
    <p
      className="max-w-prose text-sm break-words text-foreground"
      data-action-needed
    >
      <span className="font-semibold">ACTION NEEDED — {line.site}:</span>{" "}
      {line.action}
      {line.done === null ? null : (
        <>
          {" "}
          <span className="font-medium">Done so far:</span> {line.done}
        </>
      )}
      {line.sent === null ? null : (
        <>
          {" "}
          <span className="font-medium">Sent:</span> {line.sent}
        </>
      )}
    </p>
  );
}
