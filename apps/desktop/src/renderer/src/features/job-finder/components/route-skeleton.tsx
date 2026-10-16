import { LIST_DETAIL_COLUMNS_CLASS } from "./list-detail-columns";
import { cn } from "@renderer/lib/cn";

import { LockedScreenLayout } from "./locked-screen-layout";
import { PageHeader } from "./page-header";

/**
 * The lazy-route loading frame.
 *
 * `docs/PRODUCT.md` "Nothing shifts": *a skeleton is laid out block for block
 * like the loaded screen*. Every first visit to Find jobs, Shortlisted,
 * Applications or the Studio used to paint a small bordered card dead-centred
 * in an otherwise empty viewport — a shape that appears nowhere in the loaded
 * app, predicts nothing about where anything will land, and reads like a
 * crash. `RouteSkeleton` paints the destination's own frame instead: the same
 * `LockedScreenLayout` those routes use, the route's title in the same header
 * slot, and one muted block per pane filling the pane it reserves. Hydration
 * then replaces content inside a frame that is already in the right place.
 *
 * The centred `WorkspaceStateScreen fillAvailableViewport` card stays for the
 * genuine full-screen states it was built for — startup, and an unrecoverable
 * error — where there is no destination frame to predict.
 */
export interface RouteSkeletonProps {
  className?: string;
  /**
   * Matches the loaded route's own description line, so the header block is
   * the same height before and after hydration.
   */
  description?: string;
  /**
   * How many panes the destination's loaded layout has. The locked two-pane
   * routes (Find jobs, Shortlisted, Applications, Studio) are `2`; Profile and
   * the scrolling routes are `1`. A skeleton that guesses this wrong is worse
   * than none: it moves the content sideways on hydration.
   */
  panes: 1 | 2;
  title: string;
}

/** The pane count of each destination's loaded layout, keyed by route path. */
export const ROUTE_SKELETON_PANES_BY_PATH: ReadonlyArray<{
  panes: 1 | 2;
  path: string;
}> = [
  // Profile is locked but single-column: section tabs above one editor column.
  { panes: 1, path: "/job-finder/profile" },
  // Find jobs, Shortlisted and Applications are all `xl:grid-cols-[…_…]` list
  // + detail. The Studio lives under `/job-finder/review-queue/…` and is a
  // two-pane preview + tools grid, so the same prefix answers for both.
  { panes: 2, path: "/job-finder/discovery" },
  { panes: 2, path: "/job-finder/review-queue" },
  { panes: 2, path: "/job-finder/applications" },
];

export function getRouteSkeletonPanes(pathname: string): 1 | 2 {
  return (
    ROUTE_SKELETON_PANES_BY_PATH.find((entry) =>
      pathname.startsWith(entry.path),
    )?.panes ?? 1
  );
}

function SkeletonPane({ lines }: { lines: number }) {
  return (
    <div
      className="surface-panel-shell grid min-w-0 content-start gap-3 rounded-(--radius-panel) border border-(--surface-panel-border) p-5 xl:h-full xl:min-h-0"
      data-route-skeleton-pane
    >
      <div className="h-4 w-36 rounded bg-(--surface-panel-raised)" />
      {Array.from({ length: lines }, (_, index) => (
        <div
          className={cn(
            "h-4 rounded bg-(--surface-panel-raised)",
            index % 2 === 0 ? "w-full max-w-[52ch]" : "w-64 max-w-full",
          )}
          key={index}
        />
      ))}
    </div>
  );
}

export function RouteSkeleton({
  className,
  description,
  panes,
  title,
}: RouteSkeletonProps) {
  return (
    <LockedScreenLayout
      topContent={
        <div
          aria-atomic="true"
          aria-live="polite"
          className="grid min-w-0 gap-5"
          role="status"
        >
          <PageHeader
            description={description ?? `Opening ${title.toLowerCase()}.`}
            title={title}
          />
        </div>
      }
    >
      <div
        aria-hidden="true"
        className={cn(
          // The same `gap-4` two-column shape the locked routes declare, so
          // the muted panes sit where the real panes will.
          "grid min-w-0 items-stretch gap-4 pt-5 xl:h-full xl:min-h-0",
          panes === 2 ? LIST_DETAIL_COLUMNS_CLASS : "xl:grid-cols-1",
          className,
        )}
        data-route-skeleton
        data-route-skeleton-panes={panes}
      >
        <SkeletonPane lines={3} />
        {panes === 2 ? <SkeletonPane lines={4} /> : null}
      </div>
    </LockedScreenLayout>
  );
}
