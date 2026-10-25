import { Chip } from "@renderer/components/ui/chip";

interface PreferenceListProps {
  compact?: boolean;
  label: string;
  /**
   * `chips` suits short tokens (sources, skills). `sentences` renders full
   * sentences as a sentence-case bulleted list, because uppercase mono chips
   * make a whole sentence hard to read.
   */
  presentation?: "chips" | "sentences";
  values: readonly string[];
}

export function PreferenceList({
  compact = false,
  label,
  presentation = "chips",
  values,
}: PreferenceListProps) {
  return (
    <div className="grid gap-3">
      <p className="text-(length:--text-field-label) font-medium tracking-(--tracking-label) text-muted-foreground">
        {label}
      </p>
      {values.length > 0 ? (
        presentation === "sentences" ? (
          <ul className="m-0 grid min-w-0 gap-1.5 pl-5 text-(length:--text-small) leading-6 text-foreground-soft">
            {values.map((value) => (
              <li className="break-words" key={value}>
                {value}
              </li>
            ))}
          </ul>
        ) : (
          <div
            className={
              compact ? "flex flex-wrap gap-1.5" : "flex flex-wrap gap-2"
            }
          >
            {values.map((value) => (
              <Chip key={value}>{value}</Chip>
            ))}
          </div>
        )
      ) : (
        <p className="font-mono text-(length:--text-tiny) uppercase tracking-(--tracking-chip) text-muted-foreground">
          No values configured.
        </p>
      )}
    </div>
  );
}
