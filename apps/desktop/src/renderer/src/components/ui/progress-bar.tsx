import { useMemo, type CSSProperties } from 'react'

/**
 * The empty meter has to read as a meter.
 *
 * The track fill measured 1.12:1 (dark) / 1.28:1 (light) against the card it
 * renders on, so a 0%-complete bar read as "no bar". Raising the fill itself to
 * 3:1 is arithmetically impossible while keeping the fill/track separation: the
 * card, an accessible track and the --primary fill cannot all sit 3:1 apart on
 * one luminance axis (both pairs top out at 2.59:1). The track therefore keeps
 * its recessed fill and gains a boundary on the published control token, which
 * clears 3:1 against the track (4.48 dark / 3.03 light) and against the card
 * (3.99 / 3.88). Pinned by styles/globals.test.ts.
 */
const PROGRESS_TRACK_CLASS_NAME =
  'h-2 w-full rounded-full bg-(--surface-progress-track) shadow-[inset_0_0_0_1px_var(--control-border)]'

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }

  return Math.max(0, Math.min(100, value))
}

interface ProgressBarProps {
  ariaLabel?: string
  className?: string
  /**
   * Omit a percentage the operation cannot substantiate. An indeterminate bar
   * reports "still working" without asserting a completion fraction, and drops
   * `aria-valuenow` so assistive tech is told the same thing the eye is.
   */
  indeterminate?: boolean
  percent?: number | null | undefined
}

export function ProgressBar({
  ariaLabel = 'Progress',
  className,
  indeterminate = false,
  percent,
}: ProgressBarProps) {
  const clampedPercent = clampPercent(percent ?? 0)
  const style = useMemo(
    () => ({ ['--progress-width' as const]: `${clampedPercent}%` }) as CSSProperties,
    [clampedPercent],
  )

  if (indeterminate) {
    return (
      <div
        aria-label={ariaLabel}
        aria-valuemax={100}
        aria-valuemin={0}
        className={className ?? PROGRESS_TRACK_CLASS_NAME}
        data-progress-indeterminate
        role="progressbar"
      >
        <div className="h-full w-2/5 rounded-full bg-primary/70 motion-safe:animate-pulse-brief" />
      </div>
    )
  }

  return (
    <div
      aria-label={ariaLabel}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={clampedPercent}
      className={className ?? PROGRESS_TRACK_CLASS_NAME}
      role="progressbar"
    >
      <div className="progress-fill h-full bg-primary-fill shadow-(--progress-active-glow)" style={style} />
    </div>
  )
}
