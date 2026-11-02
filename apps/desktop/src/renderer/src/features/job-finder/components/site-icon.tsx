import { siteIconOrigin } from "@nestor/contracts";
import { Globe2 } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import { cn } from "@renderer/lib/cn";

/**
 * Job sites' own icons in the renderer: one shared store over the browser
 * bridge's icon cache (Electron main fills it from each site's own origin).
 * Origins are asked for in one batch per tick; a cache change asks again.
 */
const icons = new Map<string, string>();
const asked = new Set<string>();
const listeners = new Set<() => void>();
let queued = new Set<string>();
let flushing = false;
let watching = false;

function bridge() {
  return typeof window === "undefined"
    ? undefined
    : window.nestor?.browser?.siteIcons;
}

function notify() {
  for (const listener of listeners) listener();
}

function flush() {
  flushing = false;
  const origins = [...queued];
  queued = new Set();
  const icon = bridge();
  if (!icon || origins.length === 0) return;
  void icon
    .get({ urls: origins })
    .then(({ icons: found }) => {
      let changed = false;
      for (const [origin, dataUrl] of Object.entries(found)) {
        if (icons.get(origin) === dataUrl) continue;
        icons.set(origin, dataUrl);
        changed = true;
      }
      if (changed) notify();
    })
    .catch(() => undefined);
}

function ask(origin: string, again = false) {
  if (!again && asked.has(origin)) return;
  asked.add(origin);
  queued.add(origin);
  if (!flushing) {
    flushing = true;
    queueMicrotask(flush);
  }
}

function watch() {
  if (watching) return;
  const icon = bridge();
  if (!icon) return;
  watching = true;
  icon.onChanged(() => {
    for (const origin of asked) ask(origin, true);
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached icon of the site at this address, as a data URL, or null. */
export function useSiteIcon(url: string | null | undefined): string | null {
  const origin = url ? siteIconOrigin(url) : null;
  const icon = useSyncExternalStore(subscribe, () =>
    origin ? (icons.get(origin) ?? null) : null,
  );
  useEffect(() => {
    if (!origin) return;
    watch();
    ask(origin);
  }, [origin]);
  return icon;
}

/**
 * A site's own icon, or today's neutral globe when there is none yet. Always
 * the same box, so an icon arriving moves nothing. Decorative: the site's
 * name is always written beside it.
 */
export function SiteIcon(props: {
  url: string | null | undefined;
  className?: string;
}) {
  const icon = useSiteIcon(props.url);
  const box = cn("size-3.5 shrink-0", props.className);
  return icon ? (
    <img
      alt=""
      aria-hidden="true"
      className={cn(box, "rounded-(--radius-small) object-contain")}
      data-site-icon=""
      draggable={false}
      src={icon}
    />
  ) : (
    <Globe2
      aria-hidden="true"
      className={cn(box, "text-foreground-muted")}
      data-site-icon="none"
    />
  );
}

/** Test seam: forget everything the store has seen. */
export function resetSiteIconsForTest() {
  icons.clear();
  asked.clear();
  queued = new Set();
  flushing = false;
  watching = false;
}
