import { createContext, useContext } from "react";

/**
 * True inside a screen that stays mounted while another one shows (Find jobs
 * and Shortlisted, see `JobFinderKeptRoutesOutlet`). Window-wide key handlers
 * and the assistant's context sources read it so a hidden screen never acts
 * on a key or describes itself as what the person is looking at.
 */
export const KeptRouteHiddenContext = createContext(false);

export function useKeptRouteHidden(): boolean {
  return useContext(KeptRouteHiddenContext);
}
