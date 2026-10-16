/**
 * React's development build records a User Timing entry, with a description
 * of the changed props, for every component that renders with new props, and
 * the browser keeps every entry until something clears it. A search refreshes
 * the screen several times a second, so `pnpm desktop:dev` gained hundreds of
 * entries a second and the window grew by gigabytes over a long search, while
 * diffing the props cost CPU on every render. React records them only when
 * `console.timeStamp` exists, so the app removes it before React loads;
 * nothing else uses it, and production React records nothing either way.
 * Set VITE_NORDRI_REACT_PERFORMANCE_TRACKS=1 to keep React's tracks for a
 * Performance-panel profile.
 */
export function disableReactPerformanceTracks(
  keepForProfiling: boolean,
  target: Console = console,
): void {
  if (keepForProfiling) return;
  Reflect.deleteProperty(target, "timeStamp");
}
