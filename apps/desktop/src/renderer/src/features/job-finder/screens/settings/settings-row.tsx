import type { ReactNode } from "react";

import { cn } from "@renderer/lib/cn";

/**
 * The one measure inside a settings card: a row's text (70ch), its gap and a
 * field-wide control (16rem). Choice cards and inline switch rows end here
 * too, so every card has one right edge for its controls; only the template
 * gallery, a picture, takes the card's width.
 */
export const SETTINGS_MEASURE_CLASS = "max-w-[calc(70ch+1.5rem+16rem)]";

/**
 * One settings row, the same shape as the switch rows: what it is and why on
 * the left at a reading measure (about 70 characters), the control right
 * after it, and one hairline between rows. Wraps the control under the text when
 * the pane is too narrow for both.
 */
export function SettingsRow(props: {
  label: ReactNode;
  labelId?: string;
  description?: ReactNode;
  /** Below the description: what the current choice means, or a warning. */
  footer?: ReactNode;
  control: ReactNode;
  className?: string;
  id?: string;
  tabIndex?: number;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 gap-x-6 gap-y-2 border-t border-(--surface-panel-border) py-3 first:border-t-0 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,70ch)_auto] md:items-start md:justify-start",
        props.className,
      )}
      data-settings-row
      id={props.id}
      tabIndex={props.tabIndex}
    >
      <div className="grid min-w-0 max-w-[70ch] gap-0.5">
        <h4
          className="text-(length:--text-body) font-medium leading-5 text-foreground"
          id={props.labelId}
        >
          {props.label}
        </h4>
        {props.description ? (
          <div className="text-(length:--text-small) leading-5 text-foreground-soft">
            {props.description}
          </div>
        ) : null}
        {props.footer ? (
          <div className="mt-1 grid gap-2">{props.footer}</div>
        ) : null}
      </div>
      {/* At the end of the text's measure, like the switch rows: never
          across a wide empty middle at the pane's far edge. */}
      <div className="min-w-0">{props.control}</div>
    </div>
  );
}
