"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@renderer/lib/utils"

function Switch({
  className,
  size = "default",
  style,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  // Calculate dimensions based on size
  const dimensions = React.useMemo(() => {
    const trackWidth = size === "sm" ? 32 : 40 // w-8 or w-10
    const trackHeight = size === "sm" ? 16 : 20 // h-4 or h-5
    const thumbSize = size === "sm" ? 10 : 12 // size-2.5 or size-3
    const padding = 2 // px-[2px]
    const thumbTravel = trackWidth - thumbSize - padding
    
    return {
      '--switch-track-width': `${trackWidth}px`,
      '--switch-track-height': `${trackHeight}px`,
      '--switch-thumb-size': `${thumbSize}px`,
      '--switch-thumb-travel': `${thumbTravel}px`,
    } as React.CSSProperties
  }, [size])

  const switchStyle = React.useMemo(
    () => ({
      ...style,
      ...dimensions,
    }),
    [dimensions, style]
  )

  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      style={switchStyle}
      className={cn(
        // The track is a control boundary, so it carries --control-border
        // rather than --border (the Separator token, which measured 1.60-1.80:1
        // against the fills a switch sits on, and which stays Separator's).
        // The unchecked track keeps the --input fill; the thumb, not the
        // track, is what changes colour with state, because no single thumb
        // colour can clear 3:1 against both an --input track and the --primary
        // one - in dark those two constraints have no overlapping solution.
        // It binds --disabled-foreground too: a switch paints no text of its
        // own, but the token is what any inherited content and the thumb's
        // `currentColor` resolve to, so all three disabled tokens are bound
        // here rather than two of three with an implicit exception.
        "peer group/switch inline-flex shrink-0 items-center rounded-none border border-(--control-border) bg-input transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-(--disabled-border) disabled:bg-(--disabled-surface) disabled:text-(--disabled-foreground)",
        "h-(--switch-track-height) w-(--switch-track-width)",
        "data-[state=checked]:bg-primary-fill data-[state=unchecked]:bg-input",
        "disabled:data-[state=checked]:bg-(--disabled-surface) disabled:data-[state=unchecked]:bg-(--disabled-surface)",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // The thumb takes the foreground of whichever fill is under it, so
          // it clears 3:1 against BOTH track states. As --background it
          // measured 1.79:1 (dark) / 2.20:1 against the unchecked track: the
          // control's own parts were not separable even though the two track
          // states were.
          "pointer-events-none block rounded-none bg-(--foreground-soft) ring-0 transition-transform",
          "data-[state=checked]:bg-primary-fill-foreground",
          // A disabled track has no fill, so the thumb takes the disabled
          // boundary colour: it stays the visible carrier of on/off instead of
          // disappearing into the surface behind the emptied track.
          "group-disabled/switch:bg-(--disabled-border)",
          "size-(--switch-thumb-size)",
          "data-[state=checked]:translate-x-(--switch-thumb-travel)",
          "data-[state=unchecked]:translate-x-[2px]",
          "my-auto"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
