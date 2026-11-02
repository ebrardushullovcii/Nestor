import { ListReadError } from "@renderer/features/job-lists";

/**
 * A screen whose content is already shown (Profile, Settings) when a later
 * read or save fails: one line above the page that says what failed and
 * what is kept, with Try again for a read. The fields and any typing stay.
 */
export function ScreenReadWarning(props: {
  /** What could not be read, e.g. "Your profile". */
  what: string;
  readError: string | null;
  /** A refused save, said in the store's words, with no retry here. */
  saveError?: string | null;
  onRetry: () => void;
}) {
  if (props.readError)
    return (
      <div
        className="mb-3 overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) [&>[data-list-read-error]]:border-b-0"
        data-screen-read-warning
      >
        <ListReadError
          error={props.readError}
          inline
          inlineText={`Couldn’t read the latest of ${props.what.toLowerCase()}. What you see, and anything you were typing, is kept.`}
          onRetry={props.onRetry}
          what={props.what}
        />
      </div>
    );
  if (!props.saveError) return null;
  return (
    <p
      className="mb-3 rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--warning-surface) px-3 py-2 text-(length:--text-small) text-foreground"
      data-screen-save-warning
      role="alert"
    >
      {props.saveError}
    </p>
  );
}
