import type { JobSiteSelection } from "@nestor/contracts";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@renderer/components/ui/button";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Input } from "@renderer/components/ui/input";
import {
  Popover,
  type PopoverPlacement,
} from "@renderer/components/ui/popover";

import { useSitePage } from "@renderer/features/job-lists/use-site-page";

/**
 * Which sites a search looks at: all of them, or the ones ticked. Only the
 * sites turned on in Profile are listed, so "All" means what it says.
 */
export function SitePicker(props: {
  value: JobSiteSelection;
  onChange: (value: JobSiteSelection) => void;
}) {
  const navigate = useNavigate();
  const button = useRef<HTMLButtonElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const [filter, setFilter] = useState("");
  const open = placement !== null;

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setPlacement(null);
        return;
      }
      const target = event.target as Node;
      if (
        !surface.current?.contains(target) &&
        !button.current?.contains(target)
      )
        setPlacement(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const sites = useSitePage({
    text: filter,
    filter: "enabled",
    selection: props.value,
    limit: open ? 25 : 1,
  });
  const ids = new Set(
    "all" in props.value ? props.value.except : props.value.ids,
  );
  const total = sites.enabledTotal;
  const label =
    sites.loading && total === 0
      ? "Your sites"
      : total === 0
        ? "No sites yet"
        : sites.selected === total
          ? `All ${total} site${total === 1 ? "" : "s"}`
          : `${sites.selected} of ${total} sites`;

  return (
    <>
      <Button
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => {
          if (open) {
            setPlacement(null);
            return;
          }
          const rect = button.current!.getBoundingClientRect();
          setPlacement({
            top: rect.bottom + 6,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)),
            width: 320,
            maxHeight: Math.max(240, window.innerHeight - rect.bottom - 24),
          });
        }}
        ref={button}
        size="toolbar"
        type="button"
        variant="outline"
      >
        {label}
        <ChevronDown aria-hidden="true" />
      </Button>
      <Popover
        className="grid gap-2 p-3"
        label="Sites to search"
        open={open}
        placement={placement ?? { top: 0, left: 0 }}
        ref={surface}
      >
        {total === 0 ? (
          <div className="grid gap-2 text-(length:--text-small) text-foreground-soft">
            <p>Add the job sites you use, and searches look at them.</p>
            <Button
              onClick={() => void navigate("/job-finder/profile")}
              size="sm"
              type="button"
              variant="outline"
            >
              Add sites in Profile
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Find a site"
                className="flex-1"
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Find a site"
                size="toolbar"
                value={filter}
              />
              <Button
                onClick={() => props.onChange({ all: true, except: [] })}
                size="toolbar"
                type="button"
                variant="ghost"
              >
                All
              </Button>
              <Button
                onClick={() => props.onChange({ ids: [] })}
                size="toolbar"
                type="button"
                variant="ghost"
              >
                None
              </Button>
            </div>
            <ul className="grid max-h-72 list-none gap-0.5 overflow-y-auto p-0">
              {sites.rows.map((site) => (
                <li key={site.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-(--radius-small) px-1.5 py-1 hover:bg-(--surface-overlay-list)">
                    <Checkbox
                      checked={
                        "all" in props.value
                          ? !ids.has(site.id)
                          : ids.has(site.id)
                      }
                      onCheckedChange={() => {
                        const next = new Set(ids);
                        if (next.has(site.id)) next.delete(site.id);
                        else next.add(site.id);
                        props.onChange(
                          "all" in props.value
                            ? { all: true, except: [...next] }
                            : { ids: [...next] },
                        );
                      }}
                    />
                    <span className="min-w-0 truncate text-(length:--text-small) text-foreground">
                      {site.label}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between gap-2">
              <Button
                size="toolbar"
                variant="ghost"
                disabled={sites.pageIndex === 0 || sites.loading}
                onClick={sites.previous}
              >
                Previous sites
              </Button>
              <span className="text-xs">
                {sites.total} match{sites.total === 1 ? "" : "es"}
              </span>
              <Button
                size="toolbar"
                variant="ghost"
                disabled={!sites.nextCursor || sites.loading}
                onClick={sites.next}
              >
                Next sites
              </Button>
            </div>
            <p className="text-(length:--text-tiny) text-foreground-muted">
              Sites you turned off in Profile are not listed.
            </p>
          </>
        )}
      </Popover>
    </>
  );
}
