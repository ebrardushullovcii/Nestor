import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  RefreshCcw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JobFinderResumePreview } from "@nestor/contracts";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/cn";
import { getJobFinderScrollBehavior } from "../../lib/job-finder-scroll-behavior";

type PreviewStatus = "idle" | "loading" | "ready" | "error";

/**
 * Opens the studio's optional-suggestions disclosure and moves focus to it so
 * the preview's suggestion count is a real entry point, not a passive label.
 */
function focusValidationSuggestions(): boolean {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("[data-resume-validation-notes]"),
  );
  const target =
    candidates.find((candidate) => candidate.getClientRects().length > 0) ??
    candidates[0] ??
    null;
  if (!target) {
    return false;
  }

  if (target instanceof HTMLDetailsElement) {
    target.open = true;
  }

  const focusTarget = target.querySelector<HTMLElement>("summary") ?? target;
  target.scrollIntoView({
    behavior: getJobFinderScrollBehavior(),
    block: "start",
  });
  focusTarget.focus({ preventScroll: true });
  return true;
}
type PreviewRefreshFeedback = "pending" | "completed" | "failed";

interface ResumeStudioPreviewPaneProps {
  isDirty: boolean;
  isPending: boolean;
  onRetry: () => void;
  onSelectTarget: (selection: {
    sectionId: string | null;
    entryId: string | null;
    targetId: string | null;
  }) => void;
  /**
   * Called before the suggestions list is focused, so a compact layout can
   * switch to the Tools tab that holds it. Without this the link did nothing
   * whenever the list was not mounted, which every blind tester reported.
   */
  onRevealSuggestions?: () => void;
  preview: JobFinderResumePreview | null;
  previewError: string | null;
  previewStatus: PreviewStatus;
  /** Increments only for an explicit editor/preview selection that should scroll. */
  selectionScrollKey?: number;
  selectedEntryId: string | null;
  selectedSectionId: string | null;
  selectedTargetId: string | null;
  /**
   * Section, entry, and bullet ids an accepted assistant proposal landed on.
   * They are marked on the page itself so an applied AI edit is never a
   * silently different paragraph.
   */
  aiEditedTargetIds?: readonly string[];
  templateLabel?: string | null;
}

function parseSelectionTarget(node: EventTarget | null) {
  const element =
    node &&
    typeof node === "object" &&
    "nodeType" in node &&
    typeof (node as Node).nodeType === "number"
      ? (node as Node).nodeType === Node.ELEMENT_NODE
        ? ((node as Element).closest<HTMLElement>("*") ?? null)
        : (node as Node).parentElement
      : null;
  const entryTarget =
    element?.closest<HTMLElement>("[data-resume-entry-id]") ?? null;
  const sectionTarget =
    element?.closest<HTMLElement>("[data-resume-section-id]") ?? null;
  const fieldTarget =
    element?.closest<HTMLElement>("[data-resume-target-id]") ?? null;

  return {
    entryId: entryTarget?.dataset.resumeEntryId ?? null,
    sectionId:
      entryTarget?.dataset.resumeSectionId ??
      sectionTarget?.dataset.resumeSectionId ??
      null,
    targetId: fieldTarget?.dataset.resumeTargetId ?? null,
  };
}

/** Letter width at 96dpi plus the page's own shell padding. */
const NATURAL_PREVIEW_WIDTH = 8.5 * 96 + 12;

/**
 * The smallest scale at which the rendered document is still readable. Opening
 * the Assistant narrows this column to about 355px, which scaled the page to
 * ~0.42 — measured 4-5px ink on a 7-8px line pitch — while the banner above it
 * said to approve the resume shown in the preview. At this floor the ink
 * matches the two-column layout, and the page scrolls horizontally inside its
 * own region rather than shrinking out of legibility.
 */
const MIN_READABLE_PREVIEW_SCALE = 0.72;

/**
 * How the page width is resolved for the column it currently sits in.
 *
 * `auto` is the default and is re-resolved on every measurement, including the
 * one the column's own `ResizeObserver` triggers when the Assistant rail docks
 * or closes and changes the column count. Holding the readable floor in a
 * column that cannot show the page at that floor left the document cut off by
 * ~285px with no scroll cue, under a banner that says to approve the resume
 * shown in the preview, so `auto` fits the width in exactly that case.
 */
type PreviewWidthMode = "auto" | "fit" | "readable";

/**
 * Width hysteresis between the two automatic modes. Without it a column that
 * lands exactly on the readable floor flips between "fit the width" and "hold
 * the readable floor" on consecutive measurements, which the user sees as the
 * page zooming in and out continuously.
 */
const PREVIEW_AUTO_MODE_HYSTERESIS = 8;

/** A sub-pixel column change is layout noise, not a new width to scale to. */
const PREVIEW_WIDTH_EPSILON = 1;

/** The scroll region's own padding (`p-0.5`), both sides. */
const PREVIEW_REGION_PADDING = 4;

/**
 * The page shell around the frame: a 1px border plus `p-1.5`, both sides. It is
 * part of what has to fit inside the visible region, so the scale has to budget
 * for it or the page's right edge lands under the scrollbar.
 */
const PREVIEW_PAGE_SHELL_CHROME = 14;

/**
 * Slack between the zoomed shell and the frame that holds it, so sub-pixel
 * rounding in `zoom` cannot clip the page against its own viewport.
 */
const PREVIEW_FRAME_SLACK = 8;

/** Everything between the visible region's box and the page's own width. */
const PREVIEW_PAGE_CHROME =
  PREVIEW_REGION_PADDING + PREVIEW_PAGE_SHELL_CHROME + PREVIEW_FRAME_SLACK;

export function ResumeStudioPreviewPane(props: ResumeStudioPreviewPaneProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);
  // The width is measured on a zero-height probe that is a sibling of the
  // scroll region, never on the scroll region itself. Measuring the scroller
  // fed its own output back in: the scaled page changes the scroller's content
  // size, that toggles a scrollbar, the scrollbar changes the measured width,
  // and the next measurement picks a different scale — a visible zoom loop.
  // The scroller's own width is still read, but only to learn the fixed
  // scrollbar gutter it reserves out of that column; the latch below keeps that
  // reading from ever re-entering the loop.
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const lastMeasuredWidthRef = useRef<number | null>(null);
  const lastAppliedWidthModeRef = useRef<PreviewWidthMode | null>(null);
  const autoFitToWidthRef = useRef(false);
  // The scale that the frame's width was computed for. Every draft re-render
  // replaces the `srcdoc` document, and a fresh body starts at the stylesheet
  // default `--preview-scale: 1`, so the resolved scale is re-applied to
  // whatever body is current — resolving it stays gated on a real width change.
  const appliedPreviewScaleRef = useRef<number | null>(null);
  // Width the scroll region reserves for its stable scrollbar gutter, latched
  // to the largest value ever observed. See `measurePreviewHeight`.
  const reservedScrollbarGutterRef = useRef(0);
  const previousSelectionScrollKeyRef = useRef<number | null>(null);
  const refreshRequestedRef = useRef(false);
  const [previewHeight, setPreviewHeight] = useState("72rem");
  const [previewFrameWidth, setPreviewFrameWidth] = useState<string | null>(
    null,
  );
  const [isPreviewScaleFloored, setIsPreviewScaleFloored] = useState(false);
  const [isPreviewFitToWidth, setIsPreviewFitToWidth] = useState(false);
  // `auto` resolves per measurement: hold the readable floor while the column
  // can show the whole page at it, and fit the width once it cannot. An
  // explicit click pins the mode so a later rail toggle does not undo the
  // choice the user just made.
  const [previewWidthMode, setPreviewWidthMode] =
    useState<PreviewWidthMode>("auto");
  const previewWidthModeRef = useRef(previewWidthMode);
  previewWidthModeRef.current = previewWidthMode;
  const [refreshFeedback, setRefreshFeedback] =
    useState<PreviewRefreshFeedback | null>(null);
  const selectionScrollKey = props.selectionScrollKey ?? 0;
  const hasReadyPreview =
    props.previewStatus === "ready" && Boolean(props.preview);
  const retryPreviewDisabled =
    props.isPending || props.previewStatus === "loading";
  const warningCount = props.preview?.warnings.length ?? 0;
  // Fallback when no suggestions list is mounted anywhere (the preview can
  // carry warnings the validation list does not): show them right here so
  // the count is never a dead link.
  const [showInlineWarnings, setShowInlineWarnings] = useState(false);

  const requestPreviewRefresh = () => {
    refreshRequestedRef.current = true;
    setRefreshFeedback("pending");
    props.onRetry();
  };

  useEffect(() => {
    if (props.previewStatus === "loading") {
      if (!refreshRequestedRef.current) {
        setRefreshFeedback((current) =>
          current === "completed" ? null : current,
        );
      }
      return;
    }

    if (!refreshRequestedRef.current) {
      return;
    }

    refreshRequestedRef.current = false;
    if (props.previewStatus === "ready") {
      setRefreshFeedback("completed");
    } else if (props.previewStatus === "error") {
      setRefreshFeedback("failed");
    }
  }, [props.previewStatus]);

  useEffect(() => {
    const frame = frameRef.current;

    if (!frame || !props.preview) {
      return;
    }

    const shouldScrollForSelection =
      selectionScrollKey > 0 &&
      previousSelectionScrollKeyRef.current !== selectionScrollKey;
    previousSelectionScrollKeyRef.current = selectionScrollKey;

    const measurePreviewHeight = () => {
      const document = frame.contentDocument;
      // A committed `srcdoc` document exists before its parser inserts
      // `<body>`, so `contentDocument` is non-null while `document.body` is
      // still null. The width probe's own ResizeObserver delivers its first
      // entry a frame after mount, which lands inside exactly that window on
      // first entry into the studio — and writing `.style` on the null body
      // threw an uncaught TypeError into the renderer. The `load` handler
      // rebinds and remeasures once the document is real.
      const body = document?.body ?? null;
      if (!document || !body) {
        return;
      }

      document.documentElement.style.overflow = "hidden";
      body.style.overflow = "hidden";
      // The probe spans the whole column and is immune to anything the page
      // does; the scroll region is that same box minus the scrollbar gutter it
      // reserves, which is the width the page actually gets. Their difference
      // is that gutter, and it is latched to the largest value ever seen: a
      // latched maximum only ever grows, and it grows at most once, so a
      // scrollbar coming and going can never widen the budget again and flip
      // the scale back. Measuring the probe alone was 15px too generous — the
      // page's right edge then sat under the scrollbar.
      const probeWidth = widthProbeRef.current?.clientWidth ?? 0;
      const regionWidth = scrollRegionRef.current?.clientWidth ?? 0;
      if (probeWidth > 0 && regionWidth > 0) {
        reservedScrollbarGutterRef.current = Math.max(
          reservedScrollbarGutterRef.current,
          probeWidth - regionWidth,
        );
      }
      const measuredWidth =
        (probeWidth > 0
          ? probeWidth - reservedScrollbarGutterRef.current
          : regionWidth) || frame.clientWidth;
      const containerWidth = Math.max(
        1,
        Math.floor(measuredWidth) - PREVIEW_PAGE_CHROME,
      );
      const lastMeasuredWidth = lastMeasuredWidthRef.current;
      const mode = previewWidthModeRef.current;
      // Height changes (the page itself growing, a vertical scrollbar) must
      // never re-run the scale decision; only a real width change, or the user
      // pinning a different mode, may.
      const shouldResolveScale =
        lastMeasuredWidth === null ||
        Math.abs(containerWidth - lastMeasuredWidth) > PREVIEW_WIDTH_EPSILON ||
        mode !== lastAppliedWidthModeRef.current;

      if (shouldResolveScale) {
        lastMeasuredWidthRef.current = containerWidth;
        lastAppliedWidthModeRef.current = mode;

        const fitScale = Math.min(1, containerWidth / NATURAL_PREVIEW_WIDTH);
        const readableFloorWidth =
          NATURAL_PREVIEW_WIDTH * MIN_READABLE_PREVIEW_SCALE;

        // Fitting starts exactly at the floor, never below it: a dead band on
        // this side means holding a page the column cannot show, which is a
        // silent crop under a banner that says to approve the resume shown in
        // the preview. Returning to the readable floor still waits for the
        // hysteresis, so the two thresholds stay distinct and a column resting
        // on the boundary settles instead of flapping.
        if (containerWidth < readableFloorWidth) {
          autoFitToWidthRef.current = true;
        } else if (
          containerWidth >
          readableFloorWidth + PREVIEW_AUTO_MODE_HYSTERESIS
        ) {
          autoFitToWidthRef.current = false;
        }

        // An explicit choice pins the mode outright; automatic resolution does
        // not run at all once the user has decided.
        const isFitToWidth =
          mode === "fit"
            ? true
            : mode === "readable"
              ? false
              : autoFitToWidthRef.current;
        const previewScale = Math.min(
          1,
          isFitToWidth
            ? fitScale
            : Math.max(fitScale, MIN_READABLE_PREVIEW_SCALE),
        );

        setIsPreviewScaleFloored(
          !isFitToWidth && fitScale < MIN_READABLE_PREVIEW_SCALE,
        );
        setIsPreviewFitToWidth(isFitToWidth && fitScale < 1);
        // When the page is scaled to fit, it can never legitimately need more
        // than the column it was fitted to: `Math.ceil` over a float product
        // otherwise asks for one pixel more than the width the scale came from
        // and puts the page's right edge back under the scrollbar. A pinned
        // readable size is the deliberate exception and still overflows into
        // the region's own horizontal scroll.
        const scaledShellWidth =
          previewScale <= fitScale
            ? Math.min(NATURAL_PREVIEW_WIDTH * previewScale, containerWidth)
            : NATURAL_PREVIEW_WIDTH * previewScale;
        setPreviewFrameWidth(
          `${Math.ceil(scaledShellWidth) + PREVIEW_FRAME_SLACK}px`,
        );
        appliedPreviewScaleRef.current = previewScale;
      }

      // Applied on every measurement, not only when the scale is re-resolved.
      // Each draft re-render replaces the `srcdoc` document, and the fresh body
      // starts at the stylesheet's `--preview-scale: 1` while the frame keeps
      // the width computed for the scaled page — so the page rendered ~37%
      // too large and every line lost its right quarter, with no scrollbar to
      // say so. Re-writing the resolved value is idempotent: an unchanged
      // custom property produces no layout change and so cannot re-enter here.
      const resolvedScale = appliedPreviewScaleRef.current;
      if (resolvedScale !== null) {
        body.style.setProperty("--preview-scale", String(resolvedScale));
      }

      const page = document.querySelector<HTMLElement>(".page");
      const rawHeight =
        page?.getBoundingClientRect().height ?? body.scrollHeight ?? 0;

      if (rawHeight > 0) {
        const nextHeight = Math.ceil(rawHeight + 8);
        setPreviewHeight(`${nextHeight}px`);
      }
    };

    const bindPreviewDocument = () => {
      const document = frame.contentDocument;
      // Same still-parsing window as above: `observe(null)` would throw. The
      // `load` handler runs `bindPreviewDocument` again once the document has
      // a body, so nothing is lost by declining to bind here.
      const body = document?.body ?? null;

      if (!document || !body) {
        return () => {};
      }

      measurePreviewHeight();
      const page = document.querySelector<HTMLElement>(".page");
      const resizeObserver =
        typeof ResizeObserver === "undefined"
          ? null
          : new ResizeObserver(() => {
              measurePreviewHeight();
            });
      resizeObserver?.observe(body);
      if (page) {
        resizeObserver?.observe(page);
      }

      const allTargets = document.querySelectorAll<HTMLElement>(
        "[data-resume-section-id], [data-resume-entry-id], [data-resume-target-id]",
      );
      const handleClick = (event: MouseEvent) => {
        const selection = parseSelectionTarget(event.target);

        if (!selection.sectionId && !selection.entryId && !selection.targetId) {
          return;
        }

        event.preventDefault();
        props.onSelectTarget(selection);
      };
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }

        const selection = parseSelectionTarget(event.target);

        if (!selection.sectionId && !selection.entryId && !selection.targetId) {
          return;
        }

        event.preventDefault();
        props.onSelectTarget(selection);
      };

      let selectedFieldTarget: HTMLElement | null = null;
      let selectedEntryTarget: HTMLElement | null = null;
      let selectedSectionTarget: HTMLElement | null = null;

      // The workspace seeds a default selection (usually the first section) so
      // the editor has something to show. Painting that derived selection in
      // the preview made the exported page look wrong — a grey block behind
      // Summary that the user never asked for. Only an explicit editor or
      // preview selection (which is the sole thing that advances
      // `selectionScrollKey`) may tint the page; hover and focus-visible
      // highlighting stays owned by the preview stylesheet.
      const hasExplicitSelection = selectionScrollKey > 0;

      const aiEditedTargetIds = new Set(props.aiEditedTargetIds ?? []);

      for (const target of allTargets) {
        const isAiEdited =
          aiEditedTargetIds.size > 0 &&
          [
            target.dataset.resumeSectionId,
            target.dataset.resumeEntryId,
            target.dataset.resumeBulletId,
            target.dataset.resumeTargetId,
          ].some((value) => Boolean(value) && aiEditedTargetIds.has(value!));

        if (isAiEdited) {
          target.setAttribute("data-resume-ai-edited", "true");
        } else {
          target.removeAttribute("data-resume-ai-edited");
        }

        const isSelectedEntry =
          Boolean(props.selectedEntryId) &&
          target.dataset.resumeEntryId === props.selectedEntryId;
        const isSelectedSection =
          !props.selectedEntryId &&
          Boolean(props.selectedSectionId) &&
          target.dataset.resumeSectionId === props.selectedSectionId;
        const isSelectedField =
          Boolean(props.selectedTargetId) &&
          target.dataset.resumeTargetId === props.selectedTargetId;

        if (
          hasExplicitSelection &&
          (isSelectedEntry || isSelectedSection || isSelectedField)
        ) {
          target.setAttribute("data-resume-selected", "true");
        } else {
          target.removeAttribute("data-resume-selected");
        }

        if (isSelectedField && !selectedFieldTarget) {
          selectedFieldTarget = target;
        } else if (isSelectedEntry && !selectedEntryTarget) {
          selectedEntryTarget = target;
        } else if (isSelectedSection && !selectedSectionTarget) {
          selectedSectionTarget = target;
        }
      }

      const selectedPreviewTarget =
        selectedFieldTarget ?? selectedEntryTarget ?? selectedSectionTarget;

      // Initial selection is derived from the draft and must not move the
      // locked Resume route. `scrollIntoView` on an iframe document can scroll
      // its ancestor route owner, hiding the route header under the fixed
      // shell. Only an explicit editor/preview selection gets this behavior.
      if (selectedPreviewTarget && shouldScrollForSelection) {
        selectedPreviewTarget.scrollIntoView({
          behavior: "auto",
          block: "nearest",
        });

        const scrollRegion = scrollRegionRef.current;
        if (scrollRegion) {
          const targetRect = selectedPreviewTarget.getBoundingClientRect();
          const iframeRect = frame.getBoundingClientRect();
          const regionRect = scrollRegion.getBoundingClientRect();
          const targetTop =
            scrollRegion.scrollTop +
            iframeRect.top +
            targetRect.top -
            regionRect.top;
          const targetBottom =
            scrollRegion.scrollTop +
            iframeRect.top +
            targetRect.bottom -
            regionRect.top;

          if (targetTop < scrollRegion.scrollTop + 24) {
            scrollRegion.scrollTop = Math.max(0, targetTop - 24);
          } else if (
            targetBottom >
            scrollRegion.scrollTop + scrollRegion.clientHeight - 24
          ) {
            scrollRegion.scrollTop =
              targetBottom - scrollRegion.clientHeight + 24;
          }
        }
      }

      document.addEventListener("click", handleClick);
      document.addEventListener("keydown", handleKeyDown);

      return () => {
        resizeObserver?.disconnect();
        document.removeEventListener("click", handleClick);
        document.removeEventListener("keydown", handleKeyDown);
      };
    };

    let cleanupDocument = () => {};

    const handleLoad = () => {
      cleanupDocument();
      cleanupDocument = bindPreviewDocument();
    };
    const handleResize = () => {
      measurePreviewHeight();
    };

    cleanupDocument = bindPreviewDocument();
    frame.addEventListener("load", handleLoad);
    window.addEventListener("resize", handleResize);

    // A sidebar collapse or a split-pane change alters this column's width
    // without resizing the window, so `resize` never fires and the page would
    // keep the scale it had in the wider column. The zero-height width probe
    // is watched instead of the scroll region: it is a sibling of the
    // scroller, so nothing this measurement writes (the frame's width and
    // height, a scrollbar appearing) can change its box and feed back in. Only
    // its `contentRect.width` is read, and only past a 1px threshold.
    let observedProbeWidth: number | null = null;
    const regionObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries[0];
            const nextWidth =
              entry?.contentRect.width ??
              widthProbeRef.current?.clientWidth ??
              frame.clientWidth;

            if (
              observedProbeWidth !== null &&
              Math.abs(nextWidth - observedProbeWidth) <= PREVIEW_WIDTH_EPSILON
            ) {
              return;
            }

            observedProbeWidth = nextWidth;
            measurePreviewHeight();
          });
    const widthProbe = widthProbeRef.current ?? scrollRegionRef.current;
    if (widthProbe) {
      regionObserver?.observe(widthProbe);
    }

    return () => {
      frame.removeEventListener("load", handleLoad);
      window.removeEventListener("resize", handleResize);
      regionObserver?.disconnect();
      cleanupDocument();
    };
  }, [
    props.aiEditedTargetIds,
    props.onSelectTarget,
    props.preview,
    props.previewStatus,
    selectionScrollKey,
    props.selectedEntryId,
    props.selectedSectionId,
    props.selectedTargetId,
    previewWidthMode,
  ]);

  return (
    <section className="surface-panel-shell relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border)">
      <header className="border-b border-(--surface-panel-border) px-3.5 py-2">
        {/* A two-column grid let the badge column shrink below its content
            while the badges themselves did not, so Refresh preview painted
            over "Saved draft rendered" once the Assistant rail narrowed this
            column. Wrapping cannot overlap: the action drops to its own row
            when the badges need the width. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="grid min-w-0 flex-1 basis-56 gap-1">
            {/* One quiet line, not a row of chips: what this is, whether it
                shows saved or unsaved content, and the optional suggestions
                as a text action. The template name lives in the template row
                of the tools column, so it is not repeated here. */}
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-(length:--text-small) leading-5">
              <p className="font-semibold text-(--text-headline)">
                Resume preview
              </p>
              {props.previewStatus === "loading" ? (
                <span className="inline-flex items-center gap-1 text-foreground-soft">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Refreshing
                </span>
              ) : null}
              {props.previewStatus === "ready" ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    props.isDirty ? "text-primary" : "text-foreground-soft",
                  )}
                >
                  <CheckCircle2 className="size-3.5" />
                  {props.isDirty
                    ? "Unsaved edits rendered"
                    : "Saved draft rendered"}
                </span>
              ) : null}
              {props.previewStatus === "ready" &&
              typeof props.preview?.metadata.pageCount === "number" ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    props.isDirty ? "text-primary" : "text-foreground-soft",
                  )}
                  title="Page count of the exported PDF"
                  data-resume-preview-page-count={
                    props.preview.metadata.pageCount >= 2 ? "" : undefined
                  }
                >
                  {props.preview.metadata.pageCount} page
                  {props.preview.metadata.pageCount === 1 ? "" : "s"}
                </span>
              ) : null}
              {props.templateLabel ? (
                <span className="sr-only">{props.templateLabel}</span>
              ) : null}
              {warningCount > 0 ? (
                <button
                  className="cursor-pointer rounded-sm text-foreground-soft underline decoration-from-font underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  data-resume-preview-suggestions
                  onClick={() => {
                    if (focusValidationSuggestions()) {
                      return;
                    }
                    // The list lives in the Tools tab in compact layouts and
                    // is not mounted until that tab is shown.
                    props.onRevealSuggestions?.();
                    requestAnimationFrame(() => {
                      if (!focusValidationSuggestions()) {
                        setShowInlineWarnings((current) => !current);
                      }
                    });
                  }}
                  title="Show the optional suggestions"
                  type="button"
                >
                  {warningCount} suggestion{warningCount === 1 ? "" : "s"}
                </button>
              ) : null}
            </div>
            {showInlineWarnings && warningCount > 0 ? (
              <ul
                className="grid gap-1 rounded-(--radius-field) border border-(--surface-panel-border) bg-background/45 px-3 py-2 text-(length:--text-tiny) leading-4 text-foreground-soft"
                data-resume-preview-inline-warnings
              >
                {(props.preview?.warnings ?? []).map((warning) => (
                  <li key={warning.id}>{warning.message}</li>
                ))}
              </ul>
            ) : null}
            {refreshFeedback ? (
              <p
                aria-atomic="true"
                aria-live="polite"
                className="text-(length:--text-tiny) leading-4 text-foreground-soft"
                data-resume-preview-refresh-status
              >
                {refreshFeedback === "pending"
                  ? "Refreshing preview…"
                  : refreshFeedback === "completed"
                    ? "Preview refreshed."
                    : "Preview refresh failed; try again."}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 self-start">
            {/* A narrow window can push this column past the readable floor.
                (The Assistant no longer can: it is a floating panel and never
                takes a studio column.) The page fits its column on its own, so
                the whole document stays visible under a banner that says to
                approve the resume shown in the preview; this control trades
                back to the larger, sideways-scrolling reading size and pins
                that choice. */}
            {isPreviewScaleFloored || isPreviewFitToWidth ? (
              <Button
                data-resume-preview-fit-width
                onClick={() =>
                  setPreviewWidthMode(isPreviewFitToWidth ? "readable" : "fit")
                }
                size="compact"
                title={
                  isPreviewFitToWidth
                    ? "Scale the page back up to a readable size"
                    : "Shrink the whole page to fit this column"
                }
                type="button"
                variant="secondary"
              >
                {isPreviewFitToWidth ? "Readable size" : "Fit width"}
              </Button>
            ) : null}
            <Button
              disabled={props.isPending || props.previewStatus === "loading"}
              onClick={requestPreviewRefresh}
              size="compact"
              type="button"
              variant="secondary"
            >
              <RefreshCcw className="size-4" />
              Refresh preview
            </Button>
          </div>
        </div>
      </header>

      {/* Zero-height width probe. It is a sibling of the scroll region, so its
          width follows only this pane's column — never the scaled page, the
          frame height, or a scrollbar the page's own size brings and takes
          away. Measuring the scroller instead produced a visible zoom loop. */}
      <div
        aria-hidden="true"
        className="h-0 w-full shrink-0"
        data-resume-preview-width-probe
        ref={widthProbeRef}
      />

      {/* The pane always sits in a bounded box (the Preview tab below xl, a
          column above it), so the region fills it and scrolls. A 42rem floor
          below xl made it taller than the tab, which clipped the page under
          Experience at the default window size (N-042). */}
      <div
        aria-label="Live resume preview"
        className="relative min-h-0 flex-1 overflow-x-auto overflow-y-auto bg-[linear-gradient(180deg,var(--surface-gradient-start),var(--surface-gradient-end))] p-0.5 [scrollbar-gutter:stable]"
        data-locked-pane-scroll-region
        data-resume-preview-scroll-region
        ref={scrollRegionRef}
        role="region"
        tabIndex={0}
      >
        <div className="grid min-h-full min-w-max justify-items-center pb-4">
          {props.isPending && !hasReadyPreview ? (
            <div
              aria-live="polite"
              className="grid h-full min-h-80 place-items-center rounded-(--radius-field) border border-dashed border-(--surface-panel-border) bg-background/70 p-6 text-center"
              role="status"
            >
              <div className="grid max-w-md gap-3">
                <LoaderCircle className="mx-auto size-6 animate-spin text-primary" />
                <h3 className="font-display text-foreground">
                  Updating your resume
                </h3>
                <p className="text-sm leading-6 text-foreground-soft">
                  The refreshed preview will appear here when it is ready.
                </p>
              </div>
            </div>
          ) : props.previewStatus === "error" ? (
            <div
              aria-atomic="true"
              className="grid h-full place-items-center rounded-(--radius-field) border border-dashed border-critical/35 bg-critical/10 p-6 text-center"
              role="alert"
            >
              <div className="grid max-w-md gap-3">
                <div className="mx-auto flex size-11 items-center justify-center rounded-full border border-critical/25 bg-critical/10 text-critical">
                  <AlertTriangle className="size-5" />
                </div>
                <h3 className="font-display text-foreground">
                  Preview unavailable
                </h3>
                <p className="text-sm leading-6 text-foreground-soft">
                  {props.previewError ??
                    "The current draft could not be rendered."}
                </p>
                <p className="text-sm leading-6 text-foreground-soft">
                  Your edits are still in the studio and nothing was discarded.
                  You can retry the preview at any time.
                </p>
                <Button
                  className="justify-self-center"
                  disabled={retryPreviewDisabled}
                  onClick={requestPreviewRefresh}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  <RefreshCcw className="size-4" />
                  Retry preview
                </Button>
              </div>
            </div>
          ) : props.preview ? (
            <div className="relative mx-auto w-max overflow-hidden rounded-(--radius-field) border border-(--surface-panel-border) bg-(--resume-preview-frame) p-1.5 shadow-(--resume-preview-shell-shadow)">
              {/* The rendered document carries its own
                  `default-src 'none'; script-src 'none'` policy (see
                  `job-finder-resume-renderer`), and this renderer's own CSP
                  has no `unsafe-inline`, so nothing inside a resume can
                  execute. A `sandbox` attribute would have to keep
                  `allow-same-origin` anyway for the click-to-edit binding
                  below, and it made Chromium log "Blocked script execution in
                  'about:srcdoc'" on every preview reload. */}
              <iframe
                className="mx-auto block rounded-(--radius-field) border-0 bg-card"
                ref={frameRef}
                srcDoc={props.preview.html}
                style={{
                  height: previewHeight,
                  width: previewFrameWidth ?? "8.95in",
                }}
                title="Live resume preview"
              />
            </div>
          ) : (
            <div className="grid h-full place-items-center rounded-(--radius-field) border border-dashed border-(--surface-panel-border) bg-background/70 p-6 text-center">
              <div className="grid max-w-md gap-3">
                <h3 className="font-display text-foreground">
                  Preview pending
                </h3>
                <p className="text-sm leading-6 text-foreground-soft">
                  The studio is preparing a live preview from your current
                  draft.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
