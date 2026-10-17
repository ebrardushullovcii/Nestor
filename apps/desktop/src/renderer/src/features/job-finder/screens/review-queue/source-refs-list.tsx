import type { ResumeDraftSourceRef } from "@nestor/contracts";

function formatSourceKindLabel(value: string): string {
  switch (value) {
    case "resume":
      return "Imported resume";
    case "profile":
      return "Profile";
    case "proof":
      return "Proof";
    case "job":
      return "Job details";
    case "research":
      return "Saved research";
    case "user":
      return "Your edit";
    default:
      return value
        .replaceAll("_", " ")
        .replace(/\b\w/g, (match) => match.toUpperCase());
  }
}

export function SourceRefsList(props: {
  emptyLabel?: string;
  sourceRefs: readonly ResumeDraftSourceRef[];
  variant?: "compact" | "default";
}) {
  const isCompact = props.variant === "compact";

  if (props.sourceRefs.length === 0) {
    return (
      <p className="text-sm text-foreground-soft">
        {props.emptyLabel ?? "No supporting evidence linked yet."}
      </p>
    );
  }

  return (
    <ul className="grid gap-2">
      {props.sourceRefs.map((ref) => (
        <li
          key={ref.id}
          className={
            isCompact
              ? "rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) px-2 py-1.5 text-xs leading-5 text-foreground-soft"
              : "rounded-(--radius-field) border border-(--surface-panel-border) bg-(--surface-panel) p-3 text-sm text-foreground-soft"
          }
        >
          <p
            className={
              isCompact
                ? "mb-0.5 text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground"
                : "mb-1 text-(length:--text-tiny) uppercase tracking-(--tracking-caps) text-muted-foreground"
            }
          >
            {formatSourceKindLabel(ref.sourceKind)}
          </p>
          {/* The compact variant is the evidence shown beside a proposal's
              Accept control. It used to clamp to three lines, so the excerpt
              the user was asked to accept ended mid-sentence in an ellipsis
              with nothing to expand. Evidence excerpts are short by
              construction, so they are simply rendered in full. */}
          <p className="whitespace-pre-wrap break-words">
            {ref.snippet ?? "No excerpt saved."}
          </p>
        </li>
      ))}
    </ul>
  );
}
