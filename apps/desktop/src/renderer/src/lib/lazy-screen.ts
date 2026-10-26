import { createElement, lazy, useState } from "react";
import type { ComponentType } from "react";

/** Loads a screen's chunk once and remembers it, so later mounts render at once. */
export function createSharedRouteLoader<T>(load: () => Promise<T>) {
  let promise: Promise<T> | null = null;
  const loader = Object.assign(
    () => {
      promise ??= load().then((module) => {
        loader.loaded = module;
        return module;
      });
      return promise;
    },
    { loaded: null as T | null },
  );
  return loader;
}

/**
 * A lazy screen that renders at once when its code has already arrived (the
 * idle preload below). `React.lazy` suspends on its first render even then,
 * and React keeps a fallback it revealed for about 300 ms, so a preloaded
 * screen still opened ~340 ms after the click. The choice is made once per
 * mount, so a screen never swaps component type under its own state.
 */
export function lazyScreen<P extends object>(
  loader: ReturnType<
    typeof createSharedRouteLoader<{ default: ComponentType<P> }>
  >,
): ComponentType<P> {
  const Lazy = lazy(loader) as unknown as ComponentType<P>;
  return function LazyScreen(props: P) {
    const [Screen] = useState<ComponentType<P>>(
      () => loader.loaded?.default ?? Lazy,
    );
    return createElement(Screen, props);
  };
}

/**
 * Fetches screens' code once the window is idle, so the first click on any
 * of them renders at once instead of waiting on its chunk.
 */
export function preloadWhenIdle(
  loaders: ReadonlyArray<() => Promise<unknown>>,
) {
  if (import.meta.env.MODE === "test" || typeof window === "undefined") return;
  const preload = () => {
    for (const load of loaders) void load().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(preload, { timeout: 4000 });
  else window.setTimeout(preload, 2000);
}
