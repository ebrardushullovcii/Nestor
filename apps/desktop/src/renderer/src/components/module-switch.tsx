import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Briefcase, Check, ChevronDown, MessageSquareText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { suiteModules } from "@nestor/contracts";
import type { SuiteModule } from "@nestor/contracts";

import { Popover } from "@renderer/components/ui/popover";
import type { PopoverPlacement } from "@renderer/components/ui/popover";
import { cn } from "@renderer/lib/cn";

/**
 * The one control that switches between the two product modules.
 *
 * Where it lives and why: a person is inside one module at a time, the way
 * they are inside one workspace in a chat app. The module therefore reads as
 * the caption under the wordmark ("JOB FINDER"), and that caption is the
 * switch. Pressing it opens a short menu naming both modules with the current
 * one checked. This spends one line of the sidebar, never shortens a module
 * name (only the active name is printed; the other waits in the menu), and
 * leaves the top bar to its utilities.
 *
 * Earlier shapes tried in this repo, and why they lost: text labels centred
 * between the brand and the utilities in the top bar drifted with whatever
 * sat beside them; a two-option segmented control in the sidebar either
 * truncated "Live Assistant" side by side or spent two full rows stacked and
 * read as a second navigation list above the real one.
 *
 * Semantics: the trigger is a plain button with `aria-haspopup="menu"` and
 * `aria-expanded`; the menu items are buttons with `role="menuitemradio"` and
 * `aria-checked`, so a screen reader hears "Job Finder, checked" and "Open
 * Live Assistant". Plain buttons keep the settled decision recorded on
 * `components/ui/segmented-control` (radio/tab roles broke UI automation).
 * Keyboard: Enter, Space or ArrowDown opens and focuses the first item; arrows
 * cycle; Escape closes and returns focus to the trigger; Tab away closes.
 *
 * Variants: `caption` (default; the small-caps module name plus a chevron) for
 * the expanded sidebar, the compact destination card and the Live Assistant
 * brand block; `rail` for the 4rem collapsed rail, where only the module icon
 * and chevron fit and the name lives in the tooltip. `row` and `stacked` are
 * accepted as aliases of `caption` so existing call sites keep working.
 */
export const MODULE_SWITCH_LABELS = {
  "job-finder": "Job Finder",
  "live-assistant": "Live Assistant",
} as const satisfies Record<SuiteModule, string>;

const MODULE_SWITCH_ICONS = {
  "job-finder": Briefcase,
  "live-assistant": MessageSquareText,
} as const satisfies Record<SuiteModule, LucideIcon>;

export type ModuleSwitchVariant = "caption" | "rail" | "row" | "stacked";

/** Accessible name: the current module states itself, the other one offers. */
export function getModuleSwitchAccessibleName(
  moduleName: SuiteModule,
  selected: boolean,
): string {
  return selected
    ? MODULE_SWITCH_LABELS[moduleName]
    : `Open ${MODULE_SWITCH_LABELS[moduleName]}`;
}

/** The trigger's accessible name says what it is and what it does. */
export function getModuleSwitchTriggerName(activeModule: SuiteModule): string {
  return `${MODULE_SWITCH_LABELS[activeModule]}, switch module`;
}

const MODULE_SWITCH_MENU_MIN_WIDTH = 200;

/**
 * The caption trigger: the wordmark's small-caps caption with a chevron. It
 * paints no box at rest so it reads as the caption it replaces; hover and
 * focus lift it the way the sidebar's own quiet controls lift.
 */
export const MODULE_SWITCH_TRIGGER_CLASS =
  "group/module inline-flex h-5 max-w-full items-center gap-1 rounded-(--radius-button) border border-transparent px-1 -mx-1 text-left outline-none transition-colors hover:bg-secondary/50 focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:bg-secondary/60";
export const MODULE_SWITCH_CAPTION_CLASS =
  "min-w-0 whitespace-nowrap text-[0.72rem] font-semibold uppercase leading-none tracking-(--tracking-caps) text-foreground sm:text-[0.78rem]";
export const MODULE_SWITCH_CHEVRON_CLASS =
  "size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/module:rotate-180";
/** The 4rem rail: icon plus chevron, centred, name in the tooltip. */
export const MODULE_SWITCH_RAIL_TRIGGER_CLASS =
  "group/module inline-flex h-9 w-full items-center justify-center gap-0.5 rounded-(--radius-button) border border-transparent outline-none transition-colors hover:bg-secondary/50 focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:bg-secondary/60";
export const MODULE_SWITCH_MENU_CLASS = "p-1";
export const MODULE_SWITCH_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-(--radius-button) px-2 py-1.5 text-left text-(length:--text-small) outline-none transition-colors hover:bg-secondary/60 focus-visible:bg-secondary/60";
export const MODULE_SWITCH_ITEM_ACTIVE_CLASS = "font-semibold text-foreground";
export const MODULE_SWITCH_ITEM_INACTIVE_CLASS = "text-foreground";

export interface ModuleSwitchProps {
  activeModule: SuiteModule;
  className?: string;
  /** Kept for call-site compatibility; the caption never hides its label. */
  labelClassName?: string;
  onSelectModule: (moduleName: SuiteModule) => void;
  /** Kept for call-site compatibility; icons are decided by the variant. */
  showIcons?: boolean;
  style?: CSSProperties;
  variant?: ModuleSwitchVariant;
}

function placementFor(trigger: HTMLElement): PopoverPlacement {
  const rect = trigger.getBoundingClientRect();
  const minWidth = Math.max(
    MODULE_SWITCH_MENU_MIN_WIDTH,
    Math.round(rect.width),
  );
  const viewportWidth =
    typeof window === "undefined" ? minWidth : window.innerWidth;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - minWidth - 8));
  return { top: rect.bottom + 10, left, minWidth, maxHeight: 240 };
}

export function ModuleSwitch({
  activeModule,
  className,
  onSelectModule,
  style,
  variant = "caption",
}: ModuleSwitchProps) {
  const isRail = variant === "rail";
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const menuId = useId();
  const ActiveIcon = MODULE_SWITCH_ICONS[activeModule];

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    setPlacement(placementFor(trigger));
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const first = menuRef.current?.querySelector<HTMLButtonElement>(
      "button[data-module-switch-option]",
    );
    first?.focus();

    const onPointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (!open) {
          openMenu();
        }
      }
    },
    [open, openMenu],
  );

  const handleMenuKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key === "Tab") {
        setOpen(false);
        return;
      }
      const forward = event.key === "ArrowDown";
      const backward = event.key === "ArrowUp";
      if (!forward && !backward) {
        return;
      }
      const items = [
        ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
          "button[data-module-switch-option]",
        ) ?? []),
      ];
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      const next =
        index === -1
          ? 0
          : (index + (forward ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    },
    [close],
  );

  const handleSelect = useCallback(
    (moduleName: SuiteModule) => {
      close(moduleName === activeModule);
      if (moduleName !== activeModule) {
        onSelectModule(moduleName);
      }
    },
    [activeModule, close, onSelectModule],
  );

  const stopMenuMouseDown = useCallback((event: MouseEvent) => {
    // Keep focus on the trigger/menu so the outside-click listener does not
    // read a click on an item as a click outside.
    event.stopPropagation();
  }, []);

  return (
    <div
      aria-label="Nestor modules"
      className={cn("min-w-0", className)}
      data-desktop-module-navigation
      data-module-switch-variant={isRail ? "rail" : "caption"}
      role="group"
      style={style}
    >
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={getModuleSwitchTriggerName(activeModule)}
        className={
          isRail
            ? MODULE_SWITCH_RAIL_TRIGGER_CLASS
            : MODULE_SWITCH_TRIGGER_CLASS
        }
        data-module-switch-trigger
        data-state={open ? "open" : "closed"}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        title={`${MODULE_SWITCH_LABELS[activeModule]} · switch module`}
        type="button"
      >
        {isRail ? (
          <ActiveIcon aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <span className={MODULE_SWITCH_CAPTION_CLASS}>
            {MODULE_SWITCH_LABELS[activeModule]}
          </span>
        )}
        <ChevronDown
          aria-hidden="true"
          className={MODULE_SWITCH_CHEVRON_CLASS}
        />
      </button>
      {placement ? (
        <Popover
          className={MODULE_SWITCH_MENU_CLASS}
          id={menuId}
          label="Switch module"
          onKeyDown={handleMenuKeyDown}
          onMouseDown={stopMenuMouseDown}
          open={open}
          placement={placement}
          ref={menuRef}
          role="menu"
        >
          {suiteModules.map((moduleName) => {
            const selected = moduleName === activeModule;
            const Icon = MODULE_SWITCH_ICONS[moduleName];
            return (
              <button
                aria-checked={selected}
                aria-label={getModuleSwitchAccessibleName(moduleName, selected)}
                className={cn(
                  MODULE_SWITCH_ITEM_CLASS,
                  selected
                    ? MODULE_SWITCH_ITEM_ACTIVE_CLASS
                    : MODULE_SWITCH_ITEM_INACTIVE_CLASS,
                )}
                data-module-switch-option={moduleName}
                data-state={selected ? "on" : "off"}
                key={moduleName}
                onClick={() => handleSelect(moduleName)}
                role="menuitemradio"
                type="button"
              >
                <Icon
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">
                  {MODULE_SWITCH_LABELS[moduleName]}
                </span>
                {selected ? (
                  <Check aria-hidden="true" className="size-4 shrink-0" />
                ) : null}
              </button>
            );
          })}
        </Popover>
      ) : null}
    </div>
  );
}
