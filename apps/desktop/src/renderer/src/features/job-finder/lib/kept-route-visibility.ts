import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type DependencyList,
} from "react";

/**
 * Whether a screen kept mounted behind another one (Find jobs and Shortlisted,
 * see `JobFinderKeptRoutesOutlet`) is hidden. A store rather than a value:
 * a context value that changed on every hide and show re-rendered the whole
 * kept screen, list included, on each navigation away from it and back, even
 * while it could not be seen.
 */
export interface KeptRouteVisibility {
  isHidden: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

const ALWAYS_SHOWN: KeptRouteVisibility = {
  isHidden: () => false,
  subscribe: () => () => {},
};

export function createKeptRouteVisibility(
  hidden: boolean,
): KeptRouteVisibility & { setHidden: (hidden: boolean) => void } {
  let current = hidden;
  const listeners = new Set<() => void>();
  return {
    isHidden: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setHidden: (next) => {
      if (next === current) return;
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export const KeptRouteVisibilityContext =
  createContext<KeptRouteVisibility>(ALWAYS_SHOWN);

/**
 * True inside a hidden kept screen. Re-renders the caller on every hide and
 * show, so keep it to small components; effects that only need to stop while
 * hidden use {@link useEffectWhileKeptRouteShown}.
 */
export function useKeptRouteHidden(): boolean {
  const visibility = useContext(KeptRouteVisibilityContext);
  return useSyncExternalStore(visibility.subscribe, visibility.isHidden);
}

/**
 * Runs `effect` while the screen is shown and cleans it up while it is hidden
 * behind another one, without re-rendering the screen. Window-wide key
 * handlers and the assistant's context sources use it so a hidden screen
 * never acts on a key or describes itself as what the person is looking at.
 */
export function useEffectWhileKeptRouteShown(
  effect: () => void | (() => void),
  deps: DependencyList,
): void {
  const visibility = useContext(KeptRouteVisibilityContext);
  const effectRef = useRef(effect);
  effectRef.current = effect;
  useEffect(() => {
    let cleanup: void | (() => void);
    let running = false;
    const sync = () => {
      const shouldRun = !visibility.isHidden();
      if (shouldRun === running) return;
      running = shouldRun;
      if (shouldRun) cleanup = effectRef.current();
      else {
        cleanup?.();
        cleanup = undefined;
      }
    };
    sync();
    const unsubscribe = visibility.subscribe(sync);
    return () => {
      unsubscribe();
      if (running) cleanup?.();
    };
    // `deps` are the caller's; the effect itself is read through the ref.
  }, [visibility, ...deps]);
}
