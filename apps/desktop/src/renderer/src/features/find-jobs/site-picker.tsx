import type { JobSite } from "@nestor/contracts";
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

/** The person's job sites, read once per visit to the screen. */
function useSites() {
  const [sites, setSites] = useState<JobSite[] | null>(null);
  useEffect(() => {
    let live = true;
    void window.nestor.jobs
      .run("list_sites", {})
      .then(({ sites: next }) => {
        if (live) setSites(next);
      })
      .catch(() => {
        if (live) setSites([]);
      });
    return () => {
      live = false;
    };
  }, []);
  return sites;
}

/**
 * Which sites a search looks at: all of them, or the ones ticked. Only the
 * sites turned on in Profile are listed, so "All" means what it says.
 */
export function SitePicker(props: {
  value: "all" | readonly string[];
  onChange: (value: "all" | string[]) => void;
}) {
  const sites = useSites();
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

  const all = sites ?? [];
  const chosen = new Set(
    props.value === "all" ? all.map((site) => site.id) : props.value,
  );
  const label =
    sites === null
      ? "Your sites"
      : all.length === 0
        ? "No sites yet"
        : props.value === "all" || chosen.size === all.length
          ? `All ${all.length} site${all.length === 1 ? "" : "s"}`
          : `${chosen.size} of ${all.length} sites`;
  const shown = filter.trim()
    ? all.filter((site) =>
        `${site.label} ${site.url}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      )
    : all;
  const set = (ids: Set<string>) =>
    props.onChange(ids.size === all.length ? "all" : [...ids]);

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
        {all.length === 0 ? (
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
                onClick={() => props.onChange("all")}
                size="toolbar"
                type="button"
                variant="ghost"
              >
                All
              </Button>
              <Button
                onClick={() => set(new Set())}
                size="toolbar"
                type="button"
                variant="ghost"
              >
                None
              </Button>
            </div>
            <ul className="grid max-h-72 list-none gap-0.5 overflow-y-auto p-0">
              {shown.map((site) => (
                <li key={site.id}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-(--radius-small) px-1.5 py-1 hover:bg-(--surface-overlay-list)">
                    <Checkbox
                      checked={chosen.has(site.id)}
                      onCheckedChange={() => {
                        const next = new Set(chosen);
                        if (next.has(site.id)) next.delete(site.id);
                        else next.add(site.id);
                        set(next);
                      }}
                    />
                    <span className="min-w-0 truncate text-(length:--text-small) text-foreground">
                      {site.label}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-(length:--text-tiny) text-foreground-muted">
              Sites you turned off in Profile are not listed.
            </p>
          </>
        )}
      </Popover>
    </>
  );
}
