import { useEffect, useState } from "react";
import type { DiscoveryRunRecord } from "@nestor/contracts";

/**
 * How long a browser-backed command may keep its controls disabled.
 *
 * The same window bounds a stop request: a search that has not acknowledged
 * Stop within it is reported as stopped and every control it was holding is
 * released.
 */
export const COMMAND_PENDING_RELEASE_MS = 90_000;

/**
 * Where a stop request stands.
 *
 * - `none` — nothing was asked to stop.
 * - `stopping` — Stop was asked for and the search may still be winding down.
 * - `unacknowledged` — Stop was asked for longer than
 *   {@link COMMAND_PENDING_RELEASE_MS} ago and the search never answered. The
 *   app stops claiming to be stopping something it no longer controls.
 */
export type DiscoveryStopState = "none" | "stopping" | "unacknowledged";

type StoppableRun = Pick<
  DiscoveryRunRecord,
  "state" | "cancellationRequestedAt"
>;

export function getDiscoveryStopState(
  run: StoppableRun | null | undefined,
  now: number = Date.now(),
): DiscoveryStopState {
  if (!run || run.state !== "running" || !run.cancellationRequestedAt) {
    return "none";
  }

  const requestedAt = new Date(run.cancellationRequestedAt).getTime();
  if (Number.isNaN(requestedAt)) {
    return "stopping";
  }

  return now - requestedAt >= COMMAND_PENDING_RELEASE_MS
    ? "unacknowledged"
    : "stopping";
}

/**
 * The live stop state, re-read once the release window elapses.
 *
 * A single timer is armed only while a stop request is outstanding, so a
 * screen with no stop in flight schedules nothing.
 */
export function useDiscoveryStopState(
  run: StoppableRun | null | undefined,
): DiscoveryStopState {
  const [state, setState] = useState<DiscoveryStopState>(() =>
    getDiscoveryStopState(run),
  );
  const requestedAt =
    run?.state === "running" ? (run.cancellationRequestedAt ?? null) : null;

  useEffect(() => {
    const current = getDiscoveryStopState(
      requestedAt
        ? { state: "running", cancellationRequestedAt: requestedAt }
        : null,
    );
    setState(current);

    if (current !== "stopping" || !requestedAt) {
      return;
    }

    const elapsed = Date.now() - new Date(requestedAt).getTime();
    const timer = setTimeout(
      () => setState("unacknowledged"),
      Math.max(0, COMMAND_PENDING_RELEASE_MS - elapsed),
    );
    return () => clearTimeout(timer);
  }, [requestedAt]);

  return state;
}
