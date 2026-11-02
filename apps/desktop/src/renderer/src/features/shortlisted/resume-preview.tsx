import { Minus, Plus } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Button } from "@renderer/components/ui/button";
import {
  SegmentedControl,
  type SegmentedControlOption,
} from "@renderer/components/ui/segmented-control";

/** A letter page at 96 px per inch, the size the renderer lays out. */
const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;
/** The warm desk around the paper. */
const DESK_PADDING = 24;
const ZOOM_STEPS: readonly number[] = [
  0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2,
];
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
/**
 * The smallest scale the page opens at: body text stays about 9 px or
 * more. Where fit width would draw it smaller (a narrow pane, the assistant
 * docked), the page opens at this step and scrolls sideways instead.
 */
const READABLE_ZOOM = 0.75;

const ZOOM_PRESETS: readonly SegmentedControlOption<"fit" | "actual">[] = [
  {
    value: "fit",
    label: "Fit width",
    title: "Fit the page to the pane's width (0)",
  },
  { value: "actual", label: "Actual size", title: "Actual size, 100% (1)" },
];
/** Keys that scroll the page; they stay with the page, never the list. */
const READING_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

/** "fit" follows the pane's width; a number is a fixed scale. */
export type ResumeZoom = "fit" | number;

/** The scale one step in from `scale`, or the same scale at either end. */
export function stepZoom(scale: number, direction: 1 | -1): number {
  if (direction === 1)
    return ZOOM_STEPS.find((step) => step > scale + 0.001) ?? MAX_ZOOM;
  return (
    [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001) ?? MIN_ZOOM
  );
}

/** The width-filling scale for a desk of `deskWidth` pixels (its padding included). */
export function fitWidthScale(deskWidth: number): number {
  return Math.min(
    MAX_ZOOM,
    Math.max(MIN_ZOOM, (deskWidth - DESK_PADDING * 2) / PAGE_WIDTH),
  );
}

/**
 * The zoom the person last chose (a preset, − or +, or a key) this session.
 * Every page opens at it, the next resume and the skeleton while one is
 * written included, so reading the next job never resets their choice.
 */
let chosenZoom: ResumeZoom | null = null;

/** Forgets the person's zoom choice (tests). */
export function forgetResumeZoom(): void {
  chosenZoom = null;
}

/**
 * The scale a page opens at on a desk of `deskWidth`: the person's own
 * choice, or fit width, or the readable step where fit width would be too
 * small to read. The list screens give the paper the width it needs
 * (Shortlisted narrows its list or reads in a sheet), so fit width is the
 * usual answer; the readable step is the fallback for a desk nobody could
 * widen.
 */
export function openingZoom(deskWidth: number): ResumeZoom {
  const fit = fitWidthScale(deskWidth);
  const fallback = fit < READABLE_ZOOM - 0.001 ? READABLE_ZOOM : "fit";
  if (chosenZoom === null || chosenZoom === "fit")
    return chosenZoom ?? fallback;
  // A scale chosen on a wider desk would cut every line here: the person
  // zoomed on purpose for that desk, not this one, so this page opens at the
  // widest scale whose lines are whole. Their choice stays remembered for
  // the next desk that fits it.
  return chosenZoom <= fit + 0.001 ? chosenZoom : fallback;
}

/**
 * The desk's width (its padding included) and the page's scale on it: the
 * same for the skeleton while a page is written and for the page that
 * replaces it, so the paper lands where its skeleton was, at the same size.
 * Read before the first paint, so the page never draws once at 100% first.
 */
function useDesk() {
  const deskRef = useRef<HTMLDivElement>(null);
  const [deskWidth, setDeskWidth] = useState<number | null>(null);
  // Decided from the measured desk (below), never taken as it was: a scale
  // remembered from a wider desk would crop this one.
  const [zoom, setZoomState] = useState<ResumeZoom | null>(null);
  useLayoutEffect(() => {
    const node = deskRef.current;
    if (!node) return undefined;
    // A hidden desk (a sheet not open yet) measures nothing; the page is
    // sized when it is first seen.
    const read = (contentWidth: number) => {
      if (contentWidth > 0) setDeskWidth(contentWidth + DESK_PADDING * 2);
    };
    read(node.clientWidth - DESK_PADDING * 2);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) read(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // The opening scale is decided once, from the first measured width; the
  // person's own choice is never overridden afterwards.
  const current: ResumeZoom =
    zoom ?? (deskWidth === null ? "fit" : openingZoom(deskWidth));
  useEffect(() => {
    if (zoom === null && deskWidth !== null)
      setZoomState(openingZoom(deskWidth));
  }, [zoom, deskWidth]);
  const setZoom = (next: ResumeZoom) => {
    chosenZoom = next;
    setZoomState(next);
  };
  const fit = deskWidth === null ? 1 : fitWidthScale(deskWidth);
  return {
    deskRef,
    zoom: current,
    setZoom,
    fit,
    scale: current === "fit" ? fit : current,
  };
}

/**
 * The paper on its desk with the reading controls above it. Fit width by
 * default (or the person's last zoom); 100% and zoom in or out by button or
 * by key while the page has focus (+, −, 0 for fit width, 1 for 100%). The
 * page itself is in the tab order, so arrow keys and Page Up/Down read it.
 * The rendered document stays inert (clicks and keys stay with the screen,
 * so ⌘Enter still approves and a link in the resume never navigates the
 * preview).
 */
export function ResumePaper(props: {
  html: string;
  pageCount: number | null;
  /** What the page is, for the region's name ("Tailored resume"). */
  label?: string;
  /** A quiet note at the toolbar's start, after the page count. */
  note?: ReactNode;
}) {
  const { deskRef, zoom, setZoom, scale } = useDesk();
  // The page at the middle of the desk, for "Page 2 of 3".
  const [page, setPage] = useState(1);

  const pages = Math.max(1, props.pageCount ?? 1);
  const height = PAGE_HEIGHT * pages;
  const percent = `${Math.round(scale * 100)}%`;
  const onScroll = () => {
    const node = deskRef.current;
    if (!node || pages === 1) return;
    const middle = node.scrollTop + node.clientHeight / 2 - DESK_PADDING;
    setPage(
      Math.min(
        pages,
        Math.max(1, Math.floor(middle / (PAGE_HEIGHT * scale)) + 1),
      ),
    );
  };
  const pageText =
    pages === 1
      ? "1 page"
      : `Page ${Math.min(page, pages).toLocaleString()} of ${pages.toLocaleString()}`;

  const zoomBy = (direction: 1 | -1) => setZoom(stepZoom(scale, direction));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // The browser scrolls the focused page; the list's J/K and arrow keys
    // (listening on the window) never hear these, so reading never switches
    // the job.
    if (READING_KEYS.has(event.key)) {
      event.stopPropagation();
      return;
    }
    if (event.key === "+" || event.key === "=") zoomBy(1);
    else if (event.key === "-" || event.key === "_") zoomBy(-1);
    else if (event.key === "0") setZoom("fit");
    else if (event.key === "1") setZoom(1);
    else return;
    event.preventDefault();
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--resume-preview-frame)">
      <div
        aria-label="Resume zoom"
        className="flex min-h-10 flex-wrap items-center gap-2 border-b border-(--surface-panel-border) bg-(--surface-panel) px-3 py-1"
        role="toolbar"
      >
        <span
          className="text-xs tabular-nums text-foreground-soft"
          data-resume-page-count
        >
          {pageText}
        </span>
        {props.note ? (
          <span className="min-w-0 truncate text-xs text-foreground-soft">
            {props.note}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {/* One current figure: the two presets are the shared segmented
              choice, and the percentage beside − and + is the only number. */}
          <SegmentedControl
            label="Zoom preset"
            onValueChange={(value) => setZoom(value === "fit" ? "fit" : 1)}
            options={ZOOM_PRESETS}
            value={zoom === "fit" ? "fit" : zoom === 1 ? "actual" : "custom"}
          />
          <Button
            aria-label="Zoom out"
            disabled={scale <= MIN_ZOOM + 0.001}
            onClick={() => zoomBy(-1)}
            size="icon-xs"
            title="Zoom out (−)"
            type="button"
            variant="ghost"
          >
            <Minus aria-hidden />
          </Button>
          <output
            aria-live="polite"
            className="w-11 text-center text-xs tabular-nums text-foreground-soft"
            data-resume-zoom={zoom === "fit" ? "fit" : String(zoom)}
          >
            {percent}
          </output>
          <Button
            aria-label="Zoom in"
            disabled={scale >= MAX_ZOOM - 0.001}
            onClick={() => zoomBy(1)}
            size="icon-xs"
            title="Zoom in (+)"
            type="button"
            variant="ghost"
          >
            <Plus aria-hidden />
          </Button>
        </div>
      </div>
      <div
        aria-label={`${props.label ?? "Resume"}, ${pages === 1 ? "1 page" : `${pages} pages`}, ${percent}. Plus and minus zoom, 0 fits the width, 1 is actual size.`}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        data-resume-desk
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        ref={deskRef}
        role="region"
        style={{ padding: DESK_PADDING }}
        tabIndex={0}
      >
        {/* Centred when it is smaller than the desk, scrolled when larger:
            the page never ends halfway down a blank well on one side. */}
        <div
          className="mx-auto overflow-hidden rounded-(--radius-small) bg-white"
          data-resume-paper
          style={{
            boxShadow: "var(--resume-preview-shell-shadow)",
            height: height * scale,
            width: PAGE_WIDTH * scale,
          }}
        >
          <iframe
            className="pointer-events-none origin-top-left border-0 bg-white"
            srcDoc={withPaperBackdrop(props.html)}
            style={{
              height,
              transform: `scale(${scale})`,
              width: PAGE_WIDTH,
            }}
            tabIndex={-1}
            title={props.label ?? "Resume preview"}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The renderer's preview document paints its own canvas (a cool blue-gray
 * fallback outside the app) and pads the page. On the desk the paper is the
 * only surface, so the canvas goes transparent and the page sits flush.
 */
function withPaperBackdrop(html: string): string {
  const style =
    "<style>html,body.preview-body{background:transparent!important}.preview-shell{padding:0!important}.preview-body .page{box-shadow:none!important}</style>";
  return html.includes("</head>")
    ? html.replace("</head>", `${style}</head>`)
    : `${style}${html}`;
}

/**
 * The rendered resume on its desk, or its loading or failed state in the
 * same frame.
 */
export function ResumePreview(props: {
  preview: { html: string; pageCount: number | null } | null;
  error: string | null;
  /** Draws the preview again after it failed. */
  onRetry?: () => void;
  label?: string;
}) {
  if (props.preview)
    return (
      <ResumePaper
        html={props.preview.html}
        pageCount={props.preview.pageCount}
        {...(props.label ? { label: props.label } : {})}
      />
    );
  if (!props.error) return <ResumePaperSkeleton label="Drawing the preview…" />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--resume-preview-frame) p-6">
      {props.error ? (
        <div
          className="grid justify-items-center gap-3 p-6 text-center text-sm text-foreground-soft"
          role="alert"
        >
          <p>{props.error}</p>
          {props.onRetry ? (
            <Button
              onClick={props.onRetry}
              size="toolbar"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const PAPER_LINES: readonly (readonly [string, string])[] = [
  ["h-2.5", "w-11/12"],
  ["h-2.5", "w-full"],
  ["h-2.5", "w-4/5"],
  ["h-2.5", "w-10/12"],
];

/**
 * A blank page while a resume is written, rewritten or drawn, with what is
 * happening said above it ("Rewriting the Light resume…"). It is laid out exactly like
 * the loaded page: the same toolbar bar, the same desk padding, and the paper
 * at the scale the page will open at (the person's zoom, or fit width), from
 * the same top-centre origin, so the page that arrives lands where this was.
 */
export function ResumePaperSkeleton(props: { label: string }) {
  const { deskRef, scale } = useDesk();
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-(--radius-panel) border border-(--surface-panel-border) bg-(--resume-preview-frame)"
      data-resume-writing
    >
      <div className="flex min-h-10 items-center gap-2 border-b border-(--surface-panel-border) bg-(--surface-panel) px-3 py-1">
        <p
          className="flex items-center gap-2 text-xs text-foreground-soft"
          role="status"
        >
          <span className="relative inline-flex h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-(--surface-progress-track)">
            <span className="progress-indeterminate absolute inset-y-0 left-0 w-2/5 rounded-full bg-primary-fill" />
          </span>
          {props.label}
        </p>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto"
        data-resume-desk
        ref={deskRef}
        style={{ padding: DESK_PADDING }}
      >
        <div
          aria-hidden="true"
          className="resume-paper-skeleton mx-auto grid content-start gap-[3.5%] overflow-hidden rounded-(--radius-small) px-[9%] py-[8%]"
          data-resume-paper-skeleton
          style={{
            boxShadow: "var(--resume-preview-shell-shadow)",
            height: PAGE_HEIGHT * scale,
            width: PAGE_WIDTH * scale,
          }}
        >
          <div className="grid justify-items-center gap-3">
            <span className="skeleton block h-5 w-2/5" />
            <span className="skeleton block h-2.5 w-3/5" />
          </div>
          {[0, 1, 2].map((section) => (
            <div className="grid gap-2" key={section}>
              <span className="skeleton block h-3 w-1/4" />
              {PAPER_LINES.map(([height, width], index) => (
                <span
                  className={`skeleton block ${height} ${width}`}
                  key={index}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
