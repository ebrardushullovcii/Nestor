import type { ReactNode } from "react";

import { ListRowSkeleton } from "@renderer/features/job-lists/list-pane";
import { cn } from "@renderer/lib/cn";

import { LIST_DETAIL_COLUMNS_CLASS } from "./list-detail-columns";
import { LockedScreenLayout } from "./locked-screen-layout";
import { PageHeader } from "./page-header";

/**
 * The lazy-route loading frame.
 *
 * `docs/PRODUCT.md` "Nothing shifts": *a skeleton is laid out block for block
 * like the loaded screen*. Each destination gets its own frame: its title and
 * description in the header slot, its toolbar (the search card, the tabs,
 * the filter chips), then the list pane with its two toolbar rows and
 * skeleton rows at the real row size, and the detail pane. Hydration then
 * replaces content inside a frame that is already in the right place.
 *
 * The centred `WorkspaceStateScreen fillAvailableViewport` card stays for the
 * genuine full-screen states it was built for — startup, and an unrecoverable
 * error — where there is no destination frame to predict.
 */
export interface RouteSkeletonProps {
  className?: string;
  /** The route being opened; picks its layout. */
  pathname: string;
  title: string;
}

type RouteShape =
  | "find-jobs"
  | "shortlisted"
  | "applications"
  | "needs-you"
  | "profile"
  | "settings"
  | "home";

/** Each destination's loaded layout, keyed by route path. */
const ROUTE_SHAPES: ReadonlyArray<{
  path: string;
  shape: RouteShape;
  description: string;
}> = [
  {
    path: "/job-finder/discovery",
    shape: "find-jobs",
    description:
      "Search your job sites, then shortlist the jobs worth a resume.",
  },
  {
    path: "/job-finder/review-queue",
    shape: "shortlisted",
    description:
      "Resumes write themselves as jobs arrive. Read, edit if you like, approve.",
  },
  {
    path: "/job-finder/applications",
    shape: "applications",
    description: "Every application, where it stands and what is next.",
  },
  {
    path: "/job-finder/actions",
    shape: "needs-you",
    description: "Answer once. Finish the steps only you can do.",
  },
  {
    path: "/job-finder/profile",
    shape: "profile",
    description:
      "Everything Job Finder knows about you. Edit any field or ask the assistant.",
  },
  {
    path: "/job-finder/settings",
    shape: "settings",
    description:
      "Everything saves as you go: a choice when you pick it, typed text when you pause or leave the field.",
  },
];

export function getRouteShape(pathname: string): {
  shape: RouteShape;
  description: string;
} {
  return (
    ROUTE_SHAPES.find((entry) => pathname.startsWith(entry.path)) ?? {
      shape: "home",
      description: "Your next step, and how your search is going.",
    }
  );
}

const PANEL =
  "surface-panel-shell rounded-(--radius-panel) border border-(--surface-panel-border)";

function Bar(props: { className: string }) {
  return <span className={cn("skeleton block", props.className)} />;
}

/** The tabs under a header: underlined labels, 36px tall. */
function TabsSkeleton(props: { count: number }) {
  return (
    <div className="flex h-9 items-center gap-4 self-start border-b border-(--border-subtle) px-2.5">
      {Array.from({ length: props.count }, (_, index) => (
        <Bar className="h-3 w-20" key={index} />
      ))}
    </div>
  );
}

/** A list pane: its tool row, its status row and rows at the real size. */
function ListPaneSkeleton(props: { rowLines: 2 | 3 }) {
  return (
    <div
      className={cn(
        PANEL,
        "flex min-h-0 min-w-0 flex-col overflow-hidden split:h-full",
      )}
      data-route-skeleton-pane
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-(--surface-panel-border) px-3 py-2">
        <Bar className="h-8 flex-1" />
        <Bar className="h-8 w-28" />
      </div>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-(--surface-panel-border) px-3">
        <Bar className="h-3 w-24" />
        <Bar className="h-6 w-16" />
      </div>
      <ul className="m-0 grid list-none content-start overflow-hidden p-0">
        {Array.from({ length: 8 }, (_, index) => (
          <ListRowSkeleton index={index} key={index} lines={props.rowLines} />
        ))}
      </ul>
    </div>
  );
}

/** A detail pane: title, a line of facts, actions, then paragraphs. */
function DetailSkeleton(props: { paper?: boolean }) {
  return (
    <div
      className={cn(PANEL, "grid min-h-0 content-start gap-3 p-6 split:h-full")}
      data-route-skeleton-pane
    >
      <Bar className="h-5 w-2/3" />
      <Bar className="h-3 w-2/5" />
      <div className="flex gap-2 pt-1">
        <Bar className="h-8 w-28" />
        <Bar className="h-8 w-20" />
      </div>
      {props.paper ? (
        <div className="resume-paper-skeleton mx-auto mt-2 grid aspect-[816/1056] w-full max-w-[816px] content-start gap-3 rounded-(--radius-field) p-[8%]">
          <Bar className="mx-auto h-5 w-2/5" />
          {Array.from({ length: 8 }, (_, index) => (
            <Bar
              className={cn("h-2.5", index % 3 === 0 ? "w-1/4" : "w-full")}
              key={index}
            />
          ))}
        </div>
      ) : (
        ["w-full", "w-11/12", "w-4/5", "w-full", "w-3/5"].map(
          (width, index) => <Bar className={cn("h-3.5", width)} key={index} />,
        )
      )}
    </div>
  );
}

function TwoPanes(props: { paper?: boolean; rowLines?: 2 | 3 }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid min-h-0 min-w-0 flex-1 items-stretch gap-4 split:h-full split:grid-rows-[minmax(0,1fr)]",
        LIST_DETAIL_COLUMNS_CLASS,
      )}
      data-route-skeleton
      data-route-skeleton-panes={2}
    >
      <ListPaneSkeleton rowLines={props.rowLines ?? 3} />
      <DetailSkeleton paper={props.paper ?? false} />
    </div>
  );
}

/** Form sections, for Profile and Settings: a heading and label/field rows. */
export function FormSectionsSkeleton(props: { tabs: number }) {
  return (
    <div
      aria-hidden="true"
      className="grid min-w-0 content-start gap-4"
      data-route-skeleton
      data-route-skeleton-panes={1}
    >
      <TabsSkeleton count={props.tabs} />
      {[4, 3].map((rows, section) => (
        <div className={cn(PANEL, "grid gap-4 p-5")} key={section}>
          <Bar className="h-4 w-40" />
          {Array.from({ length: rows }, (_, row) => (
            <div className="grid gap-1.5" key={row}>
              <Bar className="h-3 w-28" />
              <Bar className="h-10 w-full" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Guided setup while its profile loads: the page header, then one card the
 * shape of the first step (a heading, a line, and the two ways to start),
 * where the loaded screen lands. Not a lone "Loading…" line over a blank
 * page.
 */
export function GuidedSetupSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading guided setup"
      className="grid min-w-0 content-start gap-4"
      data-route-skeleton
      role="status"
    >
      <PageHeader
        description="Your profile is what Job Finder searches and applies with."
        title="Guided setup"
      />
      <div aria-hidden="true" className={cn(PANEL, "grid gap-5 p-7")}>
        <div className="grid gap-2">
          <Bar className="h-4 w-64" />
          <Bar className="h-3 w-full max-w-2xl" />
          <Bar className="h-3 w-3/5 max-w-xl" />
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Bar className="h-48 w-full" />
          <Bar className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}

function HomeBlocks() {
  return (
    <div
      aria-hidden="true"
      className="grid min-w-0 content-start gap-4"
      data-route-skeleton
      data-route-skeleton-panes={1}
    >
      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(18rem,2fr)]">
        <Bar className="h-44 w-full" />
        <Bar className="h-44 w-full" />
      </div>
      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((tile) => (
          <Bar className="h-24 w-full" key={tile} />
        ))}
      </div>
    </div>
  );
}

export function RouteSkeleton({
  className,
  pathname,
  title,
}: RouteSkeletonProps) {
  const { shape, description } = getRouteShape(pathname);
  const header = (
    <div
      aria-atomic="true"
      aria-busy="true"
      aria-live="polite"
      className="grid min-w-0 gap-3"
      role="status"
    >
      <PageHeader description={description} title={title} />
      {shape === "shortlisted" || shape === "needs-you" ? (
        <TabsSkeleton count={2} />
      ) : null}
      {shape === "applications" ? (
        <div className="flex flex-wrap gap-1">
          {Array.from({ length: 8 }, (_, index) => (
            <Bar className="h-8 w-20" key={index} />
          ))}
        </div>
      ) : null}
    </div>
  );

  if (shape === "find-jobs") {
    // Find jobs lays out as a column, not a locked two-row screen.
    return (
      <div
        className={cn(
          "flex h-full min-h-0 flex-col gap-3 overflow-hidden pt-3",
          className,
        )}
      >
        {header}
        <div
          aria-hidden="true"
          className={cn(PANEL, "grid gap-1.5 px-3 pt-3 pb-2")}
          data-route-skeleton-search
        >
          <div className="flex h-8 items-center gap-3">
            <Bar className="h-8 flex-1" />
            <Bar className="h-8 w-28" />
            <Bar className="h-8 w-36" />
            <Bar className="h-8 w-56" />
            <Bar className="h-8 w-24" />
          </div>
          <div className="flex h-8 items-center">
            <Bar className="h-3 w-72" />
          </div>
        </div>
        <TabsSkeleton count={3} />
        <TwoPanes rowLines={2} />
      </div>
    );
  }

  let body: ReactNode;
  if (shape === "profile") body = <FormSectionsSkeleton tabs={6} />;
  else if (shape === "settings") body = <FormSectionsSkeleton tabs={4} />;
  else if (shape === "home") body = <HomeBlocks />;
  else body = <TwoPanes paper={shape === "shortlisted"} />;

  return (
    <LockedScreenLayout
      contentClassName={cn("split:overflow-hidden", className)}
      lockContentHeight={shape !== "home" && shape !== "settings"}
      topContent={<div className="pb-4">{header}</div>}
    >
      {body}
    </LockedScreenLayout>
  );
}
