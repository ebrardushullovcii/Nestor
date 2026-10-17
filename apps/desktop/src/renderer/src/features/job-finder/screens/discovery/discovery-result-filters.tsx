import { useCallback, useEffect, useRef, useState } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { Popover } from "@renderer/components/ui/popover";
import { useBoundedFloatingSurface } from "../../components/bounded-floating-surface";
import { useJobFinderOverlayOwnership } from "../../lib/job-finder-overlay-ownership";
import { isImeComposingEvent } from "../../lib/job-finder-shortcuts";

export interface DiscoveryFilterGroup {
  label: string;
  searchable?: boolean;
  options: readonly {
    label: string;
    selected: boolean;
    onToggle: () => void;
  }[];
}

export function DiscoveryResultFilters({
  groups,
  activeCount,
  matchingCount,
  totalCount,
  onClear,
}: {
  groups: readonly DiscoveryFilterGroup[];
  activeCount: number;
  matchingCount: number;
  totalCount: number;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sourceQuery, setSourceQuery] = useState("");
  const anchorRef = useRef<HTMLButtonElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchorRef.current?.focus();
  }, []);
  const { isTopmost } = useJobFinderOverlayOwnership({
    active: open,
    close: () => close(true),
  });
  const placement = useBoundedFloatingSurface({
    open,
    triggerRef: anchorRef,
    preferredWidth: groups.length === 1 ? 360 : 520,
    desiredHeight: 430,
  });
  const hasPlacement = placement !== null;

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchorRef.current?.contains(event.target) &&
        !surfaceRef.current?.contains(event.target)
      )
        close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        isImeComposingEvent(event) ||
        !isTopmost()
      )
        return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close, isTopmost]);

  useEffect(() => {
    if (open && placement)
      surfaceRef.current?.querySelector<HTMLElement>("input,button")?.focus();
  }, [open, hasPlacement]);

  return (
    <div
      onBlur={(event) => {
        const target = event.relatedTarget;
        if (
          target instanceof Node &&
          (anchorRef.current?.contains(target) ||
            surfaceRef.current?.contains(target))
        )
          return;
        if (target) close(false);
      }}
    >
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
        ref={anchorRef}
        size="toolbar"
        type="button"
        variant="outline"
      >
        <SlidersHorizontal aria-hidden="true" className="size-3" />
        Filters
        {activeCount > 0 ? (
          <span
            aria-label={`${activeCount} active ${activeCount === 1 ? "filter" : "filters"}`}
            className="rounded-full bg-accent px-1.5 tabular-nums text-accent-foreground"
          >
            {activeCount}
          </span>
        ) : null}
      </Button>
      {placement ? (
        <Popover
          label="Filter jobs"
          open={open}
          placement={placement}
          ref={surfaceRef}
        >
          <div className="flex items-center justify-between border-b border-(--surface-panel-border) px-3 py-2">
            <span className="text-sm font-semibold">Filters</span>
            <Button
              aria-label="Close filters"
              onClick={() => close(true)}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
          <div
            className={`grid gap-x-4 gap-y-3 p-3 ${groups.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}
            data-testid="discovery-results-filter-groups"
          >
            {groups.map((group) => {
              const options = group.searchable
                ? group.options.filter((option) =>
                    option.label
                      .toLowerCase()
                      .includes(sourceQuery.trim().toLowerCase()),
                  )
                : group.options;
              return (
                <fieldset
                  className={`min-w-0 ${group.searchable && groups.length > 1 ? "col-start-2 row-start-1 row-span-3" : "col-start-1"}`}
                  key={group.label}
                >
                  <legend className="mb-1.5 text-xs font-semibold text-foreground">
                    {group.label}
                  </legend>
                  {group.searchable ? (
                    <Input
                      aria-label="Search sources"
                      className="mb-2"
                      onChange={(event) => setSourceQuery(event.target.value)}
                      placeholder="Search sources"
                      size="toolbar"
                      type="search"
                      value={sourceQuery}
                    />
                  ) : null}
                  <div
                    className={`grid gap-1 ${group.searchable ? "max-h-64 overflow-y-auto overscroll-contain" : ""}`}
                  >
                    {options.map((option) => (
                      <label
                        className="flex min-h-8 min-w-0 cursor-pointer items-start gap-2 rounded-(--radius-small) px-1.5 py-1.5 text-xs leading-5 text-foreground-soft hover:bg-accent"
                        key={option.label}
                        title={option.label}
                      >
                        <input
                          checked={option.selected}
                          className="mt-0.5 size-4 shrink-0 accent-current"
                          onChange={option.onToggle}
                          type="checkbox"
                        />
                        <span className="min-w-0 break-words">
                          {option.label}
                        </span>
                      </label>
                    ))}
                    {options.length === 0 ? (
                      <p className="py-2 text-xs text-foreground-muted">
                        No sources match.
                      </p>
                    ) : null}
                  </div>
                </fieldset>
              );
            })}
          </div>
          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-(--surface-panel-border) bg-popover px-3 py-2">
            <span
              aria-live="polite"
              className="text-xs tabular-nums text-foreground-muted"
            >
              Showing {matchingCount} of {totalCount}
            </span>
            <div className="flex gap-1">
              <Button
                disabled={activeCount === 0}
                onClick={onClear}
                size="xs"
                type="button"
                variant="ghost"
              >
                Clear filters
              </Button>
              <Button
                onClick={() => close(true)}
                size="xs"
                type="button"
                variant="outline"
              >
                Done
              </Button>
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}
