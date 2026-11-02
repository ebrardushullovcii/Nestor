import type { JobStage } from "@nestor/contracts";

import { cn } from "@renderer/lib/cn";

import { describeFit, type FitLevel } from "./job-format";

const METER_STEPS = [1, 2, 3, 4] as const;

/**
 * Four marks, filled from the left: ●●●● strong, ●●●○ good, ●●○○ stretch,
 * ●○○○ weak. A filled mark is a pine dot and an empty one a ring, so the
 * step reads by shape and count in grayscale, never by hue.
 */
export function FitMeter(props: { level: FitLevel; size?: "row" | "detail" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center",
        props.size === "detail" ? "gap-1" : "gap-0.5",
      )}
      data-fit-meter={props.level}
    >
      {METER_STEPS.map((step) => (
        <span
          className={cn(
            "block shrink-0 rounded-full",
            props.size === "detail" ? "size-2.5" : "size-2",
            step <= props.level
              ? "bg-(--fit-meter)"
              : "ring-1 ring-(--fit-meter-empty) ring-inset",
          )}
          key={step}
        />
      ))}
    </span>
  );
}

/**
 * The one way a fit is shown, in a row and in the details: the score, the
 * meter and one label form ("Strong fit", "Good fit", "Stretch fit", "Weak
 * fit", "Not scored yet"). `labelClassName` lets a narrow row keep the label
 * for assistive tech only; the score and the meter still carry the step.
 */
export function Fit(props: {
  score: number | null;
  stage?: JobStage;
  size?: "row" | "detail";
  className?: string;
  labelClassName?: string;
}) {
  const fit = describeFit(props.score, props.stage);
  const detail = props.size === "detail";
  if (props.score === null)
    return (
      <span
        className={cn(
          "inline-flex items-center whitespace-nowrap text-(length:--text-small) text-foreground-muted",
          props.className,
        )}
        data-fit="unscored"
        title="Fit is checked in the background; this job has no score yet."
      >
        {fit.label}
      </span>
    );
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap",
        detail ? "gap-2" : "gap-1.5",
        props.className,
      )}
      data-fit={fit.level}
      title={`Fit ${props.score} of 100: ${fit.label}`}
    >
      <span
        className={cn(
          "font-semibold tabular-nums text-(--text-headline)",
          detail
            ? "text-(length:--text-heading-3)"
            : "text-(length:--text-small)",
        )}
      >
        {props.score}
      </span>
      {/* Heard as "92, Strong fit", not "92Strong fit". */}
      <span className="sr-only">, </span>
      <FitMeter level={fit.level} size={props.size ?? "row"} />
      <span
        className={cn(
          "text-foreground-soft",
          detail
            ? "text-(length:--text-description) font-medium"
            : "text-(length:--text-small)",
          props.labelClassName,
        )}
      >
        {fit.label}
      </span>
    </span>
  );
}
