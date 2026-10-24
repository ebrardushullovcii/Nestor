import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";

import { Button } from "@renderer/components/ui/button";
import { Popover } from "@renderer/components/ui/popover";
import { TextLink } from "@renderer/components/ui/text-link";
import { cn } from "@renderer/lib/cn";

import { useJobFinderOverlayOwnership } from "../lib/job-finder-overlay-ownership";
import { isImeComposingEvent } from "../lib/job-finder-shortcuts";
import { useBoundedFloatingSurface } from "./bounded-floating-surface";

/**
 * The one line under a page title for conditions that affect this page but
 * are owned somewhere else (paused activity, safeguard holds, setup in
 * progress), the latest automatic run, and a bulk follow-up for the page's
 * list (ADR 0044). It is not a box: a toned dot, plain text and at most one
 * small button. When there is nothing to report it renders nothing.
 */
export type PageStatusTone = "critical" | "warning" | "info";

export type PageStatusAction =
  | {
      readonly kind: "link";
      readonly label: string;
      /** A route in the app; the link leads to the screen that owns the detail. */
      readonly to: string;
    }
  | {
      readonly kind: "link";
      readonly label: string;
      readonly onClick: () => void;
    }
  | {
      /** A page-level action done right here, such as Resume activity. */
      readonly kind: "button";
      readonly label: string;
      readonly onClick: () => void;
      readonly disabled?: boolean;
      readonly pending?: boolean;
    };

export interface PageStatusItem {
  readonly id: string;
  readonly tone?: PageStatusTone;
  readonly text: string;
  readonly action?: PageStatusAction;
  /**
   * An id for the item's text on the line, so a control the condition
   * disables can name it with `aria-describedby`.
   */
  readonly textId?: string;
  /**
   * Called when the person hides the item, for a screen that remembers the
   * choice for longer than this visit.
   */
  readonly onHide?: () => void;
}

const TONE_ORDER: Record<PageStatusTone | "neutral", number> = {
  critical: 0,
  warning: 1,
  info: 2,
  neutral: 3,
};

const TONE_DOT_CLASS: Record<PageStatusTone, string> = {
  critical: "bg-destructive",
  warning: "bg-(--warning-text)",
  info: "bg-(--info-text)",
};

/** The flex gap between items, in px (`gap-x-3`). */
const ITEM_GAP_PX = 12;
/** Used until the "+N more" button has been measured once. */
const MORE_BUTTON_FALLBACK_WIDTH_PX = 76;
const POPOVER_PREFERRED_WIDTH_PX = 360;
const POPOVER_DESIRED_HEIGHT_PX = 320;

export function sortPageStatusItems(
  items: readonly PageStatusItem[],
): PageStatusItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (left, right) =>
        TONE_ORDER[left.item.tone ?? "neutral"] -
          TONE_ORDER[right.item.tone ?? "neutral"] || left.index - right.index,
    )
    .map(({ item }) => item);
}

function StatusAction(props: { action: PageStatusAction; asButton: boolean }) {
  const { action } = props;
  if (action.kind === "button" && props.asButton) {
    return (
      <Button
        className="shrink-0"
        disabled={action.disabled ?? false}
        onClick={action.onClick}
        pending={action.pending ?? false}
        size="xs"
        type="button"
        variant="outline"
      >
        {action.label}
      </Button>
    );
  }
  if ("to" in action) {
    return (
      <TextLink asChild className="shrink-0">
        <Link to={action.to}>{action.label}</Link>
      </TextLink>
    );
  }
  return (
    <TextLink
      className="shrink-0"
      disabled={action.kind === "button" ? (action.disabled ?? false) : false}
      onClick={action.onClick}
    >
      {action.label}
    </TextLink>
  );
}

function StatusDot({ tone }: { tone: PageStatusTone | undefined }) {
  if (!tone) return null;
  return (
    <span
      aria-hidden="true"
      className={cn("size-2 shrink-0 rounded-full", TONE_DOT_CLASS[tone])}
      data-page-status-dot={tone}
    />
  );
}

export function PageStatusLine(props: {
  className?: string;
  items: readonly PageStatusItem[];
}) {
  // Hidden for this visit only: the line lives in the page, so the set is
  // gone when the page is left, and a condition that still holds is shown
  // again on the next visit.
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const shownItems = useMemo(
    () =>
      sortPageStatusItems(props.items).filter(
        (item) => !hiddenIds.has(item.id),
      ),
    [hiddenIds, props.items],
  );
  // The first page-level button keeps its button; any later one reads as a
  // link, so the line never holds two buttons.
  const buttonItemId =
    shownItems.find((item) => item.action?.kind === "button")?.id ?? null;
  const signature = shownItems
    .map(
      (item) => `${item.id}\u0000${item.text}\u0000${item.action?.label ?? ""}`,
    )
    .join("\u0001");

  const lineRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const widthsRef = useRef<number[]>([]);
  const measuredSignatureRef = useRef<string | null>(null);
  const moreWidthRef = useRef(MORE_BUTTON_FALLBACK_WIDTH_PX);
  // null renders every item so each one can be measured; a number is how
  // many fit before the "+N more" button.
  const [fitCount, setFitCount] = useState<number | null>(null);
  const [isPopoverOpen, setPopoverOpen] = useState(false);

  const computeFit = useCallback(() => {
    const line = lineRef.current;
    const widths = widthsRef.current;
    if (!line || widths.length === 0) return;
    const available = line.clientWidth;
    const total =
      widths.reduce((sum, width) => sum + width, 0) +
      ITEM_GAP_PX * (widths.length - 1);
    if (available <= 0 || total <= available) {
      setFitCount(widths.length);
      return;
    }
    const reserve = ITEM_GAP_PX + moreWidthRef.current;
    let count = widths.length - 1;
    let used =
      widths.slice(0, count).reduce((sum, width) => sum + width, 0) +
      ITEM_GAP_PX * Math.max(0, count - 1);
    while (count > 1 && used + reserve > available) {
      count -= 1;
      used -= (widths[count] ?? 0) + ITEM_GAP_PX;
    }
    setFitCount(Math.max(1, count));
  }, []);

  // A changed set of items is measured again with every item rendered.
  useLayoutEffect(() => {
    setFitCount(null);
  }, [signature]);

  useLayoutEffect(() => {
    if (fitCount !== null) return;
    const line = lineRef.current;
    if (!line) return;
    widthsRef.current = Array.from(
      line.querySelectorAll<HTMLElement>("[data-page-status-item]"),
    ).map((element) => element.offsetWidth);
    measuredSignatureRef.current = signature;
    computeFit();
  }, [computeFit, fitCount, signature]);

  // Measured when what the button says can change, not after every render:
  // reading it forces a layout.
  useLayoutEffect(() => {
    if (moreRef.current && moreRef.current.offsetWidth > 0) {
      moreWidthRef.current = moreRef.current.offsetWidth;
    }
  }, [fitCount, signature]);

  useEffect(() => {
    const line = lineRef.current;
    if (!line || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => computeFit());
    observer.observe(line);
    return () => observer.disconnect();
  }, [computeFit, signature]);

  const closePopover = useCallback((restoreFocus: boolean) => {
    setPopoverOpen(false);
    if (restoreFocus) moreRef.current?.focus();
  }, []);
  const { isTopmost } = useJobFinderOverlayOwnership({
    active: isPopoverOpen,
    close: () => closePopover(true),
  });
  const placement = useBoundedFloatingSurface({
    alignment: "start",
    desiredHeight: POPOVER_DESIRED_HEIGHT_PX,
    open: isPopoverOpen,
    preferredWidth: POPOVER_PREFERRED_WIDTH_PX,
    triggerRef: moreRef,
  });
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isPopoverOpen) return undefined;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !moreRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        closePopover(true);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) return;
      if (event.key !== "Escape" || !isTopmost()) return;
      event.preventDefault();
      closePopover(true);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePopover, isPopoverOpen, isTopmost]);

  const isPopoverMounted = isPopoverOpen && placement !== null;
  useLayoutEffect(() => {
    if (!isPopoverMounted) return;
    popoverRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled), a[href]")
      ?.focus();
  }, [isPopoverMounted]);

  const hideFocusRef = useRef<{
    nextIds: string[];
    header: HTMLElement | null;
  } | null>(null);

  const hideItem = useCallback(
    (id: string) => {
      const focused = document.activeElement;
      if (
        lineRef.current?.contains(focused) ||
        popoverRef.current?.contains(focused)
      ) {
        hideFocusRef.current = {
          nextIds: shownItems
            .slice(shownItems.findIndex((item) => item.id === id) + 1)
            .map((item) => item.id),
          header:
            lineRef.current
              ?.closest("[data-page-header-stack]")
              ?.querySelector<HTMLElement>("[data-page-header]") ?? null,
        };
      }
      setHiddenIds((current) => new Set([...current, id]));
      props.items.find((item) => item.id === id)?.onHide?.();
    },
    [props.items, shownItems],
  );

  useLayoutEffect(() => {
    const pending = hideFocusRef.current;
    if (
      !pending ||
      (shownItems.length > 0 &&
        (fitCount === null || measuredSignatureRef.current !== signature))
    )
      return;
    const nextItem = Array.from(
      lineRef.current?.querySelectorAll<HTMLElement>(
        "[data-page-status-item]",
      ) ?? [],
    ).find((element) =>
      pending.nextIds.includes(element.dataset.pageStatusItem ?? ""),
    );
    const target =
      nextItem?.querySelector<HTMLElement>("button, a") ??
      moreRef.current ??
      pending.header ??
      lineRef.current;
    target?.focus();
    hideFocusRef.current = null;
  }, [fitCount, signature, shownItems.length]);

  useEffect(() => {
    if (shownItems.length === 0 && isPopoverOpen) setPopoverOpen(false);
  }, [isPopoverOpen, shownItems.length]);

  if (shownItems.length === 0) {
    return null;
  }

  const visibleCount = fitCount ?? shownItems.length;
  const visibleItems = shownItems.slice(0, visibleCount);
  const overflowCount = shownItems.length - visibleItems.length;

  return (
    <div
      aria-live="polite"
      className={cn(
        // Clipped sideways only, so focus rings above and below a control
        // stay visible.
        "mt-1.5 flex h-6 min-w-0 items-center gap-x-3 overflow-x-clip whitespace-nowrap text-(length:--text-small) leading-5 text-foreground-soft",
        props.className,
      )}
      data-page-header-status
      ref={lineRef}
      role="status"
      tabIndex={-1}
    >
      {visibleItems.map((item, index) => (
        <span
          className={cn(
            "group/status-item inline-flex min-w-0 items-center gap-1.5",
            // Every item is measured at its full width. Once the fit is known
            // only the first item may shrink; it truncates instead of the
            // line wrapping.
            index === 0 && fitCount !== null ? "shrink" : "shrink-0",
          )}
          data-page-status-item={item.id}
          data-tone={item.tone ?? "neutral"}
          key={item.id}
        >
          {index > 0 ? (
            <span aria-hidden="true" className="mr-1.5 text-foreground-muted">
              ·
            </span>
          ) : null}
          <StatusDot tone={item.tone} />
          <span
            className={cn(
              "min-w-0 truncate",
              item.tone === "critical" && "text-foreground",
            )}
            {...(item.textId ? { id: item.textId } : {})}
            title={item.text}
          >
            {item.text}
          </span>
          {item.action ? (
            <StatusAction
              action={item.action}
              asButton={item.id === buttonItemId}
            />
          ) : null}
          {/* Zero width until the item is hovered or the button has keyboard
              focus, so hiding an item costs no room on the line. */}
          <button
            aria-label={`Hide for now: ${item.text}`}
            className="-ml-1.5 inline-flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-(--radius-small) text-foreground-muted opacity-0 outline-none hover:bg-secondary hover:text-foreground focus-visible:ml-0 focus-visible:w-6 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/status-item:ml-0 group-hover/status-item:w-6 group-hover/status-item:opacity-100"
            data-page-status-hide
            onClick={() => hideItem(item.id)}
            type="button"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      {overflowCount > 0 ? (
        <Button
          aria-expanded={isPopoverOpen}
          aria-haspopup="dialog"
          className="shrink-0"
          data-page-status-more
          onClick={() => {
            if (isPopoverOpen) closePopover(true);
            else setPopoverOpen(true);
          }}
          ref={moreRef}
          size="xs"
          type="button"
          variant="ghost"
        >
          +{overflowCount} more
        </Button>
      ) : null}
      {placement && overflowCount > 0 ? (
        <Popover
          className="grid gap-1 p-2"
          data-page-status-popover
          label="Everything on this page's status line"
          open={isPopoverOpen}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || isImeComposingEvent(event)) return;
            const controls = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                "button:not(:disabled), a[href]",
              ),
            );
            const edge = event.shiftKey ? controls[0] : controls.at(-1);
            if (document.activeElement === edge) {
              event.preventDefault();
              closePopover(true);
            }
          }}
          placement={{
            left: placement.left,
            maxHeight: placement.maxHeight,
            top: placement.top,
            width: placement.width,
          }}
          ref={popoverRef}
          role="dialog"
        >
          <ul className="grid gap-1">
            {shownItems.map((item) => (
              <li
                className="flex items-start gap-2 rounded-(--radius-small) px-2 py-1.5 text-(length:--text-small) leading-5"
                key={item.id}
              >
                <span className="mt-1.5 flex size-2 shrink-0">
                  <StatusDot tone={item.tone} />
                </span>
                <span className="grid min-w-0 flex-1 gap-1">
                  <span
                    className={cn(
                      "text-foreground-soft",
                      item.tone === "critical" && "text-foreground",
                    )}
                  >
                    {item.text}
                  </span>
                  {item.action ? (
                    <span>
                      <StatusAction
                        action={item.action}
                        asButton={item.id === buttonItemId}
                      />
                    </span>
                  ) : null}
                </span>
                <Button
                  aria-label={`Hide for now: ${item.text}`}
                  className="shrink-0"
                  onClick={() => hideItem(item.id)}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  Hide
                </Button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </div>
  );
}
