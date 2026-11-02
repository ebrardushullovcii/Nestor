import * as React from "react";

import { cn } from "@renderer/lib/utils";

/**
 * The canonical one-of-N inline switcher.
 *
 * Eight hand-rolled tab strips and segmented groups existed before this: the
 * density switcher was written three ways inside a single file, and six route
 * switchers carried six tracks, six radii and six selected channels. This is
 * the one implementation - one track, one height from the published control
 * scale, one radius token, and exactly one selected treatment: a sunken
 * neutral track with a raised white "thumb" under the chosen segment, and a
 * medium-weight label, so the state is carried by shape and elevation, never
 * by hue alone. No underline: underlines belong to page-level Tabs.
 *
 * Each segment is an ordinary `aria-pressed` button rather than a
 * `role="radio"` inside a radiogroup. That is deliberate and settled: the
 * Settings theme switcher shipped as `role="radio"` and UI automation could
 * not click it, so it was converted to `aria-pressed` buttons. Plain buttons
 * also stay individually tabbable, so keyboard users reach every option with
 * Tab and activate with Enter or Space without a roving-tabindex contract.
 * Arrow keys additionally move between segments for pointer-free scanning.
 */
export interface SegmentedControlOption<TValue extends string> {
  readonly value: TValue;
  readonly label: React.ReactNode;
  /** Accessible name when `label` is an icon or an abbreviation. */
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly title?: string;
}

export type SegmentedControlSize = "toolbar" | "field";
/**
 * `segmented` is the in-toolbar choice (sunken track, raised thumb).
 * `tabs` is the page-section switch: the same buttons and keyboard model,
 * drawn as underline tabs on a hairline, matching the `Tabs` primitive.
 */
export type SegmentedControlVariant = "segmented" | "tabs";

const SEGMENTED_CONTROL_TRACK_SIZE_CLASS = {
  toolbar: "h-8",
  field: "h-10",
} as const satisfies Record<SegmentedControlSize, string>;

const SEGMENTED_CONTROL_SEGMENT_SIZE_CLASS = {
  toolbar: "px-2.5 text-(length:--text-small)",
  field: "px-3.5 text-sm",
} as const satisfies Record<SegmentedControlSize, string>;

function SegmentedControl<TValue extends string>({
  className,
  label,
  onValueChange,
  options,
  segmentClassName,
  size = "toolbar",
  value,
  variant = "segmented",
  ...props
}: Omit<React.ComponentProps<"div">, "onChange"> & {
  /** Accessible name for the group. Required: the group is never unlabelled. */
  label: string;
  onValueChange: (value: TValue) => void;
  options: readonly SegmentedControlOption<TValue>[];
  segmentClassName?: string;
  size?: SegmentedControlSize;
  value: TValue;
  variant?: SegmentedControlVariant;
}) {
  const isTabs = variant === "tabs";
  const trackRef = React.useRef<HTMLDivElement | null>(null);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const backward = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !backward) {
        return;
      }

      const track = trackRef.current;
      if (!track) {
        return;
      }

      const segments = [
        ...track.querySelectorAll<HTMLButtonElement>(
          "button[data-slot='segmented-control-segment']:not([disabled])",
        ),
      ];
      if (segments.length < 2) {
        return;
      }

      const activeIndex = segments.indexOf(
        document.activeElement as HTMLButtonElement,
      );
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const nextIndex =
        (activeIndex + (forward ? 1 : -1) + segments.length) % segments.length;
      segments[nextIndex]?.focus();
    },
    [],
  );

  return (
    <div
      aria-label={label}
      className={cn(
        isTabs
          ? "inline-flex h-9 w-fit max-w-full items-stretch gap-1 border-b border-(--border-subtle)"
          : cn(
              "inline-flex w-fit max-w-full items-center gap-0.5 overflow-hidden rounded-(--radius-button) bg-(--segment-track) p-0.5",
              SEGMENTED_CONTROL_TRACK_SIZE_CLASS[size],
            ),
        className,
      )}
      data-size={size}
      data-variant={variant}
      data-slot="segmented-control"
      onKeyDown={handleKeyDown}
      ref={trackRef}
      role="group"
      {...props}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-label={option.ariaLabel}
            aria-pressed={selected}
            className={cn(
              "inline-flex h-full min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-(--duration-fast) outline-none focus-ring",
              isTabs
                ? cn(
                    "-mb-px rounded-none border-b-2 border-transparent px-2.5 text-sm",
                    selected
                      ? "border-b-primary font-medium text-foreground"
                      : "font-normal text-foreground-soft hover:border-b-(--border-strong) hover:text-foreground",
                  )
                : cn(
                    "rounded-(--radius-small) border border-transparent",
                    SEGMENTED_CONTROL_SEGMENT_SIZE_CLASS[size],
                    selected
                      ? "border-(--segment-thumb-border) bg-(--segment-thumb) font-medium text-foreground shadow-sm"
                      : "font-normal text-foreground-soft hover:bg-(--surface-fill-chip) hover:text-foreground active:bg-pressed",
                  ),
              // A disabled segment stays part of its track: no box of its
              // own (each one outlined read as a row of separate buttons),
              // the thumb kept under the chosen one, the words dimmed.
              "disabled:cursor-not-allowed disabled:text-(--disabled-foreground) disabled:opacity-100 disabled:shadow-none disabled:hover:bg-transparent",
              "disabled:data-[state=on]:border-(--disabled-border) disabled:data-[state=on]:bg-(--disabled-surface)",
              segmentClassName,
            )}
            data-slot="segmented-control-segment"
            data-state={selected ? "on" : "off"}
            data-value={option.value}
            disabled={option.disabled}
            key={option.value}
            onClick={() => {
              if (option.disabled || selected) {
                return;
              }

              onValueChange(option.value);
            }}
            title={option.title}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export {
  SegmentedControl,
  SEGMENTED_CONTROL_SEGMENT_SIZE_CLASS,
  SEGMENTED_CONTROL_TRACK_SIZE_CLASS,
};
