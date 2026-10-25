import type {
  JobFinderDiscoveryState,
  DiscoveryBootstrapState,
} from "@nestor/contracts";
import { cloneValue } from "./state";
import { freezeProjection } from "./saved-job-projection";
import type { DiscoveryDisplayProjection } from "../repository-types";

export function toDiscoveryDisplayProjection(
  state: JobFinderDiscoveryState,
): DiscoveryDisplayProjection {
  return freezeProjection(
    cloneValue(state),
  ) as unknown as DiscoveryDisplayProjection;
}

export function toDiscoveryBootstrapProjection(
  state: JobFinderDiscoveryState,
): DiscoveryBootstrapState {
  return freezeProjection(
    cloneValue({
      sessions: state.sessions,
      activeSourceDebugRun: state.activeSourceDebugRun,
    }),
  );
}
