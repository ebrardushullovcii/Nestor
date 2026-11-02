import { isAssistantNavigationRequest } from "@nestor/contracts";
import { Suspense, useContext, useLayoutEffect, useRef } from "react";
import type { ContextType, ReactElement, ReactNode } from "react";
import {
  UNSAFE_LocationContext as LocationContext,
  useLocation,
  useOutlet,
} from "react-router-dom";
import {
  createKeptRouteVisibility,
  KeptRouteVisibilityContext,
} from "@renderer/features/job-finder/lib/kept-route-visibility";

/**
 * The two lists a person goes back and forth between all day. Mounting either
 * one again on every visit cost 45-90 ms (50 rows built, laid out and
 * measured), so they stay mounted once opened and are only hidden while
 * another screen shows.
 */
export const KEPT_ROUTE_PATHS: readonly string[] = [
  "/job-finder/discovery",
  "/job-finder/review-queue",
];

type LocationContextValue = ContextType<typeof LocationContext>;

interface KeptRoute {
  context: unknown;
  /** Stable per path, so hiding or showing re-renders nothing in the screen. */
  visibility: ReturnType<typeof createKeptRouteVisibility>;
  element: ReactElement;
  location: LocationContextValue;
}

function sameLocation(left: LocationContextValue, right: LocationContextValue) {
  return (
    left.location.pathname === right.location.pathname &&
    left.location.search === right.location.search &&
    left.location.hash === right.location.hash &&
    (!(
      new URLSearchParams(right.location.search).has("resumeMode") ||
      isAssistantNavigationRequest(right.location.state)
    ) ||
      left.location.key === right.location.key)
  );
}

/**
 * The box a kept screen lives in. Shown, it is an ordinary full-height block.
 * Hidden, it keeps its last size out of the flow with `content-visibility:
 * hidden`, so the browser keeps its layout and showing it again is a style
 * change rather than a rebuild (`display: none` threw the layout away and
 * cost as much as mounting). `inert` keeps focus, clicks and find-in-page out.
 */
function KeptRouteFrame(props: {
  hidden: boolean;
  visibility: KeptRoute["visibility"];
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<{
    width: number;
    height: number;
    top: number;
    left: number;
  } | null>(null);
  const { hidden, visibility } = props;
  useLayoutEffect(() => {
    visibility.setHidden(hidden);
  }, [hidden, visibility]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || props.hidden) return undefined;
    // Where and how big the shown screen is, so hidden it keeps exactly
    // that box: shown again, nothing in it moves (a hidden screen pinned to
    // the corner of the scroll area measured as a layout shift on arrival).
    const measure = () => {
      box.current = {
        width: node.offsetWidth,
        height: node.offsetHeight,
        top: node.offsetTop,
        left: node.offsetLeft,
      };
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [props.hidden]);
  const hiddenBox = box.current;
  return (
    <div
      aria-hidden={props.hidden || undefined}
      className={props.hidden ? undefined : "h-full min-h-0"}
      data-kept-route={props.hidden ? "hidden" : "shown"}
      inert={props.hidden}
      ref={ref}
      style={
        props.hidden
          ? {
              position: "absolute",
              top: hiddenBox ? `${hiddenBox.top}px` : 0,
              left: hiddenBox ? `${hiddenBox.left}px` : 0,
              width: hiddenBox ? `${hiddenBox.width}px` : "100%",
              // Never wider than the scroll area it sits in: after the window
              // narrows or the text grows, a box kept at its old width made
              // the shown screen scroll sideways.
              maxWidth: hiddenBox ? `calc(100% - ${hiddenBox.left}px)` : "100%",
              height: hiddenBox ? `${hiddenBox.height}px` : "100%",
              contentVisibility: "hidden",
              visibility: "hidden",
              pointerEvents: "none",
            }
          : undefined
      }
    >
      {props.children}
    </div>
  );
}

/**
 * The matched route, with Find jobs and Shortlisted kept alive between
 * visits. A hidden one keeps its state (open job, page, filters, scroll) and
 * the page context and location it was last shown with, so it does no work
 * while another screen changes the URL or the workspace. Coming back to the
 * same URL with nothing changed re-renders nothing at all. An explicit
 * resumeMode or marked Assistant request passes its new key even when the URL
 * repeats. Every other route
 * mounts fresh per path, as before, in its own Suspense boundary so a screen
 * still loading shows its opening surface rather than the previous page.
 */
export function JobFinderKeptRoutesOutlet(props: {
  context: unknown;
  /** The opening surface while a screen's code loads. */
  fallback: ReactNode;
  /** Marks the shown screen's first meaningful paint. */
  readyMarker: ReactNode;
}) {
  const outlet = useOutlet(props.context);
  const { pathname } = useLocation();
  const location = useContext(LocationContext);
  const kept = useRef(new Map<string, KeptRoute>());
  const activeKeptPath = KEPT_ROUTE_PATHS.includes(pathname) ? pathname : null;
  if (activeKeptPath && outlet) {
    const previous = kept.current.get(activeKeptPath);
    if (
      !previous ||
      previous.context !== props.context ||
      !sameLocation(previous.location, location)
    ) {
      kept.current.set(activeKeptPath, {
        visibility: previous?.visibility ?? createKeptRouteVisibility(false),
        context: props.context,
        element: outlet,
        location,
      });
    }
  }

  return (
    <>
      {[...kept.current].map(([path, route]) => {
        const hidden = path !== activeKeptPath;
        return (
          <KeptRouteFrame
            hidden={hidden}
            key={path}
            visibility={route.visibility}
          >
            <Suspense fallback={props.fallback}>
              <KeptRouteVisibilityContext.Provider value={route.visibility}>
                <LocationContext.Provider value={route.location}>
                  {route.element}
                </LocationContext.Provider>
              </KeptRouteVisibilityContext.Provider>
              {hidden ? null : props.readyMarker}
            </Suspense>
          </KeptRouteFrame>
        );
      })}
      {activeKeptPath ? null : (
        <Suspense fallback={props.fallback} key={pathname}>
          {outlet}
          {props.readyMarker}
        </Suspense>
      )}
    </>
  );
}
