import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Popover } from "@renderer/components/ui/popover";
import { SegmentedControl } from "@renderer/components/ui/segmented-control";
import { cn } from "@renderer/lib/cn";
import { isImeComposingEvent } from "../lib/job-finder-shortcuts";
import {
  handleListSearchEscape,
  LIST_SEARCH_ATTRIBUTE,
} from "../lib/list-search-focus";
import { useJobFinderOverlayOwnership } from "../lib/job-finder-overlay-ownership";
import { useBoundedFloatingSurface } from "./bounded-floating-surface";
import { EmptyState } from "./empty-state";
import type {
  SavedCollectionView,
  SavedViewMetadata,
} from "../hooks/use-persisted-collection-view";

export type CollectionDensity = "compact" | "comfortable" | "detailed";

/**
 * One label per density for both the visible text and the accessible name,
 * so what a screen reader announces is exactly what the button shows.
 */
export function getCollectionDensityLabel(density: CollectionDensity): string {
  switch (density) {
    case "compact":
      return "Compact";
    case "comfortable":
      return "Comfortable";
    case "detailed":
      return "Detailed";
  }
}

/**
 * Search fields must never slice their hint mid-word at narrow widths.
 * Chromium ignores `text-overflow` on `::placeholder` itself (the
 * pseudo-element only accepts a limited property subset), so the ellipsis
 * rides on the input element: nowrap plus hidden overflow make an overflowing
 * hint — and an overflowing typed value left unscrolled — fade out with “…”
 * instead of a hard clip, without growing the toolbar. The complete search
 * scope stays available to assistive technology through each field's label or
 * aria-label.
 */
export const collectionSearchFieldClass =
  "overflow-hidden whitespace-nowrap text-ellipsis";

/**
 * Seam ownership for the toolbar row. The default keeps both borders;
 * `"page"` defers all seams to the page header stack and body gap, and
 * `"panel"` lets the panel header above own the top seam.
 */
export type CollectionSearchToolbarPlacement = "page" | "panel";

/** Naming field plus a handful of saved rows; the solver clamps the rest. */
const SAVED_VIEWS_DESIRED_HEIGHT_PX = 320;
const SAVED_VIEWS_PREFERRED_WIDTH_PX = 288;
/** Roughly eight checkbox rows; the solver clamps the rest. */
const COLUMN_PICKER_DESIRED_HEIGHT_PX = 280;
const COLUMN_PICKER_PREFERRED_WIDTH_PX = 224;

export function normalizeCollectionSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function matchesCollectionSearch(
  query: string,
  values: readonly (string | null | undefined)[],
): boolean {
  const normalizedQuery = normalizeCollectionSearch(query);
  if (!normalizedQuery) return true;

  return values.some((value) =>
    value?.toLocaleLowerCase().includes(normalizedQuery),
  );
}

export function useCollectionSearch<T>(
  items: readonly T[],
  matcher: (item: T, query: string) => boolean,
) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const filteredItems = useMemo(
    () => items.filter((item) => matcher(item, deferredQuery)),
    [deferredQuery, items, matcher],
  );

  return { deferredQuery, filteredItems, query, setQuery };
}

/**
 * One density switcher. The same control used to be written three ways inside
 * this file — a bordered `overflow-hidden` track with an inset ring, a
 * trackless `flex gap-1` row of `secondary`/`ghost` buttons, and a third copy
 * with `px-2 text-xs` — so the same choice looked like three different
 * controls depending on which branch rendered it. All three now render the
 * shared `SegmentedControl`, which carries the one track, height, radius and
 * selected treatment.
 */
function CollectionDensitySwitcher(props: {
  densities: readonly CollectionDensity[];
  density: CollectionDensity;
  onDensityChange: (density: CollectionDensity) => void;
}) {
  return (
    <SegmentedControl
      className="shrink-0"
      label="List density"
      onValueChange={props.onDensityChange}
      options={props.densities.map((density) => ({
        ariaLabel: getCollectionDensityLabel(density),
        label: getCollectionDensityLabel(density),
        value: density,
      }))}
      size="toolbar"
      value={props.density}
    />
  );
}

export function CollectionSearchToolbar(props: {
  className?: string;
  compact?: boolean;
  density?: CollectionDensity;
  /**
   * The density options this collection actually offers. Defaults to all
   * three; a list whose rows only have two useful shapes offers two.
   */
  densities?: readonly CollectionDensity[];
  /**
   * Filter controls (Show, Sort, chips) that share the compact row, placed
   * right after the search field and its count.
   */
  filters?: ReactNode;
  hideCompactCount?: boolean;
  /**
   * A panel title and count at the start of the compact row, used only when
   * the page has two panes that need names (ADR 0044).
   */
  leading?: ReactNode;
  label: string;
  onDensityChange?: (density: CollectionDensity) => void;
  onQueryChange: (query: string) => void;
  placement?: CollectionSearchToolbarPlacement;
  placeholder: string;
  query: string;
  totalCount: number;
  viewActions?: ReactNode;
  visibleCount: number;
}) {
  const inputId = useId();
  const densities =
    props.densities ?? (["compact", "comfortable", "detailed"] as const);
  const showingSubset = props.visibleCount !== props.totalCount;
  const countLabel = showingSubset
    ? `${props.visibleCount} of ${props.totalCount} results`
    : `${props.totalCount} ${props.totalCount === 1 ? "result" : "results"}`;
  const topSeam =
    props.placement === "panel"
      ? undefined
      : "border-t border-(--surface-panel-border)";

  if (props.compact) {
    // The list panel toolbar: one 48px row with the search field (no visible
    // label), the count, filters, density and view actions. A narrow panel
    // wraps the trailing controls instead of clipping them.
    return (
      <div
        className={cn(
          "relative z-20 flex min-h-12 min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-(--surface-panel-border) px-3 py-2",
          topSeam,
          props.className,
        )}
        data-collection-toolbar-compact
      >
        {props.leading}
        <label className="sr-only" htmlFor={inputId}>
          {props.label}
        </label>
        <Input
          autoComplete="off"
          className={cn(
            "min-w-24 flex-1 text-(length:--text-small)",
            collectionSearchFieldClass,
          )}
          id={inputId}
          onChange={(event) => props.onQueryChange(event.target.value)}
          onKeyDown={(event) =>
            handleListSearchEscape(event, props.query, props.onQueryChange)
          }
          placeholder={props.placeholder}
          size="toolbar"
          title="Search this list (/)"
          type="search"
          value={props.query}
          {...{ [LIST_SEARCH_ATTRIBUTE]: "" }}
        />
        {props.query ? (
          <Button
            onClick={() => props.onQueryChange("")}
            size="xs"
            type="button"
            variant="ghost"
          >
            Clear
          </Button>
        ) : null}
        {!props.hideCompactCount ? (
          <span
            aria-atomic="true"
            aria-live="polite"
            className="shrink-0 text-(length:--text-small) tabular-nums text-foreground-muted"
          >
            {countLabel}
          </span>
        ) : null}
        {props.filters}
        {props.density && props.onDensityChange ? (
          <CollectionDensitySwitcher
            densities={densities}
            density={props.density}
            onDensityChange={props.onDensityChange}
          />
        ) : null}
        {props.viewActions ? (
          <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-1">
            {props.viewActions}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid min-w-0 gap-2",
        props.placement === "page"
          ? "py-3"
          : "border-y border-(--surface-panel-border) px-5 py-3",
        props.compact && "relative z-20 px-4 py-2",
        props.className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-end gap-2",
          props.compact && "grid gap-1.5",
        )}
      >
        <div className="min-w-0 w-full flex-1 sm:min-w-56">
          <div className="mb-1 flex min-w-0 items-center justify-between gap-3">
            <label
              className="block text-(length:--text-tiny) uppercase tracking-(--tracking-label) text-foreground-muted"
              htmlFor={inputId}
            >
              {props.label}
            </label>
            {props.compact ? (
              <p
                aria-atomic="true"
                aria-live="polite"
                className="min-w-0 truncate text-xs text-foreground-muted"
              >
                {countLabel}
              </p>
            ) : null}
          </div>
          <Input
            autoComplete="off"
            className={cn(collectionSearchFieldClass, props.compact && "h-9")}
            id={inputId}
            onChange={(event) => props.onQueryChange(event.target.value)}
            placeholder={props.placeholder}
            type="search"
            value={props.query}
          />
        </div>
        {!props.compact && props.density && props.onDensityChange ? (
          <CollectionDensitySwitcher
            densities={densities}
            density={props.density}
            onDensityChange={props.onDensityChange}
          />
        ) : null}
        {!props.compact ? props.viewActions : null}
      </div>
      <div className="flex min-h-5 min-w-0 flex-wrap items-center justify-between gap-2">
        {props.compact ? (
          <div className="flex min-w-0 items-center gap-1">
            {props.density && props.onDensityChange ? (
              <CollectionDensitySwitcher
                densities={densities}
                density={props.density}
                onDensityChange={props.onDensityChange}
              />
            ) : null}
            {props.viewActions}
          </div>
        ) : (
          <p
            aria-atomic="true"
            aria-live="polite"
            className="min-w-0 text-(length:--text-small) text-foreground-muted"
          >
            {countLabel}
          </p>
        )}
        {props.query ? (
          <Button
            onClick={() => props.onQueryChange("")}
            size={props.compact ? "xs" : "sm"}
            type="button"
            variant="ghost"
          >
            {props.compact ? "Clear" : "Clear search"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function CollectionSavedViews(props: {
  onApply: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (name: string, metadata?: SavedViewMetadata) => void;
  // Opaque payload captured with the view at save time; the toolbar never
  // interprets it. The owning collection supplies and restores its meaning.
  savedViewMetadata?: SavedViewMetadata;
  views: readonly SavedCollectionView[];
}) {
  const [name, setName] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Closing through Escape returns focus to the trigger; a focusout Tab-out
  // closes without dragging focus back.
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setIsOpen(false);
    if (restoreFocus) {
      anchorRef.current?.focus();
    }
  }, []);

  const { isTopmost: isMenuTopmost } = useJobFinderOverlayOwnership({
    active: isOpen,
    close: () => closeMenu(true),
  });

  // The shared solver owns flipping, shifting and the available height. This
  // popover used to re-derive all three, and its `Math.max(160, …)` floor
  // could exceed the space actually left, so at short heights the surface
  // painted past the window bottom instead of scrolling inside itself.
  const placement = useBoundedFloatingSurface({
    alignment: "end",
    desiredHeight: SAVED_VIEWS_DESIRED_HEIGHT_PX,
    open: isOpen,
    preferredWidth: SAVED_VIEWS_PREFERRED_WIDTH_PX,
    triggerRef: anchorRef,
  });

  useEffect(() => {
    if (!isOpen) return undefined;

    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !anchorRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key !== "Escape" || !isMenuTopmost()) {
        return;
      }
      event.preventDefault();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeMenu, isOpen, isMenuTopmost]);

  // The portaled dialog never receives focus by default; claim it for the
  // naming field so keyboard and screen reader users land inside the dialog.
  // It waits for the placement because the surface is not mounted until the
  // solver has measured — focusing a frame after opening would have missed it.
  useEffect(() => {
    if (!isOpen || !placement) {
      return;
    }
    nameInputRef.current?.focus();
  }, [isOpen, placement]);

  return (
    <div
      className="relative z-40"
      onBlur={(event) => {
        // React blur bubbles (focusout), so moves inside the trigger or the
        // portaled dialog keep the menu open; leaving both closes it while
        // the browser continues the ordinary Tab traversal untouched.
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          (anchorRef.current?.contains(nextTarget) ||
            menuRef.current?.contains(nextTarget))
        ) {
          return;
        }
        closeMenu(false);
      }}
    >
      {/* An ordinary `outline` toolbar button. It was a raw `<button>` on the
          inert `--border-strong` token, so it did not match the controls it
          sits beside — and the `Columns` trigger next to it had no border at
          all. Both are the same control class now. */}
      <Button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((open) => !open)}
        ref={anchorRef}
        size="toolbar"
        type="button"
        variant="outline"
      >
        Saved views{props.views.length > 0 ? ` (${props.views.length})` : ""}
      </Button>
      {placement ? (
        <Popover
          className="grid gap-3 p-3"
          data-saved-views-menu
          label="Saved views"
          open={isOpen}
          placement={{
            left: placement.left,
            maxHeight: placement.maxHeight,
            top: placement.top,
            width: placement.width,
          }}
          ref={menuRef}
          role="dialog"
        >
          <div className="flex gap-2">
            <Input
              aria-label="Saved view name"
              onChange={(event) => setName(event.target.value)}
              placeholder="Name this view"
              ref={nameInputRef}
              value={name}
            />
            <Button
              disabled={!name.trim()}
              onClick={() => {
                // Preserve the historical single-argument contract for
                // consumers without a payload; metadata rides along only
                // when the collection actually supplied one.
                const savedViewMetadata = props.savedViewMetadata;
                if (savedViewMetadata === undefined) {
                  props.onSave(name);
                } else {
                  props.onSave(name, savedViewMetadata);
                }
                setName("");
              }}
              size="sm"
              type="button"
              variant="secondary"
            >
              Save
            </Button>
          </div>
          {props.views.length === 0 ? (
            <p className="text-xs text-foreground-muted">
              Save this search and density for quick reuse.
            </p>
          ) : (
            <ul className="grid gap-1">
              {props.views.map((view) => (
                <li
                  className="flex items-center justify-between gap-2"
                  key={view.id}
                >
                  <button
                    className="min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm hover:bg-secondary"
                    onClick={() => props.onApply(view.id)}
                    type="button"
                  >
                    {view.name}
                  </button>
                  {/* The one link treatment, not a hand-rolled underlined
                          span in a muted body colour. */}
                  <Button
                    aria-label={`Delete saved view ${view.name}`}
                    onClick={() => props.onDelete(view.id)}
                    size="xs"
                    type="button"
                    variant="link"
                  >
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Popover>
      ) : null}
    </div>
  );
}

export interface CollectionColumnOption {
  id: string;
  label: string;
  required?: boolean;
  visible: boolean;
}

export function CollectionColumnPicker(props: {
  columns: readonly CollectionColumnOption[];
  onChange: (columnId: string, visible: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setIsOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);
  const { isTopmost } = useJobFinderOverlayOwnership({
    active: isOpen,
    close: () => closeMenu(true),
  });
  // Was a `<details>` with an `absolute right-0 top-full` fieldset, so its
  // host section's `overflow-hidden` clipped it and a long column list had no
  // max-height at all. Portalled and solver-placed, it is bounded and cannot
  // be clipped by layout it does not own.
  const placement = useBoundedFloatingSurface({
    alignment: "end",
    desiredHeight: COLUMN_PICKER_DESIRED_HEIGHT_PX,
    open: isOpen,
    preferredWidth: COLUMN_PICKER_PREFERRED_WIDTH_PX,
    triggerRef,
  });

  useEffect(() => {
    if (!isOpen) return undefined;

    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !triggerRef.current?.contains(target) &&
        !surfaceRef.current?.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isImeComposingEvent(event)) {
        return;
      }
      if (event.key !== "Escape" || !isTopmost()) {
        return;
      }
      event.preventDefault();
      closeMenu(true);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeMenu, isOpen, isTopmost]);

  return (
    <div className="relative">
      <Button
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        onClick={() => setIsOpen((open) => !open)}
        ref={triggerRef}
        size="toolbar"
        type="button"
        variant="outline"
      >
        Columns
      </Button>
      {placement ? (
        <Popover
          className="p-3"
          data-collection-column-picker
          label="Visible columns"
          open={isOpen}
          placement={{
            left: placement.left,
            maxHeight: placement.maxHeight,
            top: placement.top,
            width: placement.width,
          }}
          ref={surfaceRef}
          role="dialog"
        >
          <fieldset className="grid gap-2">
            <legend className="sr-only">Visible columns</legend>
            {props.columns.map((column) => (
              <label
                className="flex items-center gap-2 text-sm"
                key={column.id}
              >
                <input
                  checked={column.visible}
                  disabled={column.required}
                  onChange={(event) =>
                    props.onChange(column.id, event.target.checked)
                  }
                  type="checkbox"
                />
                {column.label}
              </label>
            ))}
          </fieldset>
        </Popover>
      ) : null}
    </div>
  );
}

export function CollectionNoMatches(props: {
  /**
   * Replaces the generic advice line when the surface knows something better
   * to say — most importantly how many results the search DID find. "No jobs
   * match 'Akron'" printed over eleven kept results read as "we found you
   * nothing", which was false.
   */
  description?: string;
  noun: string;
  onClear: () => void;
  query: string;
}) {
  return (
    // The shared `EmptyState`. This was a borderless `grid min-h-48` block, so
    // the no-match state on all eleven toolbar routes looked unlike every
    // other empty state in the app — including ones on the same screen.
    <EmptyState
      description={
        props.description ??
        "Try a company, role, location, status, or a shorter phrase. Your other filters and selections have not changed."
      }
      title={`No ${props.noun} match “${props.query.trim()}”`}
    >
      <div className="flex justify-center">
        <Button onClick={props.onClear} type="button" variant="secondary">
          Clear search
        </Button>
      </div>
    </EmptyState>
  );
}
