import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether this window has asked for the old whole-workspace load. Launch and
 * the store screens never do: it starts when a screen that still reads the
 * old workspace opens (Profile, guided setup, Settings) or when the command
 * palette asks for it, and stays loaded after that.
 */
let wanted = false;
const listeners = new Set<() => void>();

/** Screens that still read the old workspace until their own queries land. */
const LEGACY_WORKSPACE_PATHS = ["/job-finder/profile", "/job-finder/settings"];

export function needsLegacyWorkspace(pathname: string): boolean {
  return LEGACY_WORKSPACE_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export function requestLegacyWorkspace(): void {
  if (wanted) return;
  wanted = true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const read = () => wanted;

/** True once the old workspace is wanted; opening `pathname` may ask for it. */
export function useLegacyWorkspaceWanted(pathname: string): boolean {
  const current = useSyncExternalStore(subscribe, read, read);
  const needed = needsLegacyWorkspace(pathname);
  useEffect(() => {
    if (needed) requestLegacyWorkspace();
  }, [needed]);
  return current || needed;
}
